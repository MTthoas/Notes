// Studio — interface. Tout est pilotable au clavier ; la palette (⌘K) donne accès à chaque action.
import * as store from './core/store.ts';
import * as events from './core/events.ts';
import * as cr from './core/crypto.ts';
import { renderMarkdown, esc, plain, LINK_RE } from './lib/markdown.ts';
import { fuzzy, fold } from './lib/fuzzy.ts';
import { diffLines, diffWords } from './lib/diff.ts';
import { zip } from './lib/zip.ts';
import { createGraph } from './lib/graph.ts';
import * as hub from './features/hub.ts';
import * as todo from './features/tasks.ts';
import * as notifs from './integrations/linear/notifications.ts';
import * as linearView from './integrations/linear/page.ts';
import * as github from './integrations/github/api.ts';
import * as githubPage from './integrations/github/page.ts';
import * as voice from './features/voice.ts';
import * as home from './features/home.ts';
import * as automations from './features/automations.ts';
import * as help from './features/help.ts';
import * as onboarding from './features/onboarding.ts';
import * as caret from './ui/caret.ts';
import * as biometric from './core/biometric.ts';
import * as linear from './integrations/linear/api.ts';
import * as vault from './core/vault.ts';
import * as link from './integrations/link.ts';
import { $, $$, el, icon, logo, kbd, keys, matches, isMac, rel, until, full, menu, modal, confirmBox, toast, download, closeTop, topLayer, need, target, errMsg, num, hue } from './ui/kit.ts';
import type { MenuItem } from './ui/kit.ts';
import type { Note, Version, ViewState } from './types.ts';
import type { Graph, GraphInput } from './lib/graph.ts';

// ---------- Préférences ----------
/** État d'interface mémorisé entre deux visites. */
interface UiState { view: ViewState; id: string | null; mode: 'edit' | 'split' | 'read'; side: boolean; theme: string; tagsOpen: boolean }
/** Note ouverte dans l'éditeur et ses éléments. */
interface Editor {
  note: Note; title: HTMLInputElement;
  /** Absents quand la note est verrouillée (seul le formulaire de mot de passe est affiché). */
  ta: HTMLTextAreaElement | null; preview: HTMLElement | null; read: HTMLElement | null;
  sorts: Map<number, { col: number; dir: number }>; titleAtFocus: string;
}
/** Position de lecture et de saisie conservée quand la note est redessinée. */
interface Keep { s: number; e: number; top: number; ptop: number | null; focus: boolean }
/** Minuteur [timer 25m] : en cours (endAt) ou en pause (left, en secondes). */
interface TimerState { dur: number; endAt?: number; left?: number }
/** Opération de diff ligne à ligne. */
interface DiffOp { t: string; s: string }
/** Entrée de la palette de commandes. */
interface PaletteItem { icon: string; title: string; run: () => unknown; score?: number; sub?: string; hint?: string; keys?: string }
interface PaletteSection { label: string; items: PaletteItem[] }
/** Liste d'autocomplétion des [[liens]]. */
interface Autocomplete { node: HTMLElement; sel: number; items: string[]; q: string }
/** Éditeur avec sa zone de saisie (note déverrouillée). */
type OpenEditor = Editor & { ta: HTMLTextAreaElement };
const editing = (): OpenEditor | null => (ed && ed.ta ? ed as OpenEditor : null);

const read = <T>(k: string, d: T): T => { try { return (JSON.parse(localStorage.getItem(k) || 'null') as T | null) ?? d; } catch { return d; } };
const write = (k: string, v: unknown): void => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* stockage indisponible */ } };
const ui: UiState = Object.assign({ view: { type: 'home' }, id: null, mode: 'split', side: true, theme: 'auto', tagsOpen: true } as UiState, read<Partial<UiState>>('carnet.ui', {}));
const saveUI = () => write('carnet.ui', ui);
let focusMode = false, ed: Editor | null = null, graph: Graph | null = null;

const SC = {
  palette: 'mod+k', ask: 'mod+shift+i', settings: 'mod+,', tasks: 'mod+shift+t', notifs: 'mod+shift+l', capture: 'mod+j', newNote: 'mod+alt+n', mode: 'mod+e', focus: 'mod+shift+f',
  today: 'mod+shift+d', graph: 'mod+shift+g', history: 'mod+shift+h', lock: 'mod+shift+l',
  sidebar: isMac ? 'ctrl+mod+s' : 'mod+alt+s', task: 'mod+enter', bold: 'mod+b', italic: 'mod+i',
};
const VIEWS: Record<string, { label: string; icon: string }> = {
  home: { label: 'Accueil', icon: 'home' }, agents: { label: 'Automatisations', icon: 'bot' }, help: { label: 'Aide', icon: 'help' }, settings: { label: 'Réglages', icon: 'gear' },
  today: { label: 'Aujourd’hui', icon: 'today' }, tasks: { label: 'Tâches', icon: 'check' }, linear: { label: 'Linear', icon: 'linear' }, github: { label: 'GitHub', icon: 'github' }, all: { label: 'Toutes les notes', icon: 'notes' },
  inbox: { label: 'Boîte de réception', icon: 'inbox' }, ephemeral: { label: 'Éphémères', icon: 'hourglass' },
  graph: { label: 'Graphe', icon: 'graph' }, trash: { label: 'Corbeille', icon: 'trash' },
};
/** Teinte de l'icône de chaque section dans la barre latérale. */
const SIDE_HUE: Record<string, string> = { home: 'gray', inbox: 'blue', today: 'amber', all: 'gray', ephemeral: 'orange', tasks: 'green', agents: 'violet', help: 'blue', linear: 'indigo', github: 'gray', graph: 'teal', trash: 'gray' };
const titleOf = (n: Note) => n.title.trim() || 'Sans titre';
const WIDE = new Set(['graph', 'home', 'settings', 'tasks', 'linear', 'github', 'agents', 'help']); // vues sans colonne de liste

function applyTheme() {
  const dark = ui.theme === 'dark' || (ui.theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $('meta[name=theme-color]')?.setAttribute('content', dark ? '#08090a' : '#f2f2f3');
  window.webkit?.messageHandlers?.carnet?.postMessage({ type: 'theme', dark }); // app native : la fenêtre suit le thème
  graph?.redraw();
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

// ---------- Enregistrement (différé, par note) ----------
const pending = new Map();
function scheduleSave(n: Note) {
  clearTimeout(pending.get(n.id));
  pending.set(n.id, setTimeout(() => flush(n.id), 450));
  setSaveState(false);
}
const saving = new Map(); // écritures en cours : on les attend avant de lire l'historique ou de changer de note
async function flush(id: string) {
  if (pending.has(id)) {
    clearTimeout(pending.get(id)); pending.delete(id);
    const n = store.get(id);
    if (n) {
      const job = (saving.get(id) || Promise.resolve()).then(() => store.saveNote(n)).catch((e: unknown) => { console.error(e); toast('Enregistrement impossible : ' + errMsg(e)); });
      saving.set(id, job);
      job.then(() => { if (saving.get(id) === job) saving.delete(id); });
    }
  }
  await saving.get(id);
  if (!pending.size) setSaveState(true);
}
const flushAll = async (): Promise<void> => { await Promise.all([...pending.keys()].map(flush)); };
function setSaveState(saved: boolean) {
  const s = $('.save-state'); if (!s) return;
  s.classList.toggle('busy', !saved);
  if (s.lastChild) s.lastChild.textContent = saved ? 'Enregistré sur cet appareil' : 'Enregistrement…';
}

// ---------- Vues et navigation ----------
function viewNotes(v = ui.view) {
  const all = [...store.notes.values()];
  if (v.type === 'trash') return all.filter(n => n.deletedAt).sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0));
  let list = all.filter(n => !n.deletedAt);
  if (v.type === 'inbox') list = list.filter(n => n.inbox);
  if (v.type === 'agents') list = list.filter(n => (store.getBody(n) || '').includes('```agent'));
  if (v.type === 'ephemeral') return list.filter(n => n.expiresAt).sort((a, b) => (a.expiresAt ?? 0) - (b.expiresAt ?? 0));
  if (v.type === 'tag') list = list.filter(n => store.meta(n).tags.some(t => t === v.tag || t.startsWith(v.tag + '/')));
  return list.sort((a, b) => (Number(b.pinned) - Number(a.pinned)) || (b.updated - a.updated));
}

async function setView(v: ViewState, { keepNote = false } = {}) {
  await flushAll();
  ui.view = v;
  if (v.type === 'today') ui.id = (await store.dailyNote()).id;
  else if (!WIDE.has(v.type) && !keepNote) {
    const list = viewNotes();
    if (!list.some(n => n.id === ui.id)) ui.id = list[0]?.id ?? null;
  }
  document.body.classList.remove('pane-main');
  if (matchMedia('(max-width: 900px)').matches) ui.side = false;
  saveUI(); render();
}

async function openNote(id: string, { edit = false } = {}) {
  if (ui.id && ui.id !== id) await flush(ui.id);
  const n = store.get(id); if (!n) return;
  ui.id = id;
  const t = ui.view.type;
  if (WIDE.has(t) || (t !== 'today' && !viewNotes().some(x => x.id === id))) ui.view = { type: n.deletedAt ? 'trash' : 'all' };
  document.body.classList.add('pane-main');
  saveUI(); render();
  if (edit) { if (ui.mode === 'read') setMode('edit'); (n.title ? ed?.ta : ed?.title)?.focus(); }
}

async function newNote(props: Partial<Note> = {}): Promise<Note> {
  onboarding.mark('note');
  const v = ui.view;
  const body = v.type === 'tag' && !props.body ? `#${v.tag} ` : props.body || '';
  const n = await store.createNote({ ...props, body, inbox: v.type === 'inbox' });
  if (v.type === 'ephemeral') { n.expiresAt = Date.now() + 864e5; await store.saveNote(n, { version: false }); }
  await openNote(n.id, { edit: true });
  return n;
}

async function openByTitle(title: string) {
  const n = store.findByTitle(title) || await store.createNote({ title: title.trim() });
  openNote(n.id);
}

