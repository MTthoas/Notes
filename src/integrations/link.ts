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
import * as cr from '../core/crypto.ts';
import * as vault from '../core/vault.ts';
import * as store from '../core/store.ts';
import * as native from '../core/native.ts';
import { errMsg } from '../ui/kit.ts';
import type { Note } from '../types.ts';

/** Appareil lié (gardé chiffré dans le coffre). */
export interface Device { secret: string; id: string | null; name: string; pairedAt: number; lastSync: number; /** Sur ce Mac : cet appareil peut piloter Claude Code à distance. */ remote?: boolean }
export type LinkEvent =
  | { type: 'devices' }
  | { type: 'status'; secret: string; state: string }
  | { type: 'paired'; name: string }
  | { type: 'error'; message: string }
  | { type: 'synced'; name: string; sent: number; got: number }
  | { type: 'remote'; name: string; what: string };
/** Message de signalisation, chiffré sur le relais. */
interface Signal { t: 'hello' | 'offer' | 'answer'; re?: boolean; sdp?: string; oid?: string; from: string; name: string; ts: number }
type Tombs = Record<string, number>;
/** Message du canal direct entre appareils. */
type Wire =
  | { t: 'manifest'; notes: { id: string; updated: number }[]; tombs?: Tombs }
  | { t: 'notes'; recs: Note[]; tombs?: Tombs }
  | { t: 'done'; sent: number }
  | { t: 'part'; id: string; i: number; n: number; d: string }
  | { t: 'caps'; agents: boolean; name: string }
  | { t: 'rpc'; id: number; type: string; action: string; params: Record<string, unknown> }
  | { t: 'rpc-res'; id: number; res: native.Reply };

// ---------- Pilotage à distance ----------
// Un appareil lié (l'iPhone) peut demander au Mac de lancer, suivre et arrêter les agents Claude Code de ses projets.
// Le Mac ne répond qu'aux appareils explicitement autorisés, et seulement à cette liste fermée de demandes.
const REMOTE_ALLOWED = new Set(['agent.list', 'agent.run', 'agent.server', 'agent.start', 'agent.stop', 'agent.worktrees', 'agent.daily', 'agent.commits', 'project.info', 'project.sessions', 'project.session', 'claude.status']);
const isMac = (): boolean => native.available() && document.documentElement.dataset.native === 'mac';
const pending = new Map<number, (r: native.Reply) => void>();
let rpcSeq = 0;
/** Mac joignable qui accepte le pilotage depuis cet appareil. */
export function remoteHost(): { name: string } | null {
  for (const s of peers.values()) if (s.caps?.agents && s.dc?.readyState === 'open') return { name: s.caps.name || s.dev.name };
  return null;
}
/** Envoie une demande au Mac lié (réponse au même format que le pont natif). */
export function remoteCall(type: string, action: string, params: Record<string, unknown> = {}, timeout = 60000): Promise<native.Reply> {
  const s = [...peers.values()].find(x => x.caps?.agents && x.dc?.readyState === 'open');
  if (!s) return Promise.resolve({ ok: false, message: 'Aucun Mac joignable pour le pilotage à distance.' });
  const id = ++rpcSeq;
  return new Promise(resolve => {
    pending.set(id, resolve);
    setTimeout(() => { if (pending.delete(id)) resolve({ ok: false, message: 'Le Mac ne répond pas.' }); }, timeout);
    s.send({ t: 'rpc', id, type, action, params });
  });
}
/** Autorise (ou non) un appareil lié à piloter Claude Code sur ce Mac. */
export async function setRemote(secret: string, on: boolean): Promise<void> {
  await updateDevice(secret, { remote: on });
  const s = peers.get(secret); if (s) { s.dev.remote = on; s.announce(); }
  emit({ type: 'devices' });
}

const RELAY = 'ntfy.sh';
const ME = 'carnet.device';
const listeners = new Set<(e: LinkEvent) => void>();
const peers = new Map<string, Session>(); // secret d'appairage -> session
export const on = (f: (e: LinkEvent) => void): void => { listeners.add(f); };
const emit = (e: LinkEvent): void => listeners.forEach(f => f(e));

