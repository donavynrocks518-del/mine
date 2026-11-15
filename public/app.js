'use strict';
/* Paper Desk dashboard. Talks only to the bot running on this computer. */

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const usd = (n) => `$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const sUsd = (n) => `${n >= 0 ? '+' : '−'}${usd(n)}`;
const sPct = (n) => `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(1)}%`;
const kUsd = (n) => (n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `$${Math.round(n / 1000)}k` : `$${Math.round(n)}`);
const count = (n) => (n >= 10000 ? `${(n / 1000).toFixed(1)}k` : n.toLocaleString('en-US'));
const clock = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
const cls = (n) => (n >= 0 ? 'up' : 'down');
function price(p) {
  if (!p) return '–';
  if (p >= 1) return `$${p.toFixed(3)}`;
  const zeros = Math.max(0, -Math.floor(Math.log10(p)) - 1);
  return `$${p.toFixed(Math.min(12, zeros + 4))}`;
}
function ago(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'under 1m';
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
function tok(x) {
  const img = x.img && /^https:\/\//.test(x.img)
    ? `<img src="${esc(x.img)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
    : `<span class="ph">${esc((x.sym || '?')[0])}</span>`;
  return `<span class="tok">${img}$${esc(x.sym)}</span>`;
}

const AGENTS = [
  ['scout', 'Scout', 'new pairs', 'S'],
  ['filter', 'Filter', 'rug checks', 'F'],
  ['analyst', 'Analyst', 'scores survivors', 'A'],
  ['executor', 'Executor', 'places paper trades', 'E'],
  ['risk', 'Risk', 'stops and trails', 'R'],
  ['logger', 'Logger', 'reason for all', 'L'],
];
const FIELDS = [
  ['Account'],
  ['startBalance', 'Starting balance', '$', 1],
  ['maxSizePct', 'Max size per trade', '% of account', 0.5],
  ['maxOpen', 'Max open positions', '', 1],
  ['cooldownMin', 'Wait before re-buying a token', 'min', 5],
  ['Risk'],
  ['stopPct', 'Hard stop', '% loss', 0.5],
  ['trailArmPct', 'Trailing stop starts at', '% gain', 1],
  ['trailDistPct', 'Trailing stop distance', '% below peak', 0.5],
  ['beArmPct', 'Move stop to entry at (0 = off)', '% gain', 1],
  ['tpPct', 'Take profit at (0 = off)', '% gain', 1],
  ['tpSellPct', 'Take profit sells', '% of position', 5],
  ['staleMin', 'Close if going nowhere after (0 = off)', 'min', 5],
  ['maxHoldHours', 'Max hold time (0 = none)', 'hours', 0.5],
  ['Filter'],
  ['minVolH1', 'Min volume, last hour', '$', 1000],
  ['minLiq', 'Min pool liquidity', '$', 1000],
  ['maxTop10Pct', 'Max top 10 holders', '%', 1],
  ['minLpLockedPct', 'Min LP locked', '%', 1],
  ['minScore', 'Analyst pass mark', '0 to 1', 0.01],
  ['Fill realism'],
  ['feePct', 'Swap fee per side', '%', 0.05],
  ['slipPct', 'Extra slippage per side', '%', 0.1],
  ['maxPoolPct', 'Max share of a pool', '%', 0.1],
  ['AI Analyst'],
  ['aiAnalyst', 'Ask Claude for a verdict on every token that passes the filters', 'bool'],
  ['aiKey', 'Anthropic API key (from console.anthropic.com, stays on this computer)', 'secret'],
  ['aiModel', 'Model', 'model'],
  ['Speed'],
  ['rpcUrl', 'Private Solana node address (optional, blank = free public node)', 'text'],
];

let snap = null;
let logs = [];
const filter = { agent: 'all', reason: null, text: '', noise: false };
let logDirty = false;

// ---------- actions ----------
async function post(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await res.json();
  if (res.ok) render(j);
  return res.ok;
}

