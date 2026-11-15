'use strict';
/* Paper Desk · Kalshi weather. Talks only to the bot running on this computer, under /api/kalshi/. */

const API = '/api/kalshi';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const usd = (n) => `$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const sUsd = (n) => `${n >= 0 ? '+' : '−'}${usd(n)}`;
const sPct = (n) => `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(1)}%`;
const cents = (p) => `${Math.round(p * 100)}¢`;
const pct = (p) => `${Math.round(p * 100)}%`;
const count = (n) => (n >= 10000 ? `${(n / 1000).toFixed(1)}k` : n.toLocaleString('en-US'));
const clock = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
const cls = (n) => (n >= 0 ? 'up' : 'down');
function ago(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'under 1m';
  if (m < 60) return `${m}m`;
  if (m < 2880) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${Math.floor(m / 1440)}d`;
}
const dayName = (d) => new Date(`${d}T12:00:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });

const AGENTS = [
  ['scout', 'Scout', 'open contracts', 'S'],
  ['filter', 'Filter', 'liquidity checks', 'F'],
  ['analyst', 'Analyst', 'forecast vs price', 'A'],
  ['executor', 'Executor', 'places paper orders', 'E'],
  ['risk', 'Risk', 'limits and settlement', 'R'],
  ['logger', 'Logger', 'reason for all', 'L'],
];
const FIELDS = [
  ['Account'],
  ['startBalance', 'Starting balance', '$', 1],
  ['maxStakePct', 'Max on one contract', '% of account', 0.5],
  ['maxCityDayPct', "Max on one city's day", '% of account', 1],
  ['Trading'],
  ['minEdge', 'Minimum edge after fees', '$ per contract', 0.01],
  ['modelWeight', 'Trust in the forecast (0 = market, 1 = forecast)', '0 to 1', 0.05],
  ['exitEdge', 'Sell early when bid beats fair value by', '$ per contract', 0.01],
  ['Forecast model'],
  ['sigmaToday', "Forecast error for today's high", '°F', 0.1],
  ['sigmaTomorrow', "Forecast error for tomorrow's high", '°F', 0.1],
  ['Filter'],
  ['minVol24', 'Min contracts traded in 24h', '', 50],
  ['maxSpread', 'Max bid/ask gap', '$', 0.01],
  ['minPrice', 'Skip contracts priced under', '$', 0.01],
  ['maxPrice', 'Skip contracts priced over', '$', 0.01],
  ['closeBufferMin', 'Stop trading this long before close', 'min', 5],
  ['Costs'],
  ['feeRate', 'Kalshi fee rate', '× price × (1 − price)', 0.01],
];

let snap = null;
let logs = [];
const filter = { agent: 'all', reason: null, text: '' };
let logDirty = false;

async function post(p, body) {
  const res = await fetch(`${API}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await res.json();
  if (res.ok) render(j);
  return res.ok;
}

$('toggle').onclick = () => snap && post('/control', { action: snap.running ? 'pause' : 'start' });
$('reset').onclick = () => {
  if (!snap) return;
  const n = snap.positions.length;
  if (confirm(`Reset the Kalshi paper account to $${snap.config.startBalance}?\n\nThis clears ${n} open contract${n === 1 ? '' : 's'}, all closed trades and the forecast scorecard. The memecoin desk is not affected. It cannot be undone.`)) {
    logs = []; post('/control', { action: 'reset' });
  }
};
$('openSettings').onclick = () => {
  if (!snap) return;
  $('fields').innerHTML = FIELDS.map((f) => (f.length === 1 ? `<h3>${f[0]}</h3>`
    : `<div class="field"><label for="f_${f[0]}">${f[1]}</label><div class="in"><input id="f_${f[0]}" name="${f[0]}" type="number" step="any" min="0" value="${snap.config[f[0]]}" required>${f[2] ? `<span class="unit">${f[2]}</span>` : ''}</div></div>`)).join('');
  $('settings').showModal();
};
$('settings').addEventListener('close', () => {
  if ($('settings').returnValue !== 'save') return;
  const body = {};
  new FormData($('settingsForm')).forEach((v, k) => { body[k] = Number(v); });
  post('/config', body);
});

