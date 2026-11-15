'use strict';
// Paper Desk: runs the bot and serves the dashboard on this computer only.
//   node server.js          then open http://localhost:4280
//   node server.js --open   also opens your browser

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Desk } = require('./bot/engine');
const { KalshiDesk } = require('./bot/kalshiDesk');

const PORT = Number(process.env.PORT) || 4280;
const HOST = '127.0.0.1'; // never exposed to the network
const PUBLIC = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

// Two separate desks, each with its own account, settings, log and data folder.
//   /api/...         the memecoin desk
//   /api/kalshi/...  the Kalshi weather desk
const desks = {
  '': { desk: new Desk(path.join(__dirname, 'data')), clients: new Set() },
  kalshi: { desk: new KalshiDesk(path.join(__dirname, 'data', 'kalshi')), clients: new Set() },
};

const send = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
for (const d of Object.values(desks)) {
  d.desk.on('log', (row) => d.clients.forEach((res) => send(res, 'log', row)));
  setInterval(() => {
    if (!d.clients.size) return;
    const snap = d.desk.snapshot();
    d.clients.forEach((res) => send(res, 'snap', snap));
  }, 1500);
}

function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (d) => { raw += d; if (raw.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

// Only this dashboard may send commands: blocks other websites from poking the local server.
function trusted(req) {
  const local = [`localhost:${PORT}`, `127.0.0.1:${PORT}`];
  if (!local.includes(req.headers.host)) return false;
  const origin = req.headers.origin;
  return !origin || local.some((h) => origin === `http://${h}`);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  // Route /api/kalshi/* to the Kalshi desk and /api/* to the memecoin desk.
  const isKalshi = url.pathname.startsWith('/api/kalshi/');
  const { desk, clients } = desks[isKalshi ? 'kalshi' : ''];
  const apiPath = isKalshi ? `/api/${url.pathname.slice('/api/kalshi/'.length)}` : url.pathname;
  try {
    if (req.method === 'GET' && apiPath === '/api/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      send(res, 'backlog', desk.backlog());
      send(res, 'snap', desk.snapshot());
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (req.method === 'GET' && apiPath.startsWith('/api/token/')) {
      return json(res, 200, desk.tokenSheet(decodeURIComponent(apiPath.slice(11))));
    }
    if (req.method === 'POST' && apiPath.startsWith('/api/')) {
      if (!trusted(req)) return json(res, 403, { error: 'forbidden' });
      const body = await readBody(req);
      if (apiPath === '/api/control') {
        if (body.action === 'start') desk.setRunning(true);
        else if (body.action === 'pause') desk.setRunning(false);
        else if (body.action === 'reset') desk.reset();
        else return json(res, 400, { error: 'unknown action' });
      } else if (apiPath === '/api/config') desk.setConfig(body);
      else if (apiPath === '/api/close') {
        if (!desk.closeManual(Number(body.id))) return json(res, 404, { error: 'position not found' });
      } else return json(res, 404, { error: 'not found' });
      return json(res, 200, desk.snapshot());
    }
    if (req.method === 'GET') {
      const file = path.join(PUBLIC, path.normalize(url.pathname === '/' ? 'index.html' : url.pathname));
      if (file.startsWith(PUBLIC) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
        return fs.createReadStream(file).pipe(res);
      }
    }
    json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE'
    ? `Port ${PORT} is busy. Paper Desk may already be running: open http://localhost:${PORT}`
    : e.message);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const link = `http://localhost:${PORT}`;
  console.log(`\n  Paper Desk is running.  Dashboard: ${link}\n  Paper money only. Keep this window open; press Ctrl+C to stop.\n`);
  Object.values(desks).forEach((d) => d.desk.start());
  if (process.argv.includes('--open')) {
    const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', link]]
      : process.platform === 'darwin' ? ['open', [link]] : ['xdg-open', [link]];
    try { spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch { /* open it by hand */ }
  }
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { Object.values(desks).forEach((d) => d.desk.stop()); process.exit(0); });
}
