'use strict';
// The desk: six agents in one pipeline, trading with pretend money.
//   Scout -> Filter -> Analyst -> Executor -> Risk, with Logger recording everything.

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const feeds = require('./feeds');
const ai = require('./ai');

const DEFAULT_CONFIG = {
  startBalance: 280, // pretend dollars; applied on reset
  maxSizePct: 8, // max share of the account per trade
  maxOpen: 5, // max positions held at once
  stopPct: 6, // hard stop
  trailArmPct: 12, // trailing stop switches on at this gain
  trailDistPct: 8, // trailing stop sells this far below the peak
  beArmPct: 8, // stop moves up to the entry price at this gain (0 = off)
  tpPct: 25, // take profit: sell part of the position at this gain (0 = off)
  tpSellPct: 50, // how much of the position the take profit sells
  staleMin: 45, // close a position that has gone nowhere after this long (0 = off)
  maxHoldHours: 6, // 0 = no time limit
  minVolH1: 50000, // filter: volume in the last hour
  minLiq: 15000, // filter: pool liquidity
  maxTop10Pct: 20, // filter: top 10 holders
  minLpLockedPct: 90, // filter: liquidity locked or burned
  minScore: 0.6, // analyst pass mark
  feePct: 0.3, // swap fee charged on each side
  slipPct: 0.5, // extra slippage allowance on each side
  maxPoolPct: 2, // never be more than this share of a pool
  cooldownMin: 120, // don't re-buy the same token within this time
  rpcUrl: '', // optional private Solana node; blank uses the free public one
  aiAnalyst: false, // ask Claude for a verdict on tokens that pass the filters (needs an API key)
  aiModel: ai.DEFAULT_MODEL,
};

const LIMITS = {
  startBalance: [10, 1e7], maxSizePct: [0.5, 100], maxOpen: [1, 50], stopPct: [0.5, 90],
  trailArmPct: [1, 1000], trailDistPct: [0.5, 90], maxHoldHours: [0, 720], minVolH1: [0, 1e9],
  minLiq: [0, 1e9], maxTop10Pct: [1, 100], minLpLockedPct: [0, 100], minScore: [0, 1],
  beArmPct: [0, 1000], tpPct: [0, 10000], tpSellPct: [5, 95], staleMin: [0, 100000],
  feePct: [0, 10], slipPct: [0, 20], maxPoolPct: [0.1, 100], cooldownMin: [0, 10080],
};

const REASONS = {
  volume: 'Volume too low in the last hour',
  liquidity: 'Pool liquidity too thin',
  mint: 'Mint authority not revoked',
  freeze: 'Freeze authority not revoked',
  lp: 'LP not locked',
  holders: 'Top 10 holders own too much',
  dev: 'Dev wallet linked to past rugs',
  unverified: 'Safety report unavailable',
  score: 'Analyst score below pass mark',
  ai: 'AI Analyst said no',
};

// Pool types whose price is simply one vault balance divided by the other.
const CHAIN_POOLS = new Set(['pump_fun_amm', 'raydium', 'raydium_cpmm']);

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const ramp = (x, lo, hi) => clamp01((x - lo) / (hi - lo));
const money = (n) => `$${Math.abs(n) >= 1000 ? Math.round(n).toLocaleString('en-US') : n.toFixed(2)}`;
const signed = (n) => `${n >= 0 ? '+' : '−'}${money(Math.abs(n))}`;
const pct = (n) => `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(1)}%`;
const kUsd = (n) => (n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `$${Math.round(n / 1000)}k` : `$${Math.round(n)}`);

class Desk extends EventEmitter {
  constructor(dataDir) {
    super();
    this.dataDir = dataDir;
    this.stateFile = path.join(dataDir, 'state.json');
    this.logFile = path.join(dataDir, 'log.jsonl');
    fs.mkdirSync(dataDir, { recursive: true });
    this.config = { ...DEFAULT_CONFIG };
    // Secrets live in their own file and are never sent to the dashboard.
    this.secretsFile = path.join(dataDir, 'secrets.json');
    this.secrets = {};
    try { this.secrets = JSON.parse(fs.readFileSync(this.secretsFile, 'utf8')); } catch { /* none saved */ }
    this.aiQueue = [];
    this.aiActive = 0;
    this.fresh();
    this.load();
    this.timers = [];
    this.rugQueue = [];
    this.rugBusy = false;
    this.riskBusy = false;
    this.chainBusy = false;
    this.scoutTick = 0;
    this.dirty = false;
  }

