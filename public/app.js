'use strict';
/*
 * Intercom Moto — cliente (Firefox/Chrome en Android, Safari en iPhone).
 * WebRTC P2P en la red del hotspot: sin STUN/TURN, sin Internet.
 *
 * Pantalla bloqueada / segundo plano:
 *  - Firefox Android mantiene el micrófono con la pantalla bloqueada.
 *  - Chrome Android corta el micrófono ~5 s después (bug de Chromium 374374232).
 *  - Safari iOS puede pausar audio/micrófono al bloquear; depende de la versión.
 *  La página hace todo lo posible por seguir activa (Media Session, sesión de audio
 *  de llamada, reproducción continua, señalización que tolera cortes) y, al volver,
 *  MIDE si el audio siguió fluyendo mientras la pantalla estuvo bloqueada.
 */
const $ = (s) => document.querySelector(s);
const ui = {
  device: $('#device'),
  tip: $('#tip'),
  statusBox: $('#statusBox'),
  status: $('#status'),
  substatus: $('#substatus'),
  bgReport: $('#bgReport'),
  bgText: $('#bgText'),
  bgOk: $('#bgOk'),
  meLevel: $('#meLevel'),
  peerLevel: $('#peerLevel'),
  meTxt: $('#meTxt'),
  peerTxt: $('#peerTxt'),
  connect: $('#btnConnect'),
  mute: $('#btnMute'),
  hangup: $('#btnHangup'),
  keepAwake: $('#keepAwake'),
  stats: $('#stats'),
  log: $('#log'),
  audio: $('#remoteAudio'),
};

const UA = navigator.userAgent;
const IS_IOS = /iPhone|iPad|iPod/.test(UA) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const IS_ANDROID = /Android/.test(UA);
const IS_FIREFOX = /Firefox\//.test(UA);
const IS_ANDROID_CHROME = IS_ANDROID && !IS_FIREFOX && /Chrome\//.test(UA);

const AUDIO_CONSTRAINTS = {
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1,
  },
  video: false,
};
const MAX_BITRATE = 32000; // 32 kb/s Opus: voz muy clara y poco consumo

const S = {
  key: deviceKey(),                  // id estable de este celular
  session: randomId(),               // id de esta carga de la página
  name: deviceName(),
  active: false,
  es: null,
  pc: null,
  pcSerial: 0,                       // cambia cada vez que se crea una conexión nueva
  caller: false,
  stream: null,
  muted: false,
  full: false,
  pendingIce: [],
  wakeLock: null,
  keepAwake: loadKeepAwake(),
  restartTimer: null,
  pingTimer: null,
  statsTimer: null,
  prev: {},
  tuned: false,
  // monitoreo de segundo plano
  snap: null,                        // últimos contadores RTP conocidos
  hidden: null,                      // { at, snap } al ocultarse la página
  peerHidden: false,
  rxIdleSecs: 0,
};

ui.device.textContent = S.name + (IS_FIREFOX ? ' · Firefox' : IS_ANDROID_CHROME ? ' · Chrome' : IS_IOS ? ' · Safari' : '');
ui.keepAwake.checked = S.keepAwake;
showBrowserTip();

/* ---------------------------- utilidades ---------------------------- */
function randomId() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function store(k, v) { try { localStorage.setItem(k, v); } catch (_) {} }
function load(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }

function deviceKey() {
  let k = load('intercomKey');
  if (!k) { k = randomId(); store('intercomKey', k); }
  return k;
}

function loadKeepAwake() {
  const v = load('intercomKeepAwake');
  if (v === '1') return true;
  if (v === '0') return false;
  // Por defecto: en Firefox Android se puede bloquear; en el resto, mejor pantalla encendida.
  return !(IS_ANDROID && IS_FIREFOX);
}

function deviceName() {
  if (IS_IOS) return 'iPhone';
  if (IS_ANDROID) return 'Android';
  return 'Computador';
}

function log(msg) {
  const line = `${new Date().toLocaleTimeString('es-CO')}  ${msg}`;
  console.log(line);
  const lines = (line + '\n' + ui.log.textContent).split('\n').slice(0, 250);
  ui.log.textContent = lines.join('\n');
}

function setStatus(text, kind) {
  ui.status.textContent = text;
  ui.statusBox.dataset.kind = kind || 'idle';
}