// ---------- Rendu : barre latérale ----------
function renderSidebar() {
  const idx = store.index(), v = ui.view;
  const count: Record<string, number> = { inbox: idx.live.filter(n => n.inbox).length, tasks: todo.openCount(), linear: notifs.unreadCount(), github: github.unseenCount(), ephemeral: idx.live.filter(n => n.expiresAt).length };
  const item = (type: string) => `<button class="side-item${v.type === type ? ' sel' : ''}" data-view="${type}" style="--ic:var(--c-${SIDE_HUE[type] ?? 'gray'})">${icon(VIEWS[type]?.icon ?? 'notes')}<span>${VIEWS[type]?.label ?? type}</span>${count[type] ? `<span class="side-count">${count[type]}</span>` : ''}</button>`;
  const tags = [...idx.tags].sort((a, b) => a[0].localeCompare(b[0], 'fr'));
  const devs = vault.isOpen() ? link.devices().length : 0;
  need('#sidebar').innerHTML = `
    <div class="side-head">
      <button class="ws" data-act="workspace" aria-label="Menu Studio">${logo()}<span class="ws-name">Studio</span>${icon('chevron')}</button>
      <button class="icon-btn" data-act="palette" title="Rechercher (${keys(SC.palette)})" aria-label="Rechercher">${icon('search')}</button>
      ${voice.available() ? `<button class="icon-btn" data-act="voice" title="Note vocale" aria-label="Note vocale">${icon('mic')}</button>` : ''}
      <button class="icon-btn" data-act="new" title="Nouvelle note (${keys(SC.newNote)})" aria-label="Nouvelle note">${icon('compose')}</button>
    </div>
    <div class="side-scroll">
      <div class="side-group">${item('home')}</div>
      <div class="side-label">Notes</div>
      <div class="side-group">${item('inbox')}${item('today')}${item('all')}${count.ephemeral || v.type === 'ephemeral' ? item('ephemeral') : ''}</div>
      <div class="side-label">Organisation</div>
      <div class="side-group">${item('tasks')}${item('agents')}</div>
      <div class="side-label">Connexions</div>
      <div class="side-group">${item('linear')}${item('github')}</div>
      ${tags.length ? `<button class="side-label" data-act="tags" aria-expanded="${ui.tagsOpen}">${icon('chevron')}Tags</button>${ui.tagsOpen ? `<div class="side-group">${tags.map(([t, c]) => `<button class="side-item${v.type === 'tag' && v.tag === t ? ' sel' : ''}" data-tag="${esc(t)}"><i class="tag-dot" style="--c:var(--c-${hue(t)})"></i><span>${esc(t)}</span><span class="side-count">${c}</span></button>`).join('')}</div>` : ''}` : ''}
      <div class="side-label">Explorer</div>
      <div class="side-group">${item('graph')}${item('trash')}${item('help')}</div>
    </div>
    <button class="side-foot" data-open-conn="${vault.enabled() ? 'appareils' : 'coffre'}" title="Réglages (${keys(SC.settings)})">${icon(vault.isOpen() ? 'shield' : 'unlock')}<span>${vault.isOpen() ? 'Chiffré de bout en bout' : 'Non chiffré'}</span>${devs ? `<span class="side-count">${icon('devices')}${devs}</span>` : ''}</button>`;
}

function workspaceMenu(anchor: HTMLElement) {
  menu(anchor, [
    { label: 'Réglages', icon: 'gear', keys: SC.settings, run: () => hub.openConnections('coffre') },
    { label: 'Aide et raccourcis', icon: 'help', run: openHelp },
    '-',
    { label: 'Thème' },
    { label: 'Automatique', checked: ui.theme === 'auto', run: () => setTheme('auto') },
    { label: 'Clair', checked: ui.theme === 'light', run: () => setTheme('light') },
    { label: 'Sombre', checked: ui.theme === 'dark', run: () => setTheme('dark') },
    '-',
    { label: 'Importer des fichiers…', icon: 'upload', run: () => need('#file').click() },
    { label: 'Exporter une sauvegarde', icon: 'download', run: exportJSON },
    ...(vault.isOpen() ? ['-' as const, { label: 'Verrouiller Studio', icon: 'lock', run: async () => { await flushAll(); try { sessionStorage.setItem('studio.manualLock', '1'); } catch { /* ignoré */ } vault.lock(); } }] : []),
  ]);
}

// ---------- Rendu : liste ----------
function noteItem(n: Note) {
  const m = store.meta(n), locked = store.isLocked(n);
  const sub = locked ? 'Note chiffrée' : (m.snippet || 'Aucun contenu');
  return `<button class="note-item${n.id === ui.id ? ' sel' : ''}" data-id="${n.id}">
    <span class="ni-row"><span class="ni-title">${n.pinned ? icon('pin') : ''}${n.enc ? icon(locked ? 'lock' : 'unlock') : ''}<span>${esc(titleOf(n))}</span></span><span class="ni-date">${rel(n.deletedAt || n.updated)}</span></span>
    <span class="ni-sub">${esc(sub)}</span>
    ${n.expiresAt ? `<span class="ni-badge">${icon('hourglass')}Autodestruction dans ${until(n.expiresAt)}</span>` : ''}
  </button>`;
}

function renderList() {
  const v = ui.view, box = need('#list');
  if (WIDE.has(v.type)) { box.innerHTML = ''; return; }
  const scroll = $('.list-scroll', box)?.scrollTop || 0;
  const title = v.type === 'tag' ? '#' + v.tag : VIEWS[v.type]?.label ?? '';
  let body, sub;
  if (v.type === 'today') {
    const daily = store.get(ui.id)?.daily === store.dayKey() ? store.get(ui.id) : [...store.notes.values()].find(n => n.daily === store.dayKey() && !n.deletedAt);
    const groups = store.openTasks(daily?.id), total = groups.reduce((s, g) => s + g.tasks.length, 0);
    sub = new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
    body = (daily ? `<button class="note-item${daily.id === ui.id ? ' sel' : ''}" data-id="${daily.id}"><span class="ni-title">${icon('today')}<span>Note du jour</span></span><span class="ni-sub">${esc(store.meta(daily).snippet || 'Vide pour l’instant')}</span></button>` : '')
      + `<div class="list-label">Tâches en cours${total ? ` · ${total}` : ''}</div>`
      + (groups.length ? groups.map(g => `<div class="task-group"><button class="tg-title${g.note.id === ui.id ? ' sel' : ''}" data-id="${g.note.id}">${esc(titleOf(g.note))}</button>${g.tasks.map(t => `<label class="tg-task"><input type="checkbox" data-note="${g.note.id}" data-line="${t.line}"><span>${esc(plain(t.text))}</span></label>`).join('')}</div>`).join('')
        : `<div class="list-empty">Rien en attente.<br>Les cases <code>- [ ]</code> non cochées de toutes tes notes apparaissent ici.</div>`);
  } else {
    const list = viewNotes();
    sub = `${list.length} note${list.length > 1 ? 's' : ''}`;
    const empty = ({ inbox: `Rien à ranger.<br>Note une idée avec ${kbd(SC.capture)} : sans tag, elle arrive ici en attendant d’être rangée.`, ephemeral: 'Aucune note éphémère.<br>Menu ⋯ d’une note → « Rendre éphémère » : elle s’effacera seule à la date choisie.', trash: 'La corbeille est vide.<br>Les notes supprimées y restent 30 jours.', tag: 'Aucune note avec ce tag.<br>Écris #' + esc(v.tag ?? '') + ' dans une note pour l’y ranger.', all: `Aucune note pour l’instant.<br>${kbd(SC.newNote)} pour en écrire une, ou <button class="link-btn" data-view="help">découvre comment faire</button>.` } as Record<string, string>)[v.type];
    body = list.length ? list.map(noteItem).join('') : `<div class="list-empty">${empty}</div>`;
    if (v.type === 'trash' && list.length) body = `<div class="list-note">Suppression définitive après 30 jours.</div>` + body;
  }
  box.innerHTML = `<div class="list-head"><div class="lh-text"><h2>${v.type !== 'tag' ? icon(VIEWS[v.type]?.icon ?? 'notes') : `<i class="tag-dot" style="--c:var(--c-${hue(v.tag ?? '')})"></i>`}${esc(title)}</h2><span>${esc(sub)}</span></div>${v.type !== 'trash' ? `<button class="icon-btn" data-act="new" title="Nouvelle note (${keys(SC.newNote)})" aria-label="Nouvelle note">${icon('plus')}</button>` : ''}</div><div class="list-scroll">${body}</div>`;
  need('.list-scroll', box).scrollTop = scroll;
}

// ---------- Rendu : zone principale ----------
const tb = (act: string, ic: string, title: string, combo = '', cls = '') => `<button class="icon-btn ${cls}" data-act="${act}" title="${esc(title)}${combo ? ` (${keys(combo)})` : ''}" aria-label="${esc(title)}">${icon(ic)}</button>`;
const tbLeft = () => `<div class="tb-side">${WIDE.has(ui.view.type) ? '' : tb('back', 'back', 'Retour à la liste', '', 'only-narrow')}${tb('sidebar', 'sidebar', 'Afficher ou masquer la barre latérale', SC.sidebar)}</div>`;
// Fil d'Ariane : vue courante › titre de la note.
const crumb = (cur: string) => { const v = ui.view, parent = v.type === 'tag' ? '#' + v.tag : VIEWS[v.type]?.label; return `<div class="crumb">${parent && !WIDE.has(v.type) ? `<span>${esc(parent)}</span>${icon('chevronRight')}` : ''}<span class="crumb-cur">${esc(cur)}</span></div>`; };

function renderMain() {
  const main = need('#main');
  const keep = ed && ed.note.id === ui.id && ed.ta ? { s: ed.ta.selectionStart, e: ed.ta.selectionEnd, top: ed.ta.scrollTop, ptop: ed.read?.scrollTop ?? null, focus: document.activeElement === ed.ta } : null;
  closeAc(); graph?.destroy(); graph = null; ed = null;
  if (ui.view.type === 'graph') return mountGraph(main);
  if (ui.view.type === 'home') return home.mount(main);
  if (ui.view.type === 'settings') return hub.mountSettings(main, ui.view.tab || 'coffre');
  if (ui.view.type === 'tasks') return todo.mount(main);
  if (ui.view.type === 'agents') return automations.mount(main);
  if (ui.view.type === 'help') return help.mount(main);
  if (ui.view.type === 'linear') return linearView.mount(main);
  if (ui.view.type === 'github') return githubPage.mount(main);
  const n = store.get(ui.id);
  if (!n) {
    main.innerHTML = `<header class="toolbar">${tbLeft()}</header><div class="empty"><div class="empty-card">${icon('notes')}<h3>Aucune note sélectionnée</h3><p>${kbd(SC.newNote)} nouvelle note<br>${kbd(SC.capture)} capture rapide<br>${kbd(SC.palette)} rechercher ou lancer une commande</p></div></div>`;
    return;
  }
  mountNote(main, n, keep);
}

