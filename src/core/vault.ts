// Coffre : une clé maîtresse aléatoire (256 bits) chiffre toute la base et les secrets
// (clés API, appareils liés). Elle n'est jamais écrite en clair : seulement « emballée »
// par une clé dérivée du mot de passe et, en option, par une passkey du navigateur (extension PRF)
// ou, dans l'app native, par un secret du trousseau libéré par Touch ID / Face ID.
import * as cr from './crypto.ts';
import * as db from './db.ts';
import * as bio from './biometric.ts';
import type { Bytes } from './crypto.ts';
import type { Box, SaltedBox } from '../types.ts';

const META = 'carnet.vault', SECRETS = 'carnet.secrets';

export interface VaultSettings { autolock: number }
/** Ce qui est écrit en clair sur le disque : uniquement des clés emballées et des réglages. */
interface VaultMeta {
  v: 1;
  pw: SaltedBox;
  pk?: Box & { id: string; salt: string };
  bio?: Box & { kind: string };
  settings?: Partial<VaultSettings>;
}

/** Erreur de déverrouillage avec un code exploitable par l'interface (annulation, secret périmé…). */
export class UnlockError extends Error {
  constructor(message: string, readonly code: string) { super(message); this.name = 'UnlockError'; }
}

let master: Bytes | null = null;
let dbKey: CryptoKey | null = null;
let secKey: CryptoKey | null = null;
let secrets: Record<string, unknown> | null = null;
const listeners = new Set<() => void>();

function readMeta(): VaultMeta | null {
  try {
    const m = JSON.parse(localStorage.getItem(META) || 'null') as VaultMeta | null;
    return m && typeof m === 'object' && m.pw ? m : null;
  } catch { return null; }
}
function meta(): VaultMeta {
  const m = readMeta();
  if (!m) throw new Error('Le coffre n’est pas activé.');
  return m;
}
const writeMeta = (m: VaultMeta): void => localStorage.setItem(META, JSON.stringify(m));
const emit = (): void => listeners.forEach(f => f());

export const enabled = (): boolean => !!readMeta();
export const isOpen = (): boolean => !!master;
export const hasPasskey = (): boolean => !!readMeta()?.pk;
export const hasBiometric = (): boolean => !!readMeta()?.bio && bio.supported();
export const biometricKind = (): string => readMeta()?.bio?.kind || 'biométrie';
export const settings = (): VaultSettings => ({ autolock: 15, ...(readMeta()?.settings || {}) });
export const onChange = (f: () => void): void => { listeners.add(f); };

async function openWith(raw: Bytes): Promise<void> {
  const dk = await cr.hkdfKey(raw, 'carnet/db');
  const sk = await cr.hkdfKey(raw, 'carnet/secrets');
  db.setCipher({ seal: t => cr.encrypt(dk, t), open: box => cr.decrypt(dk, box) });
  const box = localStorage.getItem(SECRETS);
  const loaded = box ? JSON.parse(await cr.decrypt(sk, JSON.parse(box) as Box)) as Record<string, unknown> : {};
  master = raw; dbKey = dk; secKey = sk; secrets = loaded;
  emit();
}

