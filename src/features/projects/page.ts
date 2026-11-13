// Page Projets : la liste des projets, et le cockpit d'un projet — son dossier sur le Mac (VS Code, Finder,
// Terminal), ses tâches, ses notes, et les panneaux fournis par les plugins (GitHub, Linear…).
import * as store from '../../core/store.ts';
import * as native from '../../core/native.ts';
import * as github from '../../integrations/github/api.ts';
import * as linear from '../../integrations/linear/api.ts';
import * as registry from '../../plugins/registry.ts';
import * as todo from '../tasks.ts';
import * as model from './model.ts';
import { esc, plain } from '../../lib/markdown.ts';
import { $, icon, modal, need, rel, target, toast, errMsg } from '../../ui/kit.ts';
import type { AppShell, Note } from '../../types.ts';
import type { Project } from './model.ts';

let app!: AppShell;
export const init = (shell: AppShell): void => { app = shell; };

const titleOf = (n: Note) => n.title.trim() || 'Sans titre';
const go = (id: string | null) => app.setView({ type: 'projets', project: id });

// ---------- Dossier local (app Mac) ----------
interface Folder { path: string | null; name?: string; git?: boolean; branch?: string; ahead?: number; behind?: number; changes?: number; remote?: string }
const folders = new Map<string, Folder>();
async function folderOf(p: Project, fresh = false): Promise<Folder | null> {
  if (!native.available()) return null;
  if (!fresh && folders.has(p.id)) return folders.get(p.id) ?? null;
  const r = await native.call('project', 'info', { project: p.id }, 10000);
  const f: Folder = { path: typeof r.path === 'string' ? r.path : null, ...(r as Partial<Folder>) };
  folders.set(p.id, f);
  return f;
}
function folderHTML(p: Project, f: Folder | null): string {
  if (!native.available()) return `<p class="pj-folder muted">${icon('folder')}Le dossier du projet et VS Code s’ouvrent depuis l’app Studio pour Mac.</p>`;
  if (!f) return `<p class="pj-folder muted">${icon('folder')}Lecture du dossier…</p>`;
  if (!f.path) return `<div class="pj-folder">${icon('folder')}<span>Aucun dossier choisi sur ce Mac.</span><button class="btn btn-primary" data-pj="pick">Choisir le dossier</button></div>`;
  const git = f.git ? `<span class="pj-git">${icon('pr')}${esc(f.branch ?? '?')}${f.changes ? ` · <b>${f.changes} modif.</b>` : ' · à jour'}${f.ahead ? ` · ↑${f.ahead}` : ''}${f.behind ? ` · ↓${f.behind}` : ''}</span>` : '<span class="pj-git muted">pas un dépôt Git</span>';
  const hint = f.remote && !p.repos.includes(f.remote) ? `<button class="link-btn" data-pj="link-repo" data-repo="${esc(f.remote)}">Associer ${esc(f.remote)}</button>` : '';
  return `<div class="pj-folder">${icon('folder')}<code title="${esc(f.path)}">${esc(f.path.replace(/^\/Users\/[^/]+/, '~'))}</code>${git}${hint}
    <span class="pj-open"><button class="btn" data-pj="vscode">${icon('code')}VS Code</button><button class="btn" data-pj="finder">${icon('folder')}Finder</button><button class="btn" data-pj="terminal">${icon('terminal')}Terminal</button><button class="icon-btn" data-pj="pick" title="Changer de dossier" aria-label="Changer de dossier">${icon('more')}</button></span></div>`;
}