// ---------- Identité de cet appareil ----------
function guessName(): string {
  const ua = navigator.userAgent;
  const dev = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'PC Windows' : 'Ordinateur';
  return dev;
}
export function me(): { id: string; name: string } {
  const saved = ((): { id?: unknown; name?: unknown } | null => { try { return JSON.parse(localStorage.getItem(ME) || 'null') as { id?: unknown; name?: unknown } | null; } catch { return null; } })();
  if (saved && typeof saved.id === 'string' && saved.id) return { id: saved.id, name: typeof saved.name === 'string' && saved.name ? saved.name : guessName() };
  const fresh = { id: cr.hex(cr.random(8)), name: guessName() };
  localStorage.setItem(ME, JSON.stringify(fresh));
  return fresh;
}
export function rename(name: string): void { const m = me(); m.name = name.trim() || m.name; localStorage.setItem(ME, JSON.stringify(m)); }

export const devices = (): Device[] => vault.secret<Device[]>('devices') || [];
async function saveDevices(list: Device[]): Promise<void> { await vault.setSecret('devices', list); emit({ type: 'devices' }); }
async function updateDevice(secret: string, patch: Partial<Device>): Promise<void> {
  const list = devices(), d = list.find(x => x.secret === secret);
  if (d) { Object.assign(d, patch); await saveDevices(list); }
}

// ---------- Code d'appairage (base32 de Crockford, sans lettres ambiguës) ----------
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function b32(bytes: Uint8Array): string { let bits = 0, val = 0, out = ''; for (const b of bytes) { val = val << 8 | b; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } } if (bits) out += B32[(val << (5 - bits)) & 31]; return out; }
function unb32(s: string): cr.Bytes { let bits = 0, val = 0; const out: number[] = []; for (const ch of s) { const i = B32.indexOf(ch); if (i < 0) throw new Error('Code invalide.'); val = val << 5 | i; bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } } return new Uint8Array(out); }
const group = (s: string): string => (s.match(/.{1,4}/g) ?? []).join('-');

