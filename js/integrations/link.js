// Liaison entre appareils, sans serveur à soi.
//
// 1. Appairage : un secret de 128 bits passe d'un écran à l'autre (QR code, presse-papiers
//    universel d'Apple, ou saisie). Il ne transite par aucun réseau.
// 2. De ce secret on dérive : une clé AES-GCM, et un nom de canal imprévisible sur un relais
//    public (ntfy.sh). Le relais ne voit que des messages chiffrés et non stockés.
// 3. Par ce canal, les deux appareils échangent une offre WebRTC chiffrée. L'empreinte DTLS
//    voyage dans le message chiffré : le relais ne peut pas s'interposer.
// 4. Les notes passent ensuite en direct d'appareil à appareil (canal de données WebRTC chiffré),
//    puis en temps réel tant que les deux restent ouverts.
// En complément, un « paquet chiffré » (fichier) peut voyager par AirDrop ou messagerie : zéro réseau.
import * as cr from '../core/crypto.js';
import * as vault from '../core/vault.js';
import * as store from '../core/store.js';

const RELAY = 'ntfy.sh';
const ME = 'carnet.device';
const listeners = new Set();
const peers = new Map(); // id d'appareil -> session
export const on = f => listeners.add(f);
const emit = e => listeners.forEach(f => f(e));

// ---------- Identité de cet appareil ----------
function guessName() {
  const ua = navigator.userAgent;
  const dev = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'PC Windows' : 'Ordinateur';
  return dev;
}
export function me() {
  let m = null; try { m = JSON.parse(localStorage.getItem(ME)); } catch { /* neuf */ }
  if (!m?.id) { m = { id: cr.hex(cr.random(8)), name: guessName() }; localStorage.setItem(ME, JSON.stringify(m)); }
  return m;
}
export function rename(name) { const m = me(); m.name = name.trim() || m.name; localStorage.setItem(ME, JSON.stringify(m)); }

export const devices = () => vault.secret('devices') || [];
async function saveDevices(list) { await vault.setSecret('devices', list); emit({ type: 'devices' }); }
async function updateDevice(secret, patch) {
  const list = devices(), d = list.find(x => x.secret === secret);
  if (d) { Object.assign(d, patch); await saveDevices(list); }
}

// ---------- Code d'appairage (base32 de Crockford, sans lettres ambiguës) ----------
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function b32(bytes) { let bits = 0, val = 0, out = ''; for (const b of bytes) { val = val << 8 | b; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } } if (bits) out += B32[(val << (5 - bits)) & 31]; return out; }
function unb32(s) { let bits = 0, val = 0; const out = []; for (const ch of s) { const i = B32.indexOf(ch); if (i < 0) throw new Error('Code invalide.'); val = val << 5 | i; bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } } return new Uint8Array(out); }
const group = s => s.match(/.{1,4}/g).join('-');

export function parseCode(input) {
  const m = String(input).match(/lier=([0-9A-Za-z-]+)/), raw = (m ? m[1] : input).toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (raw.length !== 26) throw new Error('Le code doit contenir 26 caractères.');
  const bytes = unb32(raw); if (bytes.length !== 16) throw new Error('Code invalide.');
  return raw;
}
export const linkURL = code => `${location.origin}${location.pathname}#lier=${code}`;

// Crée une invitation : le secret est enregistré tout de suite, l'autre appareil se présentera.
export async function invite() {
  const code = b32(cr.random(16));
  const list = devices(); list.push({ secret: code, id: null, name: 'En attente…', pairedAt: Date.now(), lastSync: 0 });
  await saveDevices(list);
  connect(list[list.length - 1]);
  return { code, pretty: group(code), url: linkURL(code) };
}
export async function join(input) {
  const code = parseCode(input);
  if (devices().some(d => d.secret === code)) throw new Error('Cet appareil est déjà lié.');
  const list = devices(); list.push({ secret: code, id: null, name: 'Connexion…', pairedAt: Date.now(), lastSync: 0 });
  await saveDevices(list);
  connect(list[list.length - 1]);
}
export async function forget(secret) {
  peers.get(secret)?.close();
  await saveDevices(devices().filter(d => d.secret !== secret));
}

async function keys(code) {
  const s = unb32(code);
  return { key: await cr.hkdfKey(s, 'carnet/link/msg'), topic: 'carnet-' + cr.hex(await cr.hkdfBytes(s, 'carnet/link/topic', 16)) };
}

// ---------- Session temps réel ----------
const ICE = () => (localStorage.getItem('carnet.lan') === '1' ? [] : [{ urls: 'stun:stun.l.google.com:19302' }]);
export const lanOnly = () => localStorage.getItem('carnet.lan') === '1';
export const setLanOnly = v => localStorage.setItem('carnet.lan', v ? '1' : '0');
export const status = secret => peers.get(secret)?.state || 'hors ligne';