  fresh() {
    this.running = true;
    this.startedAt = Date.now();
    this.cash = this.config.startBalance;
    this.startBalance = this.config.startBalance;
    this.positions = [];
    this.trades = [];
    this.curve = [{ t: Date.now(), v: this.cash }];
    this.counters = { scanned: 0, killed: 0, scored: 0, traded: 0, wins: 0, losses: 0, reasons: 0, aiCalls: 0, aiInTok: 0, aiOutTok: 0 };
    this.why = Object.fromEntries(Object.keys(REASONS).map((k) => [k, 0]));
    this.agents = {};
    this.logs = []; // decisions that matter
    this.noise = []; // volume and liquidity kills (very frequent)
    this.logSeq = 0;
    this.seen = new Map(); // mint -> first seen
    this.evals = new Map(); // mint -> full check sheet
    this.secondLook = []; // { mint, due }
    this.lastBuy = new Map(); // mint -> ts
    this.posSeq = 0;
    this.solUsd = 0; // latest SOL price, learned from the pairs the Scout sees
  }

  load() {
    try {
      const s = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      this.config = this.cleanConfig({ ...DEFAULT_CONFIG, ...s.config });
      for (const k of ['running', 'startedAt', 'cash', 'startBalance', 'positions', 'trades', 'curve', 'agents', 'logs', 'noise', 'logSeq', 'posSeq', 'solUsd']) {
        if (s[k] !== undefined) this[k] = s[k];
      }
      Object.assign(this.counters, s.counters);
      Object.assign(this.why, s.why);
      this.seen = new Map(s.seen || []);
      this.evals = new Map(s.evals || []);
      this.lastBuy = new Map(s.lastBuy || []);
      for (const p of this.positions) { // positions saved by an older version
        p.basis = p.basis || p.size / p.tokens;
        p.realized = p.realized || 0;
        p.stopMove = p.stopMove ?? -this.config.stopPct;
      }
    } catch { /* first run */ }
  }

  save() {
    if (!this.dirty) return;
    this.dirty = false;
    const s = {
      config: this.config, running: this.running, startedAt: this.startedAt, cash: this.cash,
      startBalance: this.startBalance, positions: this.positions, trades: this.trades, curve: this.curve,
      counters: this.counters, why: this.why, agents: this.agents, logs: this.logs.slice(-1500),
      noise: this.noise.slice(-500), logSeq: this.logSeq, posSeq: this.posSeq, solUsd: this.solUsd,
      seen: [...this.seen].slice(-15000), evals: [...this.evals].slice(-600), lastBuy: [...this.lastBuy],
    };
    try {
      fs.writeFileSync(`${this.stateFile}.tmp`, JSON.stringify(s));
      fs.renameSync(`${this.stateFile}.tmp`, this.stateFile);
    } catch (e) { console.error('Could not save state:', e.message); }
  }

  cleanConfig(c) {
    const out = { ...this.config };
    for (const [k, [lo, hi]] of Object.entries(LIMITS)) {
      const v = Number(c[k]);
      if (Number.isFinite(v)) out[k] = Math.max(lo, Math.min(hi, v));
    }
    out.maxOpen = Math.round(out.maxOpen);
    if (typeof c.aiAnalyst === 'boolean') out.aiAnalyst = c.aiAnalyst;
    if (typeof c.aiModel === 'string') out.aiModel = /^claude-[a-z0-9.-]{3,60}$/.test(c.aiModel.trim()) ? c.aiModel.trim() : ai.DEFAULT_MODEL;
    if (typeof c.rpcUrl === 'string') {
      const u = c.rpcUrl.trim();
      out.rpcUrl = /^https:\/\/[^\s]{4,300}$/.test(u) ? u : '';
    }
    return out;
  }

  // ---------- Logger ----------
  log(agent, kind, text, cand, extra = {}) {
    const row = { id: ++this.logSeq, t: Date.now(), agent, kind, text, sym: cand?.sym || null, mint: cand?.mint || null, ...extra };
    const noisy = extra.reason === 'volume' || extra.reason === 'liquidity';
    const buf = noisy ? this.noise : this.logs;
    buf.push(row);
    if (buf.length > (noisy ? 800 : 2500)) buf.splice(0, 200);
    this.counters.reasons++;
    this.agents[agent] = { text, sym: row.sym, mint: row.mint, kind, t: row.t };
    this.agents.logger = { text: `${agent} · ${text}`, sym: row.sym, mint: row.mint, kind, t: row.t };
    this.dirty = true;
    fs.appendFile(this.logFile, `${JSON.stringify(row)}\n`, () => {});
    this.emit('log', row);
    return row;
  }

  // ---------- lifecycle ----------
  start() {
    const every = (ms, fn) => this.timers.push(setInterval(() => Promise.resolve().then(fn).catch((e) => this.softError(e)), ms));
    every(20000, () => this.scout());
    every(60000, () => this.scoutProfiles());
    every(60000, () => this.secondLooks());
    every(1000, () => this.riskChain());
    every(3000, () => this.riskFeed());
    every(1300, () => this.pumpRugQueue());
    every(700, () => this.pumpAiQueue());
    this.timers.push(setInterval(() => this.sample(), 15000));
    this.timers.push(setInterval(() => this.save(), 8000));
    this.scout().catch((e) => this.softError(e));
    this.riskFeed().catch((e) => this.softError(e));
  }

