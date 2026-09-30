#!/usr/bin/env node
// Tiny local dev server: serves /public and routes /api/<name> to netlify/functions/<name>.js
// (same handler code Netlify runs). Reads .env if present. No dependencies.
// Usage: node scripts/dev-server.js [port]     (MOCK data is used when BIBLE_BRAIN_KEY is empty)
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const envFile = path.join(root, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const PORT = Number(process.argv[2] || process.env.PORT || 8888);
const PUB = path.join(root, 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png',
  '.mp3': 'audio/mpeg', '.txt': 'text/plain', '.svg': 'image/svg+xml',
};

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(PUB, rel));
  if (!file.startsWith(PUB)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('Not found'); }
    const type = TYPES[path.extname(file)] || 'application/octet-stream';
    const headers = { 'Content-Type': type, 'Content-Length': st.size, 'Accept-Ranges': 'bytes' };
    if (file.endsWith('sw.js')) headers['Cache-Control'] = 'no-cache';
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range && type === 'audio/mpeg') {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
      res.writeHead(206, { ...headers, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${st.size}` });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
  });
}

function serveFunction(req, res, url) {
  const name = url.pathname.replace(/^\/api\//, '').replace(/[^a-z0-9_-]/gi, '');
  const file = path.join(root, 'netlify', 'functions', name + '.js');
  if (!name || !fs.existsSync(file)) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end('{"error":"not_found"}'); }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const event = {
      httpMethod: req.method, path: url.pathname, headers: req.headers,
      queryStringParameters: Object.fromEntries(url.searchParams), body: Buffer.concat(chunks).toString('utf8') || null,
    };
    try {
      const out = await require(file).handler(event, {});
      res.writeHead(out.statusCode, out.headers || {});
      res.end(out.body || '');
    } catch (e) {
      console.error('function crashed:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end('{"error":"server_error"}');
    }
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) return serveFunction(req, res, url);
  serveStatic(req, res, url.pathname);
});
if (require.main === module) {
  server.listen(PORT, () => {
    const mock = !process.env.BIBLE_BRAIN_KEY;
    console.log(`Dev server: http://localhost:${PORT}  (${mock ? 'MOCK data: no BIBLE_BRAIN_KEY' : 'live Bible Brain'})`);
    if (!process.env.ACCESS_PASSCODE) console.log('Note: ACCESS_PASSCODE is not set; the app will stay locked. Put one in .env');
  });
}
module.exports = { server };