class Session {
  constructor(dev) { this.dev = dev; this.secret = dev.secret; this.state = 'connexion'; this.parts = new Map(); this.closed = false; this.stats = { sent: 0, got: 0 }; }
  set(state) { this.state = state; emit({ type: 'status', secret: this.secret, state }); }

  async start() {
    ({ key: this.key, topic: this.topic } = await keys(this.secret));
    this.listen();
  }
  listen() {
    if (this.closed) return;
    const ws = this.ws = new WebSocket(`wss://${RELAY}/${this.topic}/ws`);
    ws.onopen = () => { this.set('en attente de l’autre appareil'); this.signal({ t: 'hello' }); };
    ws.onmessage = e => this.onRelay(e.data).catch(err => console.warn('liaison', err));
    ws.onclose = () => { if (!this.closed && !document.hidden) setTimeout(() => this.listen(), 5000); };
  }
  async signal(msg) {
    const m = me(), body = await cr.sealCompact(this.key, await cr.gzip(JSON.stringify({ ...msg, from: m.id, name: m.name, ts: Date.now() })));
    await fetch(`https://${RELAY}/${this.topic}`, { method: 'POST', body, headers: { Cache: 'no', Firebase: 'no' }, credentials: 'omit', referrerPolicy: 'no-referrer' }).catch(() => {});
  }
  async onRelay(raw) {
    const ev = JSON.parse(raw); if (ev.event !== 'message') return;
    let text = ev.message;
    if (ev.attachment?.url?.startsWith(`https://${RELAY}/`)) text = await (await fetch(ev.attachment.url, { credentials: 'omit' })).text();
    let msg;
    try { msg = JSON.parse(await cr.gunzip(await cr.openCompact(this.key, text.trim()))); } catch { return; } // pas pour nous
    const m = me();
    if (msg.from === m.id || Math.abs(Date.now() - msg.ts) > 5 * 60e3) return;
    if (this.dev.id !== msg.from || this.dev.name !== msg.name) {
      const first = !this.dev.id;
      this.dev.id = msg.from; this.dev.name = msg.name;
      await updateDevice(this.secret, { id: msg.from, name: msg.name });
      if (first) emit({ type: 'paired', name: msg.name });
    }
    const offerer = m.id < msg.from;
    if (msg.t === 'hello') {
      if (this.dc?.readyState === 'open') return;
      if (offerer) { if (Date.now() - (this.offeredAt || 0) < 8000) return; return this.offer(); }
      if (!msg.re) this.signal({ t: 'hello', re: true });
    } else if (msg.t === 'offer' && !offerer) {
      this.reset();
      const pc = this.pc = this.newPC();
      pc.ondatachannel = e => this.bind(e.channel);
      await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
      await pc.setLocalDescription(await pc.createAnswer());
      await this.gathered();
      this.signal({ t: 'answer', sdp: pc.localDescription.sdp, oid: msg.oid });
    } else if (msg.t === 'answer' && offerer && msg.oid === this.oid && this.pc?.signalingState === 'have-local-offer') {
      await this.pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
    }
  }
  newPC() {
    const pc = new RTCPeerConnection({ iceServers: ICE() });
    pc.onconnectionstatechange = () => { if (['failed', 'disconnected', 'closed'].includes(pc.connectionState) && this.pc === pc) { this.set('déconnecté'); this.dc = null; } };
    return pc;
  }
  async offer() {
    this.offeredAt = Date.now(); this.oid = cr.hex(cr.random(6));
    this.reset();
    const pc = this.pc = this.newPC();
    this.bind(pc.createDataChannel('carnet', { ordered: true }));
    await pc.setLocalDescription(await pc.createOffer());
    await this.gathered();
    this.set('négociation');
    this.signal({ t: 'offer', sdp: pc.localDescription.sdp, oid: this.oid });
  }
  gathered() {
    const pc = this.pc;
    return new Promise(res => {
      if (pc.iceGatheringState === 'complete') return res();
      const t = setTimeout(res, 3000);
      pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); res(); } });
    });
  }
  reset() { try { this.dc?.close(); this.pc?.close(); } catch { /* déjà fermé */ } this.dc = this.pc = null; }

  // --- Canal direct ---
  bind(dc) {
    this.dc = dc;
    dc.onopen = () => { this.set('connecté'); this.stats = { sent: 0, got: 0 }; this.send({ t: 'manifest', notes: store.manifest(), tombs: store.tombs() }); };
    dc.onmessage = e => this.onData(e.data).catch(err => emit({ type: 'error', message: err.message }));
    dc.onclose = () => { if (this.dc === dc) { this.dc = null; this.set('en attente de l’autre appareil'); } };
  }
  send(obj) {
    if (this.dc?.readyState !== 'open') return false;
    const s = JSON.stringify(obj), MAX = 60000;
    if (s.length <= MAX) this.dc.send(s);
    else { const id = cr.hex(cr.random(6)), n = Math.ceil(s.length / MAX); for (let i = 0; i < n; i++) this.dc.send(JSON.stringify({ t: 'part', id, i, n, d: s.slice(i * MAX, (i + 1) * MAX) })); }
    return true;
  }
  async onData(raw) {
    let msg = JSON.parse(raw);
    if (msg.t === 'part') {
      const p = this.parts.get(msg.id) || []; p[msg.i] = msg.d; this.parts.set(msg.id, p);
      if (p.filter(x => x != null).length < msg.n) return;
      this.parts.delete(msg.id); msg = JSON.parse(p.join(''));
    }
    if (msg.t === 'manifest') {
      await store.mergeRemote([], msg.tombs || {});
      const theirs = new Map(msg.notes.map(x => [x.id, x.updated])), tombs = msg.tombs || {};
      const ids = store.manifest().filter(x => !tombs[x.id] && (!theirs.has(x.id) || theirs.get(x.id) < x.updated)).map(x => x.id);
      for (let i = 0; i < ids.length; i += 20) this.send({ t: 'notes', recs: ids.slice(i, i + 20).map(store.record).filter(Boolean) });
      this.stats.sent = ids.length;
      this.send({ t: 'done', sent: ids.length });
    } else if (msg.t === 'notes') {
      this.stats.got += await store.mergeRemote(msg.recs, msg.tombs || {});
    } else if (msg.t === 'done') {
      await updateDevice(this.secret, { lastSync: Date.now() });
      emit({ type: 'synced', name: this.dev.name, sent: this.stats.sent, got: this.stats.got });
    }
  }
  push(id) {
    if (this.dc?.readyState !== 'open') return;
    const rec = store.record(id);
    this.send(rec ? { t: 'notes', recs: [rec] } : { t: 'notes', recs: [], tombs: { [id]: store.tombs()[id] || Date.now() } });
  }
  close() { this.closed = true; this.reset(); try { this.ws?.close(); } catch { /* fermé */ } peers.delete(this.secret); }
}

