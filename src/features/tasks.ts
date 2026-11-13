// Liste de tâches. Les tâches rapides vivent dans une note dédiée (« Tâches »), en Markdown :
// elles sont donc chiffrées, synchronisées et versionnées comme n'importe quelle note.
// La page réunit aussi les cases à cocher de toutes les autres notes.
//   - [ ] Corriger la synchro ENG-42 @2026-11-14   ← ticket Linear reconnu dans le texte, échéance en fin de ligne
//     - [ ] Reproduire le bug                       ← sous-tâche : simple ligne indentée
import * as store from '../core/store.ts';
import * as linear from '../integrations/linear/api.ts';
import { esc, plain, statusOf } from '../lib/markdown.ts';
import * as board from './board.ts';
import * as projectsModel from './projects/model.ts';
import type { Project } from './projects/model.ts';
import { grouped, prio, day as issueDay } from '../integrations/linear/render.ts';
import { $, $$, icon, toast, menu, need, target, errMsg, num, avatar } from '../ui/kit.ts';
import type { Note, TaskStatus } from '../types.ts';
import type { Issue } from '../integrations/linear/api.ts';

/** Ce que la page Tâches attend de l'application. */
export interface TasksApi {
  flush(id: string): Promise<void>;
  refreshNote(n: Note): void;
  toggleTask(n: Note, line: number): Promise<void>;
  tbLeft(): string;
  crumb(current: string): string;
}
/** Une tâche, avec ce qu'on en déduit : échéance, ticket Linear, sous-tâches. */
export interface Task {
  note: Note; line: number; done: boolean; status: TaskStatus; own: boolean;
  text: string; due: string | null; ticket: string | null;
  subs: Task[]; sub?: boolean;
  /** Projet (identifiant de sa note) : tag #projet/… dans la tâche, sinon celui de la note. */
  project: string | null;
}
export interface Agenda { items: Task[]; total: number; late: number; today: number; isLate(t: Task): boolean }

let app!: TasksApi;
export const init = (api: TasksApi): void => { app = api; };

const DUE_RE = /\s@(\d{4}-\d{2}-\d{2})\s*$/;
const TASK_RE = /^(\s*)(?:[-*+]|\d{1,9}[.)])\s+\[([ xX/])\]\s+(.*)$/;
const TICKET_RE = /(?:^|\s)([A-Z][A-Z0-9]{1,9}-\d{1,6})(?=\s|$)/;
const PREFIX_RE = /^(\s*(?:[-*+]|\d{1,9}[.)])\s+\[[ xX/]\]\s+)/;
const DAYS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const titleOf = (n: Note) => n.title.trim() || 'Sans titre';

export const list = () => [...store.notes.values()].find(n => n.todo && !n.deletedAt) || null;
const ensureList = async () => list() || store.createNote({ title: 'Tâches', todo: true, body: '' });

// ---------- Échéances en langage naturel ----------
const midnight = (d = new Date()) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const plusDays = (n: number) => { const d = midnight(); d.setDate(d.getDate() + n); return d; };

