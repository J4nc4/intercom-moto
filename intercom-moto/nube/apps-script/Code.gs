/**
 * Intercom Moto — señalización en la nube con Google Apps Script.
 *
 * Qué hace este script:
 *   - Valida TOKENS firmados (HMAC-SHA256). Sin un token válido no se puede
 *     entrar a la sala, ni enviar mensajes, ni obtener credenciales TURN.
 *   - Hace de "buzón" de señalización WebRTC entre los dos celulares
 *     (ofertas/respuestas SDP y candidatos ICE) mediante consultas periódicas.
 *   - Entrega credenciales TURN temporales de Cloudflare (la llave queda
 *     guardada aquí, nunca llega al navegador).
 *
 * Qué NO hace: no transporta la voz. El audio va directo entre los celulares
 * (o a través del TURN cuando la red móvil no deja conectar directo).
 *
 * Nota: la página NO puede alojarse en Apps Script (HtmlService), porque
 * Google no le concede permiso de micrófono a ese iframe. La página se publica
 * en GitHub Pages (carpeta docs/) y llama a este script con fetch().
 *
 * FUNCIONES PARA EJECUTAR DESDE EL EDITOR (menú "Ejecutar"):
 *   configurar()        -> crea el secreto de firma (una sola vez)
 *   crearTokensViaje()  -> genera los enlaces del piloto y del pasajero
 *   crearToken(nombre, dias, sala)
 *   revocarToken(id)    -> invalida un token concreto
 *   revocarTodos()      -> cambia el secreto: invalida TODOS los tokens
 *   probarTurn()        -> verifica las credenciales de Cloudflare
 */

const CFG = {
  MAX_PEERS: 2,                         // piloto + pasajero
  PEER_TIMEOUT_MS: 10 * 60 * 1000,      // tolera 10 min sin consultas (pantalla bloqueada)
  ROOM_CACHE_S: 6 * 60 * 60,            // máximo permitido por CacheService (6 h)
  MAX_QUEUE: 150,                       // mensajes pendientes por participante
  MAX_ROOM_BYTES: 90 * 1024,            // CacheService admite 100 KB por valor
  TURN_TTL_S: 12 * 60 * 60,             // vida de las credenciales TURN
  POLL_FAST_MS: 1200,                   // sugerencia al cliente mientras negocia
  POLL_SLOW_MS: 5000,                   // sugerencia al cliente ya conectado
};

/* ================================================================== */
/* Entradas HTTP                                                       */
/* ================================================================== */

function doGet(e) {
  // Solo informa que el servicio está vivo. No revela salas ni participantes.
  return json_({ ok: true, service: 'intercom-moto', version: 1, time: Date.now() });
}

function doPost(e) {
  let req;
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, error: 'json' });
  }
  try {
    return json_(handle_(req));
  } catch (err) {
    console.error(err && err.stack || err);
    return json_({ ok: false, error: 'server', detail: String(err && err.message || err) });
  }
}

function handle_(req) {
  const tok = verifyToken_(req.token);
  if (!tok.ok) return { ok: false, error: 'token', detail: tok.reason };

  const session = String(req.session || '');
  if (!/^[\w-]{4,64}$/.test(session)) return { ok: false, error: 'session' };

  switch (req.action) {
    case 'join':  return join_(tok.claims, session);
    case 'poll':  return poll_(tok.claims, session, Number(req.ack) || 0);
    case 'send':  return send_(tok.claims, session, req.data);
    case 'leave': return leave_(tok.claims, session);
    default:      return { ok: false, error: 'action' };
  }
}

/* ================================================================== */
/* Sala                                                                */
/* ================================================================== */