function render(s) {
  snap = s;
  const st = $('status');
  st.className = `status ${s.running ? 'live' : 'paused'}`;
  st.lastElementChild.textContent = s.running ? 'Live · watching' : 'Paused';
  $('toggle').textContent = s.running ? 'Pause' : 'Resume';
  $('toggle').classList.toggle('resume', !s.running);
  $('feeds').innerHTML = Object.values(s.feeds).map((f) => {
    const state = f.ok === null ? '' : f.ok ? 'ok' : 'bad';
    return `<span class="feed ${state}" title="${esc(`${f.name} · ${f.role}${f.error ? ` · ${f.error}` : ''}`)}"><i></i>${esc(f.name)}${f.ok === false ? ` · ${esc(f.error)}` : ''}</span>`;
  }).join('');

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
  $('fees').textContent = usd(s.counters.fees || 0);
  drawChart(s.curve, s.startBalance);

  const c = s.counters;
  const pills = {
    scout: `${s.watching} contracts`,
    filter: `${count(c.killed)} skipped`,
    analyst: `${count(c.scored)} priced`,
    executor: `≤ ${s.config.maxStakePct}% each`,
    risk: `${s.positions.length} open`,
    logger: `${count(c.reasons)} reasons`,
  };
  $('deskCount').textContent = `${s.watching} contracts watched · ${c.traded} traded`;
  $('agents').innerHTML = AGENTS.map(([key, name, sub, letter]) => {
    const a = s.agents[key];
    const last = a ? `${a.sym ? `<span class="sym">${esc(a.sym)}</span> ` : ''}${esc(a.text)}` : 'waiting…';
    return `<button type="button" class="agent a-${key} ${filter.agent === key ? 'on' : ''}" data-agent="${key}" title="Show ${name} in the log">
      <span class="ico">${letter}</span><span><b>${name}</b><span class="sub">${sub}</span></span>
      <span class="last">${last}</span><span class="pill">${pills[key]}</span></button>`;
  }).join('');

  $('posCount').textContent = s.positions.length ? `${s.positions.length} open` : '';
  $('positions').innerHTML = s.positions.length ? `<table><thead><tr>
    <th>Contract</th><th>Side</th><th class="r">Qty</th><th class="r">Paid</th><th class="r">Bid now</th><th class="r">Fair</th><th class="r">P&amp;L</th><th></th>
    </tr></thead><tbody>${s.positions.map((p) => `<tr data-mint="${esc(p.ticker)}">
      <td><b>${esc(p.city)}</b> <span class="muted">${esc(dayName(p.date))}</span><br>${esc(p.title)}</td>
      <td><span class="tag ${p.side === 'yes' ? 'took' : 'trail'}">${p.side.toUpperCase()}</span></td>
      <td class="r">${p.qty}</td><td class="r">${cents(p.avg)}</td><td class="r">${cents(p.mark)}</td><td class="r">${pct(p.fair)}</td>
      <td class="r ${cls(p.pnl)}">${sUsd(p.pnl)}</td>
      <td class="r"><button type="button" class="btn small" data-close="${p.id}" data-sym="${esc(`${p.city} ${p.title}`)}">Sell</button></td></tr>`).join('')}</tbody></table>`
    : `<div class="empty">No open contracts. The Executor buys only when the forecast beats the price by at least ${cents(s.config.minEdge)} after fees${s.running ? '' : ' (the desk is paused)'}.</div>`;

  const sc = s.scorecard;
  $('scoreCount').textContent = sc.n ? `${sc.n} settled` : '';
  $('scorecard').innerHTML = sc.n
    ? `<div class="kv score">
        <div><span>Forecast model</span><b class="${sc.model <= sc.market ? 'up' : 'down'}">${sc.model.toFixed(3)}</b></div>
        <div><span>Market price</span><b>${sc.market.toFixed(3)}</b></div>
        <div><span>Blend (what it trades on)</span><b class="${sc.blend <= sc.market ? 'up' : 'down'}">${sc.blend.toFixed(3)}</b></div>
      </div>
      <p class="muted small-note">Accuracy score on every settled contract the Analyst priced: lower is better. ${sc.blend <= sc.market
        ? 'The blend is beating the market so far.'
        : 'The market is beating the blend so far, so its trades are likely losing money.'}${sc.n < 100 ? ' Too few results to trust yet.' : ''}</p>`
    : `<div class="empty">Waiting for contracts to settle. Each day's contracts settle the next morning; ${s.pendingScores} priced contracts are waiting.</div>`;

  $('killCount').textContent = `${count(c.killed)} total`;
  const max = Math.max(1, ...Object.values(s.why));
  $('why').innerHTML = Object.entries(s.reasons).map(([key, label]) => `
    <button type="button" class="why-row ${filter.reason === key ? 'on' : ''}" data-reason="${key}" title="Show these in the log">
      <span>${esc(label)}</span><span class="n">${count(s.why[key] || 0)}</span>
      <span class="bar"><i style="width:${((s.why[key] || 0) / max) * 100}%"></i></span></button>`).join('');

  const days = [...new Set(Object.values(s.weather).flatMap((w) => Object.keys(w.highs)))].sort().filter((d) => d >= new Date(s.now - 86400000).toISOString().slice(0, 10)).slice(0, 2);
  $('weather').innerHTML = `<table><thead><tr><th>City</th>${days.map((d) => `<th class="r">${esc(dayName(d))}</th>`).join('')}<th class="r">High so far</th><th class="r">Now</th></tr></thead>
    <tbody>${Object.values(s.weather).map((w) => `<tr class="static"><td>${esc(w.name)} <span class="muted">${esc(w.station)}</span></td>
      ${days.map((d) => `<td class="r">${w.highs[d] != null ? `${Math.round(w.highs[d])}°` : '–'}</td>`).join('')}
      <td class="r">${w.obsMax != null ? `${Math.round(w.obsMax)}°` : '–'}</td><td class="r">${w.latest != null ? `${Math.round(w.latest)}°` : '–'}</td></tr>`).join('')}</tbody></table>`;

  const closed = c.wins + c.losses;
  $('tradeCount').textContent = closed ? `${closed} closed · ${Math.round((c.wins / closed) * 100)}% won` : '';
  $('trades').innerHTML = s.trades.length ? `<table><thead><tr><th>Contract</th><th>Side</th><th class="r">Cost</th><th class="r">Result</th><th>Why it closed</th></tr></thead>
    <tbody>${s.trades.map((t) => `<tr data-mint="${esc(t.ticker)}"><td><b>${esc(t.city)}</b> ${esc(t.title)}</td><td>${t.side.toUpperCase()}</td>
      <td class="r">${usd(t.cost)}</td><td class="r ${cls(t.pnlUsd)}">${sUsd(t.pnlUsd)}</td><td>${esc(t.reason)}</td></tr>`).join('')}</tbody></table>`
    : '<div class="empty">No closed trades yet. Contracts settle the morning after their day.</div>';
}

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
  $('tip').hidden = false;
  $('tip').textContent = `${clock(p.t)} · ${usd(p.v)}`;
  $('tip').style.left = `${Math.max(60, Math.min(box.width - 60, p.x))}px`;
});
$('chart').addEventListener('mouseleave', () => {
  $('tip').hidden = true;
  const cross = document.getElementById('cross');
  if (cross) cross.setAttribute('visibility', 'hidden');
});