function mountNote(main: HTMLElement, n: Note, keep: Keep | null): void {
  const locked = store.isLocked(n), trashed = !!n.deletedAt, ro = locked || trashed;
  const mode = trashed ? 'read' : ui.mode;
  const seg = [['edit', 'pencil', 'Écrire'], ['split', 'split', 'Côte à côte'], ['read', 'eye', 'Lire']];
  main.innerHTML = `
    <header class="toolbar">
      ${tbLeft()}${crumb(titleOf(n))}
      <div class="tb-side tb-right">
        ${n.expiresAt && !trashed ? `<button class="chip chip-warn" data-act="expire" title="Autodestruction le ${esc(full(n.expiresAt))}">${icon('hourglass')}${until(n.expiresAt)}</button>` : ''}
        ${n.enc && !trashed ? tb('lock', locked ? 'lock' : 'unlock', locked ? 'Note verrouillée' : 'Verrouiller maintenant', locked ? '' : SC.lock, 'on') : ''}
        ${ro ? '' : `<div class="seg" role="tablist" title="Changer de mode (${keys(SC.mode)})">${seg.map(([m, ic, l]) => `<button role="tab" data-mode="${m}" aria-selected="${m === mode}" aria-label="${l}" title="${l}">${icon(ic)}</button>`).join('')}</div>`}
        ${ro ? '' : `<button class="btn btn-ghost" data-act="ask" title="Demander à l’IA (${keys(SC.ask)})">${icon('sparkle')}<span>Demander</span></button>`}
        ${tb('more', 'more', 'Plus d’actions')}
      </div>
    </header>
    ${trashed ? `<div class="banner">${icon('trash')}<span>Cette note est dans la corbeille.</span><button class="btn" data-act="restore">Restaurer</button><button class="btn btn-danger" data-act="destroy">Supprimer définitivement</button></div>` : ''}
    <div class="note" data-mode="${mode}">
      <div class="note-head"><input class="title" placeholder="Sans titre" value="${esc(n.title)}" ${trashed ? 'disabled' : ''} aria-label="Titre" spellcheck="false" autocomplete="off"></div>
      ${locked ? `<div class="lock-pane"><form class="lock-card">${icon('lock')}<h3>Note chiffrée</h3><p>Le contenu est chiffré dans ce navigateur. Saisis le mot de passe pour le lire.</p><input type="password" placeholder="Mot de passe" autocomplete="off" aria-label="Mot de passe"><button class="btn btn-primary">Déverrouiller</button><p class="lock-err" role="alert"></p></form></div>`
      : `<div class="panes">
          <div class="pane pane-edit"><textarea class="body" placeholder="Écris en Markdown…  [[ pour lier une note, # pour un tag" spellcheck="true" aria-label="Contenu"></textarea></div>
          <div class="pane pane-read"><article class="md"></article><section class="backlinks"></section></div>
        </div>`}
    </div>
    <footer class="status"><span class="save-state"><i></i><span>Enregistré sur cet appareil</span></span><span class="status-right"></span></footer>`;

  const E: Editor = { note: n, title: need<HTMLInputElement>('.title', main), ta: $<HTMLTextAreaElement>('.body', main), preview: $('.md', main), read: $('.pane-read', main), sorts: new Map(), titleAtFocus: n.title };
  ed = E;
  E.title.addEventListener('focus', () => { E.titleAtFocus = n.title; });
  E.title.addEventListener('input', () => { store.touch(n); n.title = E.title.value; n.updated = Date.now(); scheduleSave(n); const c = $('.crumb-cur', main); if (c) c.textContent = titleOf(n); });
  E.title.addEventListener('blur', async () => {
    const old = E.titleAtFocus; if (old == null || old === n.title || !old.trim()) return;
    const c = await store.renameLinks(old, n.title, n.id);
    if (c) toast(`Liens mis à jour dans ${c} note${c > 1 ? 's' : ''}`);
  });
  E.title.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === 'ArrowDown') { e.preventDefault(); (E.ta || $<HTMLInputElement>('.lock-card input'))?.focus(); } });

  if (locked) {
    const form = need('.lock-card', main), input = need<HTMLInputElement>('input', form);
    form.addEventListener('submit', async e => {
      e.preventDefault(); if (!input.value) return;
      form.classList.add('busy');
      try { await store.unlock(n, input.value); }
      catch { form.classList.remove('busy'); form.classList.add('shake'); setTimeout(() => form.classList.remove('shake'), 400); need('.lock-err', form).textContent = 'Mot de passe incorrect.'; input.select(); }
    });
    if (!matchMedia('(max-width: 700px)').matches) input.focus();
    return;
  }
  const ta = E.ta, rd = E.read; if (!ta) return;
  caret.attach(ta);
  ta.value = store.getBody(n) ?? '';
  ta.readOnly = trashed;
  ta.addEventListener('input', onBodyInput);
  ta.addEventListener('keydown', onBodyKey);
  ta.addEventListener('blur', () => setTimeout(closeAc, 120));
  ta.addEventListener('click', updateAc);
  ta.addEventListener('scroll', () => { // défilement synchronisé en mode côte à côte
    if (ui.mode !== 'split' || !rd) return;
    const a = ta, b = rd, max = a.scrollHeight - a.clientHeight;
    if (max > 0) b.scrollTop = a.scrollTop / max * (b.scrollHeight - b.clientHeight);
  }, { passive: true });
  renderPreview();
  if (keep) { ta.setSelectionRange(keep.s, keep.e); ta.scrollTop = keep.top; if (keep.ptop != null && rd) rd.scrollTop = keep.ptop; if (keep.focus) ta.focus(); }
}

function onBodyInput(): void {
  const E = editing(); if (!E) return;
  if (E.ta.value.includes(']]')) onboarding.mark('link');
  const n = E.note;
  store.touch(n); store.setBody(n, E.ta.value); n.updated = Date.now();
  scheduleSave(n); schedulePreview(); updateAc();
}

let previewRaf = 0;
function schedulePreview() { if (!previewRaf) previewRaf = requestAnimationFrame(() => { previewRaf = 0; renderPreview(); }); }

function renderPreview() {
  if (!ed || !ed.preview) return;
  const n = ed.note, body = store.getBody(n) ?? '';
  ed.preview.innerHTML = body.trim() ? renderMarkdown(body, { exists: t => !!store.findByTitle(t), fence: hub.fenceFor(n) }) : `<p class="placeholder">Rien à afficher pour l’instant.</p>`;
  hub.hydrate(ed.preview);
  const sorts = ed.sorts;
  $$<HTMLTableElement>('table.sortable', ed.preview).forEach((t, i) => { const s = sorts.get(i); if (s) sortTable(t, s.col, s.dir); });
  paintTimers();
  const back = n.deletedAt ? [] : store.backlinks(n);
  const bl = ed.read && $('.backlinks', ed.read); if (bl) bl.innerHTML = back.length ? `<h4>${icon('link')}Rétroliens · ${back.length}</h4>${back.map(b => {
    const key = fold(n.title.trim());
    const line = (store.getBody(b) || '').split('\n').find(l => [...l.matchAll(LINK_RE)].some(m => fold(m[1].trim()) === key)) || '';
    return `<button class="backlink" data-id="${b.id}"><strong>${esc(titleOf(b))}</strong><span>${esc(plain(line).slice(0, 140))}</span></button>`;
  }).join('')}` : '';
  const words = body.trim() ? body.trim().split(/\s+/).length : 0;
  need('.status-right').innerHTML = `${back.length ? `<button class="status-btn" data-act="backlinks">${back.length} rétrolien${back.length > 1 ? 's' : ''}</button>` : ''}<span>${words} mot${words > 1 ? 's' : ''}</span>`;
}

function setMode(m: UiState['mode']) {
  ui.mode = m; saveUI();
  const note = $('.note'); if (!note || !ed?.ta) return;
  note.dataset.mode = m;
  $$('.seg button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.mode === m)));
  if (m === 'read') ed.ta.blur(); else ed.ta.focus();
}

function setFocus(on: boolean) {
  focusMode = on; document.body.classList.toggle('focus', on);
  if (on) { ed?.ta?.focus(); toast(`Mode focus — ${keys('esc')} pour quitter`); }
}

function toggleSidebar() { ui.side = !ui.side; saveUI(); document.body.classList.toggle('no-side', !ui.side); document.body.classList.toggle('side-open', ui.side); }

// ---------- Éditeur : confort d'écriture ----------
function replaceRange(ta: HTMLTextAreaElement, start: number, end: number, text: string) {
  ta.focus(); ta.setSelectionRange(start, end);
  const ok = text === '' ? document.execCommand('delete') : document.execCommand('insertText', false, text);
  if (!ok) { ta.setRangeText(text, start, end, 'end'); ta.dispatchEvent(new Event('input', { bubbles: true })); }
}
function wrapSelection(ta: HTMLTextAreaElement, mark: string) {
  const { selectionStart: s, selectionEnd: e, value: v } = ta, sel = v.slice(s, e);
  if (v.slice(s - mark.length, s) === mark && v.slice(e, e + mark.length) === mark) { replaceRange(ta, s - mark.length, e + mark.length, sel); ta.setSelectionRange(s - mark.length, e - mark.length); }
  else { replaceRange(ta, s, e, mark + sel + mark); ta.setSelectionRange(s + mark.length, e + mark.length); }
}
const lineBounds = (v: string, pos: number) => { const s = v.lastIndexOf('\n', pos - 1) + 1; let e = v.indexOf('\n', pos); if (e < 0) e = v.length; return [s, e]; };

function onBodyKey(e: KeyboardEvent): void {
  const E = editing(); if (!E) return;
  const ta = E.ta, v = ta.value;
  if (ac) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); ac.sel = (ac.sel + (e.key === 'ArrowDown' ? 1 : -1) + ac.items.length) % ac.items.length; paintAc(); return; }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickAc(ac.sel); return; }
  }
  if (e.isComposing) return;
  if (matches(e, SC.bold)) { e.preventDefault(); return wrapSelection(ta, '**'); }
  if (matches(e, SC.italic)) { e.preventDefault(); return wrapSelection(ta, '*'); }
  const [ls, le] = lineBounds(v, ta.selectionStart);
  if (matches(e, SC.task)) { // ⌘↵ : crée, coche ou décoche la tâche de la ligne courante
    e.preventDefault();
    const line = v.slice(ls, le), pos = ta.selectionStart;
    let next;
    if (/^\s*(?:[-*+]|\d+[.)])\s+\[[ xX/]\]/.test(line)) next = line.replace(/\[([ xX/])\]/, (_, c: string) => c === 'x' || c === 'X' ? '[ ]' : '[x]');
    else if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(line)) next = line.replace(/^(\s*(?:[-*+]|\d+[.)])\s+)/, '$1[ ] ');
    else next = line.replace(/^(\s*)/, '$1- [ ] ');
    replaceRange(ta, ls, le, next);
    const p = Math.max(ls, pos + next.length - line.length); ta.setSelectionRange(p, p);
    return;
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && ta.selectionStart === ta.selectionEnd) {
    const m = v.slice(ls, ta.selectionStart).match(/^(\s*)([-*+]|\d+[.)])(\s+)(\[[ xX/]\]\s+)?(.*)$/);
    if (!m) return;
    e.preventDefault();
    if (!m[5].trim() && ta.selectionStart === le) return replaceRange(ta, ls, le, ''); // puce vide : on sort de la liste
    const num = m[2].match(/^(\d+)([.)])$/);
    replaceRange(ta, ta.selectionStart, ta.selectionEnd, `\n${m[1]}${num ? (+num[1] + 1) + num[2] : m[2]}${m[3]}${m[4] ? '[ ] ' : ''}`);
    return;
  }
  if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    const s = ta.selectionStart, en = ta.selectionEnd, [bs] = lineBounds(v, s), [, be] = lineBounds(v, en);
    const block = v.slice(bs, be), lines = block.split('\n');
    const out = lines.map(l => e.shiftKey ? l.replace(/^( {1,2}|\t)/, '') : '  ' + l);
    const first = out[0].length - lines[0].length, total = out.join('\n').length - block.length;
    if (!total) return;
    replaceRange(ta, bs, be, out.join('\n'));
    ta.setSelectionRange(Math.max(bs, s + first), Math.max(bs, en + total));
  }
}

