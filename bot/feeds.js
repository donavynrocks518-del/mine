'use strict';
// Market data sources. All three are free public APIs that need no key.
//   GeckoTerminal - new and trending Solana pools (the Scout's eyes)
//   DexScreener   - live prices for open positions, second looks
//   RugCheck      - mint authority, liquidity lock, holders, creator history

const UA = 'paper-desk/1.0';
const QUOTES = new Set([
  'So11111111111111111111111111111111111111112', // SOL
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
]);

const health = {
  gecko: { name: 'GeckoTerminal', role: 'new pairs', ok: null, error: null, lastOk: 0, calls: 0, errors: 0 },
  dex: { name: 'DexScreener', role: 'live prices', ok: null, error: null, lastOk: 0, calls: 0, errors: 0 },
  rug: { name: 'RugCheck', role: 'safety checks', ok: null, error: null, lastOk: 0, calls: 0, errors: 0 },
  rpc: { name: 'Solana chain', role: 'on-chain prices', ok: null, error: null, lastOk: 0, calls: 0, errors: 0 },
};
const DEFAULT_RPC = 'https://api.mainnet-beta.solana.com';

async function getJson(src, url, timeoutMs = 12000, body) {
  const h = health[src];
  h.calls++;
  try {
    const res = await fetch(url, {
      method: body ? 'POST' : 'GET',
      headers: { accept: 'application/json', 'user-agent': UA, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
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

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

function fromGecko(pool) {
  const a = pool.attributes || {};
  const rel = pool.relationships || {};
  const mint = String(rel.base_token?.data?.id || '').replace(/^solana_/, '');
  const quote = String(rel.quote_token?.data?.id || '').replace(/^solana_/, '');
  if (!mint || QUOTES.has(mint) || !QUOTES.has(quote)) return null;
  const sym = String(a.name || '').split(' / ')[0].trim().slice(0, 24) || mint.slice(0, 5);
  const tx = a.transactions || {};
  return {
    quote, quoteUsd: num(a.quote_token_price_usd),
    mint, sym, name: sym, pool: a.address, dex: rel.dex?.data?.id || '',
    priceUsd: num(a.base_token_price_usd), liqUsd: num(a.reserve_in_usd),
    volH1: num(a.volume_usd?.h1), volM5: num(a.volume_usd?.m5),
    chgM5: num(a.price_change_percentage?.m5), chgH1: num(a.price_change_percentage?.h1),
    buysH1: num(tx.h1?.buys), sellsH1: num(tx.h1?.sells),
    buysM5: num(tx.m5?.buys), sellsM5: num(tx.m5?.sells),
    fdv: num(a.fdv_usd), createdAt: Date.parse(a.pool_created_at) || 0, img: null,
  };
}

function fromDexPair(p) {
  const mint = p.baseToken?.address;
  if (!mint || QUOTES.has(mint)) return null;
  const native = num(p.priceNative);
  return {
    quote: p.quoteToken?.address || '', quoteUsd: native ? num(p.priceUsd) / native : 0,
    mint, sym: String(p.baseToken.symbol || mint.slice(0, 5)).slice(0, 24),
    name: String(p.baseToken.name || '').slice(0, 60), pool: p.pairAddress, dex: p.dexId || '',
    priceUsd: num(p.priceUsd), liqUsd: num(p.liquidity?.usd),
    volH1: num(p.volume?.h1), volM5: num(p.volume?.m5),
    chgM5: num(p.priceChange?.m5), chgH1: num(p.priceChange?.h1),
    buysH1: num(p.txns?.h1?.buys), sellsH1: num(p.txns?.h1?.sells),
    buysM5: num(p.txns?.m5?.buys), sellsM5: num(p.txns?.m5?.sells),
    fdv: num(p.fdv), createdAt: num(p.pairCreatedAt), img: p.info?.imageUrl || null,
  };
}

async function geckoPools(kind) {
  const j = await getJson('gecko', `https://api.geckoterminal.com/api/v2/networks/solana/${kind}?page=1`);
  return (j.data || []).map(fromGecko).filter(Boolean);
}

// Returns Map mint -> deepest-liquidity pair for up to 30 mints per call.
async function dexTokens(mints) {
  const out = new Map();
  for (let i = 0; i < mints.length; i += 30) {
    const chunk = mints.slice(i, i + 30);
    const pairs = await getJson('dex', `https://api.dexscreener.com/tokens/v1/solana/${chunk.join(',')}`);
    for (const p of Array.isArray(pairs) ? pairs : []) {
      const c = fromDexPair(p);
      if (!c || !chunk.includes(c.mint)) continue;
      const cur = out.get(c.mint);
      if (!cur || c.liqUsd > cur.liqUsd) out.set(c.mint, c);
    }
  }
  return out;
}

async function dexLatestProfiles() {
  const j = await getJson('dex', 'https://api.dexscreener.com/token-profiles/latest/v1');
  return (Array.isArray(j) ? j : []).filter((x) => x.chainId === 'solana' && x.tokenAddress).map((x) => x.tokenAddress);
}

async function rugReport(mint) {
  const r = await getJson('rug', `https://api.rugcheck.xyz/v1/tokens/${mint}/report`, 15000);
  const markets = Array.isArray(r.markets) ? r.markets : [];
  // Accounts that hold tokens on behalf of a pool are not "holders".
  const poolAccounts = new Set();
  for (const [addr, info] of Object.entries(r.knownAccounts || {})) {
    if (info && info.type === 'AMM') poolAccounts.add(addr);
  }
  let main = null; let mainUsd = -1;
  for (const m of markets) {
    for (const k of ['pubkey', 'liquidityA', 'liquidityB', 'liquidityAAccount', 'liquidityBAccount']) {
      if (typeof m[k] === 'string') poolAccounts.add(m[k]);
    }
    const usd = num(m.lp?.quoteUSD) + num(m.lp?.baseUSD);
    if (usd > mainUsd) { mainUsd = usd; main = m; }
  }
  const holders = (r.topHolders || []).filter((h) => !poolAccounts.has(h.owner) && !poolAccounts.has(h.address));
  const top10Pct = holders.slice(0, 10).reduce((s, h) => s + num(h.pct), 0);
  const risks = (r.risks || []).map((x) => ({ name: String(x.name || ''), level: x.level || '' }));
  const devRisk = risks.find((x) => /rugged|creator/i.test(x.name));
  const pools = markets.filter((m) => typeof m.liquidityA === 'string' && typeof m.liquidityB === 'string')
    .map((m) => ({ pubkey: m.pubkey, type: m.marketType, vaults: [m.liquidityA, m.liquidityB] }));
  return {
    pools,
    mintRevoked: r.mintAuthority == null && r.token?.mintAuthority == null,
    freezeRevoked: r.freezeAuthority == null && r.token?.freezeAuthority == null,
    lpLockedPct: main ? num(main.lp?.lpLockedPct) : null,
    marketType: main ? main.marketType : null,
    top10Pct,
    holders: num(r.totalHolders),
    devFlag: r.rugged ? 'token is marked rugged' : devRisk ? devRisk.name : null,
    dangers: risks.filter((x) => x.level === 'danger').map((x) => x.name),
    warns: risks.filter((x) => x.level === 'warn').map((x) => x.name),
    scoreNorm: num(r.score_normalised),
    insiders: num(r.graphInsidersDetected),
    name: r.tokenMeta?.name ? String(r.tokenMeta.name).slice(0, 60) : null,
  };
}

// Reads token-vault balances straight from the chain, at the newest state the node has.
// Returns Map address -> { mint, amount }. One call covers every open position.
async function chainBalances(rpcUrl, addresses) {
  const out = new Map();
  if (!addresses.length) return out;
  const j = await getJson('rpc', rpcUrl || DEFAULT_RPC, 6000, {
    jsonrpc: '2.0', id: 1, method: 'getMultipleAccounts',
    params: [addresses.slice(0, 100), { encoding: 'jsonParsed', commitment: 'processed' }],
  });
  if (j.error) {
    health.rpc.ok = false; health.rpc.error = String(j.error.message || 'RPC error').slice(0, 60);
    throw new Error(health.rpc.error);
  }
  (j.result?.value || []).forEach((acc, i) => {
    const info = acc?.data?.parsed?.info;
    if (info && info.tokenAmount) out.set(addresses[i], { mint: info.mint, amount: num(info.tokenAmount.uiAmount) });
    else out.set(addresses[i], null); // account closed or not a token account
  });
  return out;
}

const SOL = 'So11111111111111111111111111111111111111112';
module.exports = { health, geckoPools, dexTokens, dexLatestProfiles, rugReport, chainBalances, SOL, QUOTES, DEFAULT_RPC };