function join_(c, session) {
  return withRoom_(c.r, function (room, now) {
    const me = c.i;
    const existing = room.peers[me];
    let resumed = false;

    if (existing && existing.session === session) {
      resumed = true;                      // misma página: solo volvió a entrar
      existing.seen = now;
    } else {
      if (existing) removePeer_(room, me, 'recargó');
      if (Object.keys(room.peers).length >= CFG.MAX_PEERS) {
        return { ok: false, error: 'full' };
      }
      room.peers[me] = { name: c.n, session: session, seen: now, seq: 0, q: [] };
    }

    let peerName = null;
    if (!resumed) {
      for (const id in room.peers) {
        if (id === me) continue;
        peerName = room.peers[id].name;
        // El que ya estaba esperando crea la oferta; el recién llegado responde.
        enqueue_(room.peers[id], { type: 'start', peerName: c.n });
      }
    }
    return {
      ok: true,
      resumed: resumed,
      me: c.n,
      peers: Object.keys(room.peers).length,
      peerPresent: peerName,
      iceServers: getIceServers_(),
      poll: { fast: CFG.POLL_FAST_MS, slow: CFG.POLL_SLOW_MS },
      expires: c.e,
    };
  });
}

function poll_(c, session, ack) {
  return withRoom_(c.r, function (room, now) {
    const me = room.peers[c.i];
    if (!me || me.session !== session) return { ok: false, error: 'not-joined' };
    me.seen = now;
    me.q = me.q.filter(function (m) { return m.s > ack; });   // confirmados: se borran
    let peerSeen = null;
    for (const id in room.peers) if (id !== c.i) peerSeen = now - room.peers[id].seen;
    return {
      ok: true,
      msgs: me.q,
      peers: Object.keys(room.peers).length,
      peerIdleMs: peerSeen,
    };
  });
}

function send_(c, session, data) {
  if (data === undefined || data === null) return { ok: false, error: 'data' };
  if (JSON.stringify(data).length > 20000) return { ok: false, error: 'too-big' };
  return withRoom_(c.r, function (room, now) {
    const me = room.peers[c.i];
    if (!me || me.session !== session) return { ok: false, error: 'not-joined' };
    me.seen = now;
    let delivered = 0;
    for (const id in room.peers) {
      if (id === c.i) continue;
      enqueue_(room.peers[id], { type: 'signal', data: data });
      delivered++;
    }
    return { ok: true, delivered: delivered };
  });
}

function leave_(c, session) {
  return withRoom_(c.r, function (room) {
    const me = room.peers[c.i];
    if (me && me.session === session) removePeer_(room, c.i, 'terminó');
    return { ok: true };
  });
}

/* --------------------------- utilidades de sala ------------------------ */

function withRoom_(roomId, fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const cache = CacheService.getScriptCache();
    const key = 'room:' + roomId;
    const raw = cache.get(key);
    const room = raw ? JSON.parse(raw) : { peers: {} };
    const now = Date.now();

    // Quien lleve más de 10 min sin consultar se considera fuera de la sala.
    for (const id in room.peers) {
      if (now - room.peers[id].seen > CFG.PEER_TIMEOUT_MS) removePeer_(room, id, 'sin respuesta');
    }

    const result = fn(room, now);
    shrink_(room);
    cache.put(key, JSON.stringify(room), CFG.ROOM_CACHE_S);
    return result;
  } finally {
    lock.releaseLock();
  }
}

function enqueue_(peer, msg) {
  peer.seq = (peer.seq || 0) + 1;
  msg.s = peer.seq;
  peer.q.push(msg);
  if (peer.q.length > CFG.MAX_QUEUE) peer.q.splice(0, peer.q.length - CFG.MAX_QUEUE);
}

function removePeer_(room, id, reason) {
  if (!room.peers[id]) return;
  delete room.peers[id];
  for (const other in room.peers) enqueue_(room.peers[other], { type: 'peer-left', reason: reason });
}

// Mantiene la sala por debajo del límite de 100 KB de CacheService
// descartando primero los candidatos ICE más viejos.
function shrink_(room) {
  let size = JSON.stringify(room).length;
  while (size > CFG.MAX_ROOM_BYTES) {
    let removed = false;
    for (const id in room.peers) {
      const q = room.peers[id].q;
      const idx = q.findIndex(function (m) { return m.type === 'signal' && m.data && (m.data.candidate || m.data.candidates); });
      if (idx >= 0) { q.splice(idx, 1); removed = true; break; }
    }
    if (!removed) {
      for (const id in room.peers) if (room.peers[id].q.length) { room.peers[id].q.shift(); removed = true; break; }
    }
    if (!removed) break;
    size = JSON.stringify(room).length;
  }
}