function setSub(text) {
  ui.substatus.textContent = text || '';
  ui.substatus.hidden = !text;
}

function vibrate(pattern) {
  try { navigator.vibrate && navigator.vibrate(pattern); } catch (_) {}
}

function fmtDur(ms) {
  const s = Math.round(ms / 1000);
  return s < 60 ? s + ' s' : Math.floor(s / 60) + ' min ' + String(s % 60).padStart(2, '0') + ' s';
}

function showBrowserTip() {
  let html = '';
  let kind = 'info';
  if (IS_ANDROID_CHROME) {
    kind = 'warn';
    html = '<b>Chrome corta el micrófono unos 5 s después de bloquear la pantalla.</b> ' +
      'Para usarlo con la pantalla bloqueada, abre esta misma dirección en <b>Firefox</b>.';
  } else if (IS_ANDROID && IS_FIREFOX) {
    kind = 'ok';
    html = '<b>Firefox mantiene el micrófono con la pantalla bloqueada.</b> Después de conectar puedes bloquear el celular.';
  } else if (IS_IOS) {
    html = '<b>iPhone:</b> Safari puede pausar el audio al bloquear la pantalla, según la versión de iOS. ' +
      'Haz la prueba: conecta, bloquea 1 minuto y desbloquea. La página te dirá si el audio siguió.';
  }
  ui.tip.innerHTML = html;
  ui.tip.dataset.kind = kind;
  ui.tip.hidden = !html;
}

/* ----------------------------- inicio ------------------------------- */
ui.connect.addEventListener('click', start);
ui.mute.addEventListener('click', toggleMute);
ui.hangup.addEventListener('click', hangup);
ui.bgOk.addEventListener('click', () => { ui.bgReport.hidden = true; });
ui.keepAwake.addEventListener('change', () => {
  S.keepAwake = ui.keepAwake.checked;
  store('intercomKeepAwake', S.keepAwake ? '1' : '0');
  if (S.keepAwake && S.active) requestWakeLock();
  if (!S.keepAwake) releaseWakeLock();
});
ui.audio.addEventListener('pause', () => {
  // Si el sistema pausa la reproducción (interrupción, segundo plano), reanudar.
  if (S.active && ui.audio.srcObject) setTimeout(unlockAudio, 300);
});

if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
  setStatus('Página no segura: el micrófono está bloqueado', 'err');
  log('Abre https://IP:8443 (iPhone) o http://localhost:8080 (Android servidor).');
  ui.connect.disabled = true;
}

async function start() {
  ui.connect.disabled = true;
  setStatus('Pidiendo permiso de micrófono…', 'wait');
  configureAudioSession();
  try {
    S.stream = await navigator.mediaDevices.getUserMedia(AUDIO_CONSTRAINTS);
  } catch (e) {
    setStatus('Sin permiso de micrófono (' + e.name + ')', 'err');
    log('getUserMedia falló: ' + e.name + ' ' + e.message);
    ui.connect.disabled = false;
    return;
  }
  watchTrack();
  S.active = true;
  unlockAudio();              // el toque del usuario habilita la reproducción
  setupMediaSession();
  if (S.keepAwake) await requestWakeLock();
  ui.connect.hidden = true;
  ui.mute.hidden = false;
  ui.hangup.hidden = false;
  openSignaling();
  clearInterval(S.statsTimer);
  S.statsTimer = setInterval(updateStats, 1000);
}

function unlockAudio() {
  ui.audio.muted = false;
  const p = ui.audio.play();
  if (p && p.catch) p.catch(() => {});
}

/* ------------- sesión de audio de "llamada" y Media Session ------------- */
function configureAudioSession() {
  // Safari 16.4+: declara que la página hace audio bidireccional (como una llamada).
  try {
    if (navigator.audioSession) {
      navigator.audioSession.type = 'play-and-record';
      log('Sesión de audio: play-and-record');
    }
  } catch (_) {}
}

function setupMediaSession(peerName) {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: 'Intercom Moto',
      artist: peerName ? 'Conectado con ' + peerName : 'Intercomunicador activo',
      album: 'Intercomunicador local',
    });
    navigator.mediaSession.playbackState = 'playing';
  } catch (_) {}
  const handlers = {
    togglemicrophone: () => toggleMute(),
    hangup: () => hangup(),
    // Sin pause/play: evita que un botón del casco o una interrupción silencie el micrófono.
  };
  for (const [action, fn] of Object.entries(handlers)) {
    try { navigator.mediaSession.setActionHandler(action, fn); } catch (_) {}
  }
  updateMediaSessionMic();
}