$('toggle').onclick = () => snap && post('/api/control', { action: snap.running ? 'pause' : 'start' });
$('reset').onclick = () => {
  if (!snap) return;
  const open = snap.positions.length;
  const msg = `Reset the paper account to $${snap.config.startBalance}?\n\nThis clears ${open} open position${open === 1 ? '' : 's'}, all closed trades and the equity history. It cannot be undone.`;
  if (confirm(msg)) { logs = []; post('/api/control', { action: 'reset' }); }
};
$('openSettings').onclick = () => {
  if (!snap) return;
  $('fields').innerHTML = FIELDS.map((f) => (f.length === 1
    ? `<h3>${f[0]}</h3>`
    : f[2] === 'bool'
      ? `<div class="field wide"><label class="check big"><input id="f_${f[0]}" name="${f[0]}" type="checkbox" ${snap.config[f[0]] ? 'checked' : ''}> ${f[1]}</label></div>`
    : f[2] === 'secret'
      ? `<div class="field wide"><label for="f_${f[0]}">${f[1]}</label><div class="in"><input id="f_${f[0]}" name="${f[0]}" type="password" placeholder="${snap.aiKeySet ? 'A key is saved. Leave blank to keep it.' : 'sk-ant-…'}" autocomplete="off"></div></div>`
    : f[2] === 'model'
      ? `<div class="field wide"><label for="f_${f[0]}">${f[1]}</label><div class="in"><input id="f_${f[0]}" name="${f[0]}" type="text" value="${esc(snap.config[f[0]])}" autocomplete="off" spellcheck="false"></div></div>`
    : f[2] === 'text'
      ? `<div class="field wide"><label for="f_${f[0]}">${f[1]}</label><div class="in"><input id="f_${f[0]}" name="${f[0]}" type="url" placeholder="https://…" value="${esc(snap.config[f[0]])}" autocomplete="off"></div></div>`
      : `<div class="field"><label for="f_${f[0]}">${f[1]}</label><div class="in"><input id="f_${f[0]}" name="${f[0]}" type="number" step="any" min="0" value="${snap.config[f[0]]}" required>${f[2] ? `<span class="unit">${f[2]}</span>` : ''}</div></div>`)).join('');
  $('settings').showModal();
};
$('settings').addEventListener('close', () => {
  if ($('settings').returnValue !== 'save') return;
  const body = {};
  new FormData($('settingsForm')).forEach((v, k) => { body[k] = ['rpcUrl', 'aiKey', 'aiModel'].includes(k) ? v : Number(v); });
  body.aiAnalyst = $('f_aiAnalyst').checked;
  if (body.aiAnalyst && !body.aiKey && !snap.aiKeySet) alert('The AI Analyst needs an API key. It stays off until you add one in Settings.');
  post('/api/config', body);
});

