// Données et règles métier : notes, index (liens, rétroliens, tags, tâches), historique,
// chiffrement, notes éphémères, import/export. Aucune dépendance au DOM.
import * as db from './db.js';
import * as cr from './crypto.js';
import { fold } from '../lib/fuzzy.js';
import { analyze, LINK_RE } from '../lib/markdown.js';

export const notes = new Map();
const unlocked = new Map();   // id -> { key, body } pour les notes chiffrées déverrouillées
const metaCache = new WeakMap();
const bursts = new Map();     // id -> { id, start, last } : regroupe une rafale d'édition en une version
const pre = new Map();        // id -> état avant la première modification
const listeners = new Set();
let idx = null;

const DAY = 864e5;
const TRASH_DAYS = 30, MAX_VERSIONS = 60;

export const uid = () => crypto.randomUUID ? crypto.randomUUID()
  : [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');

const bc = 'BroadcastChannel' in globalThis ? new BroadcastChannel('carnet') : null;
export const onChange = f => listeners.add(f);
function emit(kind, id, remote = false) {
  idx = null;
  listeners.forEach(f => f(kind, id, remote));
  if (!remote) bc?.postMessage({ kind, id });
}

export async function init() {
  await load();
  if (bc) bc.onmessage = async e => { await load(); emit(e.data.kind, e.data.id, true); };
  navigator.storage?.persist?.().catch(() => {});
  return purge();
}

async function load() {
  const list = await db.all('notes');
  const seen = new Set();
  for (const rec of list) {
    seen.add(rec.id);
    const cur = notes.get(rec.id);
    if (cur) Object.assign(cur, rec); else notes.set(rec.id, rec);
    const u = unlocked.get(rec.id);
    if (u && rec.enc) { try { u.body = await cr.decrypt(u.key, rec.enc); } catch { unlocked.delete(rec.id); } }
    if (!rec.enc) unlocked.delete(rec.id);
  }
  for (const id of [...notes.keys()]) if (!seen.has(id)) { notes.delete(id); unlocked.delete(id); }
}

// ---------- Lecture ----------
export const isLocked = n => !!n.enc && !unlocked.has(n.id);
export const getBody = n => n.enc ? (unlocked.get(n.id)?.body ?? null) : n.body;
export function setBody(n, text) {
  if (n.enc) { const u = unlocked.get(n.id); if (u) u.body = text; } else n.body = text;
  idx = null;
}

export function meta(n) {
  const body = getBody(n);
  let m = metaCache.get(n);
  if (m && m.body === body) return m;
  m = { body, ...(body == null ? { tags: [], links: [], tasks: [], snippet: '' } : analyze(body)) };
  metaCache.set(n, m);
  return m;
}

export function index() {
  if (idx) return idx;
  const live = [...notes.values()].filter(n => !n.deletedAt).sort((a, b) => a.created - b.created);
  const byTitle = new Map(), back = new Map(), tags = new Map();
  for (const n of live) { const k = fold(n.title.trim()); if (k && !byTitle.has(k)) byTitle.set(k, n.id); }
  for (const n of live) {
    const m = meta(n);
    for (const t of m.tags) tags.set(t, (tags.get(t) || 0) + 1);
    for (const l of m.links) {
      const id = byTitle.get(fold(l));
      if (id && id !== n.id) { if (!back.has(id)) back.set(id, new Set()); back.get(id).add(n.id); }
    }
  }
  return (idx = { live, byTitle, back, tags });
}

export const findByTitle = title => { const id = index().byTitle.get(fold(title.trim())); return id ? notes.get(id) : null; };
export const backlinks = n => [...(index().back.get(n.id) || [])].map(id => notes.get(id));

// ---------- Écriture ----------
export function touch(n) { // à appeler avant toute modification : mémorise l'état d'avant pour l'historique
  if (!pre.has(n.id)) pre.set(n.id, { title: n.title, body: getBody(n), ts: n.updated });
}

export async function createNote(props = {}) {
  const now = Date.now();
  const n = { id: uid(), title: '', body: '', created: now, updated: now, pinned: false, inbox: false, daily: null, expiresAt: null, deletedAt: null, enc: null, ...props };
  notes.set(n.id, n);
  await db.put('notes', n);
  emit('create', n.id);
  return n;
}

export async function saveNote(n, { version = true } = {}) {
  if (n.inbox && meta(n).tags.length) n.inbox = false;
  const rec = { ...n };
  if (n.enc) {
    const u = unlocked.get(n.id);
    if (u) { rec.enc = n.enc = { salt: n.enc.salt, ...(await cr.encrypt(u.key, u.body)) }; }
    rec.body = '';
  }
  await db.put('notes', rec);
  if (version) await snapshot(n).catch(console.error);
  emit('save', n.id);
}

export async function trashNote(n) { n.deletedAt = Date.now(); n.pinned = false; await saveNote(n, { version: false }); }
export async function restoreNote(n) { n.deletedAt = null; await saveNote(n, { version: false }); }

export async function destroyNote(id, silent = false) {
  if (notes.has(id)) tomb(id);
  notes.delete(id); unlocked.delete(id); bursts.delete(id); pre.delete(id);
  await db.del('notes', id);
  await db.delMany('versions', (await db.byIndex('versions', 'noteId', id)).map(v => v.id));
  if (!silent) emit('destroy', id);
}

// Autodestruction des notes éphémères arrivées à échéance + vidage de la corbeille après 30 jours.
export async function purge() {
  const now = Date.now(), gone = [];
  for (const n of [...notes.values()]) {
    if ((n.expiresAt && n.expiresAt <= now) || (n.deletedAt && now - n.deletedAt > TRASH_DAYS * DAY)) {
      gone.push({ id: n.id, title: n.title, expired: !!(n.expiresAt && n.expiresAt <= now) });
      await destroyNote(n.id, true);
    }
  }
  if (gone.length) emit('purge', null);
  return gone;
}

// Renommer une note met à jour les [[liens]] qui pointaient vers l'ancien titre.
export async function renameLinks(oldTitle, newTitle, exceptId) {
  const key = fold(oldTitle.trim());
  if (!key || key === fold(newTitle.trim()) || !newTitle.trim()) return 0;
  let count = 0;
  for (const n of notes.values()) {
    if (n.id === exceptId) continue;
    const body = getBody(n);
    if (body == null || !body.includes('[[')) continue;
    const next = body.replace(LINK_RE, (m, t, a) => fold(t.trim()) === key ? `[[${newTitle.trim()}${a ? '|' + a : ''}]]` : m);
    if (next !== body) { setBody(n, next); await saveNote(n, { version: false }); count++; }
  }
  return count;
}

export const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export async function dailyNote() {
  const key = dayKey();
  for (const n of notes.values()) if (n.daily === key && !n.deletedAt) return n;
  const title = new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
  return createNote({ title, daily: key });
}

// Tâches non cochées de toutes les autres notes, regroupées par note.
export function openTasks(exceptId) {
  return index().live.filter(n => n.id !== exceptId)
    .map(n => ({ note: n, tasks: meta(n).tasks.filter(t => !t.done) }))
    .filter(g => g.tasks.length)
    .sort((a, b) => b.note.updated - a.note.updated);
}

export async function toggleTask(n, line) {
  const body = getBody(n); if (body == null) return;
  const lines = body.split('\n');
  if (!/\[[ xX]\]/.test(lines[line] || '')) return;
  touch(n);
  lines[line] = lines[line].replace(/\[([ xX])\]/, (_, c) => c === ' ' ? '[x]' : '[ ]');
  setBody(n, lines.join('\n'));
  n.updated = Date.now();
  await saveNote(n);
}

// ---------- Historique ----------
async function putVersion(n, id, ts, title, body) {
  const rec = { id, noteId: n.id, ts, title };
  if (n.enc) rec.enc = await cr.encrypt(unlocked.get(n.id).key, body); else rec.body = body;
  await db.put('versions', rec);
}

export async function versions(noteId) {
  const u = unlocked.get(noteId), out = [];
  for (const v of await db.byIndex('versions', 'noteId', noteId)) {
    if (v.enc) { if (!u) continue; try { out.push({ ...v, body: await cr.decrypt(u.key, v.enc) }); } catch { /* autre mot de passe */ } }
    else out.push(v);
  }
  return out.sort((a, b) => b.ts - a.ts);
}

async function snapshot(n) {
  const body = getBody(n);
  if (body == null) return;
  const now = Date.now();
  let b = bursts.get(n.id);
  if (b && now - b.last < 120000 && now - b.start < 600000) { b.last = now; return putVersion(n, b.id, now, n.title, body); }
  const vs = await versions(n.id), latest = vs[0], p = pre.get(n.id);
  pre.delete(n.id);
  if (p && p.body != null && (p.body.trim() || p.title.trim()) && (!latest || latest.body !== p.body || latest.title !== p.title)) {
    await putVersion(n, uid(), Math.min(p.ts, now - 1), p.title, p.body);
  }
  if (latest && latest.body === body && latest.title === n.title) return;
  b = { id: uid(), start: now, last: now }; bursts.set(n.id, b);
  await putVersion(n, b.id, now, n.title, body);
  if (vs.length > MAX_VERSIONS) await db.delMany('versions', vs.slice(MAX_VERSIONS).map(v => v.id));
}

export async function restoreVersion(n, v) {
  touch(n); bursts.delete(n.id);
  n.title = v.title; setBody(n, v.body); n.updated = Date.now();
  await saveNote(n);
  bursts.delete(n.id);
}

// ---------- Chiffrement ----------
export async function encryptNote(n, password) {
  const salt = cr.newSalt(), key = await cr.deriveKey(password, salt);
  const body = n.body;
  // L'historique en clair est supprimé : sinon l'ancien contenu resterait lisible.
  await db.delMany('versions', (await db.byIndex('versions', 'noteId', n.id)).map(v => v.id));
  bursts.delete(n.id); pre.delete(n.id);
  unlocked.set(n.id, { key, body });
  n.enc = { salt, iv: '', ct: '' }; n.body = '';
  await saveNote(n, { version: false });
}

export async function unlock(n, password) {
  const key = await cr.deriveKey(password, n.enc.salt);
  const body = await cr.decrypt(key, n.enc); // lève une erreur si le mot de passe est faux
  unlocked.set(n.id, { key, body });
  emit('unlock', n.id);
}

export function lock(id) { if (unlocked.delete(id)) { bursts.delete(id); pre.delete(id); emit('lock', id); } }
export function lockAll() { const ids = [...unlocked.keys()]; ids.forEach(lock); return ids.length; }

export async function decryptNote(n) {
  const u = unlocked.get(n.id); if (!u) return;
  const vs = await versions(n.id);
  await db.putMany('versions', vs.map(({ enc, ...v }) => v));
  n.enc = null; n.body = u.body; unlocked.delete(n.id);
  await saveNote(n, { version: false });
}

// ---------- Import / export ----------
export async function exportJSON() {
  return JSON.stringify({ app: 'carnet', format: 1, exportedAt: new Date().toISOString(), notes: await db.all('notes'), versions: await db.all('versions') }, null, 2);
}

export async function importJSON(text) {
  const data = JSON.parse(text);
  if (data.app !== 'carnet' || !Array.isArray(data.notes)) throw new Error('Ce fichier n’est pas une sauvegarde Studio.');
  let count = 0;
  for (const rec of data.notes) {
    if (!rec || typeof rec.id !== 'string' || typeof rec.title !== 'string') continue;
    const cur = notes.get(rec.id);
    if (cur && cur.updated >= rec.updated) continue;
    await db.put('notes', rec); count++;
  }
  if (Array.isArray(data.versions)) await db.putMany('versions', data.versions.filter(v => v && v.id && v.noteId));
  await load(); emit('import', null);
  return count;
}

const fileName = t => (t.trim() || 'Sans titre').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').slice(0, 80);

export function toMarkdown(n) {
  const iso = t => new Date(t).toISOString();
  return `---\ntitle: ${JSON.stringify(n.title)}\ncreated: ${iso(n.created)}\nupdated: ${iso(n.updated)}\n---\n\n${getBody(n) ?? ''}\n`;
}

// Les notes chiffrées ne sont jamais exportées en clair : elles restent dans la sauvegarde JSON.
export function markdownFiles() {
  const used = new Set(), files = [];
  let skipped = 0;
  for (const n of index().live) {
    if (n.enc) { skipped++; continue; }
    let name = fileName(n.title), k = 2;
    while (used.has(name.toLowerCase())) name = `${fileName(n.title)} ${k++}`;
    used.add(name.toLowerCase());
    files.push({ name: name + '.md', text: toMarkdown(n) });
  }
  return { files, skipped };
}
export const markdownName = n => fileName(n.title) + '.md';

export async function importMarkdown(name, text) {
  let title = name.replace(/\.(md|markdown|txt)$/i, ''), created = Date.now(), updated = created;
  text = text.replace(/\r\n/g, '\n');
  const fm = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (fm) {
    text = text.slice(fm[0].length).replace(/^\n+/, '');
    for (const l of fm[1].split('\n')) {
      const m = l.match(/^(\w+):\s*(.*)$/); if (!m) continue;
      let v = m[2].trim(); try { if (v.startsWith('"')) v = JSON.parse(v); } catch { /* valeur brute */ }
      if (m[1] === 'title' && v) title = v;
      if (m[1] === 'created' && !isNaN(Date.parse(v))) created = Date.parse(v);
      if (m[1] === 'updated' && !isNaN(Date.parse(v))) updated = Date.parse(v);
    }
  } else {
    const h = text.match(/^#\s+(.+)\n?/);
    if (h) { title = h[1].trim(); text = text.slice(h[0].length).replace(/^\n+/, ''); }
  }
  return createNote({ title, body: text.replace(/\n+$/, ''), created, updated });
}

// ---------- Synchronisation entre appareils ----------
// Les suppressions définitives laissent une « tombe » (id + date) pendant 90 jours,
// pour que l'autre appareil efface aussi la note au lieu de la renvoyer.
const TOMBS = 'carnet.tombs';
export function tombs() {
  let t = {}; try { t = JSON.parse(localStorage.getItem(TOMBS)) || {}; } catch { /* vide */ }
  const limit = Date.now() - 90 * DAY;
  for (const [id, ts] of Object.entries(t)) if (ts < limit) delete t[id];
  return t;
}
function tomb(id) { const t = tombs(); t[id] = Date.now(); try { localStorage.setItem(TOMBS, JSON.stringify(t)); } catch { /* plein */ } }

export const manifest = () => [...notes.values()].map(n => ({ id: n.id, updated: n.updated, deletedAt: n.deletedAt || null }));
// Enregistrement tel qu'il est stocké : une note chiffrée par mot de passe voyage chiffrée.
export const record = id => { const n = notes.get(id); if (!n) return null; const r = { ...n }; if (r.enc) r.body = ''; return r; };

// Applique des notes reçues. Règle : la version la plus récente gagne, mais la version locale
// écrasée est d'abord rangée dans l'historique — rien n'est perdu en cas d'édition des deux côtés.
export async function mergeRemote(records = [], remoteTombs = {}) {
  let changed = 0;
  for (const rec of records) {
    if (!rec || typeof rec.id !== 'string' || typeof rec.title !== 'string' || typeof rec.updated !== 'number') continue;
    if (tombs()[rec.id] >= rec.updated) continue;
    const cur = notes.get(rec.id);
    if (cur && cur.updated >= rec.updated) continue;
    if (cur) {
      const body = getBody(cur);
      if (!cur.enc && body != null && (body !== rec.body || cur.title !== rec.title)) await db.put('versions', { id: uid(), noteId: cur.id, ts: cur.updated, title: cur.title, body });
      else if (cur.enc && cur.enc.ct && rec.enc?.ct !== cur.enc.ct) await db.put('versions', { id: uid(), noteId: cur.id, ts: cur.updated, title: cur.title, enc: { iv: cur.enc.iv, ct: cur.enc.ct } });
    }
    const clean = { ...rec }; if (clean.enc) clean.body = '';
    await db.put('notes', clean); changed++;
  }
  for (const [id, ts] of Object.entries(remoteTombs)) {
    const cur = notes.get(id);
    if (cur && cur.updated <= ts) { await destroyNote(id, true); changed++; }
  }
  if (changed) { await load(); emit('import', null); }
  return changed;
}
