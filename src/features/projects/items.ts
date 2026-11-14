// Notes et tâches qu'un agent Claude Code crée dans le projet d'où il est lancé (Réglages → Autorisations,
// « Notes et tâches du projet »). L'agent les écrit à la fin de son compte rendu, dans des blocs ```studio-tâches et
// ```studio-note Titre ; l'app Mac les en retire et les garde jusqu'à confirmation (AgentItems, Agents.swift), puis
// prévient la page (window.carnet.agentItems). Ici, on les crée : chaque tâche dans la liste « Tâches » avec le tag du
// projet, chaque note avec ce tag. Rien d'existant n'est jamais modifié ni supprimé.
// Seule la page de l'app Mac les crée (les notes se synchronisent ensuite) : un appareil lié ne les reçoit pas
// (« agent.items » n'est pas dans REMOTE_ALLOWED), sinon elles seraient créées deux fois.
import * as native from '../../core/native.ts';
import * as store from '../../core/store.ts';
import * as ai from '../../integrations/ai.ts';
import * as tasks from '../tasks.ts';
import * as model from './model.ts';
import { toast } from '../../ui/kit.ts';
import type { ViewState } from '../../types.ts';

interface Item { kind: string; text?: string; title?: string; body?: string }
interface Pending { run: string; project: string; items: Item[] }

/** Tours déjà créés (au cas où la confirmation à l'app Mac se serait perdue) : jamais deux fois les mêmes. */
const DONE_KEY = 'studio.agentItems.done';
const doneRuns = (): string[] => { try { const v: unknown = JSON.parse(localStorage.getItem(DONE_KEY) || '[]'); return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []; } catch { return []; } };
const markDone = (run: string): void => { try { localStorage.setItem(DONE_KEY, JSON.stringify([...doneRuns().filter(x => x !== run), run].slice(-200))); } catch { /* stockage indisponible : la confirmation suffit */ } };

let setView: ((v: ViewState) => Promise<void>) | null = null;
let busy = false, again = false, blocked = false, warned = false;

/** Branche la page : relève ce qui attend au démarrage, puis à chaque signal de l'app Mac. */
export function init(app: { setView(v: ViewState): Promise<void> }): void {
  if (!ai.cc.onMac()) return;
  setView = app.setView;
  if (window.carnet) window.carnet.agentItems = () => { void sync(); };
  // La note « Tâches » était verrouillée : on réessaie dès qu'une note est déverrouillée.
  store.onChange(kind => { if (kind === 'unlock' && blocked) void sync(); });
  void sync();
}

const plural = (n: number, one: string, many: string): string => `${n} ${n > 1 ? many : one}`;

/** Crée ce que les agents ont envoyé, tour par tour, et le confirme à l'app Mac. */
export async function sync(): Promise<void> {
  if (busy) { again = true; return; }
  busy = true;
  try {
    const r = await native.call('agent', 'items', {}, 10000);
    if (!r.ok || !Array.isArray(r.pending)) return;
    const done = new Set(doneRuns());
    blocked = false;
    for (const raw of r.pending as Pending[]) {
      if (!raw || typeof raw.run !== 'string') continue;
      if (done.has(raw.run)) { await native.call('agent', 'itemsDone', { run: raw.run }, 10000); continue; }
      const items = Array.isArray(raw.items) ? raw.items : [];
      const todo = items.filter(i => i.kind === 'task' && typeof i.text === 'string' && i.text.trim());
      // Liste « Tâches » verrouillée par mot de passe : ce tour attend son déverrouillage (rien n'est créé à moitié).
      const list = tasks.list();
      if (todo.length && list && store.isLocked(list)) { blocked = true; continue; }
      const p = model.byId(raw.project);
      let t = 0, n = 0;
      for (const i of todo) if (await tasks.add(i.text ?? '', p?.id ?? null)) t++;
      for (const i of items) {
        if (i.kind !== 'note') continue;
        const body = (i.body ?? '').trim();
        // Projet supprimé entre-temps : la note arrive dans la boîte de réception plutôt que de se perdre.
        await store.createNote({ title: (i.title ?? '').trim() || 'Note de l’agent', body: `${body}${p ? `${body ? '\n\n' : ''}#${p.tag}` : ''}\n`, inbox: !p });
        n++;
      }
      markDone(raw.run);
      await native.call('agent', 'itemsDone', { run: raw.run }, 10000);
      if (!t && !n) continue;
      const what = [t ? plural(t, 'tâche', 'tâches') : '', n ? plural(n, 'note', 'notes') : ''].filter(Boolean).join(' et ');
      const view: ViewState | null = p ? { type: 'projets', project: p.id, tab: t ? 'tasks' : 'notes' } : null;
      toast(`Claude Code a ajouté ${what}${p ? ` à « ${p.name} »` : ''}`, view && setView ? { label: 'Voir', run: () => setView?.(view) } : undefined);
    }
    if (blocked && !warned) { warned = true; toast('Un agent a des tâches pour toi : déverrouille la note « Tâches » pour les recevoir.'); }
  } catch (e) {
    console.error(e);
  } finally {
    busy = false;
    if (again) { again = false; void sync(); }
  }
}