  stop() {
    this.timers.forEach(clearInterval);
    this.dirty = true;
    this.save();
  }

  softError() { /* feed health already records the failure; the next tick retries */ }

  setRunning(on) {
    if (this.running === on) return;
    this.running = on;
    this.log('logger', 'info', on ? 'Desk resumed · scanning for new pairs' : 'Desk paused · no new scans or buys, open positions stay protected');
  }

  reset() {
    this.fresh();
    this.rugQueue = [];
    this.aiQueue = [];
    try { fs.renameSync(this.logFile, path.join(this.dataDir, `log-${Date.now()}.jsonl`)); } catch { /* no log yet */ }
    this.log('logger', 'info', `Account reset to ${money(this.cash)} of paper money`);
    this.dirty = true;
    this.save();
  }

  aiKey() {
    return this.secrets.anthropicKey || process.env.ANTHROPIC_API_KEY || '';
  }

  aiOn() {
    return this.config.aiAnalyst && !!this.aiKey() && Date.now() >= (this.aiPausedUntil || 0);
  }

  setConfig(patch) {
    if (typeof patch.aiKey === 'string' && patch.aiKey.trim()) {
      this.secrets.anthropicKey = patch.aiKey.trim().slice(0, 300);
      try { fs.writeFileSync(this.secretsFile, JSON.stringify(this.secrets), { mode: 0o600 }); } catch (e) { console.error('Could not save the API key:', e.message); }
    }
    this.config = this.cleanConfig(patch);
    this.aiPausedUntil = 0; // a new key or model deserves a fresh try
    this.log('logger', 'info', 'Settings changed');
  }

  // ---------- Scout ----------
  async scout() {
    if (!this.running) return;
    this.scoutTick++;
    // One call per tick keeps us inside GeckoTerminal's free rate limit.
    const kind = this.scoutTick % 4 === 0 ? 'trending_pools' : 'new_pools';
    const pools = await feeds.geckoPools(kind);
    for (const c of pools) this.consider(c, kind === 'new_pools' ? 'new pair' : 'trending');
  }

  async scoutProfiles() {
    if (!this.running) return;
    const mints = (await feeds.dexLatestProfiles()).filter((m) => !this.seen.has(m));
    if (!mints.length) return;
    const pairs = await feeds.dexTokens(mints.slice(0, 30));
    for (const c of pairs.values()) this.consider(c, 'new listing');
  }

  consider(cand, source) {
    if (cand.quote === feeds.SOL && cand.quoteUsd > 1) this.solUsd = cand.quoteUsd;
    if (this.seen.has(cand.mint) || !cand.priceUsd) return;
    this.seen.set(cand.mint, Date.now());
    if (this.seen.size > 20000) {
      for (const k of [...this.seen.keys()].slice(0, 4000)) this.seen.delete(k);
    }
    this.counters.scanned++;
    this.agents.scout = { text: `${source} on ${cand.dex || 'dex'}`, sym: cand.sym, mint: cand.mint, kind: 'info', t: Date.now() };
    this.dirty = true;
    this.filterCheap(cand, source, false);
  }

  async secondLooks() {
    if (!this.running) return;
    const now = Date.now();
    const due = this.secondLook.filter((x) => x.due <= now).slice(0, 30);
    if (!due.length) return;
    this.secondLook = this.secondLook.filter((x) => !due.includes(x));
    const pairs = await feeds.dexTokens(due.map((x) => x.mint));
    for (const c of pairs.values()) this.filterCheap(c, 'second look', true);
  }

  // ---------- Filter ----------
  sheet(cand, source) {
    const ev = { cand, source, t: Date.now(), checks: [], score: null, parts: null, outcome: 'checking', reason: null, rug: null };
    this.evals.set(cand.mint, ev);
    if (this.evals.size > 1500) {
      for (const k of [...this.evals.keys()].slice(0, 300)) this.evals.delete(k);
    }
    return ev;
  }

  kill(ev, agent, reason, detail) {
    ev.outcome = 'killed'; ev.reason = reason; ev.killedBy = agent;
    this.counters.killed++;
    this.why[reason]++;
    this.log(agent, 'kill', detail, ev.cand, { reason });
  }