// ---------- Liste ----------
function listHTML(): string {
  const all = model.projects();
  if (!all.length) return `<div class="pj-empty"><h2>Un projet réunit tout ce qui le concerne</h2>
    <p>Son dossier sur ton Mac, son dépôt GitHub et ses PR, ses tickets Linear, ses tâches et ses notes. Tu y ouvres VS Code en un clic, et tu peux bientôt y confier une tâche à Claude Code.</p>
    <button class="btn btn-primary" data-pj="new">${icon('plus')}Créer un projet</button></div>`;
  return `<div class="pj-grid">${all.map(p => {
    const t = todo.ofProject(p.id), notes = model.notesOf(p).length - 1;
    return `<button class="pj-card" data-pj-open="${esc(p.id)}" style="--c:var(--c-${p.hue})"><span class="pj-dot"></span><strong>${esc(p.name)}</strong>
      <span class="pj-sub">${p.repos.length ? `${icon('github')}${esc(p.repos[0] ?? '')}${p.repos.length > 1 ? ` +${p.repos.length - 1}` : ''}` : 'Pas de dépôt'}${p.linear ? ` · ${icon('linear')}${esc(p.linear)}` : ''}</span>
      <span class="pj-stats"><b>${t.openCount}</b> tâche${t.openCount > 1 ? 's' : ''}${t.doing.length ? ` · ${t.doing.length} en cours` : ''} · <b>${notes}</b> note${notes > 1 ? 's' : ''}</span></button>`;
  }).join('')}<button class="pj-card pj-new" data-pj="new">${icon('plus')}<strong>Nouveau projet</strong></button></div>`;
}

// ---------- Cockpit d'un projet ----------
function taskRows(p: Project): string {
  const c = todo.ofProject(p.id), items = [...c.late, ...c.doing, ...c.today, ...c.soon, ...c.tickets, ...c.undated, ...c.notes].filter((t, i, a) => a.indexOf(t) === i).slice(0, 10);
  return `${items.length ? items.map(t => `<label class="tg-task hm-task"><input type="checkbox" data-note="${t.note.id}" data-line="${t.line}"${t.status === 'doing' ? ' class="doing"' : ''}><span>${esc(plain(t.text))}</span>${t.ticket ? `<em class="hm-ticket">${esc(t.ticket)}</em>` : ''}${t.due ? `<em class="td-due${t.due < store.dayKey() ? ' late' : ''}">${esc(todo.dueLabel(t.due))}</em>` : ''}</label>`).join('') : '<p class="hm-empty">Aucune tâche ouverte dans ce projet.</p>'}
    <button class="hm-more" data-pj="kanban">${c.openCount > items.length ? `${c.openCount - items.length} de plus · ` : ''}Ouvrir en Kanban</button>`;
}
const taskBox = (p: Project) => `<form class="td-add pj-add"><span class="td-plus">${icon('plus')}</span><input placeholder="Nouvelle tâche du projet, ex. « Corriger la synchro vendredi »" aria-label="Nouvelle tâche du projet" autocomplete="off"></form><div class="pj-tasklist">${taskRows(p)}</div>`;
function noteRows(p: Project): string {
  const notes = model.notesOf(p).filter(n => n.id !== p.id).slice(0, 8);
  return `${notes.length ? notes.map(n => `<button class="w-row" data-open-note="${n.id}">${icon('notes')}<span>${esc(titleOf(n))}</span><em>${esc(rel(n.updated))}</em></button>`).join('') : '<p class="hm-empty">Aucune note dans ce projet. Ajoute <code>#' + esc(p.tag) + '</code> à une note, ou crée-la d’ici.</p>'}
    <button class="hm-more" data-pj="new-note">${icon('plus')}Nouvelle note du projet</button>`;
}
const section = (id: string, title: string, ic: string, body: string, cls = '') => `<section class="pj-sec ${cls}" data-sec="${esc(id)}"><h2>${icon(ic)}${esc(title)}</h2><div class="pj-sec-body">${body}</div></section>`;

function detailHTML(p: Project): string {
  const panels = registry.projectPanels(p);
  return `<div class="pj-head" style="--c:var(--c-${p.hue})"><button class="lv-back" data-pj-open="">${icon('back')}Projets</button>
      <div class="pj-title"><span class="pj-dot"></span><h1>${esc(p.name)}</h1><button class="btn btn-ghost" data-pj="edit">Note du projet</button></div>
      <div class="pj-links">${p.repos.map(r => `<a class="lv-chip" href="https://github.com/${esc(r)}" target="_blank" rel="noopener">${icon('github')}${esc(r)}</a>`).join('')}${p.linear ? `<span class="lv-chip">${icon('linear')}${esc(p.linear)}</span>` : ''}<span class="lv-chip">#${esc(p.tag)}</span></div>
      <div class="pj-folder-box">${folderHTML(p, folders.get(p.id) ?? null)}</div></div>
    <div class="pj-cols"><div class="pj-col">${section('tasks', 'Tâches', 'check', taskBox(p))}${section('notes', 'Notes', 'notes', noteRows(p))}</div>
      <div class="pj-col">${panels.map(x => section(x.id, x.title, x.icon, '<p class="nf-empty">Chargement…</p>', 'pj-panel')).join('') || section('none', 'Connexions', 'plug', '<p class="hm-empty">Associe un dépôt GitHub ou un projet Linear dans la note du projet pour voir ici les PR, la CI et les tickets.</p>')}</div></div>`;
}