export async function create(password: string): Promise<void> {
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

export async function unlockPassword(password: string): Promise<void> {
  const m = meta();
  const raw = await cr.decryptBytes(await cr.deriveKey(password, m.pw.salt), m.pw); // lève si faux
  await openWith(raw);
}

export async function changePassword(oldPw: string, newPw: string): Promise<void> {
  const m = meta();
  if (!master) throw new Error('Ouvre d’abord le coffre.');
  await cr.decryptBytes(await cr.deriveKey(oldPw, m.pw.salt), m.pw);
  const salt = cr.newSalt();
  m.pw = { salt, ...(await cr.encrypt(await cr.deriveKey(newPw, salt), master)) };
  writeMeta(m);
}

export async function disable(password: string): Promise<void> {
  const m = meta();
  await cr.decryptBytes(await cr.deriveKey(password, m.pw.salt), m.pw);
  const key = dbKey;
  if (!key) throw new Error('Ouvre d’abord le coffre.');
  const prev: db.Cipher = { seal: t => cr.encrypt(key, t), open: box => cr.decrypt(key, box) };
  db.setCipher(null);
  await db.reseal(prev);         // réécrit la base en clair
  localStorage.removeItem(META); localStorage.removeItem(SECRETS);
  master = dbKey = secKey = null; secrets = null;
  emit();
}

export function lock(): void {
  master = dbKey = secKey = null; secrets = null;
  db.setCipher(null);
  location.reload(); // vide la mémoire de la page : notes, clés, tout
}

export function setSetting<K extends keyof VaultSettings>(k: K, v: VaultSettings[K]): void {
  const m = meta(); m.settings = { ...m.settings, [k]: v }; writeMeta(m);
}

// ---------- Passkey (WebAuthn PRF) ----------
// Dans l'app native (vue WebKit embarquée), les passkeys web ne sont pas disponibles.
export const passkeyPossible = (): boolean => !!globalThis.PublicKeyCredential && cr.available() && !document.documentElement.dataset.native;

type PrfResults = { prf?: { enabled?: boolean; results?: { first?: BufferSource } } };
const prfOf = (c: Credential | null): PrfResults => (c as PublicKeyCredential | null)?.getClientExtensionResults?.() as PrfResults ?? {};
const toBytes = (b: BufferSource): Bytes => new Uint8Array(b instanceof ArrayBuffer ? b : b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);

async function prf(ids: Bytes[], salt: Bytes): Promise<Bytes> {
  const a = await navigator.credentials.get({ publicKey: {
    challenge: cr.random(32), userVerification: 'required', timeout: 60000,
    allowCredentials: ids.map(id => ({ type: 'public-key' as const, id })),
    extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs,
  } });
  const out = prfOf(a).prf?.results?.first;
  if (!out) throw new Error('Cette passkey ne permet pas de dériver une clé (extension PRF absente).');
  return toBytes(out);
}

export async function addPasskey(): Promise<void> {
  if (!master) throw new Error('Ouvre d’abord le coffre.');
  const salt = cr.random(32);
  const cred = await navigator.credentials.create({ publicKey: {
    rp: { name: 'Studio' }, challenge: cr.random(32), timeout: 60000,
    user: { id: cr.random(16), name: 'Coffre Studio', displayName: 'Coffre Studio' },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
    extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs,
  } }) as PublicKeyCredential | null;
  if (!cred) throw new Error('Création de la passkey annulée.');
  const ext = prfOf(cred);
  if (ext.prf?.enabled === false) throw new Error('Ce navigateur ou cet appareil ne gère pas l’extension PRF des passkeys.');
  const rawId = new Uint8Array(cred.rawId);
  const first = ext.prf?.results?.first;
  const out = first ? toBytes(first) : await prf([rawId], salt);
  const kek = await cr.hkdfKey(out, 'carnet/passkey');
  const m = meta();
  m.pk = { id: cr.b64(rawId), salt: cr.b64(salt), ...(await cr.encrypt(kek, master)) };
  writeMeta(m); emit();
}

export async function unlockPasskey(): Promise<void> {
  const pk = meta().pk;
  if (!pk) throw new Error('Aucune passkey n’est enregistrée.');
  const out = await prf([cr.unb64(pk.id)], cr.unb64(pk.salt));
  const raw = await cr.decryptBytes(await cr.hkdfKey(out, 'carnet/passkey'), pk);
  await openWith(raw);
}

export function removePasskey(): void { const m = meta(); delete m.pk; writeMeta(m); emit(); }

// ---------- Biométrie de l'app native (Touch ID / Face ID) ----------
// Un secret aléatoire vit dans le trousseau du système ; il n'en sort qu'après une vérification biométrique
// et emballe la clé maîtresse, exactement comme la passkey. Le mot de passe reste toujours valable.
export const biometricPossibleSync = (): boolean => bio.supported();
export const biometricPossible = async (): Promise<bio.BioReply> => bio.supported() ? bio.status() : { ok: true, available: false, kind: '' };

export async function addBiometric(): Promise<void> {
  if (!master) throw new Error('Ouvre d’abord le coffre.');
  const st = await bio.status();
  if (!st.available) throw new Error(st.reason || 'La biométrie n’est pas disponible sur cet appareil.');
  const secret = cr.random(32);
  const r = await bio.store(secret);
  if (!r.ok) throw new Error(r.message || 'Impossible d’enregistrer le secret.');
  const m = meta();
  m.bio = { kind: st.kind || 'biométrie', ...(await cr.encrypt(await cr.hkdfKey(secret, 'carnet/biometric'), master)) };
  writeMeta(m); emit();
}

export async function unlockBiometric(): Promise<void> {
  const box = meta().bio;
  if (!box) throw new UnlockError('Le déverrouillage biométrique n’est pas activé.', 'missing');
  const r = await bio.unlock('Ouvrir Studio');
  if (!r.ok) throw new UnlockError(r.message || 'Déverrouillage biométrique impossible.', r.error || 'denied');
  let raw: Bytes;
  try { raw = await cr.decryptBytes(await cr.hkdfKey(r.secret, 'carnet/biometric'), box); }
  catch { throw new UnlockError('Le déverrouillage biométrique ne correspond plus. Utilise le mot de passe, puis réactive-le dans Réglages → Sécurité.', 'stale'); }
  await openWith(raw);
}

export async function removeBiometric(): Promise<void> {
  await bio.remove();
  const m = meta(); delete m.bio; writeMeta(m); emit();
}

// ---------- Secrets ----------
async function saveSecrets(): Promise<void> {
  if (!secKey || !secrets) throw new Error('Le coffre est fermé.');
  localStorage.setItem(SECRETS, JSON.stringify(await cr.encrypt(secKey, JSON.stringify(secrets))));
}
/** Secret du coffre (clé d'API par défaut ; la liste des appareils liés est un tableau). */
export const secret = <T = string>(name: string): T | null => (secrets?.[name] as T | undefined) ?? null;
export async function setSecret(name: string, value: unknown): Promise<void> {
  if (!secrets) throw new Error('Le coffre est fermé.');
  if (value == null || value === '') delete secrets[name]; else secrets[name] = value;
  await saveSecrets(); emit();
}

// ---------- Verrouillage automatique après inactivité ----------
export function startAutoLock(): void {
  let last = Date.now();
  const bump = () => { last = Date.now(); };
  for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart']) addEventListener(ev, bump, { passive: true, capture: true });
  setInterval(() => {
    const min = settings().autolock;
    if (master && min > 0 && Date.now() - last > min * 60e3) lock();
  }, 15e3);
}
