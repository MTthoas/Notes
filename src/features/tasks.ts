// Liste de tâches. Les tâches rapides vivent dans une note dédiée (« Tâches »), en Markdown :
// elles sont donc chiffrées, synchronisées et versionnées comme n'importe quelle note.
// La page réunit aussi les cases à cocher de toutes les autres notes.
//   - [ ] Corriger la synchro ENG-42 @2026-11-14   ← ticket Linear reconnu dans le texte, échéance en fin de ligne
//     - [ ] Reproduire le bug                       ← sous-tâche : simple ligne indentée
import * as store from '../core/store.ts';
import * as linear from '../integrations/linear/api.ts';
import { esc, plain } from '../lib/markdown.ts';
import { $, $$, icon, toast, menu, need, target, errMsg, num } from '../ui/kit.ts';
import type { Note } from '../types.ts';
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
  note: Note; line: number; done: boolean; own: boolean;
  text: string; due: string | null; ticket: string | null;
  subs: Task[]; sub?: boolean;
}
export interface Agenda { items: Task[]; total: number; late: number; today: number; isLate(t: Task): boolean }

let app!: TasksApi;
export const init = (api: TasksApi): void => { app = api; };

const DUE_RE = /\s@(\d{4}-\d{2}-\d{2})\s*$/;
const TASK_RE = /^(\s*)(?:[-*+]|\d{1,9}[.)])\s+\[([ xX])\]\s+(.*)$/;
const TICKET_RE = /(?:^|\s)([A-Z][A-Z0-9]{1,9}-\d{1,6})(?=\s|$)/;
const PREFIX_RE = /^(\s*(?:[-*+]|\d{1,9}[.)])\s+\[[ xX]\]\s+)/;
const DAYS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const titleOf = (n: Note) => n.title.trim() || 'Sans titre';

export const list = () => [...store.notes.values()].find(n => n.todo && !n.deletedAt) || null;
const ensureList = async () => list() || store.createNote({ title: 'Tâches', todo: true, body: '' });

// ---------- Échéances en langage naturel ----------
const midnight = (d = new Date()) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const plusDays = (n: number) => { const d = midnight(); d.setDate(d.getDate() + n); return d; };

export function parseDue(input: string): { text: string; due: string | null } {
  const text = input.trim();
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
    if (d && rest) return { text: rest, due: store.dayKey(d) };
  }
  return { text, due: null };
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
export function parts(raw: string): { text: string; due: string | null; ticket: string | null } {
  const m = raw.match(DUE_RE), rest = m ? raw.slice(0, m.index) : raw, k = rest.match(TICKET_RE);
  return { text: (k ? rest.replace(k[0], ' ') : rest).replace(/\s+/g, ' ').trim() || rest.trim(), due: m?.[1] || null, ticket: k?.[1] || null };
}

// La note « Tâches » : tâches de premier niveau, chacune avec ses sous-tâches (lignes indentées dessous).
function ownTasks(n: Note): Task[] {
  const out: Task[] = []; let parent: Task | null = null;
  (store.getBody(n) ?? '').split('\n').forEach((raw, line) => {
    const m = raw.match(TASK_RE);
    if (!m) { if (raw.trim()) parent = null; return; }
    const t: Task = { note: n, line, done: m[2] !== ' ', own: true, subs: [], ...parts(m[3] ?? '') };
    if ((m[1] ?? '').length && parent) { t.sub = true; parent.subs.push(t); } else { parent = t; out.push(t); }
  });
  return out;
}

function collect() {
  const mine = list(), today = store.dayKey(), all: Task[] = [];
  let subsOpen = 0;
  for (const n of store.index().live) {
    if (store.isLocked(n)) continue;
    if (n === mine) { const own = ownTasks(n); all.push(...own); subsOpen += own.reduce((s, t) => s + t.subs.filter(x => !x.done).length, 0); }
    else for (const t of store.meta(n).tasks) all.push({ note: n, line: t.line, done: t.done, own: false, subs: [], ...parts(t.text) });
  }
  const open = all.filter(t => !t.done), byDue = (a: Task, b: Task) => (a.due ?? '').localeCompare(b.due ?? '');
  return {
    late: open.filter(t => t.due && t.due < today).sort(byDue),
    today: open.filter(t => t.due === today),
    soon: open.filter(t => t.due && t.due > today).sort(byDue),
    tickets: open.filter(t => !t.due && t.own && t.ticket),
    undated: open.filter(t => !t.due && t.own && !t.ticket),
    notes: open.filter(t => !t.due && !t.own),
    done: all.filter(t => t.done && t.own),
    openCount: open.length + subsOpen,
  };
}
export const openCount = () => collect().openCount;
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