export function parseCode(input: string): string {
  const m = String(input).match(/lier=([0-9A-Za-z-]+)/), raw = ((m ? m[1] : input) ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (raw.length !== 26) throw new Error('Le code doit contenir 26 caractères.');
  const bytes = unb32(raw); if (bytes.length !== 16) throw new Error('Code invalide.');
  return raw;
}
export const linkURL = (code: string): string => `${location.origin}${location.pathname}#lier=${code}`;

// Crée une invitation : le secret est enregistré tout de suite, l'autre appareil se présentera.
export async function invite(): Promise<{ code: string; pretty: string; url: string }> {
  const code = b32(cr.random(16));
  const dev: Device = { secret: code, id: null, name: 'En attente…', pairedAt: Date.now(), lastSync: 0 };
  await saveDevices([...devices(), dev]);
  connect(dev);
  return { code, pretty: group(code), url: linkURL(code) };
}
export async function join(input: string): Promise<void> {
  const code = parseCode(input);
  if (devices().some(d => d.secret === code)) throw new Error('Cet appareil est déjà lié.');
  const dev: Device = { secret: code, id: null, name: 'Connexion…', pairedAt: Date.now(), lastSync: 0 };
  await saveDevices([...devices(), dev]);
  connect(dev);
}
export async function forget(secret: string): Promise<void> {
  peers.get(secret)?.close();
  await saveDevices(devices().filter(d => d.secret !== secret));
}

async function keys(code: string): Promise<{ key: CryptoKey; topic: string }> {
  const s = unb32(code);
  return { key: await cr.hkdfKey(s, 'carnet/link/msg'), topic: 'carnet-' + cr.hex(await cr.hkdfBytes(s, 'carnet/link/topic', 16)) };
}

// ---------- Session temps réel ----------
const ICE = (): RTCIceServer[] => (localStorage.getItem('carnet.lan') === '1' ? [] : [{ urls: 'stun:stun.l.google.com:19302' }]);
export const lanOnly = (): boolean => localStorage.getItem('carnet.lan') === '1';
export const setLanOnly = (v: boolean): void => localStorage.setItem('carnet.lan', v ? '1' : '0');
export const status = (secret: string): string => peers.get(secret)?.state || 'hors ligne';

class Session {
  readonly secret: string;
  state = 'connexion';
  parts = new Map<string, string[]>();
  closed = false;
  stats = { sent: 0, got: 0 };
  caps: { agents: boolean; name: string } | null = null;
  calls: number[] = [];
  key!: CryptoKey;
  topic = '';
  ws: WebSocket | null = null;
  pc: RTCPeerConnection | null = null;
  dc: RTCDataChannel | null = null;
  offeredAt = 0;
  oid = '';
  constructor(public dev: Device) { this.secret = dev.secret; }
  set(state: string): void { this.state = state; emit({ type: 'status', secret: this.secret, state }); }

  async start(): Promise<void> {
    ({ key: this.key, topic: this.topic } = await keys(this.secret));
    this.listen();
  }
  listen(): void {
    if (this.closed) return;
    const ws = this.ws = new WebSocket(`wss://${RELAY}/${this.topic}/ws`);
    ws.onopen = () => { this.set('en attente de l’autre appareil'); this.signal({ t: 'hello' }); };
    ws.onmessage = (e: MessageEvent<string>) => this.onRelay(e.data).catch(err => console.warn('liaison', err));
    ws.onclose = () => { if (!this.closed && !document.hidden) setTimeout(() => this.listen(), 5000); };
  }
  async signal(msg: Omit<Signal, 'from' | 'name' | 'ts'>): Promise<void> {
    const m = me(), body = await cr.sealCompact(this.key, await cr.gzip(JSON.stringify({ ...msg, from: m.id, name: m.name, ts: Date.now() })));
    await fetch(`https://${RELAY}/${this.topic}`, { method: 'POST', body, headers: { Cache: 'no', Firebase: 'no' }, credentials: 'omit', referrerPolicy: 'no-referrer' }).catch(() => {});
  }
  async onRelay(raw: string): Promise<void> {
    const ev = JSON.parse(raw) as { event?: string; message?: string; attachment?: { url?: string } };
    if (ev.event !== 'message' || typeof ev.message !== 'string') return;
    let text = ev.message;
    if (ev.attachment?.url?.startsWith(`https://${RELAY}/`)) text = await (await fetch(ev.attachment.url, { credentials: 'omit' })).text();
    let msg: Signal;
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
      if (offerer) { if (Date.now() - this.offeredAt < 8000) return; await this.offer(); return; }
      if (!msg.re) void this.signal({ t: 'hello', re: true });
    } else if (msg.t === 'offer' && !offerer) {
      this.reset();
      const pc = this.pc = this.newPC();
      pc.ondatachannel = (e: RTCDataChannelEvent) => this.bind(e.channel);
      await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
      await pc.setLocalDescription(await pc.createAnswer());
      await this.gathered();
      void this.signal({ t: 'answer', sdp: pc.localDescription?.sdp ?? '', oid: msg.oid ?? '' });
    } else if (msg.t === 'answer' && offerer && msg.oid === this.oid && this.pc?.signalingState === 'have-local-offer') {
      await this.pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
    }
  }
  newPC(): RTCPeerConnection {
    const pc = new RTCPeerConnection({ iceServers: ICE() });
    pc.onconnectionstatechange = () => { if (['failed', 'disconnected', 'closed'].includes(pc.connectionState) && this.pc === pc) { this.set('déconnecté'); this.dc = null; } };
    return pc;
  }
  async offer(): Promise<void> {
    this.offeredAt = Date.now(); this.oid = cr.hex(cr.random(6));
    this.reset();
    const pc = this.pc = this.newPC();
    this.bind(pc.createDataChannel('carnet', { ordered: true }));
    await pc.setLocalDescription(await pc.createOffer());
    await this.gathered();
    this.set('négociation');
    void this.signal({ t: 'offer', sdp: pc.localDescription?.sdp ?? '', oid: this.oid });
  }
  gathered(): Promise<void> {
    const pc = this.pc;
    return new Promise<void>(res => {
      if (!pc || pc.iceGatheringState === 'complete') { res(); return; }
      const t = setTimeout(res, 3000);
      pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); res(); } });
    });
  }
  reset(): void { try { this.dc?.close(); this.pc?.close(); } catch { /* déjà fermé */ } this.dc = this.pc = null; }

  // --- Canal direct ---
  bind(dc: RTCDataChannel): void {
    this.dc = dc;
    dc.onopen = () => { this.set('connecté'); this.stats = { sent: 0, got: 0 }; this.send({ t: 'manifest', notes: store.manifest(), tombs: store.tombs() }); this.announce(); };
    dc.onmessage = (e: MessageEvent<string>) => this.onData(e.data).catch(err => emit({ type: 'error', message: errMsg(err) }));
    dc.onclose = () => { if (this.dc === dc) { this.dc = null; this.set('en attente de l’autre appareil'); } };
  }
  send(obj: Wire): boolean {
    const dc = this.dc;
    if (!dc || dc.readyState !== 'open') return false;
    const s = JSON.stringify(obj), MAX = 60000;
    if (s.length <= MAX) dc.send(s);
    else { const id = cr.hex(cr.random(6)), n = Math.ceil(s.length / MAX); for (let i = 0; i < n; i++) dc.send(JSON.stringify({ t: 'part', id, i, n, d: s.slice(i * MAX, (i + 1) * MAX) })); }
    return true;
  }
  /** Le Mac annonce s'il accepte le pilotage depuis cet appareil. */
  announce(): void { if (isMac()) this.send({ t: 'caps', agents: this.dev.remote === true, name: me().name }); }
  async onRpc(msg: Extract<Wire, { t: 'rpc' }>): Promise<void> {
    const deny = (message: string): void => { this.send({ t: 'rpc-res', id: msg.id, res: { ok: false, message } }); };
    if (!isMac()) return deny('Cet appareil n’est pas un Mac.');
    const dev = devices().find(d => d.secret === this.secret);
    if (!dev?.remote) return deny('Le pilotage à distance est désactivé pour cet appareil (Réglages → Appareils, sur le Mac).');
    const key = `${msg.type}.${msg.action}`;
    if (!REMOTE_ALLOWED.has(key)) return deny('Action non autorisée à distance.');
    const now = Date.now(); this.calls = this.calls.filter(t => now - t < 60000);
    if (this.calls.length >= 120) return deny('Trop de demandes : réessaie dans une minute.');
    this.calls.push(now);
    const params: Record<string, unknown> = { ...msg.params };
    delete params.type; delete params.action; delete params.id;
    if (key === 'agent.server' && (params.op ?? 'status') !== 'status') return deny('Le serveur se configure depuis le Mac.');
    if (key === 'agent.start') {
      // À distance : jamais de commandes (tests npm), consigne bornée.
      params.tests = false;
      if (typeof params.prompt !== 'string' || params.prompt.length > 20000) return deny('Consigne invalide.');
      emit({ type: 'remote', name: dev.name, what: String(params.prompt).slice(0, 120) });
    }
    if (key === 'agent.stop') emit({ type: 'remote', name: dev.name, what: 'arrêt d’un agent' });
    const res = await native.call(msg.type, msg.action, params, key === 'agent.start' ? 60000 : 30000);
    this.send({ t: 'rpc-res', id: msg.id, res });
  }

  async onData(raw: string): Promise<void> {
    let msg = JSON.parse(raw) as Wire;
    if (msg.t === 'part') {
      const p = this.parts.get(msg.id) || []; p[msg.i] = msg.d; this.parts.set(msg.id, p);
      if (p.filter(x => x != null).length < msg.n) return;
      this.parts.delete(msg.id); msg = JSON.parse(p.join('')) as Wire;
    }
    if (msg.t === 'caps') { this.caps = { agents: !!msg.agents, name: String(msg.name || '') }; emit({ type: 'devices' }); return; }
    if (msg.t === 'rpc') { await this.onRpc(msg); return; }
    if (msg.t === 'rpc-res') { const done = pending.get(msg.id); if (done) { pending.delete(msg.id); done(msg.res); } return; }
    if (msg.t === 'manifest') {
      await store.mergeRemote([], msg.tombs || {});
      const theirs = new Map(msg.notes.map(x => [x.id, x.updated])), tombs = msg.tombs || {};
      const ids = store.manifest().filter(x => !tombs[x.id] && (theirs.get(x.id) ?? -1) < x.updated).map(x => x.id);
      for (let i = 0; i < ids.length; i += 20) this.send({ t: 'notes', recs: ids.slice(i, i + 20).flatMap(id => store.record(id) ?? []) });
      this.stats.sent = ids.length;
      this.send({ t: 'done', sent: ids.length });
    } else if (msg.t === 'notes') {
      this.stats.got += await store.mergeRemote(msg.recs, msg.tombs || {});
    } else if (msg.t === 'done') {
      await updateDevice(this.secret, { lastSync: Date.now() });
      emit({ type: 'synced', name: this.dev.name, sent: this.stats.sent, got: this.stats.got });
    }
  }
  push(id: string): void {
    if (this.dc?.readyState !== 'open') return;
    const rec = store.record(id);
    this.send(rec ? { t: 'notes', recs: [rec] } : { t: 'notes', recs: [], tombs: { [id]: store.tombs()[id] || Date.now() } });
  }
  close(): void { this.closed = true; this.reset(); try { this.ws?.close(); } catch { /* fermé */ } peers.delete(this.secret); }
}

