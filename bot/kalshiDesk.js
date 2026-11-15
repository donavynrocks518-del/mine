'use strict';
// The Kalshi weather desk: six agents trading daily-high-temperature contracts with pretend money.
//   Scout -> Filter -> Analyst -> Executor -> Risk, with Logger recording everything.
// Completely separate from the memecoin desk: its own account, settings, log and data folder.

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const feeds = require('./kalshiFeeds');

const DEFAULT_CONFIG = {
  startBalance: 280, // pretend dollars; applied on reset
  maxStakePct: 4, // max share of the account on one contract
  maxCityDayPct: 10, // max share of the account on one city's day
  minEdge: 0.06, // only trade when our fair price beats the cost by this much per contract, after fees
  modelWeight: 0.5, // how much to trust the forecast model vs the market price (0 = market only, 1 = model only)
  sigmaToday: 2.0, // forecast uncertainty in °F for today's high
  sigmaTomorrow: 3.0, // and for tomorrow's
  minVol24: 200, // filter: contracts traded in the last 24 hours
  maxSpread: 0.06, // filter: gap between best bid and best ask
  minPrice: 0.03, // filter: skip contracts priced under this...
  maxPrice: 0.97, // ...or over this
  closeBufferMin: 30, // stop opening trades this close to the market closing
  exitEdge: 0.05, // sell early when the bid beats our fair price by this much
  feeRate: 0.07, // Kalshi's fee: rate x contracts x price x (1 - price), rounded up to the cent
};

const LIMITS = {
  startBalance: [10, 1e7], maxStakePct: [0.5, 50], maxCityDayPct: [1, 100], minEdge: [0, 0.5], modelWeight: [0, 1],
  sigmaToday: [0.5, 10], sigmaTomorrow: [0.5, 15], minVol24: [0, 1e7], maxSpread: [0.01, 0.5],
  minPrice: [0.01, 0.5], maxPrice: [0.5, 0.99], closeBufferMin: [0, 1440], exitEdge: [0, 0.5], feeRate: [0, 0.2],
};

const REASONS = {
  thin: 'Too little trading',
  spread: 'Bid/ask gap too wide',
  extreme: 'Price too close to 0¢ or $1',
  closing: 'Market closing soon',
  noForecast: 'No forecast for that day',
  edge: 'No edge after fees',
};

const money = (n) => `$${Math.abs(n) >= 1000 ? Math.round(n).toLocaleString('en-US') : n.toFixed(2)}`;
const signed = (n) => `${n >= 0 ? '+' : '−'}${money(Math.abs(n))}`;
const cents = (p) => `${Math.round(p * 100)}¢`;
const fee = (rate, qty, price) => (qty > 0 ? Math.ceil(rate * qty * price * (1 - price) * 100 - 1e-9) / 100 : 0);

// Standard normal cumulative distribution.
function phi(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-x * x / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x > 0 ? 1 - p : p;
}

class KalshiDesk extends EventEmitter {
  constructor(dataDir) {
    super();
    this.dataDir = dataDir;
    this.stateFile = path.join(dataDir, 'state.json');
    this.logFile = path.join(dataDir, 'log.jsonl');
    fs.mkdirSync(dataDir, { recursive: true });
    this.config = { ...DEFAULT_CONFIG };
    this.fresh();
    this.load();
    this.timers = [];
    this.weather = {}; // cityId -> { highs, issued, obs, at }
    this.markets = new Map(); // ticker -> latest market snapshot
    this.busy = {};
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
    this.counters = { scanned: 0, killed: 0, scored: 0, traded: 0, wins: 0, losses: 0, reasons: 0, fees: 0 };
    this.why = Object.fromEntries(Object.keys(REASONS).map((k) => [k, 0]));
    this.agents = {};
    this.logs = [];
    this.logSeq = 0;
    this.posSeq = 0;
    this.evals = {}; // ticker -> latest check sheet
    this.calib = { pending: {}, done: [] }; // forecast-vs-market scoring, settled one by one
    this.lastKill = {}; // ticker -> reason, so a repeat kill isn't logged every scan
  }

