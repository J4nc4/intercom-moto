'use strict';
/*
 * Simulador local de Google Apps Script para probar Code.gs sin desplegarlo.
 * Reproduce lo que importa del entorno real:
 *  - CacheService (TTL), PropertiesService, LockService, Utilities (HMAC, base64 web-safe),
 *    UrlFetchApp (respuesta simulada de Cloudflare TURN), ContentService.
 *  - El comportamiento HTTP de una Aplicación web: POST /exec responde 302 hacia
 *    OTRO origen (como script.googleusercontent.com) y NO responde OPTIONS (sin CORS
 *    preflight). Si el cliente hiciera una petición "no simple", fallaría igual que en Google.
 * Uso: node gas_mock.js <Code.gs> [puertoExec=8787] [puertoEcho=8788]
 */
const fs = require('fs');
const vm = require('vm');
const http = require('http');
const crypto = require('crypto');

const codePath = process.argv[2];
const PORT = Number(process.argv[3] || 8787);
const ECHO_PORT = Number(process.argv[4] || 8788);

const LATENCY_MS = Number(process.env.GAS_LATENCY_MS || 700); // Apps Script tarda ~0,5–2 s por llamada
let clockOffset = 0; // para simular el paso del tiempo
const now = () => Date.now() + clockOffset;
const stats = { posts: 0, options: 0, gets: 0, turnFetches: 0, inflight: 0, maxInflight: 0 };
const logs = [];