export async function add(input: string): Promise<{ text: string; due: string | null } | null> {
  const { text, due } = parseDue(input);
  if (!text) return null;
  const n = await ensureList();
  if (store.isLocked(n)) { toast('La note « Tâches » est verrouillée.'); return null; }
  await mutate(n, lines => {
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    lines.push(`- [ ] ${text}${due ? ' @' + due : ''}`);
  });
  return { text, due };
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

function line(t: Task, { source = false } = {}): string {
  const late = t.due && t.due < store.dayKey() && !t.done, n = t.subs.length, d = t.subs.filter(x => x.done).length;
  return `<div class="td-row${t.done ? ' done' : ''}${t.sub ? ' td-subrow' : ''}" data-note="${t.note.id}" data-line="${t.line}">
    <input type="checkbox" class="td-check"${t.done ? ' checked' : ''} aria-label="${t.done ? 'Rouvrir' : 'Terminer'}">
    <span class="td-text"${t.own ? ' data-edit tabindex="0" title="Cliquer pour modifier"' : ''}>${esc(plain(t.text))}</span>
    ${n ? `<span class="td-prog">${d}/${n}</span>` : ''}
    ${t.ticket ? ticketChip(t.ticket) : ''}
    ${t.due ? `<span class="td-due${late ? ' late' : ''}">${esc(dueLabel(t.due))}</span>` : ''}
    ${source && !t.own ? `<button class="td-src" data-open-note="${t.note.id}">${esc(titleOf(t.note))}</button>` : ''}
    ${t.own && !t.sub && !t.done ? `<button class="icon-btn td-del" data-td-sub title="Ajouter une sous-tâche" aria-label="Ajouter une sous-tâche">${icon('plus')}</button>` : ''}
    ${t.own ? `<button class="icon-btn td-del" data-td-del title="Supprimer" aria-label="Supprimer">${icon('trash')}</button>` : ''}
  </div>`;
}
function row(t: Task, opts?: { source?: boolean }): string {
  const adding = t.own && !t.sub && subFor === t.line;
  if (!t.subs.length && !adding) return line(t, opts);
  return `<div class="td-item">${line(t, opts)}<div class="td-subs">${t.subs.map(x => line(x)).join('')}${adding ? `<form class="td-subadd" data-line="${t.line}"><span class="td-plus">${icon('plus')}</span><input class="td-subinput" placeholder="Sous-tâche, puis Entrée" aria-label="Nouvelle sous-tâche" autocomplete="off"></form>` : ''}</div></div>`;
}

function body() {
  const c = collect();
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

let doneOpen = false, subFocus = false;
export function refresh(): void {
  const box = $('#main .td-list'); if (!box) return;
  if (box.querySelector('.td-edit')) return; // une modification est en cours : on ne casse pas la saisie
  const typed = box.querySelector<HTMLInputElement>('.td-subinput'), keep = typed?.value || '', had = typed && document.activeElement === typed;
  box.innerHTML = body();
  const si = box.querySelector<HTMLInputElement>('.td-subinput'); if (si) { si.value = keep; if (had || subFocus) si.focus(); subFocus = false; }
  const d = $<HTMLDetailsElement>('.td-donesec', box); if (d) { d.open = doneOpen; d.ontoggle = () => { doneOpen = d.open; }; }
  const c = collect(), late = c.late.length;
  const sub = $('#main .td-sub'); if (sub) sub.textContent = `${c.openCount} à faire${late ? ` · ${late} en retard` : ''}`;
}

export function mount(main: HTMLElement): void {
  main.innerHTML = `<header class="toolbar">${app.tbLeft()}${app.crumb('Tâches')}<div class="tb-side tb-right"></div></header>
    <div class="todo"><div class="todo-in">
      <div class="td-head"><h1>Tâches</h1><p class="td-sub"></p></div>
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
