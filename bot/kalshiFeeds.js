'use strict';
// Data sources for the Kalshi weather desk. Both are free and need no key for reading.
//   Kalshi            - open temperature markets, order books, settled results
//   National Weather Service (api.weather.gov) - forecasts and live station observations

const UA = 'paper-desk/1.0 (weather paper trading)';
const KALSHI = 'https://api.elections.kalshi.com/trade-api/v2';
const NWS = 'https://api.weather.gov';

// Daily-high markets on Kalshi, with the weather station each one settles on.
const CITIES = [
  { id: 'nyc', name: 'New York', series: 'KXHIGHNY', station: 'KNYC' },
  { id: 'lax', name: 'Los Angeles', series: 'KXHIGHLAX', station: 'KLAX' },
  { id: 'chi', name: 'Chicago', series: 'KXHIGHCHI', station: 'KMDW' },
  { id: 'den', name: 'Denver', series: 'KXHIGHDEN', station: 'KDEN' },
  { id: 'aus', name: 'Austin', series: 'KXHIGHAUS', station: 'KAUS' },
  { id: 'mia', name: 'Miami', series: 'KXHIGHMIA', station: 'KMIA' },
  { id: 'dal', name: 'Dallas', series: 'KXHIGHTDAL', station: 'KDFW' },
  { id: 'okc', name: 'Oklahoma City', series: 'KXHIGHTOKC', station: 'KOKC' },
  { id: 'atl', name: 'Atlanta', series: 'KXHIGHTATL', station: 'KATL' },
  { id: 'phl', name: 'Philadelphia', series: 'KXHIGHPHIL', station: 'KPHL' },
];

const health = {
  kalshi: { name: 'Kalshi', role: 'markets and prices', ok: null, error: null, lastOk: 0, calls: 0, errors: 0 },
  nws: { name: 'Weather service', role: 'forecasts and observations', ok: null, error: null, lastOk: 0, calls: 0, errors: 0 },
};