function renderChips() {
  $('chips').innerHTML = [['all', 'All'], ...AGENTS.map((a) => [a[0], a[1]])]
    .map(([k, n]) => `<button type="button" class="chip ${filter.agent === k ? 'on' : ''}" data-agent="${k}">${n}</button>`).join('')
    + (filter.reason && snap ? `<button class="chip clear" type="button" data-clear="1">${esc(snap.reasons[filter.reason])} ×</button>` : '');
}
function renderLog() {
  logDirty = false;
  const q = filter.text.trim().toLowerCase();
  const rows = logs.filter((r) => {
    if (filter.reason) return r.reason === filter.reason;
    if (filter.agent !== 'all' && filter.agent !== 'logger' && r.agent !== filter.agent) return false;
    if (q && !(r.sym || '').toLowerCase().includes(q) && !(r.mint || '').toLowerCase().includes(q)) return false;
    return true;
  }).slice(-300).reverse();
  $('log').innerHTML = rows.length ? rows.map((r) => `
    <button type="button" class="row a-${r.agent} ${r.kind}" ${r.mint ? `data-mint="${esc(r.mint)}"` : 'disabled'}>
      <span class="t">${clock(r.t)}</span><span class="who">${r.agent}</span>
      <span class="msg">${r.sym ? `<span class="sym">${esc(r.sym)}</span> · ` : ''}${esc(r.text)}</span>
    </button>`).join('')
    : '<div class="empty">Nothing here yet. Decisions appear as the agents make them.</div>';
}
const queueLog = () => { if (!logDirty) { logDirty = true; requestAnimationFrame(renderLog); } };
function setFilter(patch) {
  Object.assign(filter, patch);
  renderChips(); renderLog();
  if (snap) render(snap);
}
$('search').addEventListener('input', (e) => setFilter({ text: e.target.value }));