function connect(dev: Device): void {
  if (peers.has(dev.secret) || !('RTCPeerConnection' in globalThis)) return;
  const s = new Session(dev); peers.set(dev.secret, s); s.start().catch(e => emit({ type: 'error', message: errMsg(e) }));
}
export function startAll(): void { if (vault.isOpen()) devices().forEach(connect); }
export function syncNow(): void {
  for (const s of peers.values()) { if (s.dc?.readyState === 'open') s.send({ t: 'manifest', notes: store.manifest(), tombs: store.tombs() }); else void s.signal({ t: 'hello' }); }
  if (!peers.size) startAll();
}

// Envoi en temps réel des modifications locales aux appareils connectés.
const timers = new Map<string, ReturnType<typeof setTimeout>>();
store.onChange((kind, id, remote) => {
  if (remote || !id || !['save', 'create', 'destroy'].includes(kind) || !peers.size) return;
  clearTimeout(timers.get(id));
  timers.set(id, setTimeout(() => { timers.delete(id); for (const s of peers.values()) s.push(id); }, 1200));
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  for (const s of peers.values()) { if (s.ws?.readyState !== WebSocket.OPEN) s.listen(); else if (s.dc?.readyState !== 'open') void s.signal({ t: 'hello' }); }
});

// ---------- Paquet chiffré (hors ligne : AirDrop, Messages, clé USB…) ----------
export async function packet(dev: Device): Promise<File> {
  const { key } = await keys(dev.secret);
  const recs = store.manifest().flatMap(x => store.record(x.id) ?? []);
  const box = await cr.sealCompact(key, await cr.gzip(JSON.stringify({ notes: recs, tombs: store.tombs() })));
  const m = me();
  return new File([JSON.stringify({ app: 'carnet-paquet', v: 1, from: m.id, name: m.name, box })], `carnet-${m.name.toLowerCase().replace(/\W+/g, '-')}-vers-${dev.name.toLowerCase().replace(/\W+/g, '-')}.carnet`, { type: 'application/octet-stream' });
}
export async function openPacket(text: string): Promise<{ name: string; count: number }> {
  const p = JSON.parse(text) as { app?: string; from?: string; name?: string; box?: string };
  if (p.app !== 'carnet-paquet') throw new Error('Ce fichier n’est pas un paquet Studio.');
  for (const d of devices()) {
    const { key } = await keys(d.secret);
    let data: { notes?: unknown[]; tombs?: Tombs }; try { data = JSON.parse(await cr.gunzip(await cr.openCompact(key, p.box ?? ''))) as typeof data; } catch { continue; }
    const n = await store.mergeRemote(data.notes, data.tombs);
    await updateDevice(d.secret, { lastSync: Date.now(), ...(d.id ? {} : { id: p.from ?? null, name: p.name ?? d.name }) });
    return { name: p.name ?? d.name, count: n };
  }
  throw new Error('Aucun appareil lié ne peut ouvrir ce paquet.');
}
