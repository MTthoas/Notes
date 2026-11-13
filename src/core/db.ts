// Fine couche au-dessus d'IndexedDB : tout reste dans le navigateur.
// Quand le coffre est ouvert, chaque enregistrement est scellé (AES-GCM) avant d'être écrit :
// seuls les identifiants nécessaires aux index restent lisibles sur le disque.
import type { Box } from '../types.ts';

// Version 2 : ajoute « journal » (une fiche par jour : demandes faites à Claude Code, activité, résumé).
// Version 3 : ajoute « chats » (conversations de la page Claude).
const NAME = 'carnet', VERSION = 3;
export type StoreName = 'notes' | 'versions' | 'journal' | 'chats';
const STORES: StoreName[] = ['notes', 'versions', 'journal', 'chats'];
const CLEAR: Record<StoreName, string[]> = { notes: ['id'], versions: ['id', 'noteId'], journal: ['id'], chats: ['id'] };

/** Chiffrement appliqué aux enregistrements quand le coffre est ouvert. */
export interface Cipher { seal(text: string): Promise<Box>; open(box: Box): Promise<string> }
type Row = { id: string } & Record<string, unknown>;
type Sealed = { id: string; sealed: Box } & Record<string, unknown>;

let dbp: Promise<IDBDatabase> | undefined;
let cipher: Cipher | null = null;

export const setCipher = (c: Cipher | null): void => { cipher = c; };

function open(): Promise<IDBDatabase> {
  return dbp ||= new Promise<IDBDatabase>((res, rej) => {
    const r = indexedDB.open(NAME, VERSION);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('notes')) d.createObjectStore('notes', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('versions')) {
        d.createObjectStore('versions', { keyPath: 'id' }).createIndex('noteId', 'noteId');
      }
      if (!d.objectStoreNames.contains('journal')) d.createObjectStore('journal', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('chats')) d.createObjectStore('chats', { keyPath: 'id' });
    };
    // Une autre fenêtre ouvre une version plus récente de la base : on lui laisse la place.
    r.onblocked = () => console.warn('Base locale : mise à jour en attente d’une autre fenêtre de Studio.');
    r.onsuccess = () => { const d = r.result; d.onversionchange = () => { d.close(); dbp = undefined; }; res(d); };
    r.onerror = () => rej(r.error);
  });
}

/** Exécute une transaction et rend le résultat de la requête produite par `fn` (s'il y en a une). */
async function tx<T = undefined>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T> {
  const d = await open();
  return new Promise<T>((res, rej) => {
    const t = d.transaction(store, mode);
    let out: T | undefined;
    const r = fn(t.objectStore(store));
    if (r) r.onsuccess = () => { out = r.result; };
    t.oncomplete = () => res(out as T);
    t.onerror = t.onabort = () => rej(t.error);
  });
}

// Le chiffrement est fait AVANT d'ouvrir la transaction : une transaction IndexedDB se ferme
// d'elle-même si on attend une promesse étrangère pendant qu'elle est active.
async function seal(store: StoreName, v: Row): Promise<Row> {
  if (!cipher) return v;
  const out: Row = { id: v.id };
  for (const k of CLEAR[store]) out[k] = v[k];
  out.sealed = await cipher.seal(JSON.stringify(v));
  return out;
}
const isSealed = (v: unknown): v is Sealed => !!v && typeof v === 'object' && 'sealed' in v && !!(v as Sealed).sealed;
async function unseal<T>(v: unknown): Promise<T | null> {
  if (!isSealed(v)) return (v ?? null) as T | null;
  if (!cipher) return null;
  try { return JSON.parse(await cipher.open(v.sealed)) as T; } catch { return null; }
}
const unsealAll = async <T>(list: unknown[]): Promise<T[]> => (await Promise.all(list.map(v => unseal<T>(v)))).filter((x): x is Awaited<T> & {} => x != null) as T[];

export const all = async <T>(store: StoreName): Promise<T[]> => unsealAll<T>(await tx(store, 'readonly', s => s.getAll()));
export const put = async <T extends { id: string }>(store: StoreName, v: T): Promise<void> => {
  const rec = await seal(store, v as unknown as Row);
  await tx(store, 'readwrite', s => { s.put(rec); });
};
export const get = async <T>(store: StoreName, id: string): Promise<T | null> => unseal<T>(await tx(store, 'readonly', s => s.get(id)));
export const del = (store: StoreName, id: string): Promise<void> => tx(store, 'readwrite', s => { s.delete(id); });
export const byIndex = async <T>(store: StoreName, index: string, key: IDBValidKey): Promise<T[]> =>
  unsealAll<T>(await tx(store, 'readonly', s => s.index(index).getAll(key)));
export const putMany = async <T extends { id: string }>(store: StoreName, list: T[]): Promise<void> => {
  const recs = await Promise.all(list.map(v => seal(store, v as unknown as Row)));
  await tx(store, 'readwrite', s => { for (const v of recs) s.put(v); });
};
export const delMany = (store: StoreName, ids: string[]): Promise<void> => tx(store, 'readwrite', s => { for (const id of ids) s.delete(id); });

// Réécrit toute la base avec le chiffrement courant (activation / désactivation du coffre).
// `prev` : chiffrement en vigueur avant le changement, pour relire l'existant.
export async function reseal(prev: Cipher | null): Promise<void> {
  for (const store of STORES) {
    const raw = await tx(store, 'readonly', s => s.getAll());
    const next = cipher; cipher = prev;
    const plain = await unsealAll<Row>(raw);
    cipher = next;
    if (plain.length !== raw.length) throw new Error('Certains enregistrements n’ont pas pu être déchiffrés.');
    await putMany(store, plain);
  }
}