function updateMediaSessionMic() {
  try {
    if (navigator.mediaSession && navigator.mediaSession.setMicrophoneActive) {
      navigator.mediaSession.setMicrophoneActive(!S.muted);
    }
  } catch (_) {}
}

/* -------------------------- señalización ---------------------------- */
function openSignaling() {
  if (S.es) S.es.close();
  const q = new URLSearchParams({ key: S.key, session: S.session, name: S.name });
  const es = new EventSource('/events?' + q.toString());
  S.es = es;
  es.onopen = () => log('Servidor de señalización conectado');
  es.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch (_) { return; }
    onServerMessage(m).catch((e) => log('Error: ' + e.message));
  };
  es.onerror = () => {
    if (!S.active) return;
    if (!S.full && (!S.pc || S.pc.connectionState !== 'connected')) setStatus('Buscando el servidor…', 'warn');
    if (es.readyState === EventSource.CLOSED) {
      setTimeout(() => { if (S.active && S.es === es) openSignaling(); }, 2000);
    }
  };
  clearInterval(S.pingTimer);
  S.pingTimer = setInterval(() => post({ type: 'ping' }), 5000);
}

async function post(msg) {
  try {
    const r = await fetch('/signal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ key: S.key }, msg)),
      keepalive: true,
    });
    if (r.status === 409 && S.active) {
      log('El servidor no reconoce esta sesión: reconectando');
      openSignaling();
    }
  } catch (_) {
    /* red o servidor caídos: el EventSource reintentará */
  }
}

function sendSignal(data) { return post({ type: 'signal', data }); }

async function onServerMessage(m) {
  switch (m.type) {
    case 'welcome':
      S.full = false;
      if (m.resumed) { log('Señalización recuperada (el audio no se interrumpió)'); break; }
      closePeer();
      S.pendingIce = [];
      S.peerHidden = false;
      setSub('');
      setStatus(m.peers >= 2 ? 'Conectando…' : 'Esperando al otro celular…', 'wait');
      break;
    case 'full':
      S.full = true;
      setStatus('Ya hay dos celulares conectados', 'err');
      log('Sala llena. Se reintentará automáticamente.');
      break;
    case 'peer-present':
      log('Otro celular presente: ' + m.peerName);
      setStatus('Conectando con ' + m.peerName + '…', 'wait');
      setupMediaSession(m.peerName);
      break;
    case 'start':
      log('Entró ' + m.peerName + ': creando oferta');
      setupMediaSession(m.peerName);
      S.caller = true;
      newPeer();
      await makeOffer(false);
      break;
    case 'peer-left':
      log('El otro celular salió');
      closePeer();
      S.pendingIce = [];
      S.peerHidden = false;
      setSub('');
      setStatus('El otro se desconectó. Esperando…', 'wait');
      vibrate([80, 60, 80]);
      break;
    case 'signal':
      await onRemoteSignal(m.data || {});
      break;
  }
}

/* ----------------------------- WebRTC ------------------------------- */
function newPeer() {
  closePeer();
  const pc = new RTCPeerConnection({ iceServers: [] }); // red local: sin STUN/TURN
  S.pc = pc;
  S.pcSerial++;
  S.tuned = false;
  S.prev = {};
  S.rxIdleSecs = 0;
  for (const t of S.stream.getTracks()) pc.addTrack(t, S.stream);

  pc.onicecandidate = (e) => {
    if (e.candidate) sendSignal({ candidate: e.candidate.toJSON ? e.candidate.toJSON() : e.candidate });
  };
  pc.ontrack = (e) => {
    const stream = (e.streams && e.streams[0]) || new MediaStream([e.track]);
    if (ui.audio.srcObject !== stream) ui.audio.srcObject = stream;
    unlockAudio();
    log('Audio del otro celular recibido');
  };
  pc.onconnectionstatechange = () => onConnectionState(pc);
  pc.oniceconnectionstatechange = () => log('ICE: ' + pc.iceConnectionState);
  return pc;
}