  load() {
    try {
      const s = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      this.config = this.cleanConfig({ ...DEFAULT_CONFIG, ...s.config });
      for (const k of ['running', 'startedAt', 'cash', 'startBalance', 'positions', 'trades', 'curve', 'agents', 'logs', 'logSeq', 'posSeq', 'evals', 'calib', 'lastKill']) {
        if (s[k] !== undefined) this[k] = s[k];
      }
      Object.assign(this.counters, s.counters);
      Object.assign(this.why, s.why);
    } catch { /* first run */ }
  }

  save() {
    if (!this.dirty) return;
    this.dirty = false;
    // Keep the check sheets small: only markets that still matter.
    const keep = new Set([...this.markets.keys(), ...this.positions.map((p) => p.ticker)]);
    const evals = Object.fromEntries(Object.entries(this.evals).filter(([k]) => keep.has(k)));
    const s = {
      config: this.config, running: this.running, startedAt: this.startedAt, cash: this.cash, startBalance: this.startBalance,
      positions: this.positions, trades: this.trades, curve: this.curve, counters: this.counters, why: this.why,
      agents: this.agents, logs: this.logs.slice(-1500), logSeq: this.logSeq, posSeq: this.posSeq, evals,
      calib: { pending: this.calib.pending, done: this.calib.done.slice(-3000) }, lastKill: this.lastKill,
    };
    try {
      fs.writeFileSync(`${this.stateFile}.tmp`, JSON.stringify(s));
      fs.renameSync(`${this.stateFile}.tmp`, this.stateFile);
    } catch (e) { console.error('Could not save Kalshi state:', e.message); }
  }

  cleanConfig(c) {
    const out = { ...this.config };
    for (const [k, [lo, hi]] of Object.entries(LIMITS)) {
      const v = Number(c[k]);
      if (Number.isFinite(v)) out[k] = Math.max(lo, Math.min(hi, v));
    }
    return out;
  }

  log(agent, kind, text, m, extra = {}) {
    const row = { id: ++this.logSeq, t: Date.now(), agent, kind, text, sym: m ? `${m.city} ${m.title}` : null, mint: m?.ticker || null, ...extra };
    this.logs.push(row);
    if (this.logs.length > 2500) this.logs.splice(0, 300);
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
    const every = (ms, name, fn) => {
      const run = () => {
        if (this.busy[name]) return;
        this.busy[name] = true;
        Promise.resolve().then(fn).catch(() => {}).finally(() => { this.busy[name] = false; });
      };
      this.timers.push(setInterval(run, ms));
      setTimeout(run, 1500);
    };
    every(20 * 60000, 'forecasts', () => this.refreshForecasts());
    every(10 * 60000, 'obs', () => this.refreshObservations());
    every(3 * 60000, 'scout', () => this.scout());
    every(60000, 'risk', () => this.risk());
    every(10 * 60000, 'settle', () => this.settle());
    this.timers.push(setInterval(() => this.sample(), 60000));
    this.timers.push(setInterval(() => this.save(), 10000));
  }

  stop() {
    this.timers.forEach(clearInterval);
    this.dirty = true;
    this.save();
  }

  setRunning(on) {
    if (this.running === on) return;
    this.running = on;
    this.log('logger', 'info', on ? 'Desk resumed' : 'Desk paused · no new trades; open contracts still settle');
  }

  reset() {
    this.fresh();
    try { fs.renameSync(this.logFile, path.join(this.dataDir, `log-${Date.now()}.jsonl`)); } catch { /* no log yet */ }
    this.log('logger', 'info', `Account reset to ${money(this.cash)} of paper money`);
    this.dirty = true;
    this.save();
  }

  setConfig(patch) {
    this.config = this.cleanConfig(patch);
    this.log('logger', 'info', 'Settings changed');
  }

