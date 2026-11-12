// Chiffrement côté navigateur uniquement (WebCrypto) :
// PBKDF2-SHA256 -> AES-GCM 256 pour les mots de passe, HKDF pour dériver des sous-clés.
import type { Box, SaltedBox } from '../types.ts';

/** Octets adossés à un ArrayBuffer ordinaire (ce qu'attend WebCrypto). */
export type Bytes = Uint8Array<ArrayBuffer>;

const enc = new TextEncoder(), dec = new TextDecoder();
const ITER = 600000;

export const b64 = (buf: ArrayBuffer | Uint8Array): string => {
  let s = ''; const a = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i] ?? 0);
  return btoa(s);
};
export const unb64 = (s: string): Bytes => Uint8Array.from(atob(s), c => c.charCodeAt(0));
export const b64url = (buf: ArrayBuffer | Uint8Array): string => b64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const unb64url = (s: string): Bytes => unb64(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4));
export const random = (n: number): Bytes => crypto.getRandomValues(new Uint8Array(n));
export const available = (): boolean => !!(globalThis.crypto && crypto.subtle);
export const newSalt = (): string => b64(random(16));
export const hex = (buf: ArrayBuffer | Uint8Array): string => [...(buf instanceof Uint8Array ? buf : new Uint8Array(buf))].map(b => b.toString(16).padStart(2, '0')).join('');
export const sha256 = async (data: string | Bytes): Promise<Bytes> => new Uint8Array(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? enc.encode(data) : data));

export async function deriveKey(password: string, salt: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: unb64(salt), iterations: ITER, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

// Sous-clé AES-GCM dérivée d'un secret binaire (clé maîtresse, secret d'appairage, sortie PRF d'une passkey).
export async function hkdfKey(secret: Bytes, info: string, salt: Bytes = new Uint8Array(32)): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode(info) },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
export async function hkdfBytes(secret: Bytes, info: string, len = 32): Promise<Bytes> {
  const base = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: enc.encode(info) }, base, len * 8));
}

export async function encrypt(key: CryptoKey, text: string | Bytes): Promise<Box> {
  const iv = random(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, typeof text === 'string' ? enc.encode(text) : text);
  return { iv: b64(iv), ct: b64(ct) };
}
export async function decrypt(key: CryptoKey, box: Box): Promise<string> { return dec.decode(await decryptBytes(key, box)); }
export async function decryptBytes(key: CryptoKey, { iv, ct }: Box): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, key, unb64(ct)));
}

// Format compact (iv ‖ texte chiffré) pour les messages transportés : base64url.
export async function sealCompact(key: CryptoKey, bytes: Bytes): Promise<string> {
  const iv = random(12), ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes));
  const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12);
  return b64url(out);
}
export async function openCompact(key: CryptoKey, s: string): Promise<Bytes> {
  const a = unb64url(s);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: a.slice(0, 12) }, key, a.slice(12)));
}

// Compression gzip native (réduit les messages avant chiffrement).
async function pipe(bytes: Bytes, stream: CompressionStream | DecompressionStream): Promise<Bytes> {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}
export const gzip = (text: string): Promise<Bytes> => 'CompressionStream' in globalThis ? pipe(enc.encode(text), new CompressionStream('gzip')) : Promise.resolve(enc.encode(text));
export const gunzip = async (bytes: Bytes): Promise<string> => bytes[0] === 0x1f && bytes[1] === 0x8b ? dec.decode(await pipe(bytes, new DecompressionStream('gzip'))) : dec.decode(bytes);

// Sauvegarde protégée par mot de passe (export JSON quand le coffre est actif).
export async function sealWithPassword(password: string, text: string): Promise<SaltedBox> {
  const salt = newSalt(), key = await deriveKey(password, salt);
  return { salt, ...(await encrypt(key, await gzip(text))) };
}
export async function openWithPassword(password: string, box: SaltedBox): Promise<string> {
  const key = await deriveKey(password, box.salt);
  return gunzip(await decryptBytes(key, box));
}