/* ================================================================== */
/* Tokens firmados                                                     */
/* ================================================================== */
// Formato: v1.<datos en base64url>.<firma HMAC-SHA256 en base64url>
// Datos: { r: sala, n: nombre visible, i: id del token, e: vence (ms) }

function verifyToken_(token) {
  if (typeof token !== 'string' || token.length > 600) return { ok: false, reason: 'formato' };
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return { ok: false, reason: 'formato' };
  const secret = props_().getProperty('TOKEN_SECRET');
  if (!secret) return { ok: false, reason: 'servidor-sin-configurar' };

  const expected = sign_(parts[0] + '.' + parts[1], secret);
  if (!safeEqual_(expected, parts[2])) return { ok: false, reason: 'firma' };

  let claims;
  try {
    claims = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(pad_(parts[1]))).getDataAsString());
  } catch (err) {
    return { ok: false, reason: 'formato' };
  }
  if (!claims || !claims.r || !claims.i || !claims.n) return { ok: false, reason: 'formato' };
  if (claims.e && Date.now() > claims.e) return { ok: false, reason: 'vencido' };
  const revoked = (props_().getProperty('REVOKED') || '').split(',');
  if (revoked.indexOf(claims.i) >= 0) return { ok: false, reason: 'revocado' };
  if (!/^[\w-]{1,40}$/.test(claims.r) || !/^[\w-]{1,40}$/.test(claims.i)) return { ok: false, reason: 'formato' };
  claims.n = String(claims.n).slice(0, 24);
  return { ok: true, claims: claims };
}

function makeToken_(claims) {
  const secret = props_().getProperty('TOKEN_SECRET');
  if (!secret) throw new Error('Primero ejecuta configurar()');
  const body = Utilities.base64EncodeWebSafe(JSON.stringify(claims), Utilities.Charset.UTF_8).replace(/=+$/, '');
  const head = 'v1.' + body;
  return head + '.' + sign_(head, secret);
}

function sign_(text, secret) {
  const bytes = Utilities.computeHmacSha256Signature(text, secret, Utilities.Charset.UTF_8);
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, '');
}

function safeEqual_(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function pad_(s) { return s + '==='.slice((s.length + 3) % 4); }

function randomId_(n) {
  let s = '';
  while (s.length < n) s += Utilities.getUuid().replace(/-/g, '');
  return s.slice(0, n);
}

function props_() { return PropertiesService.getScriptProperties(); }

/* ================================================================== */
/* TURN (Cloudflare Realtime)                                          */
/* ================================================================== */
// Propiedades del script (Configuración del proyecto › Propiedades del script):
//   CF_TURN_KEY_ID     -> "Turn Token ID" de Cloudflare
//   CF_TURN_API_TOKEN  -> "API Token" de esa llave TURN
// Alternativa: ICE_SERVERS_JSON con un arreglo iceServers propio (p. ej. Metered).

const FALLBACK_STUN = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];

function getIceServers_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get('ice');
  if (cached) return JSON.parse(cached);

  const p = props_();
  let servers = null;

  const custom = p.getProperty('ICE_SERVERS_JSON');
  if (custom) {
    try { servers = JSON.parse(custom); } catch (err) { console.error('ICE_SERVERS_JSON inválido'); }
  }

  const keyId = p.getProperty('CF_TURN_KEY_ID');
  const apiToken = p.getProperty('CF_TURN_API_TOKEN');
  if (!servers && keyId && apiToken) {
    const res = UrlFetchApp.fetch(
      'https://rtc.live.cloudflare.com/v1/turn/keys/' + encodeURIComponent(keyId) + '/credentials/generate-ice-servers',
      {
        method: 'post',
        contentType: 'application/json',
        headers: { Authorization: 'Bearer ' + apiToken },
        payload: JSON.stringify({ ttl: CFG.TURN_TTL_S }),
        muteHttpExceptions: true,
      });
    const code = res.getResponseCode();
    if (code === 200 || code === 201) {
      servers = JSON.parse(res.getContentText()).iceServers || null;
      // El puerto 53 lo bloquean los navegadores: se quita para evitar esperas.
      if (servers) {
        servers = servers.map(function (s) {
          const urls = [].concat(s.urls).filter(function (u) { return !/:53(\?|$)/.test(u); });
          return Object.assign({}, s, { urls: urls });
        });
      }
    } else {
      console.error('Cloudflare TURN respondió ' + code + ': ' + res.getContentText().slice(0, 300));
    }
  }

  if (!servers) servers = FALLBACK_STUN;
  // Se guarda en caché menos tiempo del que duran las credenciales.
  const keep = servers === FALLBACK_STUN ? 600 : Math.min(CFG.TURN_TTL_S - 3600, 21600);
  cache.put('ice', JSON.stringify(servers), keep);
  return servers;
}