  filterCheap(cand, source, second) {
    const cfg = this.config;
    const ev = this.sheet(cand, source);
    const volOk = cand.volH1 >= cfg.minVolH1;
    const liqOk = cand.liqUsd >= cfg.minLiq;
    ev.checks.push({ key: 'volume', label: `Volume last hour ≥ ${kUsd(cfg.minVolH1)}`, pass: volOk, value: kUsd(cand.volH1) });
    ev.checks.push({ key: 'liquidity', label: `Pool liquidity ≥ ${kUsd(cfg.minLiq)}`, pass: liqOk, value: kUsd(cand.liqUsd) });
    if (second) {
      // The first look already counted this token as a volume kill.
      if (!volOk) { ev.outcome = 'killed'; ev.reason = 'volume'; ev.killedBy = 'filter'; return; }
      this.counters.killed--; this.why.volume--;
    }
    if (!volOk) {
      // A brand-new pair has had no time to trade. Look once more in 15 minutes.
      const young = cand.createdAt && Date.now() - cand.createdAt < 45 * 60000;
      if (!second && young && this.secondLook.length < 400) this.secondLook.push({ mint: cand.mint, due: Date.now() + 15 * 60000 });
      return this.kill(ev, 'filter', 'volume', `volume ${kUsd(cand.volH1)} in the last hour`);
    }
    if (!liqOk) return this.kill(ev, 'filter', 'liquidity', `liquidity only ${kUsd(cand.liqUsd)}`);
    if (second) this.log('scout', 'info', `second look · volume now ${kUsd(cand.volH1)}`, cand);
    if (this.rugQueue.length < 200) this.rugQueue.push(ev);
  }

  async pumpRugQueue() {
    if (this.rugBusy || !this.rugQueue.length) return;
    this.rugBusy = true;
    const ev = this.rugQueue.shift();
    try {
      let rug = null;
      try { rug = await feeds.rugReport(ev.cand.mint); } catch (e) {
        if (e.status === 429) await new Promise((r) => setTimeout(r, 8000));
      }
      this.filterSafety(ev, rug);
    } finally { this.rugBusy = false; }
  }

  filterSafety(ev, rug) {
    const cfg = this.config; const c = ev.cand;
    if (!rug) {
      ev.checks.push({ key: 'unverified', label: 'Safety report available', pass: false, value: 'no answer' });
      return this.kill(ev, 'filter', 'unverified', 'safety report unavailable · not buying blind');
    }
    // Remember the pool this pair trades in, so Risk can read its balances from the chain.
    ev.chain = (rug.pools || []).find((m) => m.pubkey === c.pool && CHAIN_POOLS.has(m.type)) || null;
    delete rug.pools;
    ev.rug = rug;
    if (rug.name && (!c.name || c.name === c.sym)) c.name = rug.name;
    const curve = rug.marketType === 'pump_fun'; // still on the bonding curve: there is no LP to pull
    const lpPct = curve ? 100 : rug.lpLockedPct;
    const rules = [
      ['mint', 'Mint authority revoked', rug.mintRevoked, rug.mintRevoked ? 'revoked' : 'dev can print more', 'mint not revoked'],
      ['freeze', 'Freeze authority revoked', rug.freezeRevoked, rug.freezeRevoked ? 'revoked' : 'dev can freeze wallets', 'freeze not revoked'],
      ['lp', `LP locked ≥ ${cfg.minLpLockedPct}%`, lpPct != null && lpPct >= cfg.minLpLockedPct, lpPct == null ? 'no pool found' : `${lpPct.toFixed(0)}% locked`, lpPct == null ? 'LP not found' : `LP only ${lpPct.toFixed(0)}% locked`],
      ['holders', `Top 10 holders ≤ ${cfg.maxTop10Pct}%`, rug.top10Pct <= cfg.maxTop10Pct, `${rug.top10Pct.toFixed(0)}%`, `top 10 holders ${rug.top10Pct.toFixed(0)}%`],
      ['dev', 'Dev wallet clean', !rug.devFlag, rug.devFlag || 'no rug history found', `dev → ${rug.devFlag || ''}`.toLowerCase()],
    ];
    let failed = null;
    for (const [key, label, pass, value, why] of rules) {
      ev.checks.push({ key, label, pass: !!pass, value });
      if (!pass && !failed) failed = [key, why];
    }
    if (failed) return this.kill(ev, 'filter', failed[0], failed[1]);
    this.analyst(ev);
  }

