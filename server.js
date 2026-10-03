'use strict';
/*
 * Intercom Moto — servidor local SIN dependencias (solo Node.js).
 *
 * - Sirve la página del intercomunicador.
 * - Hace de "señalización" WebRTC: pasa ofertas/respuestas SDP y candidatos ICE
 *   entre los dos celulares usando Server-Sent Events (servidor -> celular)
 *   y POST /signal (celular -> servidor).
 * - El AUDIO NO pasa por aquí: va directo de celular a celular (P2P, SRTP/UDP).
 *
 * Puertos:
 *   HTTP  8080  -> Android abre http://localhost:8080 (localhost cuenta como seguro)
 *                  El iPhone entra aquí la primera vez para descargar el certificado.
 *   HTTPS 8443  -> iPhone abre https://IP-DEL-ANDROID:8443
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const CERTS = path.join(ROOT, 'certs');
const HTTP_PORT = Number(process.env.HTTP_PORT) || 8080;
const HTTPS_PORT = Number(process.env.HTTPS_PORT) || 8443;
const MAX_PEERS = 2;          // piloto + pasajero
const STALE_MS = 20000;       // una conexión sin "ping" en 20 s se considera fantasma

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};
const PUBLIC_FILES = new Set(['/app.js', '/style.css', '/setup.html']);

const log = (...a) => console.log(new Date().toLocaleTimeString('es-CO'), ...a);

/* ------------------------------------------------------------------ */
/* Sala de señalización (máximo 2 participantes)                       */
/* ------------------------------------------------------------------ */
// key (id estable del dispositivo) -> { res, session, name, lastSeen }
const peers = new Map();

function sse(res, obj) {
  try { res.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch (_) { /* socket cerrado */ }
}

function otherPeer(key) {
  for (const [k, p] of peers) if (k !== key) return p;
  return null;
}

function removePeer(key, reason) {
  const p = peers.get(key);
  if (!p) return;
  peers.delete(key);
  try { p.res.end(); } catch (_) {}
  log(`- ${p.name} salió (${reason}). Conectados: ${peers.size}`);
  for (const [, q] of peers) sse(q.res, { type: 'peer-left' });
}

function handleEvents(req, res, url) {
  const key = url.searchParams.get('key') || '';
  const session = url.searchParams.get('session') || '';
  const name = (url.searchParams.get('name') || 'dispositivo').slice(0, 32);
  if (!/^[\w-]{8,64}$/.test(key) || !/^[\w-]{4,64}$/.test(session)) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Parámetros inválidos');
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');

  const existing = peers.get(key);
  let resumed = false;
  if (existing && existing.session === session) {
    // Mismo dispositivo y misma carga de página: solo se cayó la conexión de
    // señalización. El audio P2P sigue vivo, así que NO avisamos al otro.
    resumed = true;
    try { existing.res.end(); } catch (_) {}
    existing.res = res;
    existing.lastSeen = Date.now();
    log(`~ ${name} recuperó la señalización`);
  } else {
    if (existing) removePeer(key, 'recargó la página');
    if (peers.size >= MAX_PEERS) {
      const now = Date.now();
      for (const [k, p] of [...peers]) if (now - p.lastSeen > STALE_MS) removePeer(k, 'sin respuesta');
    }
    if (peers.size >= MAX_PEERS) {
      sse(res, { type: 'full' });
      return res.end();
    }
    peers.set(key, { res, session, name, lastSeen: Date.now() });
    log(`+ ${name} entró desde ${req.socket.remoteAddress}. Conectados: ${peers.size}`);
  }

  const me = peers.get(key);
  sse(res, { type: 'welcome', resumed, peers: peers.size });

  if (!resumed) {
    const op = otherPeer(key);
    if (op) {
      // El que ya estaba esperando crea la oferta; el recién llegado responde.
      sse(op.res, { type: 'start', peerName: name });
      sse(res, { type: 'peer-present', peerName: op.name });
    }
  }

  const keepAlive = setInterval(() => {
    try { res.write(': ka\n\n'); } catch (_) {}
  }, 10000);

  req.on('close', () => {
    clearInterval(keepAlive);
    // Solo se elimina si esta respuesta sigue siendo la vigente para ese dispositivo.
    // Si se cayó solo la señalización, el dispositivo vuelve con la misma sesión.
    if (peers.get(key) === me && me.res === res) {
      setTimeout(() => {
        if (peers.get(key) === me && me.res === res) removePeer(key, 'desconectado');
      }, 8000);
    }
  });
}

function handleSignal(req, res) {
  let body = '';
  let size = 0;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > 256 * 1024) { req.destroy(); return; }
    body += chunk;
  });
  req.on('end', () => {
    let msg;
    try { msg = JSON.parse(body); } catch (_) {
      res.writeHead(400); return res.end();
    }
    const me = peers.get(msg.key);
    if (!me) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      return res.end('{"error":"sin-sesion"}');
    }
    me.lastSeen = Date.now();
    if (msg.type === 'leave') {
      removePeer(msg.key, 'terminó');
    } else if (msg.type === 'signal') {
      const op = otherPeer(msg.key);
      if (op) sse(op.res, { type: 'signal', data: msg.data });
    }
    res.writeHead(204);
    res.end();
  });
}