// Autocomplétion des [[liens]]
let ac: Autocomplete | null = null;
function caretXY(ta: HTMLTextAreaElement) {
  const cs = getComputedStyle(ta), d = document.createElement('div');
  for (const p of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'tabSize'] as const) d.style[p] = cs[p];
  Object.assign(d.style, { position: 'absolute', visibility: 'hidden', whiteSpace: 'pre-wrap', overflowWrap: 'break-word', boxSizing: 'border-box', width: ta.clientWidth + 'px', top: '0', left: '0' });
  d.textContent = ta.value.slice(0, ta.selectionStart);
  const s = document.createElement('span'); s.textContent = '​'; d.append(s); document.body.append(d);
  const r = ta.getBoundingClientRect(), out = { x: r.left + s.offsetLeft - ta.scrollLeft, y: r.top + s.offsetTop - ta.scrollTop + parseFloat(cs.lineHeight) };
  d.remove(); return out;
}
function updateAc(): void {
  const E = editing();
  if (!E || document.activeElement !== E.ta) { closeAc(); return; }
  const ta = E.ta, m = ta.value.slice(0, ta.selectionStart).match(/\[\[([^\[\]\n|]*)$/);
  if (!m || ta.selectionStart !== ta.selectionEnd) { closeAc(); return; }
  const q = m[1] ?? '';
  const items = store.index().live.filter(n => n.id !== E.note.id && n.title.trim())
    .flatMap(n => { const f = fuzzy(q, n.title); return f ? [{ n, f }] : []; })
    .sort((a, b) => b.f.score - a.f.score || b.n.updated - a.n.updated).slice(0, 7).map(x => x.n.title.trim());
  if (q.trim() && !items.some(t => fold(t) === fold(q.trim()))) items.push(q.trim());
  if (!items.length) { closeAc(); return; }
  if (!ac) { const node = el('<div class="ac" role="listbox"></div>'); ac = { node, sel: 0, items: [], q: '' }; need('#layer').append(node); node.addEventListener('mousedown', e => { e.preventDefault(); const b = target(e).closest('[data-i]'); if (b) pickAc(num(b, 'i')); }); }
  const A = ac;
  A.items = items; A.q = q; A.sel = Math.min(A.sel, items.length - 1);
  paintAc();
  const { x, y } = caretXY(ta), w = A.node.offsetWidth, h = A.node.offsetHeight;
  A.node.style.left = Math.max(8, Math.min(x, innerWidth - w - 8)) + 'px';
  A.node.style.top = (y + h > innerHeight - 8 ? y - h - 28 : y + 4) + 'px';
}
function paintAc(): void {
  const A = ac; if (!A) return;
  A.node.innerHTML = A.items.map((t, i) => `<div class="ac-item${i === A.sel ? ' sel' : ''}" data-i="${i}" role="option">${icon(store.findByTitle(t) ? 'notes' : 'plus')}<span>${esc(t)}</span>${store.findByTitle(t) ? '' : '<em>nouvelle note</em>'}</div>`).join('');
}
function pickAc(i: number): void {
  const E = editing(), A = ac; if (!E || !A) return;
  const ta = E.ta, pos = ta.selectionStart, title = A.items[i], q = A.q;
  if (title === undefined) return;
  const closed = ta.value.slice(pos, pos + 2) === ']]';
  closeAc();
  replaceRange(ta, pos - q.length, pos + (closed ? 2 : 0), title + ']]');
}
function closeAc() { if (!ac) return false; ac.node.remove(); ac = null; return true; }

// ---------- Blocs intelligents : tableaux triables et minuteurs ----------
function sortTable(table: HTMLTableElement, col: number, dir: number) {
  const body = table.tBodies[0]; if (!body) return;
  const rows = [...body.rows];
  const num = (s: string) => { const t = s.replace(/[\s  €$£%]/g, '').replace(',', '.'); return t !== '' && !isNaN(Number(t)) ? Number(t) : null; };
  const val = (r: HTMLTableRowElement) => r.cells[col]?.textContent?.trim() ?? '';
  const numeric = rows.every(r => val(r) === '' || num(val(r)) !== null);
  rows.sort((a, b) => (numeric ? (num(val(a)) ?? -Infinity) - (num(val(b)) ?? -Infinity) : val(a).localeCompare(val(b), 'fr', { numeric: true, sensitivity: 'base' })) * dir);
  body.append(...rows);
  [...(table.tHead?.rows[0]?.cells ?? [])].forEach((th, i) => th.setAttribute('aria-sort', i === col ? (dir > 0 ? 'ascending' : 'descending') : 'none'));
}

const timers = read<Record<string, TimerState>>('carnet.timers', {});
const saveTimers = () => write('carnet.timers', timers);
const tLeft = (t: TimerState | undefined, dur: number): number => !t || t.dur !== dur ? dur : t.endAt ? Math.max(0, (t.endAt - Date.now()) / 1000) : t.left ?? dur;
const fmt = (s: number) => { s = Math.ceil(s); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = String(s % 60).padStart(2, '0'); return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`; };
function paintTimers(): void {
  if (!ed?.preview) return;
  const id = ed.note.id;
  for (const node of $$('.timer', ed.preview)) {
    const dur = num(node, 'dur'), t = timers[`${id}:${node.dataset.timer}`], left = tLeft(t, dur);
    const running = !!(t && t.dur === dur && t.endAt);
    node.classList.toggle('running', running); node.classList.toggle('done', left <= 0);
    node.style.setProperty('--p', (1 - left / dur) * 100 + '%');
    need('.timer-time', node).textContent = left <= 0 ? 'Terminé' : fmt(left);
    need('.timer-toggle', node).title = running ? 'Pause' : 'Démarrer';
  }
}
function toggleTimer(node: HTMLElement, reset: boolean): void {
  if (!ed) return;
  const key = `${ed.note.id}:${node.dataset.timer}`, dur = num(node, 'dur'), t = timers[key], left = tLeft(t, dur);
  if (reset) delete timers[key];
  else if (t && t.dur === dur && t.endAt) timers[key] = { dur, left };
  else {
    timers[key] = { dur, endAt: Date.now() + (left > 0 ? left : dur) * 1000 };
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
  }
  saveTimers(); paintTimers();
}
function tickTimers() {
  let changed = false;
  for (const [key, t] of Object.entries(timers)) {
    if (!t.endAt || t.endAt > Date.now()) continue;
    timers[key] = { dur: t.dur, left: 0 }; changed = true;
    const n = store.get(key.split(':')[0]);
    if (!n) { delete timers[key]; continue; }
    toast(`Minuteur terminé — ${titleOf(n)}`, { label: 'Ouvrir', run: () => openNote(n.id) });
    try { const a = new AudioContext(), o = a.createOscillator(), g = a.createGain(); o.frequency.value = 880; o.connect(g); g.connect(a.destination); g.gain.setValueAtTime(0.15, a.currentTime); g.gain.exponentialRampToValueAtTime(0.001, a.currentTime + 0.9); o.start(); o.stop(a.currentTime + 0.9); } catch { /* son indisponible */ }
    if ('Notification' in window && Notification.permission === 'granted' && document.hidden) new Notification('Minuteur terminé', { body: titleOf(n) });
  }
  if (changed) saveTimers();
  paintTimers();
}

async function toggleTask(n: Note, line: number) {
  await flush(n.id);
  await store.toggleTask(n, line);
  if (ed?.note === n && ed.ta) { const s = ed.ta.selectionStart, e = ed.ta.selectionEnd, top = ed.ta.scrollTop; ed.ta.value = store.getBody(n) ?? ''; ed.ta.setSelectionRange(s, e); ed.ta.scrollTop = top; renderPreview(); }
}

// Une note modifiée en dehors de l'éditeur (agent, IA, synchro) : on recharge le texte affiché.
function refreshNote(n: Note) {
  if (!n || ed?.note !== n || !ed.ta) return;
  const s = ed.ta.selectionStart, e = ed.ta.selectionEnd, top = ed.ta.scrollTop;
  ed.ta.value = store.getBody(n) ?? ''; ed.ta.setSelectionRange(s, e); ed.ta.scrollTop = top; renderPreview();
}
function insertBlock(text: string) {
  if (!ed?.ta) return;
  const ta = ed.ta, [, le] = lineBounds(ta.value, ta.selectionEnd);
  const before = ta.value.slice(0, le), lead = !before.trim() ? '' : before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
  replaceRange(ta, le, le, lead + text);
  if (ui.mode === 'read') setMode('split');
}
// « #todo » sur une seule ligne : la tâche va dans la liste « Tâches » plutôt que dans une nouvelle note.
async function captureTodo(text: string) {
  const r = await todo.add(text.replace(/(^|\s)#todo\b/gi, ' ').replace(/\s+/g, ' ').trim());
  if (r) toast(`Ajoutée aux tâches${r.due ? ' · échéance enregistrée' : ''}`, { label: 'Voir', run: () => setView({ type: 'tasks' }) });
  return r;
}
// Une capture déclenche les automatisations « déclencheur: capture » (sauf note privée).
function announceCapture(n: Note): void {
  onboarding.mark('note');
  if (!n.enc && !store.meta(n).tags.some(t => /^priv[ée]/.test(t))) events.emit('capture', `${n.title}\n\n${store.getBody(n) ?? ''}`);
}
async function quickCapture(text: string) {
  onboarding.mark('note');
  const c = parseCapture(text);
  if (c.isTodo && !text.trim().includes('\n')) return captureTodo(text);
  const n = await store.createNote({ title: c.title, body: c.body, inbox: !c.tags.length });
  announceCapture(n);
  toast(c.tags.length ? `Rangée dans ${c.tags.map(t => '#' + t).join(' ')}` : 'Ajoutée à la boîte de réception', { label: 'Ouvrir', run: () => openNote(n.id) });
  return n;
}

// ---------- Actions sur la note ----------
async function trash(n: Note) {
  await flush(n.id);
  await store.trashNote(n);
  if (ui.id === n.id) { ui.id = viewNotes()[0]?.id ?? null; document.body.classList.remove('pane-main'); saveUI(); render(); }
  toast(`« ${titleOf(n)} » placée dans la corbeille`, { label: 'Annuler', run: async () => { await store.restoreNote(n); openNote(n.id); } });
}
async function destroy(n: Note) {
  if (!await confirmBox({ title: 'Supprimer définitivement ?', text: `« ${titleOf(n)} » et tout son historique seront effacés de ce navigateur. Cette action est irréversible.`, ok: 'Supprimer', danger: true })) return;
  await store.destroyNote(n.id);
  if (ui.id === n.id) { ui.id = viewNotes()[0]?.id ?? null; saveUI(); render(); }
}
async function togglePin(n: Note) { n.pinned = !n.pinned; await store.saveNote(n, { version: false }); }
async function setExpire(n: Note, ts: number | null) {
  n.expiresAt = ts; await store.saveNote(n, { version: false }); renderMain();
  toast(ts ? `Autodestruction ${full(ts)}` : 'Cette note ne s’autodétruira plus');
}
type Anchor = Element | { x: number; y: number };
function expireMenu(anchor: Anchor, n: Note): void {
  const now = new Date(), tonight = new Date(now); tonight.setHours(23, 59, 0, 0);
  const inH = (h: number) => () => setExpire(n, Date.now() + h * 3600e3);
  menu(anchor, [
    { label: 'Autodestruction' },
    { label: 'Dans 1 heure', run: inH(1) },
    ...(tonight.getTime() - now.getTime() > 3600e3 ? [{ label: 'Ce soir', hint: '23:59', run: () => setExpire(n, tonight.getTime()) }] : []),
    { label: 'Dans 24 heures', run: inH(24) }, { label: 'Dans 7 jours', run: inH(168) }, { label: 'Dans 30 jours', run: inH(720) },
    { label: 'Choisir une date…', run: () => {
      const local = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60e3).toISOString().slice(0, 16);
      const m = modal({ title: 'Autodestruction', cls: 'small', html: `<p class="modal-text">À cette date, la note et son historique seront effacés définitivement, sans passer par la corbeille.</p><form><input type="datetime-local" class="field" required min="${local(new Date())}" value="${local(new Date(n.expiresAt || Date.now() + 864e5))}" autofocus><div class="modal-actions"><button type="button" class="btn" data-x>Annuler</button><button class="btn btn-primary">Programmer</button></div></form>` });
      need('[data-x]', m.node).onclick = m.close;
      need('form', m.node).onsubmit = e => { e.preventDefault(); const ts = new Date(need<HTMLInputElement>('input', m.node).value).getTime(); if (ts > Date.now()) { m.close(); setExpire(n, ts); } };
    } },
    ...(n.expiresAt ? ['-' as const, { label: 'Ne plus détruire', run: () => setExpire(n, null) }] : []),
  ]);
}

function encryptDialog(n: Note): void {
  if (!cr.available()) { toast('Le chiffrement nécessite une page servie en HTTPS (ou en local).'); return; }
  const m = modal({ title: 'Chiffrer cette note', cls: 'small', html: `<p class="modal-text">Le contenu sera chiffré dans ce navigateur (AES-256). Le titre reste visible, et l’historique actuel en clair est effacé.<br><strong>Aucune récupération possible si tu oublies le mot de passe.</strong></p><form><input type="password" class="field" placeholder="Mot de passe" autocomplete="new-password" required autofocus><input type="password" class="field" placeholder="Confirmer" autocomplete="new-password" required><p class="lock-err" role="alert"></p><div class="modal-actions"><button type="button" class="btn" data-x>Annuler</button><button class="btn btn-primary">Chiffrer</button></div></form>` });
  need('[data-x]', m.node).onclick = m.close;
  need('form', m.node).onsubmit = async e => {
    e.preventDefault();
    const [a, b] = $$<HTMLInputElement>('input', m.node);
    if (!a || !b) return;
    if (a.value !== b.value) { need('.lock-err', m.node).textContent = 'Les deux mots de passe ne correspondent pas.'; b.select(); return; }
    await flush(n.id); await store.encryptNote(n, a.value);
    m.close(); renderMain(); toast('Note chiffrée');
  };
}
async function lockAction(n: Note): Promise<void> {
  if (!n.enc) { encryptDialog(n); return; }
  if (store.isLocked(n)) { $('.lock-card input')?.focus(); return; }
  await flush(n.id); store.lock(n.id);
}
async function removeEncryption(n: Note) {
  if (!await confirmBox({ title: 'Retirer le chiffrement ?', text: 'Le contenu sera de nouveau enregistré en clair dans ce navigateur.', ok: 'Retirer' })) return;
  await flush(n.id); await store.decryptNote(n); renderMain(); toast('Chiffrement retiré');
}

function moreMenu(anchor: Anchor, n: Note): void {
  if (n.deletedAt) { menu(anchor, [{ label: 'Restaurer', icon: 'restore', run: () => store.restoreNote(n).then(() => openNote(n.id)) }, { label: 'Supprimer définitivement', icon: 'trash', danger: true, run: () => destroy(n) }]); return; }
  const locked = store.isLocked(n);
  menu(anchor, [
    ...(locked ? [] : <MenuItem[]>[
      { label: 'Historique des versions', icon: 'history', keys: SC.history, run: () => openHistory(n) },
      { label: 'Mode focus', icon: 'focus', keys: SC.focus, run: () => setFocus(!focusMode) },
      '-']),
    { label: n.pinned ? 'Désépingler' : 'Épingler en haut', icon: 'pin', run: () => togglePin(n) },
    { label: n.expiresAt ? 'Modifier l’autodestruction…' : 'Rendre éphémère…', icon: 'hourglass', run: () => expireMenu(anchor, n) },
    ...(n.enc ? (locked ? [] : [{ label: 'Retirer le chiffrement', icon: 'unlock', run: () => removeEncryption(n) }]) : [{ label: 'Chiffrer…', icon: 'lock', run: () => encryptDialog(n) }]),
    ...(n.inbox ? [{ label: 'Sortir de la boîte de réception', icon: 'inbox', run: async () => { n.inbox = false; await store.saveNote(n, { version: false }); } }] : []),
    '-',
    { label: 'Copier le lien [[…]]', icon: 'copy', run: () => navigator.clipboard?.writeText(`[[${titleOf(n)}]]`).then(() => toast('Lien copié')) },
    ...(locked ? [] : [{ label: 'Exporter en Markdown', icon: 'download', run: () => exportNote(n) }]),
    '-',
    { label: 'Placer dans la corbeille', icon: 'trash', danger: true, run: () => trash(n) },
  ]);
}

// ---------- Historique et diff ----------
async function openHistory(n: Note): Promise<void> {
  if (store.isLocked(n)) { toast('Déverrouille la note pour voir son historique.'); return; }
  await flush(n.id);
  const vs = await store.versions(n.id), cur = store.getBody(n) ?? '';
  if (!vs.length) { toast('Pas encore d’historique pour cette note.'); return; }
  const m = modal({ cls: 'history', html: `<aside class="hist-list"><h3>Historique</h3><div class="hist-scroll">${vs.map((v, i) => `<button class="hist-item" data-i="${i}"><strong>${esc(full(v.ts))}</strong><span>${v.body === cur && v.title === n.title ? 'Version actuelle' : esc(rel(v.ts))}</span></button>`).join('')}</div></aside><section class="hist-main"><header class="hist-head"></header><div class="diff"></div></section>` });
  const show = (i: number) => {
    const v = vs[i]; if (!v) return;
    const same = v.body === cur && v.title === n.title;
    $$('.hist-item', m.node).forEach((b, k) => b.classList.toggle('sel', k === i));
    const ops = diffLines(v.body ?? '', cur), add = ops.filter(o => o.t === '+').length, delc = ops.filter(o => o.t === '-').length;
    need('.hist-head', m.node).innerHTML = `<div><strong>${esc(v.title.trim() || 'Sans titre')}</strong><span>${same ? 'Identique à la note actuelle' : `Depuis cette version : <b class="add">+${add}</b> <b class="del">−${delc}</b> ligne${add + delc > 1 ? 's' : ''}`}</span></div><button class="btn btn-primary" ${same ? 'disabled' : ''}>Restaurer cette version</button><button class="icon-btn" data-close aria-label="Fermer">✕</button>`;
    need('.hist-head .btn', m.node).onclick = async () => { await store.restoreVersion(n, v); m.close(); renderMain(); toast('Version restaurée', { label: 'Historique', run: () => openHistory(n) }); };
    need('[data-close]', m.node).onclick = m.close;
    need('.diff', m.node).innerHTML = diffHtml(ops) + (v.title !== n.title ? `<div class="diff-note">Titre à cette date : « ${esc(v.title)} »</div>` : '');
  };
  need('.hist-list', m.node).addEventListener('click', e => { const b = target(e).closest('.hist-item'); if (b) show(num(b, 'i')); });
  need('.hist-list', m.node).addEventListener('keydown', e => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = $$('.hist-item', m.node), i = items.findIndex(b => b.classList.contains('sel')), k = Math.max(0, Math.min(items.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
    items[k]?.focus(); show(k);
  });
  const first = vs.length > 1 && vs[0]?.body === cur && vs[0]?.title === n.title ? 1 : 0;
  show(first); $$('.hist-item', m.node)[first]?.focus();
}

function diffHtml(ops: DiffOp[]): string {
  const out: string[] = [], row = (t: string, html: string) => out.push(`<div class="dl ${t === '+' ? 'add' : t === '-' ? 'del' : ''}"><i>${t === '=' ? '' : t === '-' ? '−' : '+'}</i><span>${html || '&nbsp;'}</span></div>`);
  let i = 0;
  while (i < ops.length) {
    if (ops[i].t === '=') {
      let j = i; while (j < ops.length && ops[j].t === '=') j++;
      const run = ops.slice(i, j);
      if (run.length > 8) { run.slice(0, i ? 3 : 0).forEach((o: DiffOp) => row('=', esc(o.s))); out.push(`<div class="dl skip"><span>⋯ ${run.length - (i ? 3 : 0) - (j < ops.length ? 3 : 0)} lignes identiques</span></div>`); if (j < ops.length) run.slice(-3).forEach((o: DiffOp) => row('=', esc(o.s))); }
      else run.forEach((o: DiffOp) => row('=', esc(o.s)));
      i = j; continue;
    }
    let j = i; const dels: string[] = [], adds: string[] = [];
    while (j < ops.length && ops[j].t !== '=') { (ops[j].t === '-' ? dels : adds).push(ops[j].s); j++; }
    if (dels.length === adds.length) { // lignes modifiées : diff mot à mot
      dels.forEach((d, k) => {
        const w = diffWords(d, adds[k]);
        row('-', w.filter(o => o.t !== '+').map(o => o.t === '-' ? `<mark>${esc(o.s)}</mark>` : esc(o.s)).join(''));
        row('+', w.filter(o => o.t !== '-').map(o => o.t === '+' ? `<mark>${esc(o.s)}</mark>` : esc(o.s)).join(''));
      });
    } else { dels.forEach(s => row('-', esc(s))); adds.forEach(s => row('+', esc(s))); }
    i = j;
  }
  return out.join('');
}

// ---------- Capture rapide ----------
function parseCapture(text: string): { title: string; body: string; tags: string[]; isTodo: boolean } {
  const lines = text.trim().split('\n'), tags = [...new Set([...text.matchAll(/(^|\s)#([\p{L}\d][\p{L}\d_/-]*)/gu)].map(m => (m[2] ?? '').toLowerCase()).filter(t => !/^\d+$/.test(t)))];
  const strip = (s: string) => s.replace(/(^|\s)#[\p{L}\d][\p{L}\d_/-]*/gu, ' ').replace(/\s+/g, ' ').trim();
  const head = lines[0] ?? '', first = strip(head), rest = lines.slice(1).join('\n').trim();
  const headTags = [...head.matchAll(/(^|\s)(#[\p{L}\d][\p{L}\d_/-]*)/gu)].map(m => m[2]).join(' ');
  const isTodo = tags.includes('todo');
  const title = (first || rest.split('\n')[0] || 'Capture').slice(0, 80);
  const body = [isTodo ? `- [ ] ${first || title}` : '', rest, headTags].filter(Boolean).join('\n\n');
  return { title, body, tags, isTodo };
}
function openCapture(): void {
  if ($('.capture')) { closeTop(); return; }
  const m = modal({ cls: 'capture', html: `<div class="cap-head">${icon('bolt')}<span>Capture rapide</span></div><textarea rows="1" placeholder="Une idée, une tâche, une info…  #idée  #todo" aria-label="Capture rapide" autofocus></textarea><div class="cap-foot"><span class="cap-dest"></span><span class="cap-hints">${kbd('enter')} ranger · ${kbd('mod+enter')} ranger et ouvrir</span></div>` });
  const ta = need<HTMLTextAreaElement>('textarea', m.node), dest = need('.cap-dest', m.node);
  const update = () => {
    ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 240) + 'px';
    const { tags, isTodo } = parseCapture(ta.value || ' ');
    dest.innerHTML = tags.length ? `${icon('hash')}Rangée dans ${tags.map(t => `<b>#${esc(t)}</b>`).join(' ')}${isTodo ? ' · ajoutée à la liste Tâches' : ''}` : `${icon('inbox')}Ira dans la boîte de réception`;
  };
  ta.addEventListener('input', update); update();
  ta.addEventListener('keydown', async e => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
    e.preventDefault(); if (!ta.value.trim()) return;
    const open = e.metaKey || e.ctrlKey, c = parseCapture(ta.value);
    if (c.isTodo && !ta.value.trim().includes('\n')) { m.close(); await captureTodo(ta.value); if (open) void setView({ type: 'tasks' }); return; }
    const n = await store.createNote({ title: c.title, body: c.body, inbox: !c.tags.length });
  announceCapture(n);
    m.close();
    if (open) openNote(n.id);
    else toast(c.tags.length ? `Rangée dans ${c.tags.map(t => '#' + t).join(' ')}` : 'Ajoutée à la boîte de réception', { label: 'Ouvrir', run: () => openNote(n.id) });
  });
}

// ---------- Palette de commandes ----------
function commands() {
  const n = store.get(ui.id), live = n && !n.deletedAt, open = live && !store.isLocked(n);
  const c = (label: string, ic: string, run: () => unknown, combo: string, kw = '') => ({ label, icon: ic, run, keys: combo, kw });
  return [
    c('Nouvelle note', 'compose', () => newNote(), SC.newNote, 'créer ajouter'),
    c('Capture rapide', 'bolt', openCapture, SC.capture, 'inbox idée todo'),
    c('Aujourd’hui', 'today', () => setView({ type: 'today' }), SC.today, 'note du jour quotidienne daily'),
    c('Tâches', 'check', () => setView({ type: 'tasks' }), SC.tasks, 'todo liste à faire'),
    c('Linear : mes tickets', 'linear', () => setView({ type: 'linear', tab: 'issues' }), SC.notifs, 'linear issues tickets'),
    c('Linear : projets', 'linear', () => setView({ type: 'linear', tab: 'projects' }), '', 'linear projects roadmap'),
    c('Linear : notifications', 'bell', () => setView({ type: 'linear', tab: 'notifs' }), '', 'linear boîte inbox mentions'),
    c('GitHub : actualité des dépôts', 'github', () => setView({ type: 'github' }), '', 'github repos commits pull requests'),
    ...(voice.available() ? [c('Note vocale', 'mic', () => voice.record(), '', 'dictée micro voix enregistrer')] : []),
    c('Ajouter une tâche', 'plus', async () => { await setView({ type: 'tasks' }); }, '', 'todo nouvelle tâche'),
    c('Notes', 'notes', () => setView({ type: 'all' }), '', 'liste toutes'),
    c('Boîte de réception', 'inbox', () => setView({ type: 'inbox' }), '', 'inbox'),
    c('Accueil', 'home', () => setView({ type: 'home' }), '', 'widgets tableau de bord dashboard'),
    c('Demander à l’IA', 'sparkle', () => hub.askAI(), SC.ask, 'claude chatgpt openai assistant question'),
    c('Automatisations', 'bot', () => setView({ type: 'agents' }), '', 'agents ia automatiser routine planifier déclencheur'),
    c('Nouvelle automatisation', 'bot', () => setView({ type: 'agents' }), '', 'créer agent modèle planifier'),
    c('Réglages : sécurité et chiffrement', 'shield', () => hub.openConnections('coffre'), '', 'sécurité mot de passe face id touch id passkey'),
    c('Réglages : intelligence artificielle', 'sparkle', () => hub.openConnections('ia'), '', 'clé api anthropic chatgpt ollama'),
    c('Réglages : Linear', 'linear', () => hub.openConnections('linear'), '', 'issues tickets'),
    c('Lier un téléphone ou un ordinateur', 'phone', () => hub.openConnections('appareils'), '', 'appareils synchronisation iphone mac qr'),
    c('Synchroniser maintenant', 'refresh', () => { link.syncNow(); toast('Recherche des appareils…'); }, '', 'appareils sync'),
    ...(vault.isOpen() ? [c('Verrouiller le coffre', 'lock', async () => { await flushAll(); try { sessionStorage.setItem('studio.manualLock', '1'); } catch { /* ignoré */ } vault.lock(); }, '', 'sécurité fermer')] : []),
    c('Graphe des notes', 'graph', () => setView({ type: 'graph' }), SC.graph, 'liens carte'),
    c('Corbeille', 'trash', () => setView({ type: 'trash' }), '', 'supprimées'),
    ...(open ? [
      c('Mode focus', 'focus', () => setFocus(!focusMode), SC.focus, 'zen concentration plein écran'),
      c('Mode : écrire', 'pencil', () => setMode('edit'), '', 'édition éditeur'),
      c('Mode : côte à côte', 'split', () => setMode('split'), '', 'split aperçu'),
      c('Mode : lire', 'eye', () => setMode('read'), '', 'lecture aperçu preview'),
      c('Historique des versions', 'history', () => openHistory(n), SC.history, 'diff restaurer version'),
      c('Exporter cette note en Markdown', 'download', () => exportNote(n), '', 'md télécharger'),
      c('Insérer un agent', 'bot', () => insertBlock(hub.AGENT_TEMPLATE), '', 'bloc automatisation'),
      c('Insérer un schéma de base de données', 'db', () => insertBlock(hub.SCHEMA_TEMPLATE), '', 'sql erd tables diagramme'),
      c('Insérer une liste Linear', 'linear', () => insertBlock('```linear\nassigné: moi\nétat: en cours, à faire\nlimite: 10\n```\n'), '', 'issues'),
      c('Linear : créer une issue depuis la sélection', 'linear', hub.issueFromSelection, '', 'ticket tâche'),
    ] : []),
    ...(live ? [
      c(n.pinned ? 'Désépingler la note' : 'Épingler la note', 'pin', () => togglePin(n), '', 'pin favori'),
      c(n.expiresAt ? 'Modifier l’autodestruction' : 'Rendre la note éphémère', 'hourglass', () => { const a = $('[data-act=more]'); if (a) expireMenu(a, n); }, '', 'éphémère expiration autodestruction date'),
      n.enc ? c(store.isLocked(n) ? 'Déverrouiller la note' : 'Verrouiller la note', 'lock', () => lockAction(n), SC.lock, 'chiffrement mot de passe')
        : c('Chiffrer la note', 'lock', () => encryptDialog(n), '', 'mot de passe chiffrement sécurité'),
      c('Placer la note dans la corbeille', 'trash', () => trash(n), '', 'supprimer effacer'),
    ] : []),
    c('Verrouiller toutes les notes chiffrées', 'lock', async () => { await flushAll(); toast(`${store.lockAll()} note(s) verrouillée(s)`); }, '', 'sécurité'),
    c('Exporter tout en JSON (sauvegarde complète)', 'download', exportJSON, '', 'backup sauvegarde'),
    c('Exporter tout en Markdown (.zip)', 'download', exportZip, '', 'archive md'),
    c('Importer des fichiers (Markdown ou JSON)', 'upload', () => need('#file').click(), '', 'import restaurer'),
    c('Thème : automatique', 'today', () => setTheme('auto'), '', 'apparence système'),
    c('Thème : clair', 'today', () => setTheme('light'), '', 'apparence light'),
    c('Thème : sombre', 'moon', () => setTheme('dark'), '', 'apparence dark nuit'),
    c('Afficher ou masquer la barre latérale', 'sidebar', toggleSidebar, SC.sidebar, 'sidebar'),
    c('Aide et raccourcis', 'help', openHelp, '?', 'aide help prise en main débuter comment'),
    c('Réglages', 'gear', () => hub.openConnections('coffre'), SC.settings, 'préférences paramètres options'),
  ];
}
function setTheme(t: string) { ui.theme = t; saveUI(); applyTheme(); }

const hl = (text: string, pos: number[]) => { const set = new Set(pos); let out = ''; [...text.normalize('NFC')].forEach((ch, i) => { out += set.has(i) ? `<b>${esc(ch)}</b>` : esc(ch); }); return out; };

function paletteResults(raw: string): PaletteSection[] {
  const cmdOnly = raw.startsWith('>'), tagOnly = raw.startsWith('#');
  const q = raw.replace(/^[>#]/, '').trim(), out: PaletteSection[] = [];
  const idx = store.index();
  if (tagOnly) {
    const tags = [...idx.tags].flatMap(([t, c]) => { const f = fuzzy(q, t); return f ? [{ t, c, f }] : []; }).sort((a, b) => b.f.score - a.f.score);
    return [{ label: 'Tags', items: tags.map(x => ({ icon: 'hash', title: hl(x.t, x.f.pos), sub: `${x.c} note${x.c > 1 ? 's' : ''}`, run: () => setView({ type: 'tag', tag: x.t }) })) }];
  }
  let notes: PaletteItem[] = [];
  if (!cmdOnly) {
    const fq = fold(q), words = fq.split(/\s+/).filter(Boolean);
    for (const n of idx.live) {
      const t = titleOf(n), f = q ? fuzzy(q, t) : { score: 0, pos: [] }, body = store.getBody(n);
      let score = f ? f.score * 2 : -Infinity, sub = store.isLocked(n) ? 'Note chiffrée' : store.meta(n).snippet;
      if (q && body) {
        const fb = fold(body);
        if (words.every(w => fb.includes(w))) {
          const at = fb.indexOf(words[0]), s = Math.max(0, at - 30), nb = body.normalize('NFC');
          const frag = nb.slice(s, at + 90).replace(/\n/g, ' ');
          sub = (s ? '…' : '') + hl(frag, Array.from({ length: words[0].length }, (_, i) => at - s + i));
          score = Math.max(score, 150);
        } else sub = esc(sub);
      } else sub = esc(sub);
      if (score === -Infinity) continue;
      notes.push({ score: score + (q ? 0 : n.updated / 1e10), icon: n.enc ? 'lock' : n.daily ? 'today' : 'notes', title: hl(t, f ? f.pos : []), sub, hint: rel(n.updated), run: () => openNote(n.id) });
    }
    notes.sort((a, b) => (b.score ?? 0) - (a.score ?? 0)); notes = notes.slice(0, q ? 8 : 5);
  }
  const found = commands().flatMap(c => { const f = q ? (fuzzy(q, c.label) || (fuzzy(q, c.kw) && { score: 40, pos: [] as number[] })) : { score: 0, pos: [] as number[] }; return f && (!q || f.score > 0 || f.pos.length) ? [{ c, f }] : []; });
  if (q) found.sort((a, b) => b.f.score - a.f.score);
  const cmds: PaletteItem[] = found.slice(0, q ? 7 : 40).map(x => ({ score: x.f.score, icon: x.c.icon, title: hl(x.c.label, x.f.pos), keys: x.c.keys, run: x.c.run }));
  const sn = { label: q ? 'Notes' : 'Récentes', items: notes }, sc = { label: 'Commandes', items: cmds };
  if (q && (cmds[0]?.score ?? -Infinity) > (notes[0]?.score ?? -Infinity) && notes.length) out.push(sc, sn); else out.push(sn, sc);
  if (q && !cmdOnly && !store.findByTitle(q)) out.push({ label: 'Créer', items: [{ icon: 'plus', title: `Créer la note « ${esc(q)} »`, run: () => newNote({ title: q }) }] });
  return out.filter(s => s.items.length);
}

function openPalette(prefill = ''): void {
  onboarding.mark('palette');
  if ($('.palette')) { closeTop(); return; }
  const m = modal({ cls: 'palette', html: `<div class="pal-input">${icon('search')}<input type="text" placeholder="Rechercher une note, lancer une commande…" aria-label="Palette de commandes" autocomplete="off" spellcheck="false" autofocus></div><div class="pal-list" role="listbox"></div><div class="pal-foot"><span>${kbd('enter')} ouvrir</span><span><kbd>↑</kbd><kbd>↓</kbd> naviguer</span><span><kbd>&gt;</kbd> commandes</span><span><kbd>#</kbd> tags</span><span>${kbd('esc')} fermer</span></div>` });
  const input = need<HTMLInputElement>('input', m.node), list = need('.pal-list', m.node);
  let flat: PaletteItem[] = [], sel = 0;
  const paint = () => { $$('.pal-item', list).forEach((b, i) => { b.classList.toggle('sel', i === sel); if (i === sel) b.scrollIntoView({ block: 'nearest' }); }); };
  const update = () => {
    const secs = paletteResults(input.value); flat = secs.flatMap(s => s.items); sel = 0; let i = 0;
    list.innerHTML = flat.length ? secs.map(s => `<div class="pal-label">${s.label}</div>${s.items.map(it => `<button class="pal-item" data-i="${i++}" role="option" tabindex="-1">${icon(it.icon)}<span class="pal-main"><span class="pal-title">${it.title}</span>${it.sub ? `<span class="pal-sub">${it.sub}</span>` : ''}</span>${it.hint ? `<span class="pal-hint">${esc(it.hint)}</span>` : ''}${kbd(it.keys)}</button>`).join('')}`).join('') : `<div class="pal-empty">Aucun résultat</div>`;
    list.scrollTop = 0; paint();
  };
  const run = (i: number) => { const it = flat[i]; if (!it) return; m.close(); void it.run(); };
  input.value = prefill; input.addEventListener('input', update); update();
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) { e.preventDefault(); sel = (sel + 1) % (flat.length || 1); paint(); }
    else if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) { e.preventDefault(); sel = (sel - 1 + flat.length) % (flat.length || 1); paint(); }
    else if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); run(sel); }
  });
  list.addEventListener('mousemove', e => { const b = target(e).closest('.pal-item'); if (b && num(b, 'i') !== sel) { sel = num(b, 'i'); $$('.pal-item', list).forEach((x, i) => x.classList.toggle('sel', i === sel)); } });
  list.addEventListener('mousedown', e => e.preventDefault());
  list.addEventListener('click', e => { const b = target(e).closest('.pal-item'); if (b) run(num(b, 'i')); });
}