  // ---------- Analyst ----------
  // A transparent rule-based score from 0 to 1. Every part is shown on the token's check sheet.
  analyst(ev) {
    const c = ev.cand; const rug = ev.rug; const cfg = this.config;
    const txH1 = c.buysH1 + c.sellsH1;
    const buyShare = txH1 >= 20 ? c.buysH1 / txH1 : 0.5;
    let momentum;
    if (c.chgH1 <= 0) momentum = 0;
    else if (c.chgH1 <= 80) momentum = ramp(c.chgH1, 0, 15);
    else momentum = Math.max(0.3, 1 - ramp(c.chgH1, 80, 300) * 0.7); // already ran: late entries get chased down
    if (c.chgM5 < -4) momentum *= 0.5; // rolling over right now
    const safety = clamp01(1 - rug.top10Pct / (cfg.maxTop10Pct * 1.5)) * 0.5
      + (rug.dangers.length ? 0 : 0.3) + ramp(rug.holders, 100, 1500) * 0.2;
    const parts = [
      { label: 'Buy pressure', weight: 0.25, value: ramp(buyShare, 0.45, 0.65), note: `${Math.round(buyShare * 100)}% of trades are buys` },
      { label: 'Momentum', weight: 0.25, value: momentum, note: `${pct(c.chgH1)} in 1h, ${pct(c.chgM5)} in 5m` },
      { label: 'Activity', weight: 0.15, value: ramp(c.liqUsd ? c.volH1 / c.liqUsd : 0, 0.3, 2), note: `hourly volume is ${(c.liqUsd ? c.volH1 / c.liqUsd : 0).toFixed(1)}× liquidity` },
      { label: 'Depth', weight: 0.15, value: ramp(Math.log10(Math.max(c.liqUsd, 1)), Math.log10(15000), Math.log10(150000)), note: `${kUsd(c.liqUsd)} in the pool` },
      { label: 'Safety', weight: 0.2, value: clamp01(safety), note: `${rug.holders.toLocaleString('en-US')} holders${rug.dangers.length ? `, flags: ${rug.dangers.join(', ')}` : ''}` },
    ];
    const score = parts.reduce((s, p) => s + p.weight * p.value, 0);
    ev.parts = parts; ev.score = score;
    this.counters.scored++;
    if (this.aiOn()) {
      // Don't spend an AI call on a token the rules already rate as clearly weak.
      const floor = Math.max(0, cfg.minScore - 0.2);
      ev.checks.push({ key: 'score', label: `Rule score ≥ ${floor.toFixed(2)} (worth an AI look)`, pass: score >= floor, value: score.toFixed(2) });
      if (score < floor) return this.kill(ev, 'analyst', 'score', `rule score ${score.toFixed(2)} · not worth an AI look`);
      if (this.aiQueue.length < 50) return this.aiQueue.push(ev);
      ev.checks.pop(); // AI is backed up: decide on the rules alone
    }
    this.decideOnRules(ev);
  }

  decideOnRules(ev) {
    const cfg = this.config; const score = ev.score;
    const pass = score >= cfg.minScore;
    ev.checks.push({ key: 'score', label: `Analyst score ≥ ${cfg.minScore.toFixed(2)}`, pass, value: score.toFixed(2) });
    if (!pass) return this.kill(ev, 'analyst', 'score', `score ${score.toFixed(2)} < ${cfg.minScore.toFixed(2)}`);
    this.log('analyst', 'pass', `passed · score ${score.toFixed(2)}`, ev.cand, { score });
    this.execute(ev).catch((e) => this.softError(e));
  }

  pumpAiQueue() {
    while (this.aiActive < 2 && this.aiQueue.length) {
      const ev = this.aiQueue.shift();
      this.aiActive++;
      this.aiReview(ev).catch((e) => this.softError(e)).finally(() => { this.aiActive--; });
    }
  }

  // Everything the AI Analyst gets to see about one token.
  brief(ev) {
    const c = ev.cand; const r = ev.rug;
    const round = (n, d = 2) => (Number.isFinite(n) ? +n.toFixed(d) : null);
    return {
      symbol: c.sym, name: c.name, description_by_creator: r.desc || null,
      exchange: c.dex, launchpad: r.launchpad, pool_age_minutes: c.createdAt ? Math.round((Date.now() - c.createdAt) / 60000) : null,
      market: {
        price_usd: c.priceUsd, market_cap_usd: Math.round(c.fdv), liquidity_usd: Math.round(c.liqUsd),
        volume_usd: { m5: Math.round(c.volM5), h1: Math.round(c.volH1), h6: Math.round(c.volH6 || 0), h24: Math.round(c.volH24 || 0) },
        price_change_pct: { m5: round(c.chgM5), h1: round(c.chgH1), h6: round(c.chgH6), h24: round(c.chgH24) },
        trades_last_hour: { buys: c.buysH1, sells: c.sellsH1 }, trades_last_5m: { buys: c.buysM5, sells: c.sellsM5 },
        unique_traders_last_hour: c.buyersH1 ? { buyers: c.buyersH1, sellers: c.sellersH1 } : null,
      },
      holders: {
        total: r.holders, top10_pct_excluding_pools: round(r.top10Pct, 1), top_holder_pcts: r.topHolderPcts,
        insider_flagged_among_top20: r.insiderHolders, insider_networks: r.insiderNetworks,
      },
      creator: { holds_pct: r.creatorHoldsPct, other_tokens_created: r.creatorOtherTokens },
      safety: {
        lp_locked_pct: r.marketType === 'pump_fun' ? 100 : round(r.lpLockedPct, 0), lp_providers: r.lpProviders,
        rugcheck_danger_flags: r.dangers, rugcheck_warnings: r.warns, jupiter_verified: r.jupVerified,
      },
      presence: c.links ? { websites: c.links.websites, socials: c.links.socials } : 'unknown',
      desk: { rule_based_score: round(ev.score), rule_score_parts: ev.parts.map((p) => ({ part: p.label, value: round(p.value) })), pass_mark: this.config.minScore },
    };
  }