async function hydrate(root: HTMLElement, p: Project): Promise<void> {
  for (const x of registry.projectPanels(p)) {
    void Promise.resolve().then(() => x.render(p)).then(html => { const b = $(`[data-sec="${CSS.escape(x.id)}"] .pj-sec-body`, root); if (b) b.innerHTML = html; })
      .catch(e => { const b = $(`[data-sec="${CSS.escape(x.id)}"] .pj-sec-body`, root); if (b) b.innerHTML = `<p class="nf-empty">${esc(errMsg(e))}</p>`; });
  }
  const f = await folderOf(p);
  const box = $('.pj-folder-box', root); if (box && f) box.innerHTML = folderHTML(p, f);
}

// ---------- Création ----------
export async function createDialog(): Promise<void> {
  const m = modal({ title: 'Nouveau projet', cls: 'pj-create', html: `<form>
    <label class="pj-field"><span>Nom</span><input class="field" name="name" placeholder="Ex. Studio" required autofocus></label>
    <label class="pj-field"><span>Dépôt GitHub <em>facultatif</em></span><input class="field" name="repo" placeholder="propriétaire/dépôt" list="pj-repos" autocomplete="off"><datalist id="pj-repos"></datalist></label>
    <label class="pj-field"><span>Projet Linear <em>facultatif</em></span><input class="field" name="linear" placeholder="Nom du projet dans Linear" list="pj-linear" autocomplete="off"><datalist id="pj-linear"></datalist></label>
    <label class="pj-field"><span>En une phrase <em>facultatif</em></span><input class="field" name="desc" placeholder="Ce que ce projet doit accomplir"></label>
    ${native.available() ? '<p class="modal-hint">Tu choisiras ensuite son dossier sur ce Mac.</p>' : ''}
    <p class="lock-err" role="alert"></p>
    <div class="modal-actions"><button type="button" class="btn" data-x>Annuler</button><button class="btn btn-primary">Créer le projet</button></div></form>` });
  need('[data-x]', m.node).onclick = m.close;
  if (github.connected()) github.myRepos().then(rs => { const d = $('#pj-repos', m.node); if (d) d.innerHTML = rs.map(r => `<option value="${esc(r)}">`).join(''); }).catch(() => {});
  if (linear.connected()) linear.projects().then(ps => { const d = $('#pj-linear', m.node); if (d) d.innerHTML = ps.map(x => `<option value="${esc(x.name)}">`).join(''); }).catch(() => {});
  need('form', m.node).onsubmit = async e => {
    e.preventDefault();
    const f = target(e) as HTMLFormElement, val = (n: string) => (f.elements.namedItem(n) as HTMLInputElement | null)?.value.trim() ?? '';
    const name = val('name'), repo = val('repo').replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '');
    if (repo && !/^[\w.-]+\/[\w.-]+$/.test(repo)) { need('.lock-err', m.node).textContent = 'Le dépôt s’écrit « propriétaire/nom ».'; return; }
    if (model.projects().some(p => p.slug === model.slugify(name))) { need('.lock-err', m.node).textContent = 'Un projet porte déjà ce nom.'; return; }
    try {
      const p = await model.createProject({ name, repos: repo ? [repo] : [], linear: val('linear') || null, description: val('desc') });
      m.close();
      if (native.available()) { const r = await native.call('project', 'pick', { project: p.id }, 600000); if (r.ok) folders.delete(p.id); }
      await go(p.id);
      toast(`Projet « ${p.name} » créé`);
    } catch (x) { need('.lock-err', m.node).textContent = errMsg(x); }
  };
}