/** Tous les raccourcis, pour la page d'aide. */
function shortcutRows(): [string, string][] {
  return [['Palette de commandes', SC.palette], ['Capture rapide', SC.capture], ['Nouvelle note', SC.newNote], ['Aujourd’hui', SC.today], ['Changer de mode (écrire, côte à côte, lire)', SC.mode], ['Mode focus', SC.focus], ['Graphe', SC.graph], ['Historique', SC.history], ['Verrouiller la note chiffrée', SC.lock], ['Barre latérale', SC.sidebar], ['Réglages', SC.settings], ['Tâches', SC.tasks], ['Linear', SC.notifs], ['Demander à l’IA', SC.ask], ['Créer ou cocher une tâche', SC.task], ['Gras / italique', SC.bold], ['Indenter / désindenter', 'tab'], ['Aide et raccourcis', '?']];
}
function openHelp(): void { void setView({ type: 'help' }); }

// ---------- Import / export ----------
const stamp = () => store.dayKey();
async function exportJSON() {
  await flushAll();
  const json = await hub.sealBackup(await store.exportJSON()); if (!json) return;
  download(`carnet-${stamp()}.json`, new Blob([json], { type: 'application/json' }));
  toast(vault.enabled() ? 'Sauvegarde chiffrée téléchargée' : 'Sauvegarde JSON téléchargée');
}
async function exportZip() {
  await flushAll();
  const { files, skipped } = store.markdownFiles();
  if (!files.length) return toast('Aucune note à exporter.');
  if (vault.enabled() && !await confirmBox({ title: 'Exporter en clair ?', text: 'Le coffre est actif, mais un export Markdown est lisible par n’importe qui. Pour une sauvegarde chiffrée, utilise l’export JSON.', ok: 'Exporter en clair' })) return;
  download(`carnet-${stamp()}.zip`, zip(files));
  toast(`${files.length} note${files.length > 1 ? 's' : ''} exportée${files.length > 1 ? 's' : ''}${skipped ? ` — ${skipped} chiffrée${skipped > 1 ? 's' : ''} ignorée${skipped > 1 ? 's' : ''} (présentes dans l’export JSON)` : ''}`);
}
async function exportNote(n: Note) { await flush(n.id); download(store.markdownName(n), new Blob([store.toMarkdown(n)], { type: 'text/markdown;charset=utf-8' })); }
async function importFiles(files: File[] | FileList) {
  let notes = 0, last = null; const errors = [];
  for (const f of files) {
    try {
      const text = await f.text();
      if (/\.json$/i.test(f.name)) notes += await store.importJSON(await hub.openBackup(text));
      else if (/\.carnet$/i.test(f.name)) await hub.importPacket(text);
      else if (/\.(md|markdown|txt)$/i.test(f.name)) { last = await store.importMarkdown(f.name, text); notes++; }
      else errors.push(f.name);
    } catch (e) { errors.push(`${f.name} (${errMsg(e)})`); }
  }
  if (last) openNote(last.id); else render();
  toast(`${notes} note${notes > 1 ? 's' : ''} importée${notes > 1 ? 's' : ''}${errors.length ? ` · non importé : ${errors.join(', ')}` : ''}`);
}

