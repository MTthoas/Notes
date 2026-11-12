// Pont vers la biométrie de l'app native (Touch ID / Face ID). Dans un navigateur, ce sont les passkeys qui font ce rôle.
// Chaque demande part avec un numéro ; l'app répond par window.carnet.bio({ id, ok, ... }).
import { b64, unb64, type Bytes } from './crypto.ts';

/** Réponse de l'app native. */
export interface BioReply { id?: number; ok: boolean; error?: string; message?: string; available?: boolean; kind?: string; reason?: string; secret?: string }

const bridge = () => window.webkit?.messageHandlers?.carnet;
const waiting = new Map<number, (r: BioReply) => void>();
let seq = 0;

export const supported = (): boolean => !!bridge();

export function onNative(p: BioReply): void {
  if (typeof p?.id !== 'number') return;
  const done = waiting.get(p.id);
  if (done) { waiting.delete(p.id); done(p); }
}

function call(action: string, extra: Record<string, unknown> = {}, timeout = 120000): Promise<BioReply> {
  return new Promise<BioReply>(resolve => {
    const b = bridge();
    if (!b) return resolve({ ok: false, error: 'unavailable', message: 'La biométrie n’est disponible que dans l’app Studio.' });
    const id = ++seq;
    waiting.set(id, resolve);
    setTimeout(() => { if (waiting.delete(id)) resolve({ ok: false, error: 'timeout', message: 'Pas de réponse de l’appareil.' }); }, timeout);
    b.postMessage({ type: 'bio', action, id, ...extra });
  });
}

export const status = () => call('status', {}, 5000);                              // { available, kind, reason }
export const store = async (secret: Bytes) => call('enable', { secret: b64(secret) });      // secret : 32 octets
export const remove = () => call('remove', {}, 5000);
export type Unlocked = { ok: true; secret: Bytes } | { ok: false; error?: string; message?: string };
export async function unlock(reason: string): Promise<Unlocked> {
  const r = await call('unlock', { reason });
  if (r.ok && typeof r.secret === 'string') return { ok: true, secret: unb64(r.secret) };
  return { ok: false, error: r.error ?? 'invalid', message: r.message };
}