// ---------- render ----------
function render(s) {
  snap = s;
  const st = $('status');
  st.className = `status ${s.running ? 'live' : 'paused'}`;
  st.lastElementChild.textContent = s.running ? 'Live · scanning' : 'Paused';
  $('toggle').textContent = s.running ? 'Pause' : 'Resume';
  $('toggle').classList.toggle('resume', !s.running);

  $('feeds').innerHTML = Object.values(s.feeds).map((f) => {
    const state = f.ok === null ? '' : f.ok ? 'ok' : 'bad';
    const tip = f.ok === false ? `${f.name} error: ${f.error}` : `${f.name} · ${f.role} · ${f.calls} calls`;
    return `<span class="feed ${state}" title="${esc(tip)}"><i></i>${esc(f.name)}${f.ok === false ? ` · ${esc(f.error)}` : ''}</span>`;
  }).join('');

  // equity
  const pnl = s.equity - s.startBalance;
  const whole = Math.floor(s.equity);
  $('equity').innerHTML = `$${whole.toLocaleString('en-US')}<small>.${String(Math.round((s.equity - whole) * 100) % 100).padStart(2, '0')}</small>`;
  $('delta').textContent = `${sUsd(pnl)} (${sPct((pnl / s.startBalance) * 100)})`;
  $('delta').className = `delta ${cls(pnl)}`;
  $('mult').textContent = `${(s.equity / s.startBalance).toFixed(2)}×`;
  $('mult').className = `mult ${cls(pnl)}`;
  $('since').textContent = `${usd(s.startBalance)} at ${clock(s.startedAt)} · running ${ago(s.now - s.startedAt)}`;
  $('cash').textContent = usd(s.cash);
  $('invested').textContent = usd(s.equity - s.cash);
  $('wl').textContent = `${s.counters.wins}W / ${s.counters.losses}L`;
  $('bw').innerHTML = s.best === null ? '–' : `<span class="${cls(s.best)}">${sUsd(s.best)}</span> / <span class="${cls(s.worst)}">${sUsd(s.worst)}</span>`;
  drawChart(s.curve, s.startBalance);

  // desk
  const c = s.counters;
  const pills = {
    scout: `${count(c.scanned)} pairs`,
    filter: `${count(c.killed)} · ${c.scanned ? Math.round((c.killed / c.scanned) * 100) : 0}%`,
    analyst: s.aiOn ? `${count(c.scored)} scored · ${count(c.aiCalls)} by AI` : `${count(c.scored)} scored`,
    executor: `size ≤ ${s.config.maxSizePct}%`,
    risk: `−${s.config.stopPct}% · trail +${s.config.trailArmPct}%`,
    logger: `${count(c.reasons)} reasons`,
  };
  $('deskCount').textContent = `${count(c.scanned)} scanned · ${c.traded} traded`;
  $('agents').innerHTML = AGENTS.map(([key, name, sub, letter]) => {
    const a = s.agents[key];
    const last = a ? `${a.sym ? `<span class="sym">$${esc(a.sym)}</span> ` : ''}${esc(a.text)}` : (key === 'executor' ? 'nothing passed yet' : key === 'risk' ? 'no open risk' : 'waiting…');
    const role = key === 'analyst' && s.aiOn ? 'rules, then Claude' : sub;
    return `<button type="button" class="agent a-${key} ${filter.agent === key ? 'on' : ''}" data-agent="${key}" title="Show ${name} in the log">
      <span class="ico">${letter}</span><span><b>${name}</b><span class="sub">${role}</span></span>
      <span class="last">${last}</span><span class="pill">${pills[key]}</span></button>`;
  }).join('');

  // positions
  $('posCount').textContent = `${s.positions.length} of ${s.config.maxOpen} slots`;
  $('positions').innerHTML = s.positions.length ? `<table><thead><tr>
    <th>Token</th><th class="r">Size</th><th class="r">Entry</th><th class="r">Now</th><th class="r">P&amp;L</th><th>Exit plan</th><th class="r">Held</th><th></th>
    </tr></thead><tbody>${s.positions.map((p) => {
    const stop = p.stopMove < 0 ? `stop −${s.config.stopPct}%` : 'stop at entry';
    const plan = (p.trailing
      ? `<span class="tag trail" title="Trailing stop is on: sells if the price falls to this">trail ${price(p.peak * (1 - s.config.trailDistPct / 100))}</span>`
      : `<span class="tag">${stop}</span>`)
      + (p.tookProfit ? ' <span class="tag took" title="Part of this position was already sold for a profit">profit banked</span>' : '')
      + (p.source === 'chain' ? ' <span class="tag fast" title="Price read straight from the blockchain every second">on-chain</span>' : ' <span class="tag" title="Price from the DexScreener feed every 3 seconds">feed</span>');
    return `<tr data-mint="${esc(p.mint)}"><td>${tok(p)}</td><td class="r">${usd(p.size)}</td><td class="r">${price(p.entryPrice)}</td>
      <td class="r">${price(p.price)}</td><td class="r ${cls(p.pnlUsd)}">${sPct(p.pnlPct)} · ${sUsd(p.pnlUsd)}</td>
      <td>${plan}</td><td class="r">${ago(s.now - p.openedAt)}</td>
      <td class="r"><button type="button" class="btn small" data-close="${p.id}" data-sym="${esc(p.sym)}">Close</button></td></tr>`;
  }).join('')}</tbody></table>`
    : `<div class="empty">No open positions. The Executor buys only what survives every check${s.running ? '' : ' (the desk is paused)'}.</div>`;

  // why they died
  $('killCount').textContent = `${count(c.killed)} killed`;
  const max = Math.max(1, ...Object.values(s.why));
  $('why').innerHTML = Object.entries(s.reasons).map(([key, label]) => `
    <button type="button" class="why-row ${filter.reason === key ? 'on' : ''}" data-reason="${key}" title="Show these in the log">
      <span>${esc(label)}</span><span class="n">${count(s.why[key] || 0)}</span>
      <span class="bar"><i style="width:${((s.why[key] || 0) / max) * 100}%"></i></span></button>`).join('');

  // closed trades
  const closed = c.wins + c.losses;
  $('tradeCount').textContent = closed ? `${closed} closed · ${Math.round((c.wins / closed) * 100)}% won` : '';
  $('trades').innerHTML = s.trades.length ? `<table><thead><tr>
    <th>Token</th><th class="r">Size</th><th class="r">Result</th><th>Why it closed</th><th class="r">Held</th><th class="r">Closed</th>
    </tr></thead><tbody>${s.trades.map((t) => `<tr data-mint="${esc(t.mint)}"><td>${tok(t)}</td><td class="r">${usd(t.size)}</td>
      <td class="r ${cls(t.pnlUsd)}">${sPct(t.pnlPct)} · ${sUsd(t.pnlUsd)}</td><td>${esc(t.reason)}</td>
      <td class="r">${ago(t.closedAt - t.openedAt)}</td><td class="r">${clock(t.closedAt)}</td></tr>`).join('')}</tbody></table>`
    : '<div class="empty">No closed trades yet.</div>';
}