// ---------- Graphe ----------
function mountGraph(main: HTMLElement): void {
  const idx = store.index(), nodes: GraphInput[] = idx.live.map(n => ({ id: n.id, title: titleOf(n) })), edges: { a: string; b: string }[] = [], ghosts = new Map<string, string>(), seen = new Set<string>();
  for (const n of idx.live) for (const l of store.meta(n).links) {
    let id = idx.byTitle.get(fold(l));
    if (!id) { id = 'ghost:' + fold(l); if (!ghosts.has(id)) { ghosts.set(id, l); nodes.push({ id, title: l, ghost: true }); } }
    const k = [n.id, id].sort().join('|');
    if (id !== n.id && !seen.has(k)) { seen.add(k); edges.push({ a: n.id, b: id }); }
  }
  main.innerHTML = `<header class="toolbar">${tbLeft()}${crumb('Graphe')}<div class="tb-side tb-right"></div></header>
    <div class="graph-wrap"><canvas aria-label="Graphe des liens entre notes"></canvas>
      <div class="graph-info">${idx.live.length} note${idx.live.length > 1 ? 's' : ''} · ${edges.length} lien${edges.length > 1 ? 's' : ''}${ghosts.size ? ` · ${ghosts.size} à créer` : ''}</div>
      <div class="graph-ctl"><button data-z="0.8" aria-label="Dézoomer">−</button><button data-z="0" aria-label="Recentrer">⌖</button><button data-z="1.25" aria-label="Zoomer">+</button></div>
      ${nodes.length ? '' : '<div class="empty"><div class="empty-card"><h3>Rien à relier pour l’instant</h3><p>Écris <code>[[Titre d’une note]]</code> pour créer un lien.</p></div></div>'}
    </div>`;
  const g = createGraph(need<HTMLCanvasElement>('canvas', main), { nodes, edges, currentId: ui.id, onOpen: node => void (node.ghost ? openByTitle(node.title) : openNote(node.id)) });
  graph = g;
  need('.graph-ctl', main).addEventListener('click', e => { const z = target(e).dataset.z; if (z === '0') g.reset(); else if (z) g.zoom(Number(z)); });
}