  // ---------- weather ----------
  async refreshForecasts() {
    for (const c of feeds.CITIES) {
      try {
        const f = await feeds.forecastHighs(c.station);
        const { tz } = await feeds.station(c.station);
        this.weather[c.id] = { ...(this.weather[c.id] || {}), tz, highs: f.highs, issued: f.issued, at: Date.now() };
      } catch { /* keep the last forecast; health shows the error */ }
    }
  }

  async refreshObservations() {
    for (const c of feeds.CITIES) {
      try {
        const o = await feeds.observedToday(c.station);
        this.weather[c.id] = { ...(this.weather[c.id] || {}), obs: o };
      } catch { /* keep the last reading */ }
    }
  }

  // ---------- Analyst's model ----------
  // The day's official high T (whole °F) = max(what's already been observed, the rest of the day).
  // The rest of the day ~ Normal(mu, sigma). P(T <= x) = 0 below the observed max, else Phi((x + 0.5 - mu) / sigma).
  model(m) {
    const w = this.weather[m.cityId];
    const fc = w?.highs?.[m.date];
    if (fc == null || !w.tz) return null;
    const today = feeds.localParts(Date.now(), w.tz).date;
    const isToday = m.date === today;
    const cfg = this.config;
    let mu = fc; let sigma = isToday ? cfg.sigmaToday : cfg.sigmaTomorrow; let floorObs = -Infinity; let note = '';
    if (isToday && w.obs && w.obs.date === today && w.obs.max != null) {
      floorObs = Math.floor(w.obs.max); // hourly readings can miss the true peak, so this is a floor
      const hour = feeds.localParts(Date.now(), w.tz).hour;
      if (hour >= 16 && w.obs.latest != null) {
        // Late in the day the rest of the day is cooling: it won't top the current reading by much.
        mu = Math.min(fc, w.obs.latest + 1); sigma = Math.min(sigma, 1.2);
        note = `late in the day: rest of day ≈ ${w.obs.latest.toFixed(0)}°F now`;
      }
    }
    if (!isToday && m.date < today) return null; // the day has passed; waiting for settlement
    const cdf = (x) => (x < floorObs ? 0 : phi((x + 0.5 - mu) / sigma));
    let p;
    if (m.strikeType === 'between') p = cdf(m.cap) - cdf(m.floor - 1);
    else if (m.strikeType === 'greater') p = 1 - cdf(m.floor);
    else if (m.strikeType === 'less') p = cdf(m.cap - 1);
    else return null;
    return { p: Math.max(0.005, Math.min(0.995, p)), fc, mu, sigma, obsMax: floorObs > -Infinity ? w.obs.max : null, isToday, note };
  }

  // ---------- Scout + Filter + Analyst ----------
  async scout() {
    if (!this.weather.nyc) await this.refreshForecasts();
    for (const city of feeds.CITIES) {
      let list;
      try { list = await feeds.openMarkets(city); } catch { continue; }
      this.agents.scout = { text: `${list.length} contracts open in ${city.name}`, kind: 'info', t: Date.now() };
      for (const m of list) {
        if (!this.markets.has(m.ticker)) this.counters.scanned++;
        this.markets.set(m.ticker, m);
        this.consider(m);
      }
      this.dirty = true;
    }
    // Forget markets that are no longer open.
    for (const [k, m] of this.markets) if (m.closeTime && m.closeTime < Date.now() - 3600000) this.markets.delete(k);
  }

  sheet(m) {
    const ev = { t: Date.now(), m, checks: [], model: null, outcome: 'checking', reason: null };
    this.evals[m.ticker] = ev;
    return ev;
  }

  kill(ev, reason, detail) {
    ev.outcome = 'killed'; ev.reason = reason;
    if (this.lastKill[ev.m.ticker] === reason) return; // same verdict as last scan: don't repeat it
    this.lastKill[ev.m.ticker] = reason;
    this.counters.killed++;
    this.why[reason]++;
    this.log(reason === 'edge' ? 'analyst' : 'filter', 'kill', detail, ev.m, { reason });
  }

