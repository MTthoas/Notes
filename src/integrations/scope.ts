// Périmètres de l'IA. Chaque exécution (page Claude, « Demander à l'IA », automatisation) travaille dans UN
// périmètre, et ses outils ne voient que les données de celui-ci. Le filtre est appliqué ici, dans le code, avant que
// quoi que ce soit parte chez le fournisseur : aucune consigne ne peut l'élargir.
//   Projet  : la note du projet et celles taguées #projet/<slug>, ses tâches, ses dépôts GitHub, et son projet Linear
//             (champ « linear: » du bloc ```projet, nom exact).
//   Général : ce qui n'appartient à aucun projet. Jamais Linear : un ticket n'est lisible que depuis son projet.
// La liste des tâches (note « Tâches ») n'est jamais lue d'un bloc : ses lignes passent une à une par taskIn.
import * as store from '../core/store.ts';
import * as linear from './linear/api.ts';
import * as model from '../features/projects/model.ts';
import { fold } from '../lib/fuzzy.ts';
import type { AppEvent } from '../core/events.ts';
import type { Note } from '../types.ts';

export interface Scope { project: model.Project | null }
export const GENERAL: Scope = { project: null };
export const of = (p: model.Project | null): Scope => (p ? { project: p } : GENERAL);
export const same = (a: Scope, b: Scope): boolean => (a.project?.id ?? '') === (b.project?.id ?? '');
export const label = (s: Scope): string => (s.project ? `projet « ${s.project.name} »` : 'Général');

/** Périmètre écrit dans un bloc ```agent (« projet: Studio ») ; vide ou « général » : Général. */
export function byName(name: string): Scope {
  const v = name.trim();
  if (!v || /^(g[ée]n[ée]ral|aucun)$/i.test(v)) return GENERAL;
  const p = model.projects().find(x => fold(x.name) === fold(v) || x.slug === model.slugify(v));
  if (!p) throw new Error(`Projet « ${v} » introuvable : l’automatisation ne se lance pas hors de son périmètre.`);
  return { project: p };
}

/** Une note entière est lisible : hors liste des tâches, et du même projet que le périmètre. */
export const noteIn = (s: Scope, n: Note): boolean => !n.todo && (model.projectOfNote(n)?.id ?? null) === (s.project?.id ?? null);

/** Projet d'une tâche : celui écrit dans la ligne (#projet/…), sinon celui de sa note (même règle que features/tasks.ts). */
function taskProject(n: Note, text: string): string | null {
  const m = [...text.matchAll(model.PROJECT_TAG_RE)][0];
  return (m ? model.bySlug(m[2] ?? '')?.id : null) ?? model.projectOfNote(n)?.id ?? null;
}
export const taskIn = (s: Scope, n: Note, text: string): boolean => taskProject(n, text) === (s.project?.id ?? null);

/** Dépôt GitHub du périmètre : ceux du projet, ou en Général ceux qu'aucun projet ne déclare. */
export function repoIn(s: Scope, repo: string): boolean {
  const r = repo.toLowerCase(), has = (p: model.Project) => p.repos.some(x => x.toLowerCase() === r);
  return s.project ? has(s.project) : !model.projects().some(has);
}

// Projet Linear du périmètre, résolu par son nom exact et gardé cinq minutes.
const cache = new Map<string, { at: number; p: linear.ScopedProject | null }>();
export async function linearProject(s: Scope): Promise<linear.ScopedProject | null> {
  const name = s.project?.linear?.trim();
  if (!name || !linear.connected()) return null;
  const k = fold(name), hit = cache.get(k);
  if (hit && Date.now() - hit.at < 300e3) return hit.p;
  const p = await linear.projectByName(name);
  cache.set(k, { at: Date.now(), p });
  return p;
}
/** Comme linearProject, mais une erreur claire si le projet Linear n'existe pas. */
export async function needLinear(s: Scope): Promise<linear.ScopedProject> {
  const p = await linearProject(s);
  if (!p) throw new Error(s.project?.linear ? `Projet Linear « ${s.project.linear} » introuvable (nom exact attendu dans le champ « linear: » du projet).` : 'Linear n’est pas accessible dans ce périmètre.');
  return p;
}
/** Linear est proposé à l'IA : seulement dans un projet relié à un projet Linear. */
export const hasLinear = (s: Scope): boolean => !!s.project?.linear && linear.connected();

/** L'événement tombe-t-il dans le périmètre ? Sans origine connue : non. */
export async function eventIn(s: Scope, e: AppEvent): Promise<boolean> {
  const o = e.origin;
  if (!o) return false;
  if (e.kind === 'linear') {
    if (!o.linearProject) return false;
    const p = await linearProject(s).catch(() => null);
    return !!p && p.id === o.linearProject;
  }
  if (e.kind === 'github') return !!o.repo && repoIn(s, o.repo);
  const n = store.get(o.noteId);
  if (!n) return false;
  return e.kind === 'tache' ? taskIn(s, n, o.line ?? '') : noteIn(s, n);
}

/** Ce que l'IA doit savoir de son périmètre ; part avec la demande (pas dans la consigne système, gardée en cache). */
export function describe(s: Scope): string {
  const p = s.project;
  if (!p) return 'Périmètre : Général. Tes outils ne voient que les notes et les tâches qui n’appartiennent à aucun projet, et les dépôts GitHub qu’aucun projet ne déclare. Linear n’est pas accessible ici : pour un projet, l’utilisateur ouvre la conversation dans ce projet. N’invente rien sur ce que tu ne vois pas.';
  const bits = ['ses notes', 'ses tâches', ...(p.repos.length ? [`ses dépôts GitHub (${p.repos.join(', ')})`] : []), ...(hasLinear(s) ? [`son projet Linear « ${p.linear ?? ''} »`] : [])];
  return `Périmètre : projet « ${p.name} ». Tes outils ne voient que ${bits.join(', ')}. Rien d’autre n’est accessible ; n’invente rien sur le reste.`;
}