// ---------- chart ----------
let chartPts = [];
function drawChart(curve, base) {
  const svg = $('chartSvg');
  const W = svg.clientWidth || 600; const H = svg.clientHeight || 170;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const t0 = curve[0][0]; const t1 = Math.max(curve[curve.length - 1][0], t0 + 60000);
  const vals = curve.map((p) => p[1]).concat(base);
  let lo = Math.min(...vals); let hi = Math.max(...vals);
  const pad = Math.max((hi - lo) * 0.15, base * 0.01); lo -= pad; hi += pad;
  const x = (t) => ((t - t0) / (t1 - t0)) * W;
  const y = (v) => H - ((v - lo) / (hi - lo)) * H;
  chartPts = curve.map(([t, v]) => ({ x: x(t), y: y(v), t, v }));
  const line = chartPts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('');
  const last = chartPts[chartPts.length - 1];
  const color = last.v >= base ? 'var(--green)' : 'var(--red)';
  svg.innerHTML = `
    <defs><linearGradient id="fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity=".25"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>
    <line x1="0" x2="${W}" y1="${y(base)}" y2="${y(base)}" stroke="var(--line)" stroke-dasharray="4 5"/>
    <path d="${line}L${last.x.toFixed(1)},${H}L0,${H}Z" fill="url(#fill)"/>
    <path d="${line}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>
    <circle cx="${last.x}" cy="${last.y}" r="4" fill="${color}"/>
    <line id="cross" y1="0" y2="${H}" stroke="var(--muted)" stroke-width="1" visibility="hidden"/>`;
}
$('chart').addEventListener('mousemove', (e) => {
  if (!chartPts.length) return;
  const box = $('chart').getBoundingClientRect();
  const mx = e.clientX - box.left;
  const p = chartPts.reduce((a, b) => (Math.abs(b.x - mx) < Math.abs(a.x - mx) ? b : a));
  const cross = document.getElementById('cross');
  if (cross) { cross.setAttribute('x1', p.x); cross.setAttribute('x2', p.x); cross.setAttribute('visibility', 'visible'); }
  const tip = $('tip');
  tip.hidden = false;
  tip.textContent = `${clock(p.t)} · ${usd(p.v)}`;
  tip.style.left = `${Math.max(60, Math.min(box.width - 60, p.x))}px`;
});
$('chart').addEventListener('mouseleave', () => {
  $('tip').hidden = true;
  const cross = document.getElementById('cross');
  if (cross) cross.setAttribute('visibility', 'hidden');
});