  consider(m) {
    const cfg = this.config;
    const ev = this.sheet(m);
    const spread = m.yesAsk - m.yesBid;
    const mid = (m.yesAsk + m.yesBid) / 2;
    const minsLeft = (m.closeTime - Date.now()) / 60000;
    const checks = [
      ['thin', `Traded ≥ ${cfg.minVol24} contracts in 24h`, m.vol24 >= cfg.minVol24, `${Math.round(m.vol24)}`, `only ${Math.round(m.vol24)} contracts traded in 24h`],
      ['spread', `Bid/ask gap ≤ ${cents(cfg.maxSpread)}`, spread <= cfg.maxSpread + 1e-9, `${cents(m.yesBid)} / ${cents(m.yesAsk)}`, `gap ${cents(spread)} (${cents(m.yesBid)} bid / ${cents(m.yesAsk)} ask)`],
      ['extreme', `Price between ${cents(cfg.minPrice)} and ${cents(cfg.maxPrice)}`, mid >= cfg.minPrice && mid <= cfg.maxPrice, cents(mid), `priced at ${cents(mid)}`],
      ['closing', `More than ${cfg.closeBufferMin} min until close`, minsLeft > cfg.closeBufferMin, `${Math.round(minsLeft)} min`, `closes in ${Math.round(minsLeft)} min`],
    ];
    for (const [key, label, pass, value, why] of checks) {
      ev.checks.push({ key, label, pass, value });
      if (!pass) return this.kill(ev, key, why);
    }
    const mod = this.model(m);
    ev.checks.push({ key: 'noForecast', label: 'Forecast available for that day', pass: !!mod, value: mod ? `${mod.fc.toFixed(0)}°F` : 'none' });
    if (!mod) return this.kill(ev, 'noForecast', `no forecast for ${m.date}`);
    this.counters.scored++;
    const fair = cfg.modelWeight * mod.p + (1 - cfg.modelWeight) * mid;
    const yesEdge = fair - m.yesAsk - fee(cfg.feeRate, 1, m.yesAsk);
    const noEdge = (1 - fair) - m.noAsk - fee(cfg.feeRate, 1, m.noAsk);
    const side = yesEdge >= noEdge ? 'yes' : 'no';
    const edge = Math.max(yesEdge, noEdge);
    ev.model = { ...mod, mid, fair, yesEdge, noEdge, side, edge };
    // Remember both opinions so they can be scored against the real outcome later.
    this.calib.pending[m.ticker] = { model: mod.p, market: mid, fair, date: m.date, city: m.city, title: m.title, t: Date.now() };
    if (this.positions.some((p) => p.ticker === m.ticker)) { ev.outcome = 'holding'; return; }
    const pass = edge >= cfg.minEdge;
    ev.checks.push({ key: 'edge', label: `Edge after fees ≥ ${cents(cfg.minEdge)}`, pass, value: `${side.toUpperCase()} ${edge >= 0 ? '+' : '−'}${cents(Math.abs(edge))}` });
    if (!pass) return this.kill(ev, 'edge', `model ${Math.round(mod.p * 100)}% vs market ${Math.round(mid * 100)}% · best edge ${edge >= 0 ? '+' : '−'}${cents(Math.abs(edge))}`);
    delete this.lastKill[m.ticker];
    this.log('analyst', 'pass', `${side.toUpperCase()} looks cheap · fair ${Math.round(fair * 100)}% vs ${cents(side === 'yes' ? m.yesAsk : m.noAsk)} · edge +${cents(edge)}`, m);
    this.execute(ev).catch(() => {});
  }

  // ---------- Executor ----------
  equity() {
    return this.cash + this.positions.reduce((s, p) => s + p.value, 0);
  }

  skip(ev, why) {
    ev.outcome = 'skipped'; ev.reason = why;
    if (this.lastKill[ev.m.ticker] === `skip:${why}`) return;
    this.lastKill[ev.m.ticker] = `skip:${why}`;
    this.log('executor', 'info', `skipped · ${why}`, ev.m);
  }

