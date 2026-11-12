// Notes vocales : l'app native transcrit la voix sur l'appareil (rien n'est envoyé en ligne),
// et le texte devient une note, synchronisée ensuite comme les autres.
import * as store from '../core/store.js';
import { esc } from '../lib/markdown.js';
import { $, icon, toast, modal } from '../ui/kit.js';

let app = null, session = null;
const bridge = () => window.webkit?.messageHandlers?.carnet;
export const available = () => !!bridge();
export const init = api => { app = api; };

// Appelé par l'app native : { state: listening | partial | final | error | cancelled, text?, message? }
export function onNative(p) {
  if (!session || !p) return;
  if (p.state === 'listening') session.status('Je t’écoute…', true);
  else if (p.state === 'partial') session.text(p.text || '');
  else if (p.state === 'error') { session.close(); toast(p.message || 'La note vocale a échoué.'); }
  else if (p.state === 'final') session.done(p.text || '');
  else if (p.state === 'cancelled') session.close();
}

async function save(text) {
  text = text.trim();
  if (!text) return toast('Rien n’a été entendu.');
  const d = new Date();
  const title = `Note vocale · ${d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })} ${d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
  const n = await store.createNote({ title, body: `${text}\n\n#vocal`, inbox: true });
  toast('Note vocale enregistrée', { label: 'Ouvrir', run: () => app.openNote(n.id) });
}

export function record() {
  if (!available()) return toast('Les notes vocales fonctionnent dans l’app Studio (iPhone ou Mac) : la transcription s’y fait sur l’appareil.');
  if (session) return;
  let finished = false, last = '';
  const m = modal({ cls: 'small voice', onClose: () => { if (!finished) bridge().postMessage({ type: 'voice', action: 'cancel' }); session = null; },
    html: `<div class="vc-head"><i class="vc-dot"></i><span class="vc-state">Préparation du micro…</span></div><div class="vc-text" aria-live="polite"></div>
      <p class="modal-hint">${icon('shield')} Transcription sur l’appareil : ta voix ne part nulle part.</p>
      <div class="modal-actions"><button class="btn" data-vc-cancel>Annuler</button><button class="btn btn-primary" data-vc-stop disabled>Terminer</button></div>` });
  session = {
    status: (t, live) => { $('.vc-state', m.node).textContent = t; $('.vc-dot', m.node).classList.toggle('live', !!live); $('[data-vc-stop]', m.node).disabled = !live; },
    text: t => { last = t; const b = $('.vc-text', m.node); b.textContent = t; b.scrollTop = b.scrollHeight; },
    done: async t => { finished = true; m.close(); await save(t || last); },
    close: () => { finished = true; m.close(); },
  };
  $('[data-vc-cancel]', m.node).onclick = () => m.close();
  $('[data-vc-stop]', m.node).onclick = () => { session?.status('Transcription des derniers mots…', false); bridge().postMessage({ type: 'voice', action: 'stop' }); };
  bridge().postMessage({ type: 'voice', action: 'start' });
}