/* ================================================================== */
/* Funciones de administración (se ejecutan desde el editor)          */
/* ================================================================== */

function configurar() {
  const p = props_();
  if (!p.getProperty('TOKEN_SECRET')) {
    p.setProperty('TOKEN_SECRET', randomId_(64));
    console.log('✔ Secreto de firma creado.');
  } else {
    console.log('» El secreto ya existía; no se cambió.');
  }
  if (!p.getProperty('SALA')) p.setProperty('SALA', 'moto-' + randomId_(8));
  console.log('Sala: ' + p.getProperty('SALA'));
  console.log('Siguiente paso: implementa como Aplicación web y guarda la URL /exec en docs/config.js.');
  console.log('Luego, en Propiedades del script, agrega PAGE_URL con la dirección de tu GitHub Pages.');
}

/** Crea un token. dias = 0 -> no vence. */
function crearToken(nombre, dias, sala) {
  const p = props_();
  nombre = String(nombre || 'Invitado').slice(0, 24);
  dias = Number(dias === undefined ? 30 : dias);
  sala = sala || p.getProperty('SALA');
  if (!sala) throw new Error('Primero ejecuta configurar()');
  const claims = { r: sala, n: nombre, i: randomId_(12) };
  if (dias > 0) claims.e = Date.now() + dias * 24 * 3600 * 1000;
  const token = makeToken_(claims);
  const page = p.getProperty('PAGE_URL');
  console.log('──────────────────────────────────────────');
  console.log('Token de ' + nombre + ' (id ' + claims.i + ', ' + (dias > 0 ? 'vence en ' + dias + ' días' : 'no vence') + ')');
  console.log(page ? 'Enlace: ' + page.replace(/\/?$/, '/') + '#t=' + token : 'Token: ' + token);
  return token;
}

/** Genera los dos enlaces del viaje (uno por persona). */
function crearTokensViaje() {
  crearToken('Piloto', 30);
  crearToken('Pasajero', 30);
  console.log('Envía a cada persona SOLO su propio enlace. Cada enlace sirve para un celular.');
}

function revocarToken(id) {
  if (!id) throw new Error('Indica el id del token (aparece al crearlo).');
  const p = props_();
  const list = (p.getProperty('REVOKED') || '').split(',').filter(String);
  if (list.indexOf(id) < 0) list.push(id);
  p.setProperty('REVOKED', list.slice(-300).join(','));
  console.log('✔ Token ' + id + ' revocado.');
}

function revocarTodos() {
  props_().setProperty('TOKEN_SECRET', randomId_(64));
  props_().deleteProperty('REVOKED');
  console.log('✔ Secreto cambiado: todos los tokens anteriores dejaron de funcionar. Crea nuevos con crearTokensViaje().');
}

function probarTurn() {
  CacheService.getScriptCache().remove('ice');
  const s = getIceServers_();
  const hasTurn = JSON.stringify(s).indexOf('turn:') >= 0;
  console.log(hasTurn ? '✔ TURN configurado: ' + JSON.stringify(s[s.length - 1].urls)
                      : '⚠ Sin TURN: solo STUN. En datos móviles puede no conectar. Revisa CF_TURN_KEY_ID y CF_TURN_API_TOKEN.');
}

/* ------------------------------------------------------------------ */
function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