function closePeer() {
  clearTimeout(S.restartTimer);
  if (S.pc) {
    const pc = S.pc;
    S.pc = null;
    pc.onicecandidate = pc.ontrack = pc.onconnectionstatechange = pc.oniceconnectionstatechange = null;
    try { pc.close(); } catch (_) {}
  }
  ui.audio.srcObject = null;
}

async function makeOffer(iceRestart) {
  const pc = S.pc;
  if (!pc) return;
  const offer = await pc.createOffer({ iceRestart: !!iceRestart });
  await pc.setLocalDescription(offer);
  const d = pc.localDescription;
  await sendSignal({ sdp: { type: d.type, sdp: d.sdp } });
}

async function onRemoteSignal(d) {
  if (d.sdp && d.sdp.type === 'offer') {
    S.caller = false;
    if (!S.pc) newPeer();
    const pc = S.pc;
    if (pc.signalingState !== 'stable') {
      try { await pc.setLocalDescription({ type: 'rollback' }); } catch (_) { newPeer(); }
    }
    await S.pc.setRemoteDescription(d.sdp);
    await flushIce();
    const answer = await S.pc.createAnswer();
    await S.pc.setLocalDescription(answer);
    const l = S.pc.localDescription;
    await sendSignal({ sdp: { type: l.type, sdp: l.sdp } });
  } else if (d.sdp && d.sdp.type === 'answer') {
    if (!S.pc || S.pc.signalingState !== 'have-local-offer') { log('Respuesta fuera de tiempo, ignorada'); return; }
    await S.pc.setRemoteDescription(d.sdp);
    await flushIce();
  } else if (d.candidate) {
    if (!S.pc || !S.pc.remoteDescription) { S.pendingIce.push(d.candidate); return; }
    try { await S.pc.addIceCandidate(d.candidate); } catch (e) { log('Candidato ICE descartado: ' + e.message); }
  } else if (d.restart) {
    if (S.caller) recover();
  } else if (typeof d.peerHidden === 'boolean') {
    S.peerHidden = d.peerHidden;
    log(d.peerHidden ? 'El otro celular bloqueó la pantalla o cambió de app' : 'El otro celular volvió a la página');
  }
}

async function flushIce() {
  const list = S.pendingIce.splice(0);
  for (const c of list) {
    try { await S.pc.addIceCandidate(c); } catch (_) {}
  }
}

function onConnectionState(pc) {
  if (pc !== S.pc) return;
  const st = pc.connectionState;
  log('Conexión: ' + st);
  clearTimeout(S.restartTimer);
  if (st === 'connected') {
    setStatus('Conectado — hablen normalmente', 'ok');
    vibrate(120);
    tuneSender(pc);
  } else if (st === 'new' || st === 'connecting') {
    setStatus('Conectando…', 'wait');
  } else if (st === 'disconnected') {
    setStatus('Señal débil, recuperando…', 'warn');
    S.restartTimer = setTimeout(recover, 4000);
  } else if (st === 'failed') {
    setStatus('Conexión perdida, reintentando…', 'warn');
    recover();
  }
}

function recover() {
  clearTimeout(S.restartTimer);
  if (!S.active || !S.pc || S.pc.connectionState === 'connected') return;
  if (S.caller) {
    log('Reiniciando ICE');
    makeOffer(true).catch((e) => log('Reinicio ICE falló: ' + e.message));
  } else {
    sendSignal({ restart: true });
  }
  S.restartTimer = setTimeout(recover, 8000); // si no se recupera, vuelve a intentar
}

async function tuneSender(pc) {
  if (S.tuned) return;
  S.tuned = true;
  for (const sender of pc.getSenders()) {
    if (!sender.track || sender.track.kind !== 'audio') continue;
    try {
      const p = sender.getParameters();
      if (!p.encodings || !p.encodings.length) p.encodings = [{}];
      p.encodings[0].maxBitrate = MAX_BITRATE;
      p.encodings[0].priority = 'high';
      p.encodings[0].networkPriority = 'high';
      await sender.setParameters(p);
      log('Audio ajustado a ' + MAX_BITRATE / 1000 + ' kb/s, prioridad alta');
    } catch (e) {
      log('No se pudo ajustar el bitrate: ' + e.message);
    }
  }
}

/* --------------------------- micrófono ------------------------------ */
function watchTrack() {
  const t = S.stream && S.stream.getAudioTracks()[0];
  if (!t) return;
  t.enabled = !S.muted;
  t.onended = () => { log('El sistema detuvo el micrófono'); reacquireMic(); };
  t.onmute = () => log('Micrófono pausado por el sistema (llamada, Siri o segundo plano)');
  t.onunmute = () => log('Micrófono reanudado');
}