// ---------- log ----------
function renderChips() {
  $('chips').innerHTML = [['all', 'All'], ...AGENTS.map((a) => [a[0], a[1]])]
    .map(([k, n]) => `<button type="button" class="chip ${filter.agent === k ? 'on' : ''}" data-agent="${k}">${n}</button>`).join('');
  const clear = $('clearFilter');
  clear.hidden = !filter.reason;
  if (filter.reason && snap) clear.textContent = `${snap.reasons[filter.reason]} ×`;
}
function renderLog() {
  logDirty = false;
  const q = filter.text.trim().toLowerCase().replace(/^\$/, '');
  const noisy = (r) => r.reason === 'volume' || r.reason === 'liquidity';
  const rows = logs.filter((r) => {
    if (filter.reason) return r.reason === filter.reason;
    if (noisy(r) && !filter.noise && !q) return false;
    if (filter.agent !== 'all' && filter.agent !== 'logger' && r.agent !== filter.agent) return false;
    if (q && !(r.sym || '').toLowerCase().includes(q) && !(r.mint || '').toLowerCase().includes(q)) return false;
    return true;
  }).slice(-300).reverse();
  $('log').innerHTML = rows.length ? rows.map((r) => `
    <button type="button" class="row a-${r.agent} ${r.kind}" ${r.mint ? `data-mint="${esc(r.mint)}"` : 'disabled'}>
      <span class="t">${clock(r.t)}</span><span class="who">${r.agent}</span>
      <span class="msg">${r.kind === 'kill' ? 'killed ' : ''}${r.sym ? `<span class="sym">$${esc(r.sym)}</span> · ` : ''}${esc(r.text)}</span>
    </button>`).join('')
    : '<div class="empty">Nothing here yet. Decisions appear as the agents make them.</div>';
}
function queueLog() {
  if (logDirty) return;
  logDirty = true;
  requestAnimationFrame(renderLog);
}
function setFilter(patch) {
  Object.assign(filter, patch);
  if (patch.reason) $('showNoise').checked = filter.noise;
  renderChips(); renderLog();
  if (snap) render(snap);
}
$('search').addEventListener('input', (e) => setFilter({ text: e.target.value }));
$('showNoise').addEventListener('change', (e) => setFilter({ noise: e.target.checked }));
$('clearFilter').onclick = () => setFilter({ reason: null });

// ---------- token drawer ----------
async function openToken(mint) {
  const d = await (await fetch(`/api/token/${encodeURIComponent(mint)}`)).json();
  const ev = d.ev; const c = ev ? ev.cand : (d.position || d.trades[0]);
  if (!c) return;
  let verdict = '';
  if (ev) {
    const text = ev.outcome === 'bought' ? 'Passed every check. The Executor bought it.'
      : ev.outcome === 'killed' ? `Killed by the ${ev.killedBy}: ${snap.reasons[ev.reason] || ev.reason}.`
        : ev.outcome === 'skipped' ? `Passed every check, but the Executor skipped it: ${ev.reason}.`
          : 'Waiting in line for its safety report…';
    verdict = `<div class="verdict ${ev.outcome}">${esc(text)}<div class="muted">Checked at ${clock(ev.t)} · found as ${esc(ev.source)}</div></div>`;
  }
  const checks = ev && ev.checks.length ? `<h3>Checks</h3><div class="checks">${ev.checks.map((k) => `
    <div class="chk ${k.pass ? 'pass' : 'fail'}"><span class="m">${k.pass ? '✓' : '✕'}</span><span>${esc(k.label)}</span><span class="v">${esc(k.value)}</span></div>`).join('')}</div>` : '';
  const flags = (list, mark, klass) => list.map((f) => `<div class="chk ${klass}"><span class="m">${mark}</span><span>${esc(f)}</span><span></span></div>`).join('');
  const aiBlock = ev && ev.ai ? `<h3>AI Analyst · ${esc(ev.ai.verdict)} · ${ev.ai.score.toFixed(2)}</h3>
    <div class="verdict ${ev.ai.verdict === 'buy' ? 'bought' : 'killed'}">${esc(ev.ai.summary)}<div class="muted">${esc(ev.ai.model)}</div></div>
    <div class="checks" style="margin-top:8px">${flags(ev.ai.green, '+', 'pass')}${flags(ev.ai.red, '−', 'fail')}</div>` : '';
  const parts = ev && ev.parts ? `<h3>${ev.ai ? 'Rule score' : 'Analyst score'} · ${ev.score.toFixed(2)}</h3>${ev.parts.map((p) => `
    <div class="part"><div class="top-line"><span>${esc(p.label)} <span class="muted">· weight ${Math.round(p.weight * 100)}%</span></span><b>${p.value.toFixed(2)}</b></div>
    <div class="bar"><i style="width:${p.value * 100}%"></i></div><div class="note">${esc(p.note)}</div></div>`).join('')}` : '';
  const market = ev ? `<h3>Market when checked</h3><div class="kv">
    <div><span>Price</span><b>${price(c.priceUsd)}</b></div><div><span>Liquidity</span><b>${kUsd(c.liqUsd)}</b></div>
    <div><span>Volume 1h</span><b>${kUsd(c.volH1)}</b></div><div><span>Market cap</span><b>${c.fdv ? kUsd(c.fdv) : '–'}</b></div>
    <div><span>Change 1h</span><b class="${cls(c.chgH1)}">${sPct(c.chgH1)}</b></div><div><span>Buys / sells 1h</span><b>${c.buysH1} / ${c.sellsH1}</b></div>
    <div><span>Exchange</span><b>${esc(c.dex || '–')}</b></div><div><span>Pool age</span><b>${c.createdAt ? ago(ev.t - c.createdAt) : '–'}</b></div></div>` : '';
  const pos = d.position ? `<h3>Open position</h3><div class="kv">
    <div><span>Size</span><b>${usd(d.position.size)}</b></div><div><span>P&amp;L</span><b class="${cls(d.position.pnlUsd)}">${sPct(d.position.pnlPct)}</b></div>
    <div><span>Entry</span><b>${price(d.position.entryPrice)}</b></div><div><span>Now</span><b>${price(d.position.price)}</b></div></div>` : '';
  const hist = d.trades.length ? `<h3>Closed trades</h3><div class="checks">${d.trades.map((t) => `
    <div class="chk"><span></span><span>${clock(t.closedAt)} · ${esc(t.reason)}</span><span class="${cls(t.pnlUsd)}">${sPct(t.pnlPct)} · ${sUsd(t.pnlUsd)}</span></div>`).join('')}</div>` : '';
  $('drawerBody').innerHTML = `
    <h2>${tok(c)}</h2>
    <div class="muted">${esc(c.name && c.name !== c.sym ? c.name : '')}</div>
    <div class="mintline">${esc(mint)}</div>
    <div class="links">
      <a class="btn small" target="_blank" rel="noopener noreferrer" href="https://dexscreener.com/solana/${encodeURIComponent(mint)}">Chart on DexScreener ↗</a>
      <a class="btn small" target="_blank" rel="noopener noreferrer" href="https://rugcheck.xyz/tokens/${encodeURIComponent(mint)}">RugCheck report ↗</a>
      <button type="button" class="btn small" id="showInLog">Show in log</button>
    </div>
    ${verdict}${pos}${checks}${aiBlock}${parts}${market}${hist}`;
  $('showInLog').onclick = () => { $('search').value = c.sym; setFilter({ text: c.sym, reason: null, agent: 'all' }); };
  $('drawer').hidden = false;
}
$('closeDrawer').onclick = () => { $('drawer').hidden = true; };
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('drawer').hidden = true; });