/* ---------------- servicios simulados ---------------- */
const cacheStore = new Map();
const CacheService = {
  getScriptCache: () => ({
    get: (k) => { const v = cacheStore.get(k); if (!v) return null; if (v.exp < now()) { cacheStore.delete(k); return null; } return v.val; },
    put: (k, val, ttl) => {
      if (typeof val !== 'string') throw new Error('cache: valor no string');
      if (Buffer.byteLength(val) > 100 * 1024) throw new Error('Argument too large: value');
      if (ttl > 21600) throw new Error('cache: ttl > 6h');
      cacheStore.set(k, { val, exp: now() + (ttl || 600) * 1000 });
    },
    remove: (k) => cacheStore.delete(k),
  }),
};
const propStore = new Map();
const PropertiesService = {
  getScriptProperties: () => ({
    getProperty: (k) => (propStore.has(k) ? propStore.get(k) : null),
    setProperty: (k, v) => { propStore.set(k, String(v)); },
    deleteProperty: (k) => { propStore.delete(k); },
  }),
};
const LockService = { getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) };
const toSigned = (buf) => Array.from(buf, (b) => (b > 127 ? b - 256 : b)); // Apps Script usa Byte[] con signo
const toBuf = (x) => (typeof x === 'string' ? Buffer.from(x, 'utf8') : Buffer.from(x.map((b) => (b < 0 ? b + 256 : b))));
const Utilities = {
  Charset: { UTF_8: 'UTF-8' },
  computeHmacSha256Signature: (value, key) => toSigned(crypto.createHmac('sha256', Buffer.from(key, 'utf8')).update(Buffer.from(value, 'utf8')).digest()),
  base64EncodeWebSafe: (data) => toBuf(data).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
  base64DecodeWebSafe: (s) => {
    if (/[^A-Za-z0-9_\-=]/.test(s)) throw new Error('Could not decode string.');
    return toSigned(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
  },
  newBlob: (bytes) => ({ getDataAsString: () => toBuf(bytes).toString('utf8') }),
  getUuid: () => crypto.randomUUID(),
};
const UrlFetchApp = {
  fetch: (url, params) => {
    stats.turnFetches++;
    if (/metered\.live\/api\/v1\/turn\/credentials\?apiKey=GOODKEY$/.test(url)) {
      const arr = [{ urls: 'stun:stun.relay.metered.ca:80' },
        { urls: 'turn:global.relay.metered.ca:80', username: 'mu', credential: 'mc' },
        { urls: 'turns:global.relay.metered.ca:443?transport=tcp', username: 'mu', credential: 'mc' }];
      return { getResponseCode: () => 200, getContentText: () => JSON.stringify(arr) };
    }
    if (/metered\.live/.test(url)) return { getResponseCode: () => 401, getContentText: () => '{"error":"Invalid API Key"}' };
    const ok = /rtc\.live\.cloudflare\.com\/v1\/turn\/keys\/TESTKEY\/credentials\/generate-ice-servers$/.test(url)
      && params.headers.Authorization === 'Bearer TESTTOKEN';
    const body = ok ? {
      iceServers: [
        { urls: ['stun:127.0.0.1:3478', 'stun:127.0.0.1:53'] },
        { urls: ['turn:127.0.0.1:3478?transport=udp', 'turn:127.0.0.1:53?transport=udp', 'turns:127.0.0.1:5349?transport=tcp'],
          username: 'u-' + crypto.randomBytes(4).toString('hex'), credential: 'c-' + crypto.randomBytes(8).toString('hex') },
      ],
    } : { error: 'unauthorized' };
    return { getResponseCode: () => (ok ? 201 : 401), getContentText: () => JSON.stringify(body) };
  },
};
const ContentService = {
  MimeType: { JSON: 'application/json' },
  createTextOutput: (content) => ({ content, mime: 'text/plain', setMimeType(m) { this.mime = m; return this; } }),
};
const consoleShim = { log: (...a) => { logs.push(a.join(' ')); }, error: (...a) => { logs.push('ERROR ' + a.join(' ')); } };

const ctx = vm.createContext({
  CacheService, PropertiesService, LockService, Utilities, UrlFetchApp, ContentService,
  console: consoleShim, Date: class extends Date { static now() { return now(); } }, JSON, Math, Number, String, Object, Array, Error,
});
vm.runInContext(fs.readFileSync(codePath, 'utf8'), ctx, { filename: 'Code.gs' });

/* ---------------- servidor HTTP que imita la Aplicación web ---------------- */
const echoes = new Map();
let down = false; // simula Apps Script caído / sin señal
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') { stats.options++; res.writeHead(405); return res.end(); } // Apps Script no hace CORS preflight
  if (u.pathname === '/exec' && req.method === 'GET') {
    stats.gets++;
    const out = ctx.doGet({ parameter: Object.fromEntries(u.searchParams) });
    res.writeHead(200, { 'Content-Type': out.mime, 'Access-Control-Allow-Origin': '*' });
    return res.end(out.content);
  }
  if (down && u.pathname === '/exec') { req.resume(); res.writeHead(503, { 'Access-Control-Allow-Origin': '*' }); return res.end(); }
  if (u.pathname === '/exec' && req.method === 'POST') {
    stats.inflight++; stats.maxInflight = Math.max(stats.maxInflight, stats.inflight);
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => setTimeout(() => {
      stats.posts++; stats.inflight--;
      const out = ctx.doPost({ postData: { contents: body, type: req.headers['content-type'] } });
      const id = crypto.randomBytes(8).toString('hex');
      echoes.set(id, out);
      res.writeHead(302, { Location: `http://127.0.0.1:${ECHO_PORT}/echo?id=${id}`, 'Access-Control-Allow-Origin': '*' });
      res.end();
    }, LATENCY_MS));
    return;
  }
  // API de control para las pruebas
  if (u.pathname === '/__admin' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const cmd = JSON.parse(body || '{}');
      let result = null;
      if (cmd.run) { logs.length = 0; result = ctx[cmd.run].apply(null, cmd.args || []); }
      if (cmd.advanceMs) clockOffset += cmd.advanceMs;
      if (cmd.clearCache) cacheStore.clear();
      if (cmd.down !== undefined) down = cmd.down;
      if (cmd.setProp) propStore.set(cmd.setProp[0], cmd.setProp[1]);
      if (cmd.room) result = JSON.parse(CacheService.getScriptCache().get('room:' + cmd.room) || 'null');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ result, logs: logs.slice(), stats, props: Object.fromEntries(propStore) }));
    });
    return;
  }
  res.writeHead(404); res.end();
}).listen(PORT, '127.0.0.1');

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') { stats.options++; res.writeHead(405); return res.end(); }
  const out = echoes.get(u.searchParams.get('id'));
  echoes.delete(u.searchParams.get('id'));
  if (!out) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': out.mime + '; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(out.content);
}).listen(ECHO_PORT, '127.0.0.1');

console.log(`Apps Script simulado en http://127.0.0.1:${PORT}/exec (echo :${ECHO_PORT})`);