async function reacquireMic() {
  if (!S.active) return;
  try {
    const fresh = await navigator.mediaDevices.getUserMedia(AUDIO_CONSTRAINTS);
    const track = fresh.getAudioTracks()[0];
    if (S.pc) {
      const sender = S.pc.getSenders().find((s) => !s.track || s.track.kind === 'audio');
      if (sender) await sender.replaceTrack(track);
    }
    if (S.stream) S.stream.getTracks().forEach((t) => t.stop());
    S.stream = fresh;
    watchTrack();
    log('Micrófono recuperado');
  } catch (e) {
    log('No se pudo recuperar el micrófono: ' + e.name);
  }
}

function toggleMute() {
  S.muted = !S.muted;
  if (S.stream) S.stream.getAudioTracks().forEach((t) => { t.enabled = !S.muted; });
  ui.mute.textContent = S.muted ? 'Micrófono SILENCIADO — tocar para activar' : 'Silenciar mi micrófono';
  ui.mute.classList.toggle('is-muted', S.muted);
  updateMediaSessionMic();
  vibrate(40);
}

function hangup() {
  S.active = false;
  post({ type: 'leave' });
  clearInterval(S.pingTimer);
  clearInterval(S.statsTimer);
  closePeer();
  if (S.es) { S.es.close(); S.es = null; }
  if (S.stream) { S.stream.getTracks().forEach((t) => t.stop()); S.stream = null; }
  releaseWakeLock();
  try { navigator.mediaSession.playbackState = 'none'; } catch (_) {}
  S.muted = false;
  S.peerHidden = false;
  ui.mute.textContent = 'Silenciar mi micrófono';
  ui.mute.classList.remove('is-muted');
  ui.connect.hidden = false;
  ui.connect.disabled = false;
  ui.mute.hidden = true;
  ui.hangup.hidden = true;
  setMeter(ui.meLevel, ui.meTxt, null);
  setMeter(ui.peerLevel, ui.peerTxt, null);
  setSub('');
  setStatus('Llamada terminada', 'idle');
}

window.addEventListener('pagehide', (e) => {
  // Solo al cerrar de verdad la pestaña (no al bloquear ni al ir a segundo plano).
  if (!S.active || e.persisted) return;
  try {
    navigator.sendBeacon('/signal', new Blob([JSON.stringify({ key: S.key, type: 'leave' })], { type: 'application/json' }));
  } catch (_) {}
});

/* ------------------- pantalla / segundo plano ----------------------- */
async function requestWakeLock() {
  if (!S.keepAwake || S.wakeLock) return;
  if (!('wakeLock' in navigator)) {
    log('Este navegador no puede mantener la pantalla encendida: desactiva el bloqueo automático');
    return;
  }
  try {
    S.wakeLock = await navigator.wakeLock.request('screen');
    S.wakeLock.addEventListener('release', () => { S.wakeLock = null; });
    log('La pantalla se mantendrá encendida');
  } catch (e) {
    log('No se pudo mantener la pantalla encendida: ' + e.message);
  }
}

function releaseWakeLock() {
  if (S.wakeLock) { S.wakeLock.release().catch(() => {}); S.wakeLock = null; }
}

document.addEventListener('visibilitychange', () => {
  if (!S.active) return;
  if (document.visibilityState === 'hidden') onHidden();
  else onVisible();
});

function onHidden() {
  S.hidden = { at: Date.now(), snap: S.snap ? Object.assign({}, S.snap) : null };
  log('Pantalla bloqueada o página en segundo plano');
  sendSignal({ peerHidden: true });
}

async function onVisible() {
  const hid = S.hidden;
  S.hidden = null;
  sendSignal({ peerHidden: false });
  if (S.keepAwake) requestWakeLock();
  unlockAudio();
  const t = S.stream && S.stream.getAudioTracks()[0];
  if (!t || t.readyState === 'ended') await reacquireMic();
  if (!S.es || S.es.readyState === EventSource.CLOSED) openSignaling();
  if (S.pc && S.pc.connectionState !== 'connected') recover();
  if (hid) reportBackground(hid);
}