// Kalshi rate-limits bursts, so every Kalshi call waits its turn with a small gap.
let kalshiChain = Promise.resolve();
const gap = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(src, url, timeoutMs = 20000) {
  const h = health[src];
  h.calls++;
  try {
    const res = await fetch(url, {
      headers: { accept: src === 'nws' ? 'application/geo+json' : 'application/json', 'user-agent': UA },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const err = new Error(res.status === 429 ? 'rate limited (429)' : `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    const json = await res.json();
    h.ok = true; h.error = null; h.lastOk = Date.now();
    return json;
  } catch (e) {
    h.ok = false; h.errors++;
    h.error = e.name === 'TimeoutError' ? 'timed out' : (e.cause && e.cause.code) || e.message;
    throw e;
  }
}

function kalshiGet(path) {
  const run = kalshiChain.then(() => getJson('kalshi', `${KALSHI}${path}`));
  kalshiChain = run.catch(() => {}).then(() => gap(700));
  return run;
}

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const cToF = (c) => c * 9 / 5 + 32;

// "KXHIGHNY-26NOV15" -> "2026-11-15"
const MONTHS = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };
function eventDate(eventTicker) {
  const m = /-(\d{2})([A-Z]{3})(\d{2})$/.exec(eventTicker || '');
  if (!m || !MONTHS[m[2]]) return null;
  return `20${m[1]}-${String(MONTHS[m[2]]).padStart(2, '0')}-${m[3]}`;
}

function fromMarket(m, city) {
  const yesBid = num(m.yes_bid_dollars); const yesAsk = num(m.yes_ask_dollars);
  const noBid = num(m.no_bid_dollars); const noAsk = num(m.no_ask_dollars);
  return {
    ticker: m.ticker, event: m.event_ticker, cityId: city.id, city: city.name, date: eventDate(m.event_ticker),
    title: m.yes_sub_title || m.title, strikeType: m.strike_type,
    floor: m.floor_strike == null ? null : num(m.floor_strike), cap: m.cap_strike == null ? null : num(m.cap_strike),
    yesBid, yesAsk: yesAsk || (noBid ? 1 - noBid : 0), noBid, noAsk: noAsk || (yesBid ? 1 - yesBid : 0),
    vol24: num(m.volume_24h_fp ?? m.volume_24h), closeTime: Date.parse(m.close_time) || 0,
    status: m.status, result: m.result || '',
  };
}

async function openMarkets(city) {
  const j = await kalshiGet(`/markets?series_ticker=${city.series}&status=open&limit=100`);
  return (j.markets || []).map((m) => fromMarket(m, city));
}

async function settledMarkets(city) {
  const j = await kalshiGet(`/markets?series_ticker=${city.series}&status=settled&limit=60`);
  return (j.markets || []).map((m) => fromMarket(m, city));
}

async function market(ticker) {
  const j = await kalshiGet(`/markets/${encodeURIComponent(ticker)}`);
  return j.market || null;
}

// Order book: Kalshi lists bids only. Buying YES fills against NO bids (price 1 - no bid), and the reverse.
// Returns { yesAsks, noAsks, yesBids, noBids } as [price, qty] lists, best first.
async function orderbook(ticker) {
  const j = await kalshiGet(`/markets/${encodeURIComponent(ticker)}/orderbook?depth=20`);
  const ob = j.orderbook_fp || {};
  const levels = (arr) => (arr || []).map(([p, q]) => [num(p), num(q)]).filter(([p, q]) => p > 0 && q > 0);
  const yesBids = levels(ob.yes_dollars).sort((a, b) => b[0] - a[0]);
  const noBids = levels(ob.no_dollars).sort((a, b) => b[0] - a[0]);
  const flip = (bids) => bids.map(([p, q]) => [+(1 - p).toFixed(4), q]);
  return { yesBids, noBids, yesAsks: flip(noBids), noAsks: flip(yesBids) };
}

// ---------- weather service ----------
const stationInfo = new Map(); // station -> { lat, lon, tz, grid }

async function station(id) {
  if (stationInfo.has(id)) return stationInfo.get(id);
  const st = await getJson('nws', `${NWS}/stations/${id}`);
  const [lon, lat] = st.geometry.coordinates;
  const pt = await getJson('nws', `${NWS}/points/${lat.toFixed(4)},${lon.toFixed(4)}`);
  const info = { lat, lon, tz: st.properties.timeZone || pt.properties.timeZone, grid: pt.properties.forecastGridData };
  stationInfo.set(id, info);
  return info;
}

// Local calendar date ("YYYY-MM-DD") and hour of a moment in a time zone.
function localParts(ms, tz) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}

// Forecast daily highs by local date, in °F, from the gridpoint data.
async function forecastHighs(id) {
  const info = await station(id);
  const g = await getJson('nws', info.grid);
  const out = {};
  for (const v of g.properties?.maxTemperature?.values || []) {
    const [start, dur] = String(v.validTime).split('/');
    const hours = /PT(\d+)H/.exec(dur || '');
    if (!hours || Number(hours[1]) < 6 || v.value == null) continue; // skip leftover partial periods
    const day = localParts(Date.parse(start), info.tz).date;
    out[day] = +cToF(v.value).toFixed(1);
  }
  return { highs: out, issued: Date.parse(g.properties?.updateTime) || Date.now() };
}

// Observations so far today (local), in °F: the running maximum and the latest reading.
async function observedToday(id) {
  const info = await station(id);
  const since = new Date(Date.now() - 26 * 3600000).toISOString();
  const j = await getJson('nws', `${NWS}/stations/${id}/observations?start=${encodeURIComponent(since)}&limit=200`);
  const today = localParts(Date.now(), info.tz).date;
  let max = null; let latest = null; let latestAt = 0;
  for (const f of j.features || []) {
    const p = f.properties || {};
    const c = p.temperature?.value;
    if (c == null) continue;
    const t = Date.parse(p.timestamp);
    if (localParts(t, info.tz).date !== today) continue;
    const fv = cToF(c);
    if (max === null || fv > max) max = fv;
    if (t > latestAt) { latestAt = t; latest = fv; }
  }
  return { date: today, max, latest, latestAt };
}

module.exports = {
  CITIES, health, openMarkets, settledMarkets, market, orderbook, station, localParts, forecastHighs, observedToday,
};