  async execute(ev) {
    const cfg = this.config; const m = ev.m; const side = ev.model.side;
    if (!this.running) return this.skip(ev, 'desk is paused');
    if (this.positions.some((p) => p.ticker === m.ticker)) return this.skip(ev, 'already holding this contract');
    const eq = this.equity();
    const cityDay = this.positions.filter((p) => p.event === m.event).reduce((s, p) => s + p.cost, 0);
    let budget = Math.min(eq * cfg.maxStakePct / 100, eq * cfg.maxCityDayPct / 100 - cityDay, this.cash);
    if (budget < 1) return this.skip(ev, cityDay > 0 ? `already ${money(cityDay)} on ${m.city} that day` : 'not enough free cash');
    // Walk the real order book, buying only at prices that still clear the edge bar.
    let book;
    try { book = await feeds.orderbook(m.ticker); } catch { return this.skip(ev, 'order book unavailable'); }
    const fairSide = side === 'yes' ? ev.model.fair : 1 - ev.model.fair;
    let qty = 0; let spent = 0;
    for (const [price, avail] of side === 'yes' ? book.yesAsks : book.noAsks) {
      if (fairSide - price - fee(cfg.feeRate, 1, price) < cfg.minEdge) break;
      const take = Math.min(avail, Math.floor((budget - spent) / (price * (1 + cfg.feeRate * (1 - price))) ));
      if (take <= 0) break;
      qty += take; spent += take * price;
    }
    qty = Math.floor(qty);
    if (qty < 1) return this.skip(ev, 'price moved; no edge left in the order book');
    const avg = spent / qty;
    const f = fee(cfg.feeRate, qty, avg);
    const cost = spent + f;
    this.cash -= cost;
    this.counters.fees += f;
    const pos = {
      id: ++this.posSeq, ticker: m.ticker, event: m.event, city: m.city, cityId: m.cityId, date: m.date, title: m.title,
      side, qty, avg, cost, fees: f, openedAt: Date.now(), fair: fairSide, modelP: ev.model.p, mark: avg, value: qty * avg, pnl: -f,
    };
    this.positions.push(pos);
    this.counters.traded++;
    ev.outcome = 'bought';
    this.log('executor', 'buy', `bought ${qty} ${side.toUpperCase()} at ${cents(avg)} · ${money(cost)} incl. ${money(f)} fee`, m, { usd: cost });
    this.sample();
  }

  // ---------- Risk ----------
  // Marks positions at the price we could sell for now, and sells early when the market overpays.
  async risk() {
    const cfg = this.config;
    for (const p of [...this.positions]) {
      const m = this.markets.get(p.ticker);
      if (!m) continue;
      const bid = p.side === 'yes' ? m.yesBid : m.noBid;
      p.mark = bid; p.value = p.qty * bid; p.pnl = p.value - p.cost;
      const mod = this.model(m);
      if (mod) {
        const mid = (m.yesAsk + m.yesBid) / 2;
        const fair = cfg.modelWeight * mod.p + (1 - cfg.modelWeight) * mid;
        p.fair = p.side === 'yes' ? fair : 1 - fair;
      }
      const sellFee = fee(cfg.feeRate, p.qty, bid);
      if (this.running && bid > 0 && bid - sellFee / p.qty >= p.fair + cfg.exitEdge && Date.now() < m.closeTime) {
        this.close(p, bid * p.qty - sellFee, `sold early at ${cents(bid)} · market paid more than it's worth`, sellFee);
      }
    }
    this.dirty = true;
  }

  close(p, proceeds, reason, sellFee = 0) {
    this.positions = this.positions.filter((x) => x !== p);
    this.cash += proceeds;
    this.counters.fees += sellFee;
    const pnl = proceeds - p.cost;
    if (pnl >= 0) this.counters.wins++; else this.counters.losses++;
    this.trades.push({ ...p, closedAt: Date.now(), proceeds, pnlUsd: pnl, pnlPct: (pnl / p.cost) * 100, reason });
    if (this.trades.length > 2000) this.trades.splice(0, 200);
    this.log('risk', pnl >= 0 ? 'win' : 'loss', `${reason} · ${signed(pnl)}`, p, { usd: pnl });
    this.sample();
  }

