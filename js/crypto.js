// Chiffrement par note : PBKDF2-SHA256 -> AES-GCM 256, entièrement côté navigateur.
const enc = new TextEncoder(), dec = new TextDecoder();
const ITER = 600000;

export const b64 = buf => {
  let s = ''; const a = new Uint8Array(buf);
  for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
  return btoa(s);
};
export const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
export const available = () => !!(globalThis.crypto && crypto.subtle);
export const newSalt = () => b64(crypto.getRandomValues(new Uint8Array(16)));

export async function deriveKey(password, salt) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: unb64(salt), iterations: ITER, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function encrypt(key, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(text));
  return { iv: b64(iv), ct: b64(ct) };
}

export async function decrypt(key, { iv, ct }) {
  return dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, key, unb64(ct)));
}
