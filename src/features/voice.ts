// Notes vocales : l'app native transcrit la voix sur l'appareil (rien n'est envoyé en ligne),
// et le texte devient une note, synchronisée ensuite comme les autres.
import * as store from '../core/store.ts';
import { $, icon, toast, modal, need } from '../ui/kit.ts';
import type { AppShell } from '../types.ts';

/** Message de l'app native pendant la dictée. */
interface VoiceEvent { state: 'listening' | 'partial' | 'final' | 'error' | 'cancelled'; text?: string; message?: string }
interface Session { status(text: string, live: boolean): void; text(t: string): void; done(t: string): Promise<void>; close(): void }

let app!: AppShell;
let session: Session | null = null;
const bridge = () => window.webkit?.messageHandlers?.carnet;
const send = (action: 'start' | 'stop' | 'cancel') => bridge()?.postMessage({ type: 'voice', action });
export const available = (): boolean => !!bridge();
export const init = (shell: AppShell): void => { app = shell; };

// Appelé par l'app native : { state: listening | partial | final | error | cancelled, text?, message? }
export function onNative(raw: unknown): void {
  const p = raw as VoiceEvent | null;
  if (!session || !p || typeof p.state !== 'string') return;
  if (p.state === 'listening') session.status('Je t’écoute…', true);
  else if (p.state === 'partial') session.text(p.text || '');
  else if (p.state === 'error') { session.close(); toast(p.message || 'La note vocale a échoué.'); }
  else if (p.state === 'final') void session.done(p.text || '');
  else if (p.state === 'cancelled') session.close();
}

async function save(text: string): Promise<void> {
  text = text.trim();
  if (!text) { toast('Rien n’a été entendu.'); return; }
  const d = new Date();
  const title = `Note vocale · ${d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })} ${d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
  const n = await store.createNote({ title, body: `${text}\n\n#vocal`, inbox: true });
  toast('Note vocale enregistrée', { label: 'Ouvrir', run: () => app.openNote(n.id) });
}

export function record(): void {
  if (!available()) { toast('Les notes vocales fonctionnent dans l’app Studio (iPhone ou Mac) : la transcription s’y fait sur l’appareil.'); return; }
  if (session) return;
  let finished = false, last = '';
  const m = modal({ cls: 'small voice', onClose: () => { if (!finished) send('cancel'); session = null; },
    html: `<div class="vc-head"><i class="vc-dot"></i><span class="vc-state">Préparation du micro…</span></div><div class="vc-text" aria-live="polite"></div>
      <p class="modal-hint">${icon('shield')} Transcription sur l’appareil : ta voix ne part nulle part.</p>
      <div class="modal-actions"><button class="btn" data-vc-cancel>Annuler</button><button class="btn btn-primary" data-vc-stop disabled>Terminer</button></div>` });
  const stop = need<HTMLButtonElement>('[data-vc-stop]', m.node);
  session = {
    status: (t, live) => { need('.vc-state', m.node).textContent = t; $('.vc-dot', m.node)?.classList.toggle('live', live); stop.disabled = !live; },
    text: t => { last = t; const b = need('.vc-text', m.node); b.textContent = t; b.scrollTop = b.scrollHeight; },
    done: async t => { finished = true; m.close(); await save(t || last); },
    close: () => { finished = true; m.close(); },
  };
  need('[data-vc-cancel]', m.node).onclick = () => m.close();
  stop.onclick = () => { session?.status('Transcription des derniers mots…', false); send('stop'); };
  send('start');
}
