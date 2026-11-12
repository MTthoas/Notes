// Chiffrement côté navigateur uniquement (WebCrypto) :
// PBKDF2-SHA256 -> AES-GCM 256 pour les mots de passe, HKDF pour dériver des sous-clés.
const enc = new TextEncoder(), dec = new TextDecoder();
const ITER = 600000;

export const b64 = buf => {
  let s = ''; const a = new Uint8Array(buf);
  for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
  return btoa(s);
};
export const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
export const b64url = buf => b64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const unb64url = s => unb64(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4));
export const random = n => crypto.getRandomValues(new Uint8Array(n));
export const available = () => !!(globalThis.crypto && crypto.subtle);
export const newSalt = () => b64(random(16));
export const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
export const sha256 = async data => new Uint8Array(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? enc.encode(data) : data));

export async function deriveKey(password, salt) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: unb64(salt), iterations: ITER, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

// Sous-clé AES-GCM dérivée d'un secret binaire (clé maîtresse, secret d'appairage, sortie PRF d'une passkey).
export async function hkdfKey(secret, info, salt = new Uint8Array(32)) {
  const base = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode(info) },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
export async function hkdfBytes(secret, info, len = 32) {
  const base = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: enc.encode(info) }, base, len * 8));
}

export async function encrypt(key, text) {
  const iv = random(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, typeof text === 'string' ? enc.encode(text) : text);
  return { iv: b64(iv), ct: b64(ct) };
}
export async function decrypt(key, { iv, ct }) { return dec.decode(await decryptBytes(key, { iv, ct })); }
export async function decryptBytes(key, { iv, ct }) {
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, key, unb64(ct)));
}

// Format compact (iv ‖ texte chiffré) pour les messages transportés : base64url.
export async function sealCompact(key, bytes) {
  const iv = random(12), ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes));
  const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12);
  return b64url(out);
}
export async function openCompact(key, s) {
  const a = unb64url(s);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: a.slice(0, 12) }, key, a.slice(12)));
}

// Compression gzip native (réduit les messages avant chiffrement).
async function pipe(bytes, stream) { return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer()); }
export const gzip = text => 'CompressionStream' in globalThis ? pipe(enc.encode(text), new CompressionStream('gzip')) : Promise.resolve(enc.encode(text));
export const gunzip = async bytes => bytes[0] === 0x1f && bytes[1] === 0x8b ? dec.decode(await pipe(bytes, new DecompressionStream('gzip'))) : dec.decode(bytes);

// Sauvegarde protégée par mot de passe (export JSON quand le coffre est actif).
export async function sealWithPassword(password, text) {
  const salt = newSalt(), key = await deriveKey(password, salt);
  return { salt, ...(await encrypt(key, await gzip(text))) };
}
export async function openWithPassword(password, box) {
  const key = await deriveKey(password, box.salt);
  return gunzip(await decryptBytes(key, box));
}