  async aiReview(ev) {
    const cfg = this.config; let c = ev.cand;
    try { // fresh numbers, plus the website and socials listing
      const live = (await feeds.dexTokens([c.mint])).get(c.mint);
      if (live && live.priceUsd) { c = { ...c, ...live, name: c.name || live.name, pool: c.pool, createdAt: c.createdAt || live.createdAt, buyersH1: c.buyersH1, sellersH1: c.sellersH1 }; ev.cand = c; }
    } catch { /* use the scouted numbers */ }
    let out;
    try {
      out = await ai.review({ apiKey: this.aiKey(), model: cfg.aiModel, brief: this.brief(ev), client: this.aiClient });
    } catch (e) {
      // A rejected key won't fix itself: stop calling for a few minutes instead of failing on every token.
      if (/API key|model/.test(e.message)) this.aiPausedUntil = Date.now() + 5 * 60000;
      this.log('analyst', 'info', `AI unavailable (${e.message}) · using the rule score`, c);
      ev.checks.pop();
      return this.decideOnRules(ev);
    }
    this.counters.aiCalls++; this.counters.aiInTok += out.inTok; this.counters.aiOutTok += out.outTok;
    ev.ai = out;
    const pass = out.verdict === 'buy' && out.score >= cfg.minScore;
    ev.checks.push({ key: 'ai', label: `AI Analyst says buy, score ≥ ${cfg.minScore.toFixed(2)}`, pass, value: `${out.verdict} · ${out.score.toFixed(2)}` });
    if (!pass) return this.kill(ev, 'analyst', 'ai', `AI ${out.verdict} · ${out.score.toFixed(2)} · ${out.summary}`);
    this.log('analyst', 'pass', `AI buy · ${out.score.toFixed(2)} · ${out.summary}`, c, { score: out.score });
    this.execute(ev).catch((e) => this.softError(e));
  }

  // ---------- Executor ----------
  equity() {
    return this.cash + this.positions.reduce((s, p) => s + p.value, 0);
  }

  skip(ev, why) {
    ev.outcome = 'skipped'; ev.reason = why;
    this.log('executor', 'info', `skipped · ${why}`, ev.cand);
  }

  // Price and liquidity of one pool from its two vault balances.
  quoteFromVaults(chain, mint, balances) {
    const a = balances.get(chain.vaults[0]); const b = balances.get(chain.vaults[1]);
    if (a === undefined || b === undefined) return null; // no answer
    if (!a || !b) return { gone: true };
    const base = a.mint === mint ? a : b.mint === mint ? b : null;
    const quote = base === a ? b : a;
    if (!base || !feeds.QUOTES.has(quote.mint)) return null;
    const quoteUsd = quote.mint === feeds.SOL ? this.solUsd : 1;
    if (!quoteUsd) return null;
    if (base.amount <= 0 || quote.amount <= 0) return { gone: true };
    return { priceUsd: (quote.amount / base.amount) * quoteUsd, liqUsd: 2 * quote.amount * quoteUsd };
  }

  async execute(ev) {
    const cfg = this.config; let c = ev.cand;
    if (!this.running) return this.skip(ev, 'desk is paused');
    if (this.positions.some((p) => p.mint === c.mint)) return this.skip(ev, 'already holding it');
    const last = this.lastBuy.get(c.mint);
    if (last && Date.now() - last < cfg.cooldownMin * 60000) return this.skip(ev, 'traded it recently');
    if (this.positions.length >= cfg.maxOpen) return this.skip(ev, `already holding ${cfg.maxOpen} positions`);
    // The safety checks took a moment: buy at the price now, not the price then.
    let chain = ev.chain; let source = 'feed';
    try {
      const live = (await feeds.dexTokens([c.mint])).get(c.mint);
      if (live && live.priceUsd) {
        if (live.quote === feeds.SOL && live.quoteUsd > 1) this.solUsd = live.quoteUsd;
        c = { ...c, priceUsd: live.priceUsd, liqUsd: live.liqUsd || c.liqUsd, img: live.img || c.img }; ev.cand = c;
      }
    } catch { /* fall back to the scouted price */ }
    if (chain) {
      try {
        const q = this.quoteFromVaults(chain, c.mint, await feeds.chainBalances(cfg.rpcUrl, chain.vaults));
        // Trust the chain only if it roughly agrees with the feed: guards against reading the wrong pool.
        if (q && q.priceUsd && Math.abs(q.priceUsd / c.priceUsd - 1) < 0.25) {
          c = { ...c, priceUsd: q.priceUsd, liqUsd: q.liqUsd }; ev.cand = c; source = 'chain';
        } else chain = null;
      } catch { /* chain read failed: buy on the feed price, Risk will keep trying the chain */ }
    }
    if (this.positions.length >= cfg.maxOpen || this.positions.some((p) => p.mint === c.mint)) return this.skip(ev, 'slot taken while checking the price');
    const size = Math.min(this.equity() * cfg.maxSizePct / 100, c.liqUsd * cfg.maxPoolPct / 100, this.cash);
    if (size < 1) return this.skip(ev, 'not enough free cash');
    const impact = size / (c.liqUsd / 2); // constant-product pool: price moves by trade size over one side
    const fill = c.priceUsd * (1 + impact + cfg.slipPct / 100);
    const tokens = (size * (1 - cfg.feePct / 100)) / fill;
    const pos = {
      id: ++this.posSeq, mint: c.mint, sym: c.sym, name: c.name, pool: c.pool, dex: c.dex, img: c.img,
      openedAt: Date.now(), size, tokens, entryPrice: fill, basis: size / tokens, price: c.priceUsd, liq: c.liqUsd,
      peak: c.priceUsd, trailing: false, tookProfit: false, realized: 0, stopMove: -cfg.stopPct,
      value: tokens * c.priceUsd, score: ev.score, missingSince: 0, chain: chain ? { vaults: chain.vaults } : null,
      chainOkAt: source === 'chain' ? Date.now() : 0, source,
    };
    pos.pnlUsd = pos.value - size; pos.pnlPct = (pos.pnlUsd / size) * 100;
    this.cash -= size;
    this.positions.push(pos);
    this.lastBuy.set(c.mint, Date.now());
    this.counters.traded++;
    ev.outcome = 'bought';
    const share = (size / this.equity()) * 100;
    this.log('executor', 'buy', `bought ${money(size)} · ${share.toFixed(0)}% of stack`, c, { usd: size });
    this.log('risk', 'info', `stop set · −${cfg.stopPct}% hard · watching ${chain ? 'on-chain' : 'price feed'}`, c);
  }