// ---------- one click handler for everything rendered ----------
document.addEventListener('click', (e) => {
  const close = e.target.closest('[data-close]');
  if (close) {
    e.stopPropagation();
    if (confirm(`Close $${close.dataset.sym} now at the current price?`)) post('/api/close', { id: Number(close.dataset.close) });
    return;
  }
  const agent = e.target.closest('[data-agent]');
  if (agent) return setFilter({ agent: filter.agent === agent.dataset.agent ? 'all' : agent.dataset.agent, reason: null });
  const reason = e.target.closest('[data-reason]');
  if (reason) {
    const key = reason.dataset.reason;
    return setFilter(filter.reason === key ? { reason: null } : { reason: key, agent: 'all' });
  }
  const row = e.target.closest('[data-mint]');
  if (row) openToken(row.dataset.mint);
});

// A token picture that fails to load falls back to its first letter.
document.addEventListener('error', (e) => {
  if (e.target.tagName !== 'IMG') return;
  const ph = document.createElement('span');
  ph.className = 'ph';
  e.target.replaceWith(ph);
}, true);

// ---------- live stream ----------
function connect() {
  const es = new EventSource('/api/stream');
  es.addEventListener('backlog', (e) => { logs = JSON.parse(e.data); queueLog(); });
  es.addEventListener('log', (e) => {
    logs.push(JSON.parse(e.data));
    if (logs.length > 4000) logs.splice(0, 1000);
    queueLog();
  });
  es.addEventListener('snap', (e) => { $('offline').hidden = true; render(JSON.parse(e.data)); });
  es.onerror = () => {
    $('offline').hidden = false;
    const st = $('status'); st.className = 'status'; st.lastElementChild.textContent = 'Disconnected';
  };
}
renderChips();
renderLog();
connect();
window.addEventListener('resize', () => snap && drawChart(snap.curve, snap.startBalance));