// Compara los contadores RTP de antes y después del bloqueo para saber si el
// audio siguió fluyendo en ambos sentidos mientras la pantalla estuvo apagada.
async function reportBackground(hid) {
  const dur = Date.now() - hid.at;
  if (dur < 8000) return; // muy corto para sacar conclusiones
  const now = await readCounters();
  if (!hid.snap || !now || hid.snap.pc !== now.pc) {
    showReport('warn', `Pantalla bloqueada ${fmtDur(dur)}. La conexión se rehízo al volver, así que el audio probablemente se cortó mientras estaba bloqueada.`);
    return;
  }
  // Se comparan PAQUETES (no bytes): Opus sin DTX envía ~50 paquetes/s aunque haya silencio.
  const secs = dur / 1000;
  const txPps = (now.sent - hid.snap.sent) / secs;
  const rxPps = (now.recv - hid.snap.recv) / secs;
  const refTx = Math.max(hid.snap.txPps || 0, 25);
  const refRx = Math.max(hid.snap.rxPps || 0, 25);
  const txPct = Math.min(100, Math.round((100 * txPps) / refTx));
  const rxPct = Math.min(100, Math.round((100 * rxPps) / refRx));
  const ok = (p) => p >= 80;
  const txMsg = ok(txPct) ? 'tu micrófono siguió enviando ✔' :
    txPct > 5 ? `tu micrófono envió solo ~${Math.round((txPct * secs) / 100)} s de ${Math.round(secs)} s ✖` :
      'tu micrófono se detuvo ✖';
  const rxMsg = ok(rxPct) ? 'el audio del otro siguió llegando ✔' :
    rxPct > 5 ? 'el audio del otro llegó solo en parte ✖' : 'no llegó audio del otro ✖';
  const good = ok(txPct) && ok(rxPct);
  showReport(good ? 'ok' : 'warn',
    `Pantalla bloqueada ${fmtDur(dur)}: ${txMsg}; ${rxMsg}.` +
    (good ? ' Este celular funciona con la pantalla bloqueada.' :
      ' En este celular deja la pantalla encendida' + (IS_ANDROID_CHROME ? ' o usa Firefox.' : '.')));
  log(`Prueba de bloqueo: envío ${txPct}% · recepción ${rxPct}% (${fmtDur(dur)})`);
}

function showReport(kind, text) {
  ui.bgText.textContent = text;
  ui.bgReport.dataset.kind = kind;
  ui.bgReport.hidden = false;
}

/* ------------------------ medidores y datos ------------------------- */
function setMeter(bar, txt, level) {
  if (level == null) {
    bar.style.width = '0%';
    txt.textContent = '—';
    return;
  }
  // audioLevel es lineal (0..1); la raíz lo hace más visible al hablar
  const pct = Math.min(100, Math.round(Math.sqrt(level) * 140));
  bar.style.width = pct + '%';
  txt.textContent = level > 0.0001 ? (20 * Math.log10(level)).toFixed(0) + ' dBFS' : 'silencio';
}

function rate(id, value, ts) {
  const p = S.prev[id];
  S.prev[id] = { value, ts };
  if (!p || ts <= p.ts) return null;
  return (value - p.value) / ((ts - p.ts) / 1000); // unidades por segundo
}

async function readCounters() {
  const pc = S.pc;
  if (!pc) return null;
  let report;
  try { report = await pc.getStats(); } catch (_) { return null; }
  let sent = 0, recv = 0;
  report.forEach((r) => {
    if (r.type === 'outbound-rtp' && (r.kind || r.mediaType) === 'audio') sent = r.packetsSent || 0;
    if (r.type === 'inbound-rtp' && (r.kind || r.mediaType) === 'audio') recv = r.packetsReceived || 0;
  });
  return { pc: S.pcSerial, sent, recv };
}