  // ---------- Risk ----------
  // Fast lane: once a second, read every watched pool's balances straight from the chain.
  async riskChain() {
    const watched = this.positions.filter((p) => p.chain);
    if (this.chainBusy || !watched.length) return;
    this.chainBusy = true;
    try {
      const balances = await feeds.chainBalances(this.config.rpcUrl, watched.flatMap((p) => p.chain.vaults));
      const now = Date.now();
      for (const p of watched) {
        if (!this.positions.includes(p)) continue;
        const q = this.quoteFromVaults(p.chain, p.mint, balances);
        if (!q) continue;
        if (q.gone) {
          p.missingSince = p.missingSince || now;
          if (now - p.missingSince > 20000) this.close(p, 'liquidity gone', 0);
          continue;
        }
        p.chainOkAt = now; p.source = 'chain';
        this.manage(p, q.priceUsd, q.liqUsd, now);
      }
      this.dirty = true;
    } finally { this.chainBusy = false; }
  }

  // Slow lane: the price feed, for pools the chain reader can't price and as a backup when the node is down.
  async riskFeed() {
    const now = Date.now();
    if (this.riskBusy || !this.positions.length) return;
    this.riskBusy = true;
    try {
      const live = await feeds.dexTokens(this.positions.map((p) => p.mint));
      for (const p of [...this.positions]) {
        const q = live.get(p.mint);
        if (q && q.quote === feeds.SOL && q.quoteUsd > 1) this.solUsd = q.quoteUsd;
        if (q && q.img && !p.img) p.img = q.img;
        if (p.chain && now - p.chainOkAt < 8000) continue; // the chain reader has this one
        if (!q || !q.priceUsd) {
          // The feed answered but this token is gone from it: its pool has most likely been drained.
          p.missingSince = p.missingSince || now;
          if (now - p.missingSince > 5 * 60000) this.close(p, 'liquidity gone', 0);
          continue;
        }
        p.source = 'feed';
        this.manage(p, q.priceUsd, q.liqUsd, now);
      }
      this.dirty = true;
    } finally { this.riskBusy = false; }
  }

  // The exit rules, applied to one position at one price.
  manage(p, priceUsd, liqUsd, now) {
    const cfg = this.config;
    p.missingSince = 0;
    if (p.stopMove < 0) p.stopMove = -cfg.stopPct; // follow a changed setting until the stop has moved up
    p.price = priceUsd; p.liq = liqUsd;
    p.value = p.tokens * p.price;
    p.pnlUsd = p.realized + p.value - p.size; p.pnlPct = (p.pnlUsd / p.size) * 100;
    if (p.price > p.peak) p.peak = p.price;
    const move = (p.price / p.basis - 1) * 100; // price move since entry, entry costs included
    p.move = move;
    if (cfg.beArmPct > 0 && p.stopMove < 0 && move >= cfg.beArmPct) {
      p.stopMove = 0;
      this.log('risk', 'info', `stop moved to entry · after ${pct(move)}`, p);
    }
    if (!p.trailing && move >= cfg.trailArmPct) {
      p.trailing = true;
      this.log('risk', 'info', `trail active · after ${pct(move)}`, p);
    }
    if (cfg.tpPct > 0 && !p.tookProfit && move >= cfg.tpPct) this.takeProfit(p, move);
    const held = now - p.openedAt;
    if (move <= p.stopMove) this.close(p, p.stopMove < 0 ? 'stop hit' : 'stopped at entry');
    else if (p.trailing && p.price <= p.peak * (1 - cfg.trailDistPct / 100)) this.close(p, 'trail → sold');
    else if (cfg.staleMin > 0 && !p.trailing && !p.tookProfit && held > cfg.staleMin * 60000) this.close(p, 'going nowhere');
    else if (cfg.maxHoldHours > 0 && held > cfg.maxHoldHours * 3600000) this.close(p, 'time limit');
  }