const label = (text: string) => { const s = $('[data-act=project] span'); if (s) s.textContent = text; };
/** Choisir le projet d'une note (menu depuis l'éditeur). */
export function projectMenuItems(n: Note): { label: string; icon?: string; run?: () => unknown; checked?: boolean }[] {
  const cur = model.projectOfNote(n), all = model.projects().filter(p => p.id !== n.id);
  return [{ label: 'Projet de la note' }, ...all.map(p => ({ label: p.name, checked: cur?.id === p.id, run: () => model.setNoteProject(n, p).then(() => { label(p.name); toast(`Rangée dans « ${p.name} »`); }) })),
    { label: 'Aucun projet', checked: !cur, run: () => model.setNoteProject(n, null).then(() => label('Projet')) }, { label: 'Nouveau projet…', icon: 'plus', run: () => createDialog() }];
}

// ---------- Page ----------
export function mount(main: HTMLElement): void {
  const p = model.byId(app.viewState().project);
  main.innerHTML = `<header class="toolbar">${app.tbLeft()}${app.crumb(p ? p.name : 'Projets')}<div class="tb-side tb-right">${p ? '' : `<button class="btn btn-ghost" data-pj="new">${icon('plus')}<span>Nouveau projet</span></button>`}</div></header>
    <div class="todo pj"><div class="todo-in pj-in">${p ? detailHTML(p) : `<div class="td-head"><h1>Projets</h1><p class="td-sub">Un projet réunit son dossier, son dépôt, ses PR, ses tickets, ses tâches et ses notes.</p></div><div class="pj-list">${listHTML()}</div>`}</div></div>`;
  const root = need('.pj', main);
  $('.toolbar [data-pj=new]', main)?.addEventListener('click', () => void createDialog());
  if (p) void hydrate(root, p);
  root.addEventListener('submit', async e => {
    const f = target(e).closest('.pj-add'); if (!f || !p) return;
    e.preventDefault();
    const i = need<HTMLInputElement>('input', f), v = i.value; if (!v.trim()) return;
    i.value = ''; await todo.add(v, p.id); refresh();
  });
  root.addEventListener('click', async e => {
    const t = target(e), open = t.closest('[data-pj-open]');
    if (open) { await go(open.dataset.pjOpen || null); return; }
    const issue = t.closest('.lv-row[data-issue]');
    if (issue) { void import('../../integrations/linear/page.ts').then(m => m.openTicket(issue.dataset.issue ?? '')); return; }
    const b = t.closest('[data-pj]'); if (!b) return;
    const act = b.dataset.pj;
    if (act === 'new') { void createDialog(); return; }
    if (!p) return;
    if (act === 'edit') app.openNote(p.id);
    if (act === 'kanban') { todo.showProject(p.id); await app.setView({ type: 'tasks' }); }
    if (act === 'new-note') { const n = await store.createNote({ title: '', body: `\n\n#${p.tag}` }); app.openNote(n.id); }
    if (act === 'pick') { const r = await native.call('project', 'pick', { project: p.id }, 600000); if (r.ok) { folders.delete(p.id); void hydrate(root, p); } }
    if (act === 'vscode' || act === 'finder' || act === 'terminal') { const r = await native.call('project', 'open', { project: p.id, app: act }, 15000); if (!r.ok) toast(r.message ?? 'Impossible d’ouvrir.'); }
    if (act === 'link-repo' && b.dataset.repo) await addRepo(p, b.dataset.repo);
  });
}

/** Ajoute un dépôt au bloc ```projet de la note du projet. */
async function addRepo(p: Project, repo: string): Promise<void> {
  const body = store.getBody(p.note); if (body == null) return;
  const repos = [...p.repos, repo].join(', ');
  const next = /^\s*d[ée]p[oô]ts?\s*:.*$/m.test(body) ? body.replace(/^(\s*)d[ée]p[oô]ts?\s*:.*$/m, `$1dépôts: ${repos}`) : body.replace(/^```projet[ \t]*\n/m, m => `${m}dépôts: ${repos}\n`);
  store.touch(p.note); store.setBody(p.note, next); p.note.updated = Date.now(); await store.saveNote(p.note);
  toast(`${repo} associé au projet`);
}

export function refresh(): void {
  const root = $('#main .pj'); if (!root) return;
  const p = model.byId(app.viewState().project);
  if (!p) { const l = $('.pj-list', root); if (l) l.innerHTML = listHTML(); return; }
  const tasks = $('.pj-tasklist', root), notes = $('[data-sec="notes"] .pj-sec-body', root);
  if (tasks) tasks.innerHTML = taskRows(p);
  if (notes) notes.innerHTML = noteRows(p);
}
