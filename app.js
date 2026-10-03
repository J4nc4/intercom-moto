'use strict';
/*
 * Intercom Moto — cliente (Chrome Android / Safari iPhone).
 * WebRTC P2P en la red del hotspot: sin STUN/TURN, sin Internet.
 */
const $ = (s) => document.querySelector(s);
const ui = {
  device: $('#device'),
  statusBox: $('#statusBox'),
  status: $('#status'),
  bgWarn: $('#bgWarn'),
  bgOk: $('#bgOk'),
  meLevel: $('#meLevel'),
  peerLevel: $('#peerLevel'),
  meTxt: $('#meTxt'),
  peerTxt: $('#peerTxt'),
  connect: $('#btnConnect'),
  mute: $('#btnMute'),
  hangup: $('#btnHangup'),
  stats: $('#stats'),
  log: $('#log'),
  audio: $('#remoteAudio'),
};

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
  session: randomId(),               // id de esta carga de la pagina
  name: deviceName(),
  active: false,
  es: null,
  pc: null,
  caller: false,
  stream: null,
  muted: false,
  pendingIce: [],
  wakeLock: null,
  wasHidden: false,
  restartTimer: null,
  pingTimer: null,
  statsTimer: null,
  prev: {},
  tuned: false,
};

ui.device.textContent = S.name;

/* ---------------------------- utilidades ---------------------------- */
function randomId() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function deviceKey() {
  let k = null;
  try { k = localStorage.getItem('intercomKey'); } catch (_) {}
  if (!k) {
    k = randomId();
    try { localStorage.setItem('intercomKey', k); } catch (_) {}
  }
  return k;
}

function deviceName() {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua)) return 'iPhone';
  if (/Android/.test(ua)) return 'Android';
  return 'Computador';
}

function log(msg) {
  const line = `${new Date().toLocaleTimeString('es-CO')}  ${msg}`;
  console.log(line);
  const lines = (line + '\n' + ui.log.textContent).split('\n').slice(0, 200);
  ui.log.textContent = lines.join('\n');
}

function setStatus(text, kind) {
  ui.status.textContent = text;
  ui.statusBox.dataset.kind = kind || 'idle';
}

function vibrate(pattern) {
  try { navigator.vibrate && navigator.vibrate(pattern); } catch (_) {}
}

/* ----------------------------- inicio ------------------------------- */
ui.connect.addEventListener('click', start);
ui.mute.addEventListener('click', toggleMute);
ui.hangup.addEventListener('click', hangup);
ui.bgOk.addEventListener('click', () => { ui.bgWarn.hidden = true; S.wasHidden = false; });

if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
  setStatus('Página no segura: el micrófono está bloqueado', 'err');
  log('Abre https://IP:8443 (iPhone) o http://localhost:8080 (Android servidor).');
  ui.connect.disabled = true;
}

async function start() {
  ui.connect.disabled = true;
  setStatus('Pidiendo permiso de micrófono…', 'wait');
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
  unlockAudio();              // el toque habilita la reproduccion
  await requestWakeLock();
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

/* -------------------------- señalizacion ---------------------------- */
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
      break;
    case 'start':
      log('Entró ' + m.peerName + ': creando oferta');
      S.caller = true;
      newPeer();
      await makeOffer(false);
      break;
    case 'peer-left':
      log('El otro celular salió');
      closePeer();
      S.pendingIce = [];
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
  S.tuned = false;
  S.prev = {};
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
  if (S.wakeLock) { S.wakeLock.release().catch(() => {}); S.wakeLock = null; }
  S.muted = false;
  ui.mute.textContent = 'Silenciar mi micrófono';
  ui.mute.classList.remove('is-muted');
  ui.connect.hidden = false;
  ui.connect.disabled = false;
  ui.mute.hidden = true;
  ui.hangup.hidden = true;
  setMeter(ui.meLevel, ui.meTxt, null);
  setMeter(ui.peerLevel, ui.peerTxt, null);
  setStatus('Llamada terminada', 'idle');
}

window.addEventListener('pagehide', () => {
  if (!S.active) return;
  try {
    navigator.sendBeacon('/signal', new Blob([JSON.stringify({ key: S.key, type: 'leave' })], { type: 'application/json' }));
  } catch (_) {}
});

/* ------------------- pantalla encendida / 2.º plano ------------------ */
async function requestWakeLock() {
  if (!('wakeLock' in navigator)) {
    log('Este navegador no mantiene la pantalla encendida: desactiva el bloqueo automático');
    return;
  }
  try {
    S.wakeLock = await navigator.wakeLock.request('screen');
    S.wakeLock.addEventListener('release', () => log('La pantalla ya no está bloqueada encendida'));
    log('La pantalla se mantendrá encendida');
  } catch (e) {
    log('No se pudo mantener la pantalla encendida: ' + e.message);
  }
}

document.addEventListener('visibilitychange', async () => {
  if (!S.active) return;
  if (document.visibilityState === 'hidden') {
    S.wasHidden = true;
    log('Página en segundo plano: el micrófono puede cortarse');
    return;
  }
  ui.bgWarn.hidden = !S.wasHidden;
  await requestWakeLock();
  unlockAudio();
  const t = S.stream && S.stream.getAudioTracks()[0];
  if (!t || t.readyState === 'ended') await reacquireMic();
  if (!S.es || S.es.readyState === EventSource.CLOSED) openSignaling();
  if (S.pc && S.pc.connectionState !== 'connected') recover();
});

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

function kbps(id, bytes, ts) {
  const p = S.prev[id];
  S.prev[id] = { bytes, ts };
  if (!p || ts <= p.ts) return null;
  return ((bytes - p.bytes) * 8) / (ts - p.ts); // bits/ms = kb/s
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
    const rx = kbps('in', inb.bytesReceived || 0, inb.timestamp);
    if (rx != null) rows.push(['Recibiendo', rx.toFixed(1) + ' kb/s']);
    if (typeof inb.jitter === 'number') rows.push(['Jitter', (inb.jitter * 1000).toFixed(1) + ' ms']);
    const lost = inb.packetsLost || 0;
    const got = inb.packetsReceived || 0;
    rows.push(['Pérdida', (got + lost ? (100 * lost / (got + lost)).toFixed(2) : '0.00') + ' % (' + lost + ' paquetes)']);
    if (inb.jitterBufferDelay && inb.jitterBufferEmittedCount) {
      rows.push(['Buffer jitter', (1000 * inb.jitterBufferDelay / inb.jitterBufferEmittedCount).toFixed(0) + ' ms']);
    }
  }
  if (outb) {
    const tx = kbps('out', outb.bytesSent || 0, outb.timestamp);
    if (tx != null) rows.push(['Enviando', tx.toFixed(1) + ' kb/s']);
  }
  ui.stats.innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(String(v))}</dd>`).join('');
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
