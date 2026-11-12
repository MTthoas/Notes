// Fine couche au-dessus d'IndexedDB : tout reste dans le navigateur.
// Quand le coffre est ouvert, chaque enregistrement est scellé (AES-GCM) avant d'être écrit :
// seuls les identifiants nécessaires aux index restent lisibles sur le disque.
const NAME = 'carnet', VERSION = 1;
const CLEAR = { notes: ['id'], versions: ['id', 'noteId'] };
let dbp, cipher = null;

export const setCipher = c => { cipher = c; };

function open() {
  return dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open(NAME, VERSION);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('notes')) d.createObjectStore('notes', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('versions')) {
        d.createObjectStore('versions', { keyPath: 'id' }).createIndex('noteId', 'noteId');
      }
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

async function tx(store, mode, fn) {
  const d = await open();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode);
    let out;
    const r = fn(t.objectStore(store));
    if (r && 'onsuccess' in r) r.onsuccess = () => { out = r.result; };
    t.oncomplete = () => res(out);
    t.onerror = t.onabort = () => rej(t.error);
  });
}

// Le chiffrement est fait AVANT d'ouvrir la transaction : une transaction IndexedDB se ferme
// d'elle-même si on attend une promesse étrangère pendant qu'elle est active.
async function seal(store, v) {
  if (!cipher) return v;
  const out = {}; for (const k of CLEAR[store]) out[k] = v[k];
  out.sealed = await cipher.seal(JSON.stringify(v));
  return out;
}
async function unseal(v) {
  if (!v || !v.sealed) return v;
  if (!cipher) return null;
  try { return JSON.parse(await cipher.open(v.sealed)); } catch { return null; }
}
const unsealAll = async list => (await Promise.all(list.map(unseal))).filter(Boolean);

export const all = async store => unsealAll(await tx(store, 'readonly', s => s.getAll()));
export const put = async (store, v) => { const rec = await seal(store, v); return tx(store, 'readwrite', s => s.put(rec)); };
export const del = (store, id) => tx(store, 'readwrite', s => s.delete(id));
export const byIndex = async (store, index, key) => unsealAll(await tx(store, 'readonly', s => s.index(index).getAll(key)));
export const putMany = async (store, list) => { const recs = await Promise.all(list.map(v => seal(store, v))); return tx(store, 'readwrite', s => { for (const v of recs) s.put(v); }); };
export const delMany = (store, ids) => tx(store, 'readwrite', s => { for (const id of ids) s.delete(id); });

// Réécrit toute la base avec le chiffrement courant (activation / désactivation du coffre).
// `prev` : chiffrement en vigueur avant le changement, pour relire l'existant.
export async function reseal(prev) {
  for (const store of ['notes', 'versions']) {
    const raw = await tx(store, 'readonly', s => s.getAll());
    const next = cipher; cipher = prev;
    const plain = await unsealAll(raw);
    cipher = next;
    if (plain.length !== raw.length) throw new Error('Certains enregistrements n’ont pas pu être déchiffrés.');
    await putMany(store, plain);
  }
}