// ---------- Rendu global et événements ----------
function render() {
  document.body.classList.toggle('no-side', !ui.side); document.body.classList.toggle('side-open', ui.side);
  document.body.dataset.v = ui.view.type;
  document.body.classList.toggle('no-list', WIDE.has(ui.view.type));
  renderSidebar(); renderList(); renderMain();
}

store.onChange((kind, id, remote) => {
  if (ui.id && !store.notes.has(ui.id)) { ui.id = null; saveUI(); }
  renderSidebar(); renderList();
  if (ui.view.type === 'home' && !topLayer() && !need('#main').contains(document.activeElement)) return renderMain();
  if (ui.view.type === 'tasks') return todo.refresh();
  const typing = ed && document.activeElement && need('#main').contains(document.activeElement) && !remote;
  if (['lock', 'unlock', 'destroy', 'purge', 'import'].includes(kind) || (remote && (!id || id === ui.id) && !pending.has(ui.id))) renderMain();
  else if (kind === 'save' && ed && id !== ed.note.id && !typing) renderPreview();
  else if (kind === 'save' && ed && id !== ed.note.id) schedulePreview();
});

// Clics délégués : une seule écoute pour toute l'application.
async function onClick(e: MouseEvent): Promise<void> {
  const t = target(e);
  const anchor = t.closest('[data-act]'), act = anchor?.dataset.act, n = store.get(ui.id);
  if (anchor && act) {
    if (act === 'new') { await newNote(); return; }
    if (act === 'workspace') { workspaceMenu(anchor); return; }
    if (act === 'tags') { ui.tagsOpen = !ui.tagsOpen; saveUI(); renderSidebar(); return; }
    if (act === 'palette') { openPalette(); return; }
    if (act === 'capture') { openCapture(); return; }
    if (act === 'voice') { voice.record(); return; }
    if (act === 'sidebar') { toggleSidebar(); return; }
    if (act === 'back') { document.body.classList.remove('pane-main'); return; }
    if (!n) return;
    if (act === 'more') moreMenu(anchor, n);
    else if (act === 'expire') expireMenu(anchor, n);
    else if (act === 'lock') await lockAction(n);
    else if (act === 'history') await openHistory(n);
    else if (act === 'ask') hub.askAI();
    else if (act === 'focus') setFocus(!focusMode);
    else if (act === 'restore') { await store.restoreNote(n); await openNote(n.id); }
    else if (act === 'destroy') await destroy(n);
    else if (act === 'backlinks') menu(anchor, [{ label: 'Rétroliens' }, ...store.backlinks(n).map(b => ({ label: titleOf(b), icon: 'notes', run: () => openNote(b.id) }))]);
    return;
  }
  if (await hub.click(e)) return;
  let x: HTMLElement | null;
  if ((x = t.closest('[data-view]'))) { await setView({ type: x.dataset.view ?? 'home' }); return; }
  if ((x = t.closest('[data-open-note]')) && store.get(x.dataset.openNote)) { await openNote(x.dataset.openNote ?? ''); return; }
  if ((x = t.closest('[data-tag]'))) { e.preventDefault(); await setView({ type: 'tag', tag: x.dataset.tag ?? '' }); return; }
  if ((x = t.closest('.seg [data-mode]'))) { const m = x.dataset.mode; if (m === 'edit' || m === 'split' || m === 'read') setMode(m); return; }
  if ((x = t.closest('#list [data-id], .backlink[data-id]'))) { await openNote(x.dataset.id ?? ''); return; }
  if ((x = t.closest('.wikilink'))) { e.preventDefault(); await openByTitle(x.dataset.link ?? ''); return; }
  const E = ed; if (!E?.preview || !E.preview.contains(t)) return;
  if ((x = t.closest('.calc[data-copy]'))) { const v = x.dataset.copy ?? ''; await navigator.clipboard?.writeText(v); toast(`Résultat copié : ${v}`); return; }
  const timer = t.closest('.timer'); if (timer && t.closest('button')) { toggleTimer(timer, !!t.closest('.timer-reset')); return; }
  const th = t.closest<HTMLTableCellElement>('table.sortable th'), table = th?.closest<HTMLTableElement>('table');
  if (th && table) {
    const i = $$('table.sortable', E.preview).indexOf(table), col = th.cellIndex;
    const dir = th.getAttribute('aria-sort') === 'ascending' ? -1 : 1;
    E.sorts.set(i, { col, dir }); sortTable(table, col, dir);
  }
}
document.addEventListener('click', e => { onClick(e).catch(err => { console.error(err); toast(errMsg(err)); }); });