/* ------------------------------------------------------------------ */
/* Archivos estáticos                                                  */
/* ------------------------------------------------------------------ */
function serveFile(res, file, type) {
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('No encontrado');
    }
    res.writeHead(200, {
      'Content-Type': type || MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  });
}

function isLoopback(addr) {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function makeHandler(secure) {
  return (req, res) => {
    const url = new URL(req.url, 'http://local');
    const p = url.pathname;

    if (p === '/events' && req.method === 'GET') return handleEvents(req, res, url);
    if (p === '/signal' && req.method === 'POST') return handleSignal(req, res);

    if (p === '/ca.crt') {
      // Safari en iPhone reconoce este tipo y ofrece instalarlo como perfil.
      return serveFile(res, path.join(CERTS, 'ca.crt'), 'application/x-x509-ca-cert');
    }

    if (p === '/' || p === '/index.html') {
      // El micrófono solo funciona en HTTPS o en localhost.
      const canUseMic = secure || isLoopback(req.socket.remoteAddress);
      return serveFile(res, path.join(PUBLIC, canUseMic ? 'index.html' : 'setup.html'));
    }

    if (PUBLIC_FILES.has(p)) return serveFile(res, path.join(PUBLIC, p));

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('No encontrado');
  };
}

/* Arranque                                                            */
function lanIps() {
  if (process.env.LAN_IPS) return process.env.LAN_IPS.split(/\s+/).filter(Boolean);
  try {
    return Object.values(os.networkInterfaces()).flat()
      .filter((i) => i && i.family === 'IPv4' && !i.internal)
      .map((i) => i.address);
  } catch (_) {
    return []; // En Android 11+ esta llamada puede estar bloqueada.
  }
}

function onListenError(port) {
  return (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n✖ El puerto ${port} ya está en uso. ¿Hay otro servidor abierto? Ciérralo (Ctrl+C) e inténtalo de nuevo.`);
    } else {
      console.error(`\n✖ Error en el puerto ${port}:`, err.message);
    }
    process.exit(1);
  };
}

const httpServer = http.createServer(makeHandler(false));
httpServer.on('error', onListenError(HTTP_PORT));
httpServer.listen(HTTP_PORT); // sin host: escucha en IPv4 e IPv6 (localhost puede ser ::1)

let httpsServer = null;
try {
  const opts = {
    key: fs.readFileSync(path.join(CERTS, 'server.key')),
    cert: fs.readFileSync(path.join(CERTS, 'server.crt')),
  };
  httpsServer = https.createServer(opts, makeHandler(true));
  httpsServer.on('error', onListenError(HTTPS_PORT));
  httpsServer.listen(HTTPS_PORT);
} catch (_) {
  console.warn('⚠ No hay certificado de servidor (certs/server.crt). Solo funcionará http://localhost.');
  console.warn('  Inicia con: bash start.sh');
}

httpServer.on('listening', () => {
  const ips = lanIps();
  console.log('\n==============================================');
  console.log('  INTERCOM MOTO — servidor encendido');
  console.log('==============================================');
  console.log(`  ANDROID (este celular), en Chrome:  http://localhost:${HTTP_PORT}`);
  if (ips.length) {
    for (const ip of ips) {
      console.log(`  iPHONE, en Safari:                  https://${ip}:${HTTPS_PORT}`);
    }
    console.log(`  iPhone, primera vez (certificado):  http://${ips[0]}:${HTTP_PORT}`);
  } else {
    console.log('  iPHONE: usa la IP que aparece en Ajustes › Wi-Fi › (i) › Router');
    console.log(`          https://ESA-IP:${HTTPS_PORT}`);
  }
  console.log('----------------------------------------------');
  console.log('  Deja esta ventana abierta. Ctrl+C para apagar.\n');
});

process.on('SIGINT', () => { log('Apagando…'); process.exit(0); });
