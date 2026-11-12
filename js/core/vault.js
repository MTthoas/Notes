// Coffre : une clé maîtresse aléatoire (256 bits) chiffre toute la base et les secrets
// (clés API, appareils liés). Elle n'est jamais écrite en clair : seulement « emballée »
// par une clé dérivée du mot de passe et, en option, par une passkey (Face ID / Touch ID, extension PRF).
import * as cr from './crypto.js';
import * as db from './db.js';

const META = 'carnet.vault', SECRETS = 'carnet.secrets';
let master = null, dbKey = null, secKey = null, secrets = null;
const listeners = new Set();

const readMeta = () => { try { return JSON.parse(localStorage.getItem(META)); } catch { return null; } };
const writeMeta = m => localStorage.setItem(META, JSON.stringify(m));

export const enabled = () => !!readMeta();
export const isOpen = () => !!master;
export const hasPasskey = () => !!readMeta()?.pk;
export const settings = () => ({ autolock: 15, ...(readMeta()?.settings || {}) });
export const onChange = f => listeners.add(f);
const emit = () => listeners.forEach(f => f());

async function openWith(raw) {
  master = raw;
  dbKey = await cr.hkdfKey(raw, 'carnet/db');
  secKey = await cr.hkdfKey(raw, 'carnet/secrets');
  db.setCipher({ seal: t => cr.encrypt(dbKey, t), open: box => cr.decrypt(dbKey, box) });
  const box = localStorage.getItem(SECRETS);
  secrets = box ? JSON.parse(await cr.decrypt(secKey, JSON.parse(box))) : {};
  emit();
}

export async function create(password) {
  if (enabled()) throw new Error('Le coffre existe déjà.');
  const raw = cr.random(32), salt = cr.newSalt();
  const wrapped = await cr.encrypt(await cr.deriveKey(password, salt), raw);
  // La clé emballée est écrite AVANT de chiffrer la base : une interruption ne peut pas
  // laisser des données scellées sans moyen de les rouvrir (la lecture accepte un mélange clair/scellé).
  writeMeta({ v: 1, pw: { salt, ...wrapped }, settings: { autolock: 15 } });
  await openWith(raw);
  await saveSecrets();
  await db.reseal(null);          // chiffre tout ce qui existait en clair
}

export async function unlockPassword(password) {
  const m = readMeta();
  const raw = await cr.decryptBytes(await cr.deriveKey(password, m.pw.salt), m.pw); // lève si faux
  await openWith(raw);
}

export async function changePassword(oldPw, newPw) {
  const m = readMeta();
  await cr.decryptBytes(await cr.deriveKey(oldPw, m.pw.salt), m.pw);
  const salt = cr.newSalt();
  m.pw = { salt, ...(await cr.encrypt(await cr.deriveKey(newPw, salt), master)) };
  writeMeta(m);
}

export async function disable(password) {
  const m = readMeta();
  await cr.decryptBytes(await cr.deriveKey(password, m.pw.salt), m.pw);
  const prev = { seal: t => cr.encrypt(dbKey, t), open: box => cr.decrypt(dbKey, box) };
  db.setCipher(null);
  await db.reseal(prev);         // réécrit la base en clair
  localStorage.removeItem(META); localStorage.removeItem(SECRETS);
  master = dbKey = secKey = secrets = null;
  emit();
}

export function lock() {
  master = dbKey = secKey = secrets = null;
  db.setCipher(null);
  location.reload(); // vide la mémoire de la page : notes, clés, tout
}

export function setSetting(k, v) { const m = readMeta(); m.settings = { ...m.settings, [k]: v }; writeMeta(m); }

// ---------- Passkey (WebAuthn PRF) ----------
// Dans l'app native (vue WebKit embarquée), les passkeys web ne sont pas disponibles.
export const passkeyPossible = () => !!globalThis.PublicKeyCredential && cr.available() && !document.documentElement.dataset.native;

async function prf(ids, salt) {
  const a = await navigator.credentials.get({ publicKey: {
    challenge: cr.random(32), userVerification: 'required', timeout: 60000,
    allowCredentials: ids.map(id => ({ type: 'public-key', id })),
    extensions: { prf: { eval: { first: salt } } },
  } });
  const out = a?.getClientExtensionResults?.().prf?.results?.first;
  if (!out) throw new Error('Cette passkey ne permet pas de dériver une clé (extension PRF absente).');
  return new Uint8Array(out);
}

export async function addPasskey() {
  if (!master) throw new Error('Ouvre d’abord le coffre.');
  const salt = cr.random(32);
  const cred = await navigator.credentials.create({ publicKey: {
    rp: { name: 'Studio' }, challenge: cr.random(32), timeout: 60000,
    user: { id: cr.random(16), name: 'Coffre Studio', displayName: 'Coffre Studio' },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
    extensions: { prf: { eval: { first: salt } } },
  } });
  const ext = cred.getClientExtensionResults?.() || {};
  if (ext.prf?.enabled === false) throw new Error('Ce navigateur ou cet appareil ne gère pas l’extension PRF des passkeys.');
  const out = ext.prf?.results?.first ? new Uint8Array(ext.prf.results.first) : await prf([cred.rawId], salt);
  const kek = await cr.hkdfKey(out, 'carnet/passkey');
  const m = readMeta();
  m.pk = { id: cr.b64(cred.rawId), salt: cr.b64(salt), ...(await cr.encrypt(kek, master)) };
  writeMeta(m); emit();
}

export async function unlockPasskey() {
  const m = readMeta();
  const out = await prf([cr.unb64(m.pk.id)], cr.unb64(m.pk.salt));
  const raw = await cr.decryptBytes(await cr.hkdfKey(out, 'carnet/passkey'), m.pk);
  await openWith(raw);
}

export function removePasskey() { const m = readMeta(); delete m.pk; writeMeta(m); emit(); }

// ---------- Secrets ----------
async function saveSecrets() { localStorage.setItem(SECRETS, JSON.stringify(await cr.encrypt(secKey, JSON.stringify(secrets)))); }
export const secret = name => secrets?.[name] ?? null;
export async function setSecret(name, value) {
  if (!secrets) throw new Error('Le coffre est fermé.');
  if (value == null || value === '') delete secrets[name]; else secrets[name] = value;
  await saveSecrets(); emit();
}

// ---------- Verrouillage automatique après inactivité ----------
export function startAutoLock() {
  let last = Date.now();
  const bump = () => { last = Date.now(); };
  for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart']) addEventListener(ev, bump, { passive: true, capture: true });
  setInterval(() => {
    const min = settings().autolock;
    if (master && min > 0 && Date.now() - last > min * 60e3) lock();
  }, 15e3);
}
