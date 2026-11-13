// Pont générique vers l'app native : une demande part avec un numéro, l'app répond par window.carnet.reply({ id, ok, ... }).
// Dans un navigateur, available() est faux et chaque appel répond « indisponible » sans erreur.

export interface Reply { id?: number; ok: boolean; message?: string; [k: string]: unknown }

const bridge = () => window.webkit?.messageHandlers?.carnet;
const waiting = new Map<number, (r: Reply) => void>();
let seq = 0;

export const available = (): boolean => !!bridge() && document.documentElement.dataset.native !== undefined;

export function onReply(raw: unknown): void {
  const r = raw as Reply | null;
  if (!r || typeof r.id !== 'number') return;
  const done = waiting.get(r.id);
  if (done) { waiting.delete(r.id); done(r); }
}

export function call(type: string, action: string, extra: Record<string, unknown> = {}, timeout = 120000): Promise<Reply> {
  return new Promise<Reply>(resolve => {
    const b = bridge();
    if (!b) return resolve({ ok: false, message: 'Disponible dans l’app Studio pour Mac.' });
    const id = ++seq;
    waiting.set(id, resolve);
    setTimeout(() => { if (waiting.delete(id)) resolve({ ok: false, message: 'Pas de réponse de l’app.' }); }, timeout);
    b.postMessage({ type, action, id, ...extra });
  });
}