  // What selling `tokens` would bring in right now, after fee, slippage and our own price impact.
  proceedsFor(p, tokens) {
    const cfg = this.config;
    const gross = tokens * p.price;
    const impact = Math.min(0.95, p.liq > 0 ? gross / (p.liq / 2) : 0.95);
    return gross * Math.max(0, 1 - impact - cfg.slipPct / 100) * (1 - cfg.feePct / 100);
  }

  // Bank part of a winner; the rest keeps running behind the trailing stop.
  takeProfit(p, move) {
    const part = this.config.tpSellPct / 100;
    const sold = p.tokens * part;
    const got = this.proceedsFor(p, sold);
    p.tokens -= sold; p.realized += got; p.tookProfit = true;
    p.value = p.tokens * p.price;
    p.pnlUsd = p.realized + p.value - p.size; p.pnlPct = (p.pnlUsd / p.size) * 100;
    this.cash += got;
    this.log('risk', 'win', `took profit · sold ${this.config.tpSellPct}% at ${pct(move)} · banked ${money(got)}`, p, { usd: got });
    this.sample();
  }

  // Sell everything left at the price the market shows now.
  // A stop is a trigger, not a guaranteed price: if the token gapped down, the loss is bigger than the stop.
  close(p, reason, forcedValue) {
    const proceeds = p.realized + (forcedValue !== undefined ? forcedValue : this.proceedsFor(p, p.tokens));
    const pnlUsd = proceeds - p.size;
    const pnlPct = (proceeds / p.size - 1) * 100;
    this.positions = this.positions.filter((x) => x !== p);
    this.cash += proceeds - p.realized;
    if (pnlUsd >= 0) this.counters.wins++; else this.counters.losses++;
    this.trades.push({
      id: p.id, mint: p.mint, sym: p.sym, name: p.name, img: p.img, openedAt: p.openedAt, closedAt: Date.now(),
      size: p.size, proceeds, pnlUsd, pnlPct, reason, entryPrice: p.entryPrice, exitPrice: p.price, score: p.score,
      tookProfit: p.tookProfit, source: p.source,
    });
    if (this.trades.length > 2000) this.trades.splice(0, 200);
    this.log('risk', pnlUsd >= 0 ? 'win' : 'loss', `${reason} · ${pct(pnlPct)} · ${signed(pnlUsd)}`, p, { usd: pnlUsd });
    this.sample();
  }

  closeManual(id) {
    const p = this.positions.find((x) => x.id === id);
    if (!p) return false;
    this.close(p, 'closed by you');
    return true;
  }

  // ---------- reporting ----------
  sample() {
    const v = this.equity();
    this.curve.push({ t: Date.now(), v });
    if (this.curve.length > 6000) this.curve = this.curve.filter((_, i) => i % 2 === 0 || i > 5000);
    this.dirty = true;
  }

  snapshot() {
    const eq = this.equity();
    const step = Math.max(1, Math.ceil(this.curve.length / 500));
    const curve = this.curve.filter((_, i) => i % step === 0 || i === this.curve.length - 1).map((p) => [p.t, +p.v.toFixed(2)]);
    curve.push([Date.now(), +eq.toFixed(2)]);
    const pnls = this.trades.map((t) => t.pnlUsd);
    return {
      running: this.running, startedAt: this.startedAt, now: Date.now(),
      equity: eq, cash: this.cash, startBalance: this.startBalance,
      counters: this.counters, why: this.why, reasons: REASONS, agents: this.agents,
      positions: this.positions, trades: this.trades.slice(-200).reverse(),
      best: pnls.length ? Math.max(...pnls) : null, worst: pnls.length ? Math.min(...pnls) : null,
      curve, config: this.config, aiKeySet: !!this.aiKey(), aiOn: this.aiOn(),
      feeds: Object.fromEntries(Object.entries(feeds.health).filter(([k]) => k !== 'ai' || this.config.aiAnalyst)),
      queue: { safety: this.rugQueue.length, secondLook: this.secondLook.length },
    };
  }

  backlog() {
    return [...this.logs.slice(-500), ...this.noise.slice(-300)].sort((a, b) => a.id - b.id);
  }

  tokenSheet(mint) {
    const ev = this.evals.get(mint) || null;
    const position = this.positions.find((p) => p.mint === mint) || null;
    const trades = this.trades.filter((t) => t.mint === mint);
    return { mint, ev, position, trades };
  }
}

module.exports = { Desk, DEFAULT_CONFIG };
