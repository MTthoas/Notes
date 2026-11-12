// Pont vers la biométrie de l'app native (Touch ID / Face ID). Dans un navigateur, ce sont les passkeys qui font ce rôle.
// Chaque demande part avec un numéro ; l'app répond par window.carnet.bio({ id, ok, ... }).
import { b64, unb64 } from './crypto.js';

const bridge = () => window.webkit?.messageHandlers?.carnet;
const waiting = new Map();
let seq = 0;

export const supported = () => !!bridge();

export function onNative(p) {
  const done = waiting.get(p?.id);
  if (done) { waiting.delete(p.id); done(p); }
}

function call(action, extra = {}, timeout = 120000) {
  return new Promise(resolve => {
    if (!bridge()) return resolve({ ok: false, error: 'unavailable', message: 'La biométrie n’est disponible que dans l’app Studio.' });
    const id = ++seq;
    waiting.set(id, resolve);
    setTimeout(() => { if (waiting.delete(id)) resolve({ ok: false, error: 'timeout', message: 'Pas de réponse de l’appareil.' }); }, timeout);
    bridge().postMessage({ type: 'bio', action, id, ...extra });
  });
}

export const status = () => call('status', {}, 5000);                              // { available, kind, reason }
export const store = async secret => call('enable', { secret: b64(secret) });      // secret : 32 octets
export const remove = () => call('remove', {}, 5000);
export async function unlock(reason) {
  const r = await call('unlock', { reason });
  return r.ok ? { ...r, secret: unb64(r.secret) } : r;
}
