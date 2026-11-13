// Projets. Un projet est une note qui contient un bloc ```projet :
//
//   ```projet
//   nom: Studio
//   dépôts: MTthoas/Studio, MTthoas/studio-site     (le premier est le principal)
//   linear: Studio                                  (projet Linear, facultatif)
//   ```
//
// Une note ou une tâche appartient au projet si elle porte le tag #projet/<nom> (ou se trouve dans
// une note qui le porte). Le dossier local du projet n'est jamais écrit dans les notes : il reste sur le Mac.
import * as store from '../../core/store.ts';
import { fold } from '../../lib/fuzzy.ts';
import { hue } from '../../ui/kit.ts';
import type { Note } from '../../types.ts';

export interface Project {
  /** Identifiant : celui de la note du projet. */
  id: string;
  note: Note;
  name: string;
  /** Nom court, utilisé dans le tag : #projet/<slug>. */
  slug: string;
  tag: string;
  /** Dépôts GitHub « propriétaire/nom » ; le premier est le principal. */
  repos: string[];
  /** Nom du projet Linear associé, s'il y en a un. */
  linear: string | null;
  hue: string;
}

const BLOCK_RE = /^```projet[ \t]*\n([\s\S]*?)\n```[ \t]*$/m;
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
export const PROJECT_TAG_RE = /(^|\s)#projet\/([\p{L}\d][\p{L}\d_-]*)(?=[\s,.;:!?)]|$)/gu;

export const slugify = (s: string): string => fold(s).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'projet';

/** Lit le bloc ```projet d'une note (null si la note n'en a pas, ou s'il est vide). */
export function parse(n: Note): Project | null {
  const body = store.getBody(n); if (!body || !body.includes('```projet')) return null;
  const m = body.match(BLOCK_RE); if (!m) return null;
  let name = n.title.trim(), repos: string[] = [], linear: string | null = null;
  for (const line of (m[1] ?? '').split('\n')) {
    const kv = line.match(/^\s*([\p{L}]+)\s*:\s*(.*)$/u); if (!kv) continue;
    const k = fold(kv[1] ?? ''), v = (kv[2] ?? '').trim();
    if (k === 'nom' || k === 'name') name = v || name;
    else if (k === 'depot' || k === 'depots' || k === 'repo' || k === 'repos' || k === 'github') repos = v.split(/[,\s]+/).map(r => r.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '')).filter(r => REPO_RE.test(r));
    else if (k === 'linear') linear = v || null;
  }
  name = name || 'Projet';
  const slug = slugify(name);
  return { id: n.id, note: n, name, slug, tag: `projet/${slug}`, repos, linear, hue: hue(slug) };
}

let cache: { idx: object; list: Project[]; ofNote: Map<string, Project | null> } | null = null;
/** Index des projets, recalculé seulement quand l'index des notes change. */
function ensure(): { list: Project[]; ofNote: Map<string, Project | null> } {
  const idx = store.index();
  if (cache?.idx === idx) return cache;
  const list: Project[] = [], seen = new Set<string>();
  for (const n of idx.live) { const p = parse(n); if (p && !seen.has(p.slug)) { seen.add(p.slug); list.push(p); } }
  list.sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  const bySlug = new Map(list.map(p => [p.slug, p])), ofNote = new Map<string, Project | null>();
  for (const n of idx.live) {
    let p: Project | null = list.find(x => x.id === n.id) ?? null;
    if (!p && !n.todo) for (const t of store.meta(n).tags) { if (t.startsWith('projet/')) { p = bySlug.get(t.slice(7).split('/')[0] ?? '') ?? null; if (p) break; } }
    ofNote.set(n.id, p);
  }
  cache = { idx, list, ofNote };
  return cache;
}

/** Tous les projets (une note par projet ; à nom égal, la plus ancienne gagne). */
export const projects = (): Project[] => ensure().list;
export const byId = (id: string | null | undefined): Project | null => (id ? projects().find(p => p.id === id) ?? null : null);
export const bySlug = (slug: string | null | undefined): Project | null => (slug ? projects().find(p => p.slug === slug) ?? null : null);

/** Projet d'une note : la note du projet elle-même, ou le premier tag #projet/… qui correspond à un projet. */
export const projectOfNote = (n: Note): Project | null => ensure().ofNote.get(n.id) ?? null;

/** Notes du projet (la note du projet en premier). */
export function notesOf(p: Project): Note[] {
  return store.index().live.filter(n => n.id === p.id || projectOfNote(n)?.id === p.id)
    .sort((a, b) => (a.id === p.id ? -1 : b.id === p.id ? 1 : b.updated - a.updated));
}

/** Retire tout tag #projet/… d'un texte (une ligne de tâche, le corps d'une note). */
export const stripProjectTags = (s: string): string => s.replace(PROJECT_TAG_RE, '$1').replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+$/gm, '');

/** Range une note dans un projet (ou la sort de tout projet) en réécrivant son tag. */
export async function setNoteProject(n: Note, p: Project | null): Promise<void> {
  const body = store.getBody(n);
  if (body == null) throw new Error('Déverrouille la note pour changer son projet.');
  if (p && p.id === n.id) return;
  let next = stripProjectTags(body).replace(/\n+$/, '');
  if (p) next += (next.trim() ? '\n\n' : '') + `#${p.tag}`;
  if (next === body) return;
  store.touch(n); store.setBody(n, next + '\n'); n.updated = Date.now();
  if (p && n.inbox) n.inbox = false;
  await store.saveNote(n);
}

/** Crée la note d'un projet. */
export async function createProject({ name, repos, linear, description }: { name: string; repos: string[]; linear: string | null; description?: string }): Promise<Project> {
  const clean = repos.map(r => r.trim()).filter(r => REPO_RE.test(r));
  const block = ['```projet', `nom: ${name.trim()}`, ...(clean.length ? [`dépôts: ${clean.join(', ')}`] : []), ...(linear ? [`linear: ${linear}`] : []), '```'].join('\n');
  const n = await store.createNote({ title: name.trim(), body: `${description?.trim() || 'Ce que ce projet doit accomplir, ses liens utiles, ses décisions.'}\n\n${block}\n` });
  const p = parse(n);
  if (!p) throw new Error('Projet invalide.');
  return p;
}