async function updateStats() {
  const pc = S.pc;
  if (!pc) {
    setMeter(ui.meLevel, ui.meTxt, null);
    setMeter(ui.peerLevel, ui.peerTxt, null);
    ui.stats.innerHTML = '<dt>Estado</dt><dd>Sin conexión con el otro celular</dd>';
    return;
  }
  let report;
  try { report = await pc.getStats(); } catch (_) { return; }
  if (pc !== S.pc) return;

  let inb, outb, src, pairId;
  const pairs = [];
  report.forEach((r) => {
    if (r.type === 'inbound-rtp' && (r.kind || r.mediaType) === 'audio') inb = r;
    else if (r.type === 'outbound-rtp' && (r.kind || r.mediaType) === 'audio') outb = r;
    else if (r.type === 'media-source' && r.kind === 'audio') src = r;
    else if (r.type === 'transport' && r.selectedCandidatePairId) pairId = r.selectedCandidatePairId;
    else if (r.type === 'candidate-pair') pairs.push(r);
  });
  const pair = (pairId && report.get(pairId)) ||
    pairs.find((p) => p.nominated && p.state === 'succeeded') || pairs.find((p) => p.selected);

  setMeter(ui.meLevel, ui.meTxt, S.muted ? 0 : (src && typeof src.audioLevel === 'number' ? src.audioLevel : null));
  setMeter(ui.peerLevel, ui.peerTxt, inb && typeof inb.audioLevel === 'number' ? inb.audioLevel : null);

  const now = performance.now();
  const rxBps = inb ? rate('rxB', inb.bytesReceived || 0, now) : null;
  const txBps = outb ? rate('txB', outb.bytesSent || 0, now) : null;
  const rxPps = inb ? rate('rxP', inb.packetsReceived || 0, now) : null;
  const txPps = outb ? rate('txP', outb.packetsSent || 0, now) : null;

  // Contadores (en paquetes) para la prueba de pantalla bloqueada
  S.snap = {
    pc: S.pcSerial,
    sent: outb ? outb.packetsSent || 0 : 0,
    recv: inb ? inb.packetsReceived || 0 : 0,
    txPps: txPps != null ? txPps : (S.snap && S.snap.txPps) || 0,
    rxPps: rxPps != null ? rxPps : (S.snap && S.snap.rxPps) || 0,
  };

  // ¿Está llegando audio del otro? (Opus sin DTX envía ~50 paquetes/s incluso en silencio)
  if (pc.connectionState === 'connected' && rxPps != null) {
    S.rxIdleSecs = rxPps < 1 ? S.rxIdleSecs + 1 : 0;
    if (S.rxIdleSecs >= 3) {
      setSub(S.peerHidden ?
        'El otro celular bloqueó la pantalla y su navegador pausó el audio. Se reanuda al desbloquear.' :
        'No está llegando audio del otro celular.');
    } else {
      setSub(S.peerHidden ? 'El otro celular tiene la pantalla bloqueada — su audio sigue llegando ✔' : '');
    }
  }

  const rows = [['Estado', pc.connectionState + ' / ICE ' + pc.iceConnectionState]];
  if (pair) {
    const lc = report.get(pair.localCandidateId) || {};
    const rc = report.get(pair.remoteCandidateId) || {};
    const addr = (c) => `${c.address || c.ip || 'IP oculta'}:${c.port || '?'} (${c.candidateType || '?'}, ${c.protocol || '?'})`;
    rows.push(['Local', addr(lc)]);
    rows.push(['Remoto', addr(rc)]);
    if (typeof pair.currentRoundTripTime === 'number') rows.push(['RTT', (pair.currentRoundTripTime * 1000).toFixed(0) + ' ms']);
  }
  if (inb) {
    const codec = inb.codecId && report.get(inb.codecId);
    if (codec) rows.push(['Códec', `${codec.mimeType} ${codec.clockRate / 1000} kHz`]);
    if (rxBps != null) rows.push(['Recibiendo', ((rxBps * 8) / 1000).toFixed(1) + ' kb/s · ' + Math.round(rxPps) + ' paq/s']);
    if (typeof inb.jitter === 'number') rows.push(['Jitter', (inb.jitter * 1000).toFixed(1) + ' ms']);
    const lost = inb.packetsLost || 0;
    const got = inb.packetsReceived || 0;
    rows.push(['Pérdida', (got + lost ? (100 * lost / (got + lost)).toFixed(2) : '0.00') + ' % (' + lost + ' paquetes)']);
    if (inb.jitterBufferDelay && inb.jitterBufferEmittedCount) {
      rows.push(['Buffer jitter', (1000 * inb.jitterBufferDelay / inb.jitterBufferEmittedCount).toFixed(0) + ' ms']);
    }
  }
  if (txBps != null) rows.push(['Enviando', ((txBps * 8) / 1000).toFixed(1) + ' kb/s']);
  ui.stats.innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(String(v))}</dd>`).join('');
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
