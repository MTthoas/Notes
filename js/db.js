// Fine couche au-dessus d'IndexedDB : tout reste dans le navigateur.
const NAME = 'carnet', VERSION = 1;
let dbp;

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

export const all = store => tx(store, 'readonly', s => s.getAll());
export const put = (store, v) => tx(store, 'readwrite', s => s.put(v));
export const del = (store, id) => tx(store, 'readwrite', s => s.delete(id));
export const byIndex = (store, index, key) => tx(store, 'readonly', s => s.index(index).getAll(key));
export const putMany = (store, list) => tx(store, 'readwrite', s => { for (const v of list) s.put(v); });
export const delMany = (store, ids) => tx(store, 'readwrite', s => { for (const id of ids) s.delete(id); });