export function parseDue(input: string): { text: string; due: string | null } {
  // Les tags en fin de saisie (« … demain #projet/studio ») ne cachent pas l'échéance : ils sont remis après.
  const all = input.trim(), tags = all.match(/(?:\s+#[\p{L}\p{N}_/-]+)+$/u), tail = tags ? tags[0] : '';
  const text = tags ? all.slice(0, tags.index).trim() : all;
  const rules: [RegExp, (m: RegExpMatchArray) => Date | null][] = [
    [/\s*\b(?:pour\s+)?(?:aujourd['’]hui|ce soir|ce matin)$/i, () => midnight()],
    [/\s*\b(?:pour\s+)?apr[eè]s[- ]demain$/i, () => plusDays(2)],
    [/\s*\b(?:pour\s+)?demain$/i, () => plusDays(1)],
    [new RegExp(`\\s*\\b(?:pour\\s+|d'ici\\s+)?(${DAYS.join('|')})(?:\\s+prochain)?$`, 'i'), m => plusDays((DAYS.indexOf((m[1] ?? '').toLowerCase()) - new Date().getDay() + 7) % 7 || 7)],
    [/\s*\b(?:pour\s+)?(?:la\s+)?semaine\s+prochaine$/i, () => plusDays(((1 - new Date().getDay() + 7) % 7) || 7)],
    [/\s*\b(?:pour\s+|le\s+)?(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/, m => {
      const y = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : new Date().getFullYear();
      const d = new Date(y, Number(m[2]) - 1, Number(m[1]));
      if (!m[3] && d < midnight()) d.setFullYear(y + 1);
      return isNaN(d.getTime()) || d.getDate() !== Number(m[1]) ? null : d;
    }],
    [/\s*@(\d{4}-\d{2}-\d{2})$/, m => new Date(m[1] + 'T00:00')],
  ];
  for (const [re, fn] of rules) {
    const m = text.match(re); if (!m) continue;
    const d = fn(m), rest = text.slice(0, m.index).trim();
    if (d && rest) return { text: rest + tail, due: store.dayKey(d) };
  }
  return { text: all, due: null };
}

function dueLabel(iso: string): string {
  const d = new Date(iso + 'T00:00'), diff = Math.round((d.getTime() - midnight().getTime()) / 864e5);
  if (diff === 0) return 'Aujourd’hui';
  if (diff === 1) return 'Demain';
  if (diff === -1) return 'Hier';
  const day = DAYS[d.getDay()] ?? '';
  if (diff > 1 && diff < 7) return day.charAt(0).toUpperCase() + day.slice(1);
  return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) });
}

// ---------- Lecture ----------
// Sépare le texte affiché, l'échéance et le ticket Linear d'une ligne de tâche.
export function parts(raw: string): { text: string; due: string | null; ticket: string | null; projectSlug: string | null } {
  const m = raw.match(DUE_RE), body = m ? raw.slice(0, m.index) : raw;
  const pm = [...body.matchAll(projectsModel.PROJECT_TAG_RE)][0], rest = projectsModel.stripProjectTags(body), k = rest.match(TICKET_RE);
  return { text: (k ? rest.replace(k[0], ' ') : rest).replace(/\s+/g, ' ').trim() || rest.trim(), due: m?.[1] || null, ticket: k?.[1] || null, projectSlug: pm?.[2] ?? null };
}
/** Projet d'une tâche : celui écrit dans la tâche, sinon celui de sa note. */
const projectFor = (n: Note, slug: string | null): string | null => (slug ? projectsModel.bySlug(slug)?.id : null) ?? projectsModel.projectOfNote(n)?.id ?? null;
const mkTask = (n: Note, line: number, done: boolean, status: TaskStatus, own: boolean, raw: string): Task => {
  const { projectSlug, ...p } = parts(raw);
  return { note: n, line, done, status, own, subs: [], ...p, project: projectFor(n, projectSlug) };
};

// La note « Tâches » : tâches de premier niveau, chacune avec ses sous-tâches (lignes indentées dessous).
function ownTasks(n: Note): Task[] {
  const out: Task[] = []; let parent: Task | null = null;
  (store.getBody(n) ?? '').split('\n').forEach((raw, line) => {
    const m = raw.match(TASK_RE);
    if (!m) { if (raw.trim()) parent = null; return; }
    const status = statusOf(m[2]);
    const t: Task = mkTask(n, line, status === 'done', status, true, m[3] ?? '');
    if ((m[1] ?? '').length && parent) { t.sub = true; parent.subs.push(t); } else { parent = t; out.push(t); }
  });
  return out;
}

function collect(only?: (t: Task) => boolean) {
  const mine = list(), today = store.dayKey(), found: Task[] = [];
  let subsOpen = 0;
  for (const n of store.index().live) {
    if (store.isLocked(n)) continue;
    if (n === mine) { const own = ownTasks(n); found.push(...own); subsOpen += own.reduce((s, t) => s + t.subs.filter(x => !x.done).length, 0); }
    else for (const t of store.meta(n).tasks) found.push(mkTask(n, t.line, t.done, t.status, false, t.text));
  }
  const all = only ? found.filter(only) : found;
  const open = all.filter(t => !t.done), byDue = (a: Task, b: Task) => (a.due ?? '').localeCompare(b.due ?? '');
  return {
    late: open.filter(t => t.due && t.due < today).sort(byDue),
    today: open.filter(t => t.due === today),
    soon: open.filter(t => t.due && t.due > today).sort(byDue),
    tickets: open.filter(t => !t.due && t.own && t.ticket),
    undated: open.filter(t => !t.due && t.own && !t.ticket),
    notes: open.filter(t => !t.due && !t.own),
    done: all.filter(t => t.done && t.own),
    doing: open.filter(t => t.status === 'doing'),
    openCount: open.length + subsOpen,
  };
}
export const openCount = () => collect().openCount;
/** Ouvre la page Tâches sur un projet. */
export function showProject(id: string): void { prefs.source = 'projet:' + id; savePrefs(); linearData = null; }
/** Tâches d'un projet (pour sa page). */
export const ofProject = (id: string) => collect(t => t.project === id);
const scope = (): ((t: Task) => boolean) | undefined => prefs.source.startsWith('projet:') ? (t => t.project === prefs.source.slice(7)) : undefined;
// Pour l'accueil : ce qui presse d'abord (en retard, aujourd'hui, à venir, puis le reste).
export function agenda(max = 6): Agenda {
  const c = collect(), today = store.dayKey();
  return { items: [...c.late, ...c.today, ...c.soon, ...c.tickets, ...c.undated, ...c.notes].slice(0, max), total: c.openCount, late: c.late.length, today: c.today.length, isLate: t => !!t.due && t.due < today };
}
export { dueLabel };

// ---------- Tickets Linear ----------
const tickets = new Map<string, Issue | null>(); // identifiant -> ticket (null si introuvable)
let ticketBusy = false;
async function loadTickets(ids: string[]): Promise<void> {
  ids = [...new Set(ids)].filter(id => !tickets.has(id));
  if (!ids.length || ticketBusy || !linear.connected()) return;
  ticketBusy = true;
  try {
    const found = await linear.issuesByIds(ids);
    for (const id of ids) tickets.set(id, found.find(i => i.identifier === id) || null);
    refresh();
  } catch { /* hors ligne ou clé refusée : les pastilles restent sans détail */ }
  ticketBusy = false;
}
function ticketChip(id: string): string {
  const i = tickets.get(id);
  return `<button class="td-ticket" data-ticket="${esc(id)}" title="${esc(i ? `${i.title} · ${i.state?.name || ''}` : 'Ticket Linear')}">${i?.state?.color && /^#[0-9a-f]{3,8}$/i.test(i.state.color) ? `<i class="st" style="background:${i.state.color}"></i>` : icon('linear')}${esc(id)}</button>`;
}

// ---------- Écriture ----------
async function mutate(n: Note, fn: (lines: string[]) => void): Promise<void> {
  await app.flush(n.id);
  store.touch(n);
  const lines = (store.getBody(n) ?? '').split('\n');
  fn(lines);
  store.setBody(n, lines.join('\n'));
  n.updated = Date.now();
  await store.saveNote(n);
  app.refreshNote(n);
}

export async function add(input: string, projectId: string | null = prefs.source.startsWith('projet:') ? prefs.source.slice(7) : null): Promise<{ text: string; due: string | null } | null> {
  const parsed = parseDue(input), due = parsed.due, p = projectsModel.byId(projectId);
  const text = p ? `${projectsModel.stripProjectTags(parsed.text)} #${p.tag}` : parsed.text;
  if (!text) return null;
  const n = await ensureList();
  if (store.isLocked(n)) { toast('La note « Tâches » est verrouillée.'); return null; }
  await mutate(n, lines => {
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    lines.push(`- [ ] ${text}${due ? ' @' + due : ''}`);
  });
  return { text, due };
}

/** Range une tâche de la liste dans un projet (ou la sort de tout projet). */
export async function setProject(n: Note, line: number, p: Project | null): Promise<void> {
  await mutate(n, lines => {
    const cur = lines[line]; if (cur === undefined || !PREFIX_RE.test(cur)) return;
    const m = cur.match(DUE_RE), head = projectsModel.stripProjectTags(m ? cur.slice(0, m.index) : cur);
    lines[line] = head + (p ? ` #${p.tag}` : '') + (m ? m[0] : '');
  });
}

// Sous-tâche : ligne indentée, insérée après la dernière sous-tâche du parent.
async function addSub(n: Note, line: number, input: string): Promise<void> {
  const { text, due } = parseDue(input);
  if (!text) return;
  await mutate(n, lines => {
    if (!TASK_RE.test(lines[line] || '')) return;
    let end = line + 1;
    while (end < lines.length && /^\s+\S/.test(lines[end]) && TASK_RE.test(lines[end])) end++;
    lines.splice(end, 0, `  - [ ] ${text}${due ? ' @' + due : ''}`);
  });
}

// Modifier le texte garde l'échéance existante, sauf si une nouvelle est saisie (ou « sans date »).
async function edit(n: Note, line: number, input: string, oldDue: string | null): Promise<void> {
  const noDate = /\s*\bsans date$/i.test(input.trim());
  const { text, due } = parseDue(input.trim().replace(/\s*\bsans date$/i, ''));
  if (!text) return remove(n, line);
  const keep = noDate ? null : due || oldDue;
  await mutate(n, lines => { const m = lines[line]?.match(PREFIX_RE); if (m) lines[line] = m[1] + text + (keep ? ' @' + keep : ''); });
}
// Supprimer une tâche emporte ses sous-tâches.
const span = (lines: string[], line: number): number => { let end = line + 1; if (!/^\s/.test(lines[line] ?? '')) while (end < lines.length && /^\s+\S/.test(lines[end]) && TASK_RE.test(lines[end])) end++; return end - line; };
const remove = (n: Note, line: number) => mutate(n, lines => { if (PREFIX_RE.test(lines[line] || '')) lines.splice(line, span(lines, line)); });
const clearDone = (n: Note) => mutate(n, lines => { for (let i = lines.length - 1; i >= 0; i--) if (/^\s*(?:[-*+]|\d+[.)])\s+\[[xX]\]/.test(lines[i])) lines.splice(i, span(lines, i)); });

// ---------- Lien avec la fiche d'un ticket Linear ----------
export function forTicket(id: string): Task | null { const l = list(); return l && !store.isLocked(l) ? ownTasks(l).find(t => t.ticket === id) || null : null; }
export async function addForTicket(id: string, title: string, subText: string): Promise<Task | null> {
  if (!forTicket(id)) await add(`${title} ${id}`);
  const t = forTicket(id);
  if (t && subText?.trim()) await addSub(t.note, t.line, subText);
  return forTicket(id);
}
export const toggle = (t: Task) => app.toggleTask(t.note, t.line);

// ---------- Rendu ----------
let subFor: number | null = null; // ligne de la tâche dont on saisit une sous-tâche

/** Pastille du projet d'une tâche (masquée quand on regarde déjà ce projet). */
function projectChip(t: Task): string {
  if (!t.project || prefs.source === 'projet:' + t.project) return '';
  const p = projectsModel.byId(t.project); if (!p) return '';
  return `<button class="pj-chip" data-project-open="${esc(p.id)}" style="--c:var(--c-${p.hue})">${esc(p.name)}</button>`;
}

function line(t: Task, { source = false } = {}): string {
  const late = t.due && t.due < store.dayKey() && !t.done, n = t.subs.length, d = t.subs.filter(x => x.done).length;
  return `<div class="td-row${t.done ? ' done' : ''}${t.sub ? ' td-subrow' : ''}" data-note="${t.note.id}" data-line="${t.line}">
    <input type="checkbox" class="td-check${t.status === 'doing' ? ' doing' : ''}"${t.done ? ' checked' : ''} aria-label="${t.done ? 'Rouvrir' : 'Terminer'}">
    <span class="td-text"${t.own ? ' data-edit tabindex="0" title="Cliquer pour modifier"' : ''}>${esc(plain(t.text))}</span>
    ${t.status === 'doing' ? '<span class="td-status">En cours</span>' : ''}
    ${projectChip(t)}
    ${n ? `<span class="td-prog">${d}/${n}</span>` : ''}
    ${t.ticket ? ticketChip(t.ticket) : ''}
    ${t.due ? `<span class="td-due${late ? ' late' : t.due === store.dayKey() ? ' today' : ''}">${esc(dueLabel(t.due))}</span>` : ''}
    ${source && !t.own ? `<button class="td-src" data-open-note="${t.note.id}">${esc(titleOf(t.note))}</button>` : ''}
    ${t.own ? `<span class="td-acts">${t.sub ? '' : `<button class="icon-btn td-del" data-td-proj title="Projet" aria-label="Choisir le projet">${icon('folder')}</button>`}${!t.sub && !t.done ? `<button class="icon-btn td-del" data-td-sub title="Ajouter une sous-tâche" aria-label="Ajouter une sous-tâche">${icon('plus')}</button>` : ''}<button class="icon-btn td-del" data-td-del title="Supprimer" aria-label="Supprimer">${icon('trash')}</button></span>` : ''}
  </div>`;
}
function row(t: Task, opts?: { source?: boolean }): string {
  const adding = t.own && !t.sub && subFor === t.line;
  if (!t.subs.length && !adding) return line(t, opts);
  return `<div class="td-item">${line(t, opts)}<div class="td-subs">${t.subs.map(x => line(x)).join('')}${adding ? `<form class="td-subadd" data-line="${t.line}"><span class="td-plus">${icon('plus')}</span><input class="td-subinput" placeholder="Sous-tâche, puis Entrée" aria-label="Nouvelle sous-tâche" autocomplete="off"></form>` : ''}</div></div>`;
}

function body() {
  const c = collect(scope());
  const sec = (title: string, items: Task[], opts?: { source?: boolean }) => items.length ? `<section class="td-sec"><h2>${title}<span>${items.length}</span></h2>${items.map(t => row(t, opts)).join('')}</section>` : '';
  const groups = new Map<Note, Task[]>();
  for (const t of c.notes) { let g = groups.get(t.note); if (!g) groups.set(t.note, g = []); g.push(t); }
  const empty = !c.openCount && !c.done.length;
  queueMicrotask(() => loadTickets([...c.late, ...c.today, ...c.soon, ...c.tickets, ...c.done].flatMap(t => t.ticket ? [t.ticket] : [])));
  return (empty ? `<p class="td-empty">Aucune tâche. Écris-en une ci-dessus : « Appeler Paul demain », « Rendre le dossier lundi »…</p>` : '')
    + sec('En retard', c.late, { source: true })
    + sec('Aujourd’hui', c.today, { source: true })
    + sec('À venir', c.soon, { source: true })
    + sec('Tickets Linear', c.tickets)
    + sec('Sans date', c.undated)
    + (groups.size ? `<section class="td-sec"><h2>Dans tes notes<span>${c.notes.length}</span></h2>${[...groups].map(([n, items]) => `<div class="td-group"><button class="td-gtitle" data-open-note="${n.id}">${icon('notes')}${esc(titleOf(n))}</button>${items.map(t => row(t)).join('')}</div>`).join('')}</section>` : '')
    + (c.done.length ? `<details class="td-sec td-donesec"><summary><h2>Terminées<span>${c.done.length}</span></h2><button class="btn btn-ghost" data-td-clear>Effacer</button></summary>${c.done.map(t => row(t)).join('')}</details>` : '');
}

// ---------- Source (mes tâches ou Linear) et affichage (liste ou Kanban) ----------
interface Prefs { source: string; layout: 'list' | 'board' }
const PREFS = 'carnet.tasks.view';
const prefs: Prefs = (() => { try { return { source: 'local', layout: 'list', ...(JSON.parse(localStorage.getItem(PREFS) || '{}') as Partial<Prefs>) }; } catch { return { source: 'local', layout: 'list' }; } })();
const savePrefs = (): void => { try { localStorage.setItem(PREFS, JSON.stringify(prefs)); } catch { /* stockage indisponible */ } };
let views: linear.View[] = [], linearData: { key: string; issues: Issue[] } | null = null;

async function loadViews(): Promise<void> {
  if (!linear.connected()) return;
  try { views = await linear.views(); } catch { views = []; }
  paintChrome();
}

function paintChrome(): void {
  const nav = $('#main .td-sources'); if (!nav) return;
  const projs = projectsModel.projects();
  if (prefs.source.startsWith('projet:') && !projs.some(p => 'projet:' + p.id === prefs.source)) prefs.source = 'local';
  if ((prefs.source.startsWith('linear') || prefs.source.startsWith('view:')) && (!linear.connected() || (prefs.source.startsWith('view:') && views.length && !views.some(v => 'view:' + v.id === prefs.source)))) prefs.source = 'local';
  const chip = (src: string, label: string, dot: string) => `<button class="lv-chip${prefs.source === src ? ' sel' : ''}" data-src="${esc(src)}">${dot}${esc(label)}</button>`;
  const pchips = projs.map(p => chip('projet:' + p.id, p.name, `<i class="st" style="background:var(--c-${p.hue})"></i>`)).join('');
  const lchips = linear.connected() ? chip('linear:me', 'Mes tickets Linear', icon('linear')) + views.map(v => chip('view:' + v.id, v.name, `<i class="st" style="background:${/^#[0-9a-f]{3,8}$/i.test(v.color ?? '') ? v.color : 'var(--c-indigo)'}"></i>`)).join('') : '';
  nav.innerHTML = pchips || lchips ? chip('local', 'Toutes mes tâches', icon('check')) + pchips + (pchips && lchips ? '<i class="td-sep"></i>' : '') + lchips : '';
  nav.hidden = !nav.innerHTML;
  for (const b of $$('#main .td-layout [data-layout]')) b.setAttribute('aria-selected', String(b.dataset.layout === prefs.layout));
  const isLocal = prefs.source === 'local' || prefs.source.startsWith('projet:');
  const add = $('#main .td-add'); if (add) add.hidden = !isLocal;
  const reload = $('#main [data-td-reload]'); if (reload) reload.hidden = isLocal;
}

// Kanban de mes tâches : à faire, en cours, terminées.
const COLS: [TaskStatus, string, string][] = [['todo', 'À faire', 'gray'], ['doing', 'En cours', 'amber'], ['done', 'Terminées', 'green']];
function localCard(t: Task, i: number): string {
  const late = !!t.due && t.due < store.dayKey() && !t.done, n = t.subs.length, d = t.subs.filter(x => x.done).length;
  return `<article class="kb-card${t.done ? ' done' : ''}" draggable="true" data-key="${t.note.id}:${t.line}" data-note="${t.note.id}" data-line="${t.line}">
    <p>${esc(plain(t.text))}</p>
    <footer>${t.due ? `<span class="td-due${late ? ' late' : t.due === store.dayKey() ? ' today' : ''}">${esc(dueLabel(t.due))}</span>` : ''}${projectChip(t)}${t.ticket ? ticketChip(t.ticket) : ''}${n ? `<span class="td-prog">${d}/${n}</span>` : ''}${t.own ? '' : `<button class="td-src" data-open-note="${t.note.id}">${esc(titleOf(t.note))}</button>`}${board.moveButtons(i === 0, i === COLS.length - 1)}</footer></article>`;
}
function localBoard(): string {
  const c = collect(scope());
  const todo = [...c.late, ...c.today, ...c.soon, ...c.tickets, ...c.undated, ...c.notes].filter(t => t.status === 'todo');
  const by: Record<TaskStatus, Task[]> = { todo, doing: c.doing, done: c.done.slice(0, 30) };
  return board.boardHTML(COLS.map(([key, label, tone], i) => ({ key, label, tone, cards: by[key].map(t => localCard(t, i)) })));
}

// Kanban d'une source Linear : colonnes par type d'état (les états précis restent visibles sur les cartes).
const LCOLS: [string, string, string, string[]][] = [['backlog', 'Backlog', 'gray', ['triage', 'backlog']], ['unstarted', 'À faire', 'blue', ['unstarted']], ['started', 'En cours', 'amber', ['started']], ['completed', 'Terminé', 'green', ['completed']]];
function issueCard(i: Issue, col: number): string {
  return `<article class="kb-card" draggable="true" data-key="${esc(i.id)}" data-iid="${esc(i.id)}" data-issue="${esc(i.identifier)}" tabindex="0">
    <p>${esc(i.title)}</p>
    <footer>${prio(i.priority, i.priorityLabel)}<span class="lv-id">${esc(i.identifier)}</span><span class="kb-state"><i class="st" style="background:${/^#[0-9a-f]{3,8}$/i.test(i.state?.color ?? '') ? i.state?.color : 'var(--text-3)'}"></i>${esc(i.state?.name ?? '')}</span>${i.dueDate ? `<span class="td-due">${esc(issueDay(i.dueDate))}</span>` : ''}${i.assignee ? avatar(i.assignee.name) : ''}${board.moveButtons(col === 0, col === LCOLS.length - 1)}</footer></article>`;
}
async function paintLinear(box: HTMLElement): Promise<void> {
  const key = prefs.source;
  if (!linearData || linearData.key !== key) {
    box.innerHTML = '<p class="nf-empty">Chargement depuis Linear…</p>';
    try {
      const view = views.find(v => 'view:' + v.id === key);
      const issues = key === 'linear:me' ? await linear.issues({ assignee: 'me', states: ['triage', 'backlog', 'unstarted', 'started', 'completed'], limit: 100 })
        : view ? await linear.viewIssues(view) : [];
      if (prefs.source !== key) return; // la source a changé pendant le chargement
      linearData = { key, issues };
    } catch (e) { box.innerHTML = `<p class="nf-empty">Linear ne répond pas : ${esc(errMsg(e))}</p>`; return; }
  }
  const issues = linearData.issues;
  box.innerHTML = prefs.layout === 'board'
    ? board.boardHTML(LCOLS.map(([k, label, tone, types], i) => ({ key: k, label, tone, cards: issues.filter(x => types.includes(x.state?.type ?? '')).slice(0, k === 'completed' ? 30 : 200).map(x => issueCard(x, i)) })))
    : grouped(issues.filter(x => x.state?.type !== 'canceled'));
  const sub = $('#main .td-sub'); if (sub) sub.textContent = `${issues.filter(x => !['completed', 'canceled'].includes(x.state?.type ?? '')).length} ticket(s) ouvert(s)`;
}

async function onMove(root: HTMLElement, card: HTMLElement, col: string): Promise<void> {
  if (card.dataset.iid) {
    const issue = linearData?.issues.find(x => x.id === card.dataset.iid); if (!issue) return;
    board.place(card, root, col);
    try { const st = await linear.moveToType(issue, col); issue.state = st; toast(`${issue.identifier} → ${st.name}`); }
    catch (e) { toast('Linear : ' + errMsg(e)); }
    refresh();
    return;
  }
  const n = store.get(card.dataset.note); if (!n) return;
  const status: TaskStatus = col === 'doing' ? 'doing' : col === 'done' ? 'done' : 'todo';
  await app.flush(n.id);
  await store.setTaskStatus(n, num(card, 'line'), status);
  app.refreshNote(n);
}

let doneOpen = false, subFocus = false;
export function refresh(): void {
  const box = $('#main .td-list'); if (!box) return;
  if (box.querySelector('.td-edit')) return; // une modification est en cours : on ne casse pas la saisie
  const typed = box.querySelector<HTMLInputElement>('.td-subinput'), keep = typed?.value || '', had = typed && document.activeElement === typed;
  paintChrome();
  if (prefs.source !== 'local' && !prefs.source.startsWith('projet:')) { void paintLinear(box); return; }
  if (prefs.layout === 'board') { box.innerHTML = localBoard(); queueMicrotask(() => loadTickets(collect().doing.flatMap(t => t.ticket ? [t.ticket] : []))); }
  else box.innerHTML = body();
  const si = box.querySelector<HTMLInputElement>('.td-subinput'); if (si) { si.value = keep; if (had || subFocus) si.focus(); subFocus = false; }
  const d = $<HTMLDetailsElement>('.td-donesec', box); if (d) { d.open = doneOpen; d.ontoggle = () => { doneOpen = d.open; }; }
  const c = collect(scope()), late = c.late.length;
  const sub = $('#main .td-sub'); if (sub) sub.textContent = `${c.openCount} à faire${c.doing.length ? ` · ${c.doing.length} en cours` : ''}${late ? ` · ${late} en retard` : ''}`;
}

export function mount(main: HTMLElement): void {
  main.innerHTML = `<header class="toolbar">${app.tbLeft()}${app.crumb('Tâches')}<div class="tb-side tb-right"></div></header>
    <div class="todo"><div class="todo-in">
      <div class="td-head td-headbar"><div><h1>Tâches</h1><p class="td-sub"></p></div>
        <div class="td-tools"><button class="icon-btn" data-td-reload title="Actualiser depuis Linear" aria-label="Actualiser" hidden>${icon('refresh')}</button>
          <div class="seg td-layout" role="tablist" aria-label="Affichage"><button data-layout="list" title="Liste" aria-label="Liste">${icon('list')}</button><button data-layout="board" title="Kanban" aria-label="Kanban">${icon('board')}</button></div></div></div>
      <nav class="td-sources" aria-label="Source des tâches"></nav>
      <form class="td-add"><span class="td-plus">${icon('plus')}</span><input placeholder="Nouvelle tâche, ex. « Appeler Paul demain »" aria-label="Nouvelle tâche" autocomplete="off"><span class="td-due td-preview" hidden></span>${linear.connected() ? `<button type="button" class="icon-btn" data-td-pick title="Créer une tâche depuis un ticket Linear" aria-label="Depuis un ticket Linear">${icon('linear')}</button>` : ''}</form>
      <div class="td-list"></div>
    </div></div>`;
  const form = need('.td-add', main), input = need<HTMLInputElement>('input', form), preview = need('.td-preview', form);
  input.addEventListener('input', () => { const { text, due } = parseDue(input.value), k = parts(text).ticket, bits = [k, due && dueLabel(due)].filter(Boolean); preview.hidden = !bits.length; preview.textContent = bits.join(' · '); });
  $('[data-td-pick]', form)?.addEventListener('click', async e => {
    const btn = e.currentTarget as HTMLElement;
    try {
      const mine = await linear.issues({ assignee: 'me', states: ['started', 'unstarted'], limit: 25 });
      if (!mine.length) { toast('Aucun ticket Linear ne t’est assigné.'); return; }
      for (const i of mine) tickets.set(i.identifier, i);
      menu(btn, mine.map(i => ({ label: `${i.identifier} · ${i.title}`, icon: 'linear', run: () => add(`${i.title} ${i.identifier}`) })));
    } catch (x) { toast('Linear : ' + errMsg(x)); }
  });
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const r = await add(input.value); if (!r) return;
    input.value = ''; preview.hidden = true; input.focus();
  });
  const root = need('.todo', main);
  root.classList.toggle('wide', prefs.layout === 'board');
  board.bind(root, (card, col) => onMove(root, card, col));
  root.addEventListener('click', e => {
    const t = target(e), lay = t.closest('[data-layout]'), src = t.closest('[data-src]');
    if (lay) { prefs.layout = lay.dataset.layout === 'board' ? 'board' : 'list'; savePrefs(); root.classList.toggle('wide', prefs.layout === 'board'); refresh(); return; }
    if (src) { prefs.source = src.dataset.src ?? 'local'; savePrefs(); linearData = null; refresh(); return; }
    if (t.closest('[data-td-reload]')) { linearData = null; refresh(); return; }
    const card = t.closest('.kb-card[data-issue]');
    if (card && !t.closest('button')) void import('../integrations/linear/page.ts').then(m => m.openTicket(card.dataset.issue ?? ''));
  });
  void loadViews();
  root.addEventListener('change', e => {
    const cb = target(e).closest<HTMLInputElement>('.td-check'), r = cb?.closest('.td-row'); if (!cb || !r) return;
    const n = store.get(r.dataset.note), line = num(r, 'line');
    r.classList.toggle('done', cb.checked);
    if (n) setTimeout(() => void app.toggleTask(n, line), cb.checked ? 220 : 0); // le temps de voir la case se cocher
  });
  root.addEventListener('submit', async e => {
    const f = target(e).closest('.td-subadd'); if (!f) return;
    e.preventDefault();
    const i = need<HTMLInputElement>('input', f), l = list(), v = i.value; if (!v.trim() || !l) return;
    i.value = ''; subFocus = true; await addSub(l, num(f, 'line'), v);
  });
  root.addEventListener('keydown', e => { if (e.key === 'Escape' && target(e).matches?.('.td-subinput')) { e.preventDefault(); e.stopPropagation(); subFor = null; refresh(); } });
  root.addEventListener('focusout', e => { const t = target(e) as HTMLInputElement; if (t.matches('.td-subinput') && !t.value.trim()) setTimeout(() => { if (!subFocus && !$('.td-subinput:focus', root)) { subFor = null; refresh(); } }, 120); });
  root.addEventListener('click', e => {
    const r = target(e).closest('.td-row'), n = r && store.get(r.dataset.note);
    const k = target(e).closest('[data-ticket]');
    if (k) { const id = k.dataset.ticket ?? ''; if (linear.connected()) void import('../integrations/linear/page.ts').then(m => m.openTicket(id)); else toast('Connecte Linear dans Réglages pour ouvrir le ticket.'); return; }
    if (target(e).closest('[data-td-sub]') && r) { subFor = num(r, 'line'); subFocus = true; refresh(); return; }
    const pb = target(e).closest('[data-td-proj]');
    if (pb && n && r) {
      const line = num(r, 'line'), all = projectsModel.projects();
      menu(pb, [{ label: 'Ranger dans un projet' }, ...all.map(p => ({ label: p.name, icon: 'folder', run: () => setProject(n, line, p) })),
        ...(all.length ? ['-' as const] : []), { label: 'Aucun projet', run: () => setProject(n, line, null) },
        { label: 'Nouveau projet…', icon: 'plus', run: () => void import('./projects/page.ts').then(m => m.createDialog()) }]);
      return;
    }
    if (target(e).closest('[data-td-del]') && n && r) { void remove(n, num(r, 'line')); return; }
    if (target(e).closest('[data-td-clear]')) { e.preventDefault(); const l = list(); if (l) void clearDone(l); return; }
    const t = target(e).closest('.td-text[data-edit]'); if (t && n && r) startEdit(t, n, num(r, 'line'));
  });
  root.addEventListener('keydown', e => { const t = target(e).closest('.td-text[data-edit]'); if (t && e.key === 'Enter') { e.preventDefault(); t.click(); } });
  refresh();
  if (!matchMedia('(max-width: 640px)').matches) input.focus();
}

function startEdit(span: HTMLElement, n: Note, line: number): void {
  const r = span.closest('.td-row'), due = r?.querySelector('.td-due');
  const raw = (store.getBody(n) ?? '').split('\n')[line] || '';
  const m = raw.match(DUE_RE);
  const input = document.createElement('input');
  const before = raw.replace(PREFIX_RE, '').replace(DUE_RE, '');
  input.className = 'td-edit'; input.value = before;
  input.setAttribute('aria-label', 'Modifier la tâche'); input.placeholder = m ? 'Nouvelle échéance possible : « demain », « sans date »…' : '';
  span.replaceWith(input); due?.remove(); input.focus(); input.setSelectionRange(input.value.length, input.value.length);
  let done = false;
  const finish = async (save: boolean) => { if (done) return; done = true; input.remove(); if (save && input.value.trim() !== before.trim()) await edit(n, line, input.value, m?.[1] || null); refresh(); };
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); finish(true); } if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); } });
  input.addEventListener('blur', () => finish(true));
}