document.addEventListener('change', e => {
  const t = target(e);
  if (t.matches('.md input[type=checkbox][data-line]') && ed) void toggleTask(ed.note, num(t, 'line'));
  else if (t.matches('.tg-task input')) { const n = store.get(t.dataset.note); if (n) void toggleTask(n, num(t, 'line')); }
  else if (t instanceof HTMLInputElement && t.id === 'file' && t.files) { void importFiles([...t.files]); t.value = ''; }
});

document.addEventListener('contextmenu', e => {
  const item = target(e).closest('#list .note-item[data-id]'); if (!item) return;
  const n = store.get(item.dataset.id); if (!n) return;
  e.preventDefault(); moreMenu({ x: e.clientX, y: e.clientY }, n);
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (closeAc()) return e.preventDefault();
    if (closeTop()) return e.preventDefault();
    if (focusMode) return setFocus(false);
    if (document.body.classList.contains('side-open') && matchMedia('(max-width: 900px)').matches) return toggleSidebar();
    return;
  }
  if (matches(e, SC.palette) || (isMac && e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === 'k')) { e.preventDefault(); return openPalette(); }
  if (matches(e, SC.capture)) { e.preventDefault(); return openCapture(); }
  if (matches(e, SC.ask)) { e.preventDefault(); return hub.askAI(); }
  if (matches(e, SC.settings)) { e.preventDefault(); return hub.openConnections('coffre'); }
  if (matches(e, SC.tasks)) { e.preventDefault(); return setView({ type: 'tasks' }); }
  if (matches(e, SC.notifs)) { e.preventDefault(); return setView({ type: 'linear' }); }
  if (topLayer()) return;
  if (e.key === '?' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || (e.target instanceof HTMLElement && e.target.isContentEditable))) { e.preventDefault(); openHelp(); return; }
  const n = store.get(ui.id), open = n && !n.deletedAt && !store.isLocked(n);
  const on = (combo: string, fn: () => unknown): boolean => { if (!matches(e, combo)) return false; e.preventDefault(); void fn(); return true; };
  on(SC.newNote, () => newNote()) || on(SC.today, () => setView({ type: 'today' })) || on(SC.graph, () => setView({ type: 'graph' }))
    || on(SC.sidebar, toggleSidebar)
    || (open && (on(SC.mode, () => setMode(({ edit: 'split', split: 'read', read: 'edit' } as const)[ui.mode])) || on(SC.focus, () => setFocus(!focusMode)) || on(SC.history, () => openHistory(n))))
    || (n && n.enc && on(SC.lock, () => lockAction(n)));
});

// Fenêtre étroite : la barre latérale devient un volet, fermé par défaut
matchMedia('(max-width: 900px)').addEventListener('change', e => { ui.side = !e.matches; document.body.classList.toggle('no-side', !ui.side); document.body.classList.toggle('side-open', ui.side); });
// Glisser-déposer de fichiers .md / .json n'importe où dans la fenêtre
need('#scrim').addEventListener('click', () => { if (ui.side) toggleSidebar(); });
addEventListener('dragover', e => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
addEventListener('drop', e => { if (e.dataTransfer?.files.length) { e.preventDefault(); importFiles([...e.dataTransfer.files]); } });
document.addEventListener('visibilitychange', () => { if (document.hidden) flushAll(); });
addEventListener('pagehide', flushAll);

// ---------- Démarrage ----------
const SEED = [
  ['Bienvenue dans Studio', `Tes notes vivent **uniquement dans ce navigateur** : pas de compte, pas de serveur, et tout fonctionne hors ligne.

## L’essentiel en 30 secondes
- [ ] Ouvrir la palette avec \`${keys(SC.palette)}\` et taper quelques lettres
- [ ] Capturer une idée avec \`${keys(SC.capture)}\`, en ajoutant \`#idée\` ou \`#todo\`
- [ ] Suivre un lien : [[Blocs intelligents]]
- [x] Installer Studio (c’est déjà fait)

Les liens s’écrivent \`[[Titre de la note]]\`. Les notes qui pointent vers celle-ci apparaissent en bas, dans les rétroliens, et la vue **Graphe** dessine l’ensemble.

Pour tout le reste, voir [[Raccourcis et astuces]].

#carnet`],
  ['Blocs intelligents', `Le Markdown fait un peu plus que de la mise en forme.

## Calculs
Un loyer à 3 : \`= 1450 / 3\` par personne, soit \`= 1450 / 3 * 12\` par an.

= (120 + 80) * 1,2

## Minuteur
Une session de travail : [timer 25m] puis une pause : [timer 5m]

## Tableau triable
Clique sur un en-tête pour trier.

| Projet | Heures | Budget |
|--------|-------:|-------:|
| Refonte du site | 42 | 3 600 € |
| Application mobile | 118 | 12 400 € |
| Audit | 9 | 950 € |

## Tâches
- [ ] Une tâche à cocher ici ou depuis la vue Aujourd’hui
- [x] Une tâche terminée

Retour à [[Bienvenue dans Studio]].

#carnet`],
  ['Raccourcis et astuces', `- **Historique** : chaque note garde ses versions, avec comparaison visuelle et restauration.
- **Notes éphémères** : menu ⋯ puis « Rendre éphémère » pour une autodestruction à la date choisie.
- **Chiffrement** : le cadenas protège une note par mot de passe, chiffrée dans le navigateur.
- **Mode focus** : \`${keys(SC.focus)}\` masque tout sauf le texte.
- **Aujourd’hui** : une note par jour, et les tâches non cochées de toutes les autres notes.
- **Export** : depuis la palette, en Markdown (.zip) ou en JSON (sauvegarde complète).

Dans l’éditeur, \`${keys(SC.task)}\` crée ou coche une tâche, et taper \`[[\` propose les notes existantes.

Voir aussi [[Blocs intelligents]], [[IA, agents et schémas]] et [[Bienvenue dans Studio]].

#carnet`],
  ['IA, agents et schémas', `Commence par **Réglages** (menu Studio en haut à gauche, ou ⌘ virgule) → **Sécurité** : tout le carnet est alors chiffré, et tes clés API aussi.

## Schéma de base de données
Écris du SQL (\`CREATE TABLE…\`) dans un bloc \`sql\`, ou ce format court dans un bloc \`schema\`. Les tables se déplacent à la souris.

\`\`\`schema
users
  id uuid pk
  email text unique
  name text?

projects
  id uuid pk
  owner_id uuid > users.id
  title text

tasks
  id uuid pk
  project_id uuid > projects.id
  assignee_id uuid? > users.id
  done bool default=false
\`\`\`

## Agent
Un agent est une consigne que l’IA exécute avec des outils (notes, Linear, autres agents). Toute modification te sera soumise.

\`\`\`agent
nom: Revue du matin
outils: notes, linear
sortie: journal
planning: jours ouvrés 9h
---
Liste mes tâches ouvertes les plus urgentes, puis propose les 3 priorités du jour sous forme de cases à cocher.
\`\`\`

## Linear
\`\`\`linear
assigné: moi
état: en cours, à faire
limite: 8
\`\`\`

Les notes chiffrées et celles taguées \`#privé\` ne sont jamais envoyées à une IA.

#carnet`],
];

// Points d'entrée pour l'app native (menu Réglages, enregistrement avant de quitter).
window.carnet = { flush: async () => { await flushAll(); }, settings: () => hub.openConnections('coffre'), voice: (p: unknown) => voice.onNative(p), bio: (p: unknown) => biometric.onNative(p as biometric.BioReply) };

async function start() {
  applyTheme();
  if (!VIEWS[ui.view?.type] && ui.view?.type !== 'tag') ui.view = { type: 'home' };
  await hub.gate(); // coffre : rien n'est lu avant le déverrouillage
  const gone = await store.init();
  todo.init({ flush, refreshNote, toggleTask, tbLeft, crumb });
  const shared = { setView, openNote, capture: quickCapture, view: () => ui.view.type, viewState: () => ui.view, renderSidebar, tbLeft, crumb,
    onCount: () => { renderSidebar(); linearView.refreshCount(); if (ui.view.type === 'home' && !topLayer() && !need('#main').contains(document.activeElement)) renderMain(); } };
  home.init(shared); automations.init(shared); help.init({ ...shared, shortcuts: shortcutRows }); voice.init(shared); linearView.init(shared); githubPage.init(shared);

  hub.init({
    openNote, setView, renderMain, flush, flushAll, refreshNote, capture: quickCapture, crumb,
    theme: () => ui.theme, setTheme, exportJSON, exportZip, pickFiles: () => need('#file').click(), openHelp,
    refreshPreview: () => renderPreview(), current: () => store.get(ui.id), view: () => ui.view.type, tbLeft,
    selection: () => { if (!ed?.ta) return null; const { selectionStart: a, selectionEnd: b, value: v } = ed.ta, [ls] = lineBounds(v, a), [, le] = lineBounds(v, b); return { text: a === b ? v.slice(ls, le) : v.slice(a, b), end: le }; },
    insertAtLineEnd: (pos, text) => { if (ed?.ta) replaceRange(ed.ta, pos, pos, text); },
  });
  if (!store.notes.size && !read('carnet.seeded', false)) {
    const t = Date.now();
    for (const [i, [title, body]] of SEED.entries()) await store.createNote({ title, body, created: t - i * 1000, updated: t - i * 1000, pinned: i === 0 });
    write('carnet.seeded', true);
    ui.id = store.findByTitle(SEED[0]?.[0] ?? '')?.id ?? null;
  }
  if (ui.view.type === 'tag' && !store.index().tags.has(ui.view.tag ?? '')) ui.view = { type: 'all' };
  if (ui.view.type === 'today') ui.id = (await store.dailyNote()).id;
  if (!store.get(ui.id)) ui.id = WIDE.has(ui.view.type) ? null : viewNotes()[0]?.id ?? null;
  if (matchMedia('(max-width: 900px)').matches) ui.side = false;
  render();
  notifs.init(shared); github.init(shared);
  if (voice.available()) document.body.insertAdjacentHTML('beforeend', `<button class="fab-mic" data-act="voice" aria-label="Note vocale">${icon('mic')}</button>`);
  for (const g of gone.filter(g => g.expired)) toast(`« ${g.title.trim() || 'Sans titre'} » s’est autodétruite`);
  const params = new URLSearchParams(location.search);
  if (params.has('capture')) openCapture(); else if (params.has('new')) newNote(); else if (params.has('today')) setView({ type: 'today' });
  if (params.size) history.replaceState(null, '', location.pathname);

  setInterval(tickTimers, 250);
  setInterval(async () => {
    const out = await store.purge();
    for (const g of out.filter(g => g.expired)) toast(`« ${g.title.trim() || 'Sans titre'} » s’est autodétruite`);
    if (!out.length && !topLayer()) { renderList(); const chip = $('.chip-warn'); const n = store.get(ui.id); if (chip?.lastChild && n?.expiresAt) chip.lastChild.textContent = until(n.expiresAt); }
  }, 30000);
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {});
}
start().catch(e => { console.error(e); document.body.insertAdjacentHTML('beforeend', `<div class="fatal">Studio n’a pas pu démarrer : ${esc(e.message)}.<br>Le stockage local du navigateur est peut-être désactivé (navigation privée ?).</div>`); });

// Build de test uniquement (retiré du build normal) : accès direct aux modules pour les tests automatisés.
if (__TEST__) Object.assign(window, { __studio: { store, vault, todo, notifs, hub, github, linear, link, biometric } });