function connect(dev) {
  if (peers.has(dev.secret) || !('RTCPeerConnection' in globalThis)) return;
  const s = new Session(dev); peers.set(dev.secret, s); s.start().catch(e => emit({ type: 'error', message: e.message }));
}
export function startAll() { if (vault.isOpen()) devices().forEach(connect); }
export function syncNow() {
  for (const s of peers.values()) { if (s.dc?.readyState === 'open') s.send({ t: 'manifest', notes: store.manifest(), tombs: store.tombs() }); else s.signal({ t: 'hello' }); }
  if (!peers.size) startAll();
}

// Envoi en temps réel des modifications locales aux appareils connectés.
const timers = new Map();
store.onChange((kind, id, remote) => {
  if (remote || !id || !['save', 'create', 'destroy'].includes(kind) || !peers.size) return;
  clearTimeout(timers.get(id));
  timers.set(id, setTimeout(() => { timers.delete(id); for (const s of peers.values()) s.push(id); }, 1200));
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  for (const s of peers.values()) { if (s.ws?.readyState !== WebSocket.OPEN) s.listen(); else if (s.dc?.readyState !== 'open') s.signal({ t: 'hello' }); }
});

// ---------- Paquet chiffré (hors ligne : AirDrop, Messages, clé USB…) ----------
export async function packet(dev) {
  const { key } = await keys(dev.secret);
  const recs = store.manifest().map(x => store.record(x.id)).filter(Boolean);
  const box = await cr.sealCompact(key, await cr.gzip(JSON.stringify({ notes: recs, tombs: store.tombs() })));
  const m = me();
  return new File([JSON.stringify({ app: 'carnet-paquet', v: 1, from: m.id, name: m.name, box })], `carnet-${m.name.toLowerCase().replace(/\W+/g, '-')}-vers-${dev.name.toLowerCase().replace(/\W+/g, '-')}.carnet`, { type: 'application/octet-stream' });
}
export async function openPacket(text) {
  const p = JSON.parse(text);
  if (p.app !== 'carnet-paquet') throw new Error('Ce fichier n’est pas un paquet Studio.');
  for (const d of devices()) {
    const { key } = await keys(d.secret);
    let data; try { data = JSON.parse(await cr.gunzip(await cr.openCompact(key, p.box))); } catch { continue; }
    const n = await store.mergeRemote(data.notes, data.tombs);
    await updateDevice(d.secret, { lastSync: Date.now(), ...(d.id ? {} : { id: p.from, name: p.name }) });
    return { name: p.name, count: n };
  }
  throw new Error('Aucun appareil lié ne peut ouvrir ce paquet.');
}