async function openContract(ticker) {
  const d = await (await fetch(`${API}/token/${encodeURIComponent(ticker)}`)).json();
  const ev = d.ev; const m = ev ? ev.m : (d.position || d.trades[0]);
  if (!m) return;
  let verdict = '';
  if (ev) {
    const text = ev.outcome === 'bought' ? 'The Executor bought this contract.'
      : ev.outcome === 'holding' ? 'Holding this contract.'
        : ev.outcome === 'killed' ? `Skipped: ${snap.reasons[ev.reason] || ev.reason}.`
          : ev.outcome === 'skipped' ? `Passed the checks, but the Executor skipped it: ${ev.reason}.` : 'Being checked…';
    verdict = `<div class="verdict ${ev.outcome === 'bought' || ev.outcome === 'holding' ? 'bought' : 'killed'}">${esc(text)}<div class="muted">Last checked at ${clock(ev.t)}</div></div>`;
  }
  const checks = ev && ev.checks.length ? `<h3>Checks</h3><div class="checks">${ev.checks.map((k) => `
    <div class="chk ${k.pass ? 'pass' : 'fail'}"><span class="m">${k.pass ? '✓' : '✕'}</span><span>${esc(k.label)}</span><span class="v">${esc(k.value)}</span></div>`).join('')}</div>` : '';
  const mod = ev && ev.model;
  const model = mod ? `<h3>Analyst</h3><div class="kv">
    <div><span>Forecast high</span><b>${mod.fc.toFixed(0)}°F</b></div><div><span>Uncertainty</span><b>±${mod.sigma.toFixed(1)}°F</b></div>
    <div><span>High so far</span><b>${mod.obsMax != null ? `${Math.round(mod.obsMax)}°F` : '–'}</b></div><div><span>Forecast says</span><b>${pct(mod.p)}</b></div>
    <div><span>Market says</span><b>${pct(mod.mid)}</b></div><div><span>Fair (blend)</span><b>${pct(mod.fair)}</b></div>
    <div><span>Edge on YES</span><b class="${cls(mod.yesEdge)}">${mod.yesEdge >= 0 ? '+' : '−'}${cents(Math.abs(mod.yesEdge))}</b></div>
    <div><span>Edge on NO</span><b class="${cls(mod.noEdge)}">${mod.noEdge >= 0 ? '+' : '−'}${cents(Math.abs(mod.noEdge))}</b></div></div>
    ${mod.note ? `<p class="muted small-note">${esc(mod.note)}</p>` : ''}` : '';
  const pos = d.position ? `<h3>Open position</h3><div class="kv">
    <div><span>Side</span><b>${d.position.side.toUpperCase()} × ${d.position.qty}</b></div><div><span>Paid</span><b>${cents(d.position.avg)} each</b></div>
    <div><span>Cost incl. fee</span><b>${usd(d.position.cost)}</b></div><div><span>P&amp;L now</span><b class="${cls(d.position.pnl)}">${sUsd(d.position.pnl)}</b></div></div>` : '';
  const hist = d.trades.length ? `<h3>Closed trades</h3><div class="checks">${d.trades.map((t) => `
    <div class="chk"><span></span><span>${esc(t.reason)}</span><span class="${cls(t.pnlUsd)}">${sUsd(t.pnlUsd)}</span></div>`).join('')}</div>` : '';
  $('drawerBody').innerHTML = `
    <h2>${esc(m.city)} · ${esc(m.title)}</h2>
    <div class="muted">Daily high on ${esc(dayName(m.date))}</div>
    <div class="mintline">${esc(ticker)}</div>
    <div class="links"><a class="btn small" target="_blank" rel="noopener noreferrer" href="https://kalshi.com/markets/${encodeURIComponent(String(m.event || '').split('-')[0].toLowerCase())}">See it on Kalshi ↗</a></div>
    ${verdict}${pos}${model}${checks}${hist}`;
  $('drawer').hidden = false;
}
$('closeDrawer').onclick = () => { $('drawer').hidden = true; };
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('drawer').hidden = true; });

document.addEventListener('click', (e) => {
  const close = e.target.closest('[data-close]');
  if (close) {
    e.stopPropagation();
    if (confirm(`Sell ${close.dataset.sym} now at the current bid?`)) post('/close', { id: Number(close.dataset.close) });
    return;
  }
  if (e.target.closest('[data-clear]')) return setFilter({ reason: null });
  const agent = e.target.closest('[data-agent]');
  if (agent) return setFilter({ agent: filter.agent === agent.dataset.agent ? 'all' : agent.dataset.agent, reason: null });
  const reason = e.target.closest('[data-reason]');
  if (reason) return setFilter(filter.reason === reason.dataset.reason ? { reason: null } : { reason: reason.dataset.reason, agent: 'all' });
  const row = e.target.closest('[data-mint]');
  if (row) openContract(row.dataset.mint);
});

function connect() {
  const es = new EventSource(`${API}/stream`);
  es.addEventListener('backlog', (e) => { logs = JSON.parse(e.data); queueLog(); });
  es.addEventListener('log', (e) => { logs.push(JSON.parse(e.data)); if (logs.length > 4000) logs.splice(0, 1000); queueLog(); });
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