  closeManual(id) {
    const p = this.positions.find((x) => x.id === id);
    if (!p) return false;
    const m = this.markets.get(p.ticker);
    const bid = m ? (p.side === 'yes' ? m.yesBid : m.noBid) : 0;
    const sellFee = fee(this.config.feeRate, p.qty, bid);
    this.close(p, Math.max(0, bid * p.qty - sellFee), `closed by you at ${cents(bid)}`, sellFee);
    return true;
  }

  // Pays out settled contracts, and scores the model against the market on every settled contract it looked at.
  async settle() {
    for (const city of feeds.CITIES) {
      if (!this.positions.some((p) => p.cityId === city.id) && !Object.values(this.calib.pending).some((x) => x.city === city.name)) continue;
      let settled;
      try { settled = await feeds.settledMarkets(city); } catch { continue; }
      for (const m of settled) {
        if (m.result !== 'yes' && m.result !== 'no') continue;
        for (const p of this.positions.filter((x) => x.ticker === m.ticker)) {
          const won = p.side === m.result;
          this.close(p, won ? p.qty : 0, won ? 'settled · won' : 'settled · lost');
        }
        const c = this.calib.pending[m.ticker];
        if (c) {
          const y = m.result === 'yes' ? 1 : 0;
          this.calib.done.push({ ...c, outcome: y, settledAt: Date.now() });
          delete this.calib.pending[m.ticker];
        }
      }
    }
    this.dirty = true;
  }

  // ---------- reporting ----------
  sample() {
    this.curve.push({ t: Date.now(), v: this.equity() });
    if (this.curve.length > 6000) this.curve = this.curve.filter((_, i) => i % 2 === 0 || i > 5000);
    this.dirty = true;
  }

  // Brier score: average squared gap between the stated probability and what happened. Lower is better.
  scorecard() {
    const d = this.calib.done;
    if (!d.length) return { n: 0 };
    const brier = (k) => d.reduce((s, x) => s + (x[k] - x.outcome) ** 2, 0) / d.length;
    return { n: d.length, model: brier('model'), market: brier('market'), blend: brier('fair') };
  }

  snapshot() {
    const eq = this.equity();
    const step = Math.max(1, Math.ceil(this.curve.length / 500));
    const curve = this.curve.filter((_, i) => i % step === 0 || i === this.curve.length - 1).map((p) => [p.t, +p.v.toFixed(2)]);
    curve.push([Date.now(), +eq.toFixed(2)]);
    const pnls = this.trades.map((t) => t.pnlUsd);
    const weather = Object.fromEntries(feeds.CITIES.map((c) => {
      const w = this.weather[c.id] || {};
      return [c.id, { name: c.name, station: c.station, highs: w.highs || {}, obsMax: w.obs?.max ?? null, latest: w.obs?.latest ?? null }];
    }));
    return {
      kind: 'kalshi', running: this.running, startedAt: this.startedAt, now: Date.now(),
      equity: eq, cash: this.cash, startBalance: this.startBalance, counters: this.counters, why: this.why, reasons: REASONS,
      agents: this.agents, positions: this.positions, trades: this.trades.slice(-200).reverse(),
      best: pnls.length ? Math.max(...pnls) : null, worst: pnls.length ? Math.min(...pnls) : null,
      curve, config: this.config, feeds: feeds.health, weather, scorecard: this.scorecard(),
      watching: this.markets.size, pendingScores: Object.keys(this.calib.pending).length,
    };
  }

  backlog() {
    return this.logs.slice(-600);
  }

  tokenSheet(ticker) {
    return {
      mint: ticker, ev: this.evals[ticker] || null,
      position: this.positions.find((p) => p.ticker === ticker) || null,
      trades: this.trades.filter((t) => t.ticker === ticker),
    };
  }
}

module.exports = { KalshiDesk, DEFAULT_CONFIG };
