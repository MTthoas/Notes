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
import * as flux from './flux.ts';
import * as sessions from './sessions.ts';
import * as review from './review.ts';
import * as site from './site.ts';
import * as docker from './docker.ts';
import * as chart from '../../ui/chart.ts';
import * as bridge from '../../integrations/remote.ts';
import { shareable } from '../../integrations/ai.ts';

let app!: AppShell;
export const init = (shell: AppShell): void => {
  app = shell;
  // Une conversation Claude Code a été ouverte, renommée ou supprimée : la barre latérale et le fil d'Ariane suivent.
  sessions.onChange(() => {
    app.renderSidebar();
    const c = $('#main .toolbar .crumb');
    if (c && app.view() === 'projets') c.outerHTML = trailHTML();
  });
};

const titleOf = (n: Note) => n.title.trim() || 'Sans titre';
const go = (id: string | null, tab?: string) => app.setView({ type: 'projets', project: id, ...(tab ? { tab } : {}) });

// ---------- Dossier local (app Mac) ----------
interface Folder { path: string | null; name?: string; git?: boolean; branch?: string; ahead?: number; behind?: number; changes?: number; remote?: string }
const folders = new Map<string, Folder>();
async function folderOf(p: Project, fresh = false): Promise<Folder | null> {
  if (!bridge.local()) return null;
  if (!fresh && folders.has(p.id)) return folders.get(p.id) ?? null;
  const r = await native.call('project', 'info', { project: p.id }, 10000);
  const f: Folder = { path: typeof r.path === 'string' ? r.path : null, ...(r as Partial<Folder>) };
  folders.set(p.id, f);
  return f;
}
function folderHTML(p: Project, f: Folder | null): string {
  if (!bridge.local()) { const at = bridge.where(); return `<p class="pj-folder muted">${icon(at ? 'devices' : 'folder')}${at ? `Dossier et VS Code sur <strong>${esc(at.kind === 'remote' ? at.name : 'le Mac')}</strong> · Claude Code se pilote d’ici` : 'Le dossier du projet et VS Code s’ouvrent depuis l’app Studio pour Mac.'}</p>`; }
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
  const cc = bridge.where();
  return `${items.length ? items.map(t => `<div class="pj-row"><label class="tg-task hm-task"><input type="checkbox" data-note="${t.note.id}" data-line="${t.line}"${t.status === 'doing' ? ' class="doing"' : ''}><span>${esc(plain(t.text))}</span>${t.ticket ? `<em class="hm-ticket">${esc(t.ticket)}</em>` : ''}${t.due ? `<em class="td-due${t.due < store.dayKey() ? ' late' : ''}">${esc(todo.dueLabel(t.due))}</em>` : ''}</label>${cc ? `<button class="pj-cc" data-pj-cc-task="${esc(plain(t.text))}" title="Confier cette tâche à Claude Code">${icon('terminal')}Claude Code</button>` : ''}</div>`).join('') : '<p class="hm-empty">Aucune tâche ouverte dans ce projet.</p>'}
    <button class="hm-more" data-pj="kanban">${c.openCount > items.length ? `${c.openCount - items.length} de plus · ` : ''}Ouvrir en Kanban</button>`;
}
const taskBox = (p: Project) => `<form class="td-add pj-add"><span class="td-plus">${icon('plus')}</span><input placeholder="Nouvelle tâche du projet, ex. « Corriger la synchro vendredi »" aria-label="Nouvelle tâche du projet" autocomplete="off"></form><div class="pj-tasklist">${taskRows(p)}</div>`;
function noteRows(p: Project): string {
  const notes = model.notesOf(p).filter(n => n.id !== p.id).slice(0, 8);
  const cc = bridge.where();
  return `${notes.length ? notes.map(n => `<div class="pj-row"><button class="w-row" data-open-note="${n.id}">${icon('notes')}<span>${esc(titleOf(n))}</span><em>${esc(rel(n.updated))}</em></button>${cc && shareable(n) ? `<button class="pj-cc" data-pj-cc-note="${n.id}" title="Confier cette note à Claude Code">${icon('terminal')}Claude Code</button>` : ''}</div>`).join('') : '<p class="hm-empty">Aucune note dans ce projet. Ajoute <code>#' + esc(p.tag) + '</code> à une note, ou crée-la d’ici.</p>'}
    <button class="hm-more" data-pj="new-note">${icon('plus')}Nouvelle note du projet</button>`;
}
const section = (id: string, title: string, ic: string, body: string, cls = '') => `<section class="pj-sec ${cls}" data-sec="${esc(id)}"><h2>${icon(ic)}${esc(title)}</h2><div class="pj-sec-body">${body}</div></section>`;

/** Sous-menus d'un projet (aussi affichés dans la barre latérale). */
export const TABS: [string, string, string][] = [
  ['overview', 'Vue d’ensemble', 'home'], ['sessions', 'Claude Code', 'terminal'], ['code', 'Code', 'code'], ['flux', 'Flux', 'pr'], ['server', 'Serveur', 'server'], ['docker', 'Docker', 'box'],
  ['tasks', 'Tâches', 'check'], ['notes', 'Notes', 'notes'], ['site', 'Site', 'link'],
];
const curTab = (): string => { const t = app.viewState().tab; return t && TABS.some(x => x[0] === t) ? t : 'overview'; };
const panelsHTML = (p: Project, tab: string) => registry.projectPanels(p, tab).map(x => section(x.id, x.title, x.icon, '<p class="nf-empty">Chargement…</p>', 'pj-panel')).join('');
const card = (tab: string, title: string, ic: string, body: string) => `<button class="pj-ov" data-pj-tab="${tab}"><span class="pj-ov-h">${icon(ic)}${esc(title)}${icon('chevronRight')}</span><span class="pj-ov-b" data-ov="${tab}">${body}</span></button>`;

function siteHTML(p: Project): string {
  if (!p.site) return `<p class="hm-empty">Aucun site associé à ce projet.</p><form class="td-add pj-site-form"><span class="td-plus">${icon('link')}</span><input type="url" placeholder="https://studio.exemple.com" aria-label="Adresse du site" required></form>`;
  const host = p.site.replace(/^https:\/\//, '').replace(/\/$/, '');
  return `<div class="pj-site"><div class="pj-site-h"><span class="pj-site-dot" data-site-dot></span><a href="${esc(p.site)}" target="_blank" rel="noopener">${esc(host)}</a></div>
    <p class="pj-site-st" data-site-st>${native.available() ? 'Vérification…' : 'La vérification du site se fait depuis l’app Mac.'}</p>
    <div class="pj-site-act"><a class="btn btn-primary" href="${esc(p.site)}" target="_blank" rel="noopener">${icon('link')}Ouvrir le site</a>${native.available() ? `<button class="btn" data-pj="site-check">${icon('refresh')}Vérifier</button>` : ''}<button class="btn" data-pj="site-edit">Changer l’adresse</button></div></div>`;
}

function tabBody(p: Project, tab: string): string {
  const folderBox = `<div class="pj-folder-box">${folderHTML(p, folders.get(p.id) ?? null)}</div>`;
  if (tab === 'code') return `${folderBox}<div class="pj-review"><span>${icon('sparkle')}Revue IA</span><button class="btn" data-pj="review-working">Changements en cours</button><button class="btn" data-pj="review-branch">Branche actuelle</button></div>
    ${section('branches', 'Branches locales', 'pr', native.available() ? '<p class="nf-empty">Chargement…</p>' : '<p class="hm-empty">Visibles dans l’app Mac.</p>')}${panelsHTML(p, 'code')}`;
  if (tab === 'flux') return '<div class="pj-flux"><p class="nf-empty">Chargement du flux…</p></div>';
  if (tab === 'sessions') return '<div class="ss-box"></div>';
  if (tab === 'server') return '<div class="sv-box"><div class="pj-skel"></div></div>';
  if (tab === 'docker') return '<div class="dk-box"><p class="nf-empty">Lecture de Docker…</p></div>';
  if (tab === 'tasks') return `${section('tasks', 'Tâches', 'check', taskBox(p))}${panelsHTML(p, 'tasks')}`;
  if (tab === 'notes') return section('notes', 'Notes', 'notes', noteRows(p));
  if (tab === 'site') return `${section('site-local', 'En local', 'terminal', site.localHTML())}${section('site', 'En ligne', 'link', siteHTML(p))}${section('site-prod', 'En production', 'server', site.soonHTML())}`;
  const notes = model.notesOf(p).length - 1;
  return `${folderBox}
    ${bridge.where() ? `<section class="pj-quick">${sessions.composerHTML(p, { compact: true })}<div data-ov="agents"></div></section>` : ''}
    <div class="pj-dash">
      ${chartCard('code', 'Activité du code', 'code', 'commits')}
      ${chartCard('sessions', 'Claude Code', 'terminal', 'tokens')}
      ${chartCard('flux', 'Santé de la CI', 'pr', 'ci')}
      ${chartCard('tasks', 'Avancement des tâches', 'check', 'tasks', tasksChart(p))}
    </div>
    <div class="pj-ovs">
      ${card('code', 'Pull requests', 'github', p.repos.length ? 'Lecture des PR…' : 'Aucun dépôt associé')}
      ${card('site', 'Site', 'link', p.site ? esc(p.site.replace(/^https:\/\//, '')) : 'Ajouter le site du projet')}
      ${card('notes', 'Notes', 'notes', `<b>${notes}</b> note${notes > 1 ? 's' : ''}`)}
      ${card('docker', 'Docker', 'box', docker.supported() ? 'Lecture des conteneurs…' : 'Visible dans l’app Mac')}</div>${panelsHTML(p, 'overview')}`;
}

// ---------- Serveur (VPS, VM) ----------
interface ServerStatus { configured?: boolean; online?: boolean; host?: string; path?: string; ms?: number; error?: string; load?: number[]; cpus?: number; uptime?: string; disk?: { size: string; used: string; free: string; pct: number }; mem?: { total: number; used: number }; git?: string; claude?: string; os?: string }
const level = (pct: number) => pct >= 90 ? 'red' : pct >= 75 ? 'amber' : 'green';
function serverForm(hosts: { alias: string; hostname: string }[], cur?: ServerStatus): string {
  return `<form class="sv-form"><div class="ag-empty sv-intro">${icon('server')}<h3>Relie un serveur à ce projet</h3><p>Un VPS ou une VM où tourne le projet ou ses agents. Studio s’y connecte en SSH depuis ce Mac, avec ta configuration habituelle (<code>~/.ssh/config</code>, agent SSH) : aucune clé n’est stockée par Studio.</p></div>
    <label class="pj-field"><span>Hôte SSH</span><input class="field" name="host" list="sv-hosts" placeholder="vps-prod ou deploy@203.0.113.10" value="${esc(cur?.host ?? '')}" required autocomplete="off"><datalist id="sv-hosts">${hosts.map(h => `<option value="${esc(h.alias)}">${esc(h.hostname)}</option>`).join('')}</datalist></label>
    <label class="pj-field"><span>Dossier du projet sur le serveur</span><input class="field" name="path" placeholder="/srv/studio ou ~/studio" value="${esc(cur?.path ?? '')}" required autocomplete="off"></label>
    <p class="modal-hint">${icon('shield')}Connexion par clé uniquement (jamais de mot de passe demandé). Les commandes envoyées sont fixes : état du serveur, et Claude Code avec les mêmes garde-fous que sur le Mac.</p>
    <div class="modal-actions">${cur?.configured ? '<button type="button" class="btn" data-sv="cancel">Annuler</button>' : ''}<button class="btn btn-primary">${icon('check')}Enregistrer</button></div></form>`;
}
function serverHTML(st: ServerStatus): string {
  const local = bridge.local();
  const head = `<div class="sv-head"><span class="pj-site-dot ${st.online ? 'up' : 'down'}"></span><div><strong>${esc(st.host ?? '')}</strong><code>${esc(st.path ?? '')}</code></div>
    <span class="sv-state">${st.online ? `En ligne · ${st.ms} ms` : 'Injoignable'}</span>
    <span class="sv-act">${local ? `<button class="btn" data-sv="terminal">${icon('terminal')}Terminal SSH</button>` : ''}<button class="btn" data-sv="refresh">${icon('refresh')}Actualiser</button>${local ? `<button class="icon-btn" data-sv="edit" title="Modifier" aria-label="Modifier le serveur">${icon('pencil')}</button>` : ''}</span></div>`;
  if (!st.online) return head + `<p class="sv-err">${icon('shield')}${esc(st.error || 'La connexion SSH a échoué.')}</p><p class="modal-hint">Vérifie que <code>ssh ${esc(st.host ?? '')}</code> fonctionne dans le Terminal sans mot de passe (clé chargée dans l’agent SSH).</p>`;
  const load = st.load?.[0] ?? 0, cpus = st.cpus || 1, loadPct = Math.min(100, Math.round(load / cpus * 100));
  const memPct = st.mem ? Math.round(st.mem.used / st.mem.total * 100) : 0, diskPct = st.disk?.pct ?? 0;
  const tile = (label: string, value: string, sub: string, pct?: number) => `<div class="sv-tile"><span>${label}</span><strong>${value}</strong>${pct !== undefined ? chart.meter(pct, 100, level(pct)) : ''}<em>${sub}</em></div>`;
  return head + `<div class="sv-grid">
      ${tile('Charge', load.toLocaleString('fr-FR', { maximumFractionDigits: 2 }), `${cpus} cœur${cpus > 1 ? 's' : ''} · ${loadPct} %`, loadPct)}
      ${st.mem ? tile('Mémoire', `${memPct} %`, `${(st.mem.used / 1024).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} / ${(st.mem.total / 1024).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} Go`, memPct) : tile('Mémoire', '—', 'non disponible')}
      ${st.disk ? tile('Disque', `${diskPct} %`, `${esc(st.disk.used)} sur ${esc(st.disk.size)} · ${esc(st.disk.free)} libres`, diskPct) : tile('Disque', '—', 'dossier introuvable')}
    </div>
    <dl class="sv-facts"><div><dt>Dépôt</dt><dd>${st.git ? `<code>${esc(st.git.replace(/^## /, ''))}</code>` : 'pas un dépôt Git'}</dd></div>
      <div><dt>Claude Code</dt><dd>${st.claude ? esc(st.claude) : '<span class="warn">non installé</span>'}</dd></div>
      <div><dt>Système</dt><dd>${esc(st.os ?? '')}${st.uptime ? ` · allumé depuis ${esc(st.uptime)}` : ''}</dd></div></dl>
    ${st.claude ? `<h3 class="ss-h">Lancer un agent sur ce serveur <span>dans une copie isolée du dépôt distant</span></h3>${sessions.composerHTML(model.byId(app.viewState().project) as Project, { machine: 'server' })}` : `<p class="modal-hint">Installe Claude Code sur le serveur (<code>curl -fsSL https://claude.ai/install.sh | bash</code>) et connecte-le (<code>claude</code> puis <code>/login</code>) pour y lancer des agents.</p>`}`;
}
async function server(root: HTMLElement, p: Project): Promise<void> {
  const box = $('.sv-box', root); if (!box) return;
  if (!bridge.where()) { box.innerHTML = `<div class="ag-empty">${icon('server')}<h3>Le serveur se pilote depuis le Mac</h3><p>Ouvre ce projet dans l’app Studio pour Mac, ou lie cet appareil au Mac pour suivre le serveur d’ici.</p></div>`; return; }
  const st = (await bridge.call('agent', 'server', { project: p.id, op: 'status' }, 30000)) as ServerStatus & { ok: boolean; message?: string };
  if (!box.isConnected) return;
  if (!st.ok) { box.innerHTML = `<p class="hm-empty">${esc(st.message ?? 'Lecture impossible.')}</p>`; return; }
  if (!st.configured) {
    if (!bridge.local()) { box.innerHTML = `<div class="ag-empty">${icon('server')}<h3>Aucun serveur relié</h3><p>Relie le serveur du projet depuis le Mac (onglet Serveur).</p></div>`; return; }
    const h = await native.call('agent', 'server', { project: p.id, op: 'hosts' }, 10000);
    box.innerHTML = serverForm((h.hosts as { alias: string; hostname: string }[]) ?? []); return;
  }
  box.innerHTML = serverHTML(st);
  box.dataset.st = JSON.stringify(st);
  sessions.bindComposer(box, p, r => { sessions.select(r.session || null, p.id); void go(p.id, 'sessions'); });
}

// ---------- Tableau de bord ----------
const chartCard = (tab: string, title: string, ic: string, key: string, body = '<div class="pj-skel"></div>') =>
  `<section class="pj-chart"><header><h3>${icon(ic)}${esc(title)}</h3><button class="pj-more" data-pj-tab="${tab}">Ouvrir${icon('chevronRight')}</button></header><div class="pj-chart-b" data-ch="${key}">${body}</div></section>`;
const kpi = (n: string, label: string, extra = '') => `<p class="pj-kpi"><strong>${n}</strong><span>${label}</span>${extra}</p>`;
const muted = (t: string) => `<p class="pj-chart-empty">${t}</p>`;
function tasksChart(p: Project): string {
  const c = todo.ofProject(p.id), done = c.doneAll.length, total = done + c.openCount;
  if (!total) return muted('Aucune tâche dans ce projet pour l’instant.');
  return `${kpi(`${Math.round(done / total * 100)} %`, `${done} terminée${done > 1 ? 's' : ''} sur ${total}`)}${chart.meter(done, total)}
    <dl class="pj-facts"><div><dt>Ouvertes</dt><dd>${c.openCount}</dd></div><div><dt>En cours</dt><dd>${c.doing.length}</dd></div><div><dt>En retard</dt><dd${c.late.length ? ' class="err"' : ''}>${c.late.length}</dd></div></dl>`;
}
const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
async function dashboard(root: HTMLElement, p: Project, f: Folder | null): Promise<void> {
  const repo = p.repos[0];
  // Activité : commits par jour (dépôt local sur le Mac, sinon GitHub).
  void (async () => {
    let days: Record<string, number> | null = null, src = '';
    if (f?.path || (!bridge.local() && bridge.where())) { const r = await bridge.call('agent', 'commits', { project: p.id, days: 30 }, 20000); if (r.ok && r.found !== false) { days = r.days as Record<string, number>; src = 'toutes branches'; } }
    if (!days && repo && github.connected()) { try { days = await github.commitsPerDay(repo, 30); src = 'branche principale'; } catch { /* plus bas */ } }
    if (!days) return fill(root, '[data-ch="commits"]', muted(repo ? 'Connecte GitHub ou choisis le dossier du projet pour voir son activité.' : 'Associe un dépôt ou choisis le dossier du projet.'));
    const n = sum(days), pts = chart.lastDays(30, days);
    fill(root, '[data-ch="commits"]', kpi(String(n), `commit${n > 1 ? 's' : ''} sur 30 jours`, `<em>${src}</em>`) + chart.bars(pts, { color: 'blue', unit: 'commit', summary: `${n} commits sur 30 jours` }));
  })();
  // Claude Code : tokens écrits par jour.
  void (async () => {
    if (!bridge.where()) return fill(root, '[data-ch="tokens"]', muted('La consommation de Claude Code se lit depuis l’app Mac, ou depuis un appareil lié au Mac.'));
    if (bridge.local() && !f?.path) return fill(root, '[data-ch="tokens"]', muted('Choisis le dossier du projet pour suivre Claude Code.'));
    const r = await bridge.call('agent', 'daily', { project: p.id, days: 30 }, 30000);
    const tok = (r.tokens as Record<string, number>) ?? {}, n = sum(tok), ses = sum((r.sessions as Record<string, number>) ?? {});
    fill(root, '[data-ch="tokens"]', n ? kpi(chart.fmt(n), `tokens écrits sur 30 jours`, `<em>${ses} session${ses > 1 ? 's' : ''}</em>`) + chart.bars(chart.lastDays(30, tok), { color: 'violet', unit: 'token', summary: `${n} tokens écrits par Claude Code sur 30 jours` }) : muted('Aucune session Claude Code ces 30 derniers jours.'));
  })();
  // CI : dernières exécutions sur la branche principale.
  void (async () => {
    if (!repo || !github.connected()) return fill(root, '[data-ch="ci"]', muted(repo ? 'Connecte GitHub pour suivre la CI.' : 'Associe un dépôt GitHub au projet.'));
    try {
      const fl = await github.flow(repo), h = fl.history, done = h.filter(x => x.state !== 'pending'), ok = done.filter(x => x.state === 'success').length;
      if (!h.length) return fill(root, '[data-ch="ci"]', muted(`Aucune exécution de CI sur ${esc(fl.base)}.`));
      const last = h[h.length - 1];
      fill(root, '[data-ch="ci"]', kpi(done.length ? `${Math.round(ok / done.length * 100)} %` : '—', `réussies sur les ${h.length} dernières`, `<em><code>${esc(fl.base)}</code></em>`) + chart.strip(h)
        + `<p class="pj-chart-foot">Dernière : <span class="${last?.state === 'success' ? 'ok' : last?.state === 'failure' ? 'err' : 'warn'}">${last?.state === 'success' ? '✓ réussie' : last?.state === 'failure' ? '✕ en échec' : '… en cours'}</span>${fl.releases[0] ? ` · version <b>${esc(fl.releases[0].tag)}</b>` : ''}</p>`);
    } catch (e) { fill(root, '[data-ch="ci"]', muted(esc(errMsg(e)))); }
  })();
  chart.bindTips(root);
}
async function agentsStrip(root: HTMLElement, p: Project): Promise<void> {
  const box = $('[data-ov="agents"]', root); if (!box || !bridge.where()) return;
  const r = await bridge.call('agent', 'list', { project: p.id }, 10000), list = ((r.runs as sessions.AgentRun[] | undefined) ?? []).filter(x => x.status === 'running' || x.status === 'starting');
  box.innerHTML = list.map(x => `<button class="pj-agent" data-pj-agent="${esc(x.session)}"><i class="ss-live on"></i><span>${esc(x.prompt)}</span><em>${esc(x.lastText || 'Démarrage…')}</em>${icon('chevronRight')}</button>`).join('');
}

function detailHTML(p: Project, tab: string): string {
  return `<div class="pj-head" style="--c:var(--c-${p.hue})"><button class="lv-back" data-pj-open="">${icon('back')}Projets</button>
      <div class="pj-title"><span class="pj-dot"></span><h1>${esc(p.name)}</h1><button class="btn pj-note" data-pj="edit">${icon('notes')}Note du projet</button><button class="btn pj-note" data-pj="claude" title="Conversation bornée à ce projet : Claude ne voit que ses données">${icon('sparkle')}Claude</button></div>
      <div class="pj-links" data-k="${esc(`${p.repos.join(',')}|${p.site ?? ''}|${p.linear ?? ''}`)}">${p.repos.map(r => `<a class="lv-chip" href="https://github.com/${esc(r)}" target="_blank" rel="noopener">${icon('github')}${esc(r)}</a>`).join('')}${p.linear ? `<span class="lv-chip">${icon('linear')}${esc(p.linear)}</span>` : ''}${p.site ? `<a class="lv-chip" href="${esc(p.site)}" target="_blank" rel="noopener">${icon('link')}${esc(p.site.replace(/^https:\/\//, ''))}</a>` : ''}<span class="lv-chip">#${esc(p.tag)}</span></div>
      <nav class="lv-tabs pj-tabs">${TABS.map(([k, l]) => `<button data-pj-tab="${k}" class="${k === tab ? 'sel' : ''}">${esc(l)}</button>`).join('')}</nav></div>
    <div class="pj-body" data-tab="${tab}">${tabBody(p, tab)}</div>`;
}

const fill = (root: HTMLElement, sel: string, html: string) => { const b = $(sel, root); if (b) b.innerHTML = html; };
async function hydrate(root: HTMLElement, p: Project, tab: string): Promise<void> {
  for (const x of registry.projectPanels(p, tab)) {
    void Promise.resolve().then(() => x.render(p)).then(html => fill(root, `[data-sec="${CSS.escape(x.id)}"] .pj-sec-body`, html))
      .catch(e => fill(root, `[data-sec="${CSS.escape(x.id)}"] .pj-sec-body`, `<p class="nf-empty">${esc(errMsg(e))}</p>`));
  }
  if (tab === 'flux') void flux.render(p).then(h => fill(root, '.pj-flux', h)).catch(e => fill(root, '.pj-flux', `<p class="nf-empty">${esc(errMsg(e))}</p>`));
  const f = await folderOf(p);
  fill(root, '.pj-folder-box', folderHTML(p, f));
  if (tab === 'sessions') { const box = $('.ss-box', root); if (box) sessions.mount(box, p, f?.path ?? null); }
  if (tab === 'code' && native.available()) {
    const r = await native.call('project', 'branches', { project: p.id }, 20000), list = (r.branches as { name: string; date: string; ahead: number; behind: number; upstream: string }[] | undefined) ?? [];
    fill(root, '[data-sec="branches"] .pj-sec-body', list.length ? list.map(b => `<div class="pj-br"><code>${esc(b.name)}</code>${b.name === f?.branch ? '<em class="pj-badge approved">actuelle</em>' : ''}${b.upstream ? '' : '<em class="pj-badge">locale</em>'}<span>${b.ahead ? `↑${b.ahead} ` : ''}${b.behind ? `↓${b.behind}` : ''}</span><time>${esc(rel(Date.parse(b.date)))}</time></div>`).join('') : '<p class="hm-empty">Choisis le dossier du projet pour voir ses branches.</p>');
  }
  if (tab === 'site') site.mount(root, p);
  if (tab === 'site' && p.site && native.available()) void checkSite(root, p);
  if (tab === 'server') void server(root, p);
  if (tab === 'docker') { const box = $('.dk-box', root); if (box) docker.mount(box, p, f?.path ?? null); }
  if (tab === 'overview') {
    void overview(root, p, f); void dashboard(root, p, f); void agentsStrip(root, p); void docker.fillCard(root, p);
    sessions.bindComposer(root, p, r => { sessions.select(r.session || null, p.id); void go(p.id, 'sessions'); });
  }
}

async function checkSite(root: HTMLElement, p: Project): Promise<void> {
  const st = $('[data-site-st]', root), dot = $('[data-site-dot]', root); if (!st || !p.site) return;
  st.textContent = 'Vérification…';
  const r = await native.call('project', 'site', { url: p.site }, 20000);
  dot?.classList.toggle('up', !!r.up); dot?.classList.toggle('down', !r.up);
  st.innerHTML = !r.ok ? esc(r.message ?? 'Vérification impossible.') : r.up ? `En ligne · code ${String(r.status)} · ${String(r.ms)} ms` : `<span class="err">Ne répond pas</span>${r.status ? ` · code ${String(r.status)}` : ''}${r.message ? ` · ${esc(String(r.message))}` : ''}`;
}

async function overview(root: HTMLElement, p: Project, f: Folder | null): Promise<void> {
  const repo = p.repos[0];
  if (repo && github.connected()) {
    github.project(repo).then(({ pulls }) => {
      const failing = pulls.filter(x => x.ci === 'failure').length, ready = pulls.filter(x => x.review === 'approved' && x.ci === 'success').length;
      fill(root, '[data-ov="code"]', `<b>${pulls.length}</b> PR ouverte${pulls.length > 1 ? 's' : ''}${failing ? ` · <span class="err">${failing} CI en échec</span>` : ''}${ready ? ` · <span class="ok">${ready} prête${ready > 1 ? 's' : ''}</span>` : ''}${f?.branch ? ` · sur <code>${esc(f.branch)}</code>` : ''}`);
    }).catch(() => fill(root, '[data-ov="code"]', 'GitHub ne répond pas'));
  }
  if (p.site && native.available()) {
    const r = await native.call('project', 'site', { url: p.site }, 20000);
    fill(root, '[data-ov="site"]', `${esc(p.site.replace(/^https:\/\//, ''))} · ${r.up ? `<span class="ok">en ligne</span> · ${String(r.ms)} ms` : '<span class="err">ne répond pas</span>'}`);
  }
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

// ---------- Vers Claude Code ----------
/** Claude Code est joignable d'ici (sur ce Mac, ou un Mac lié qui l'autorise). */
export const claudeAvailable = (): boolean => !!bridge.where();
/** Ouvre l'onglet Claude Code du projet avec des notes jointes ou une consigne déjà écrite. */
export function toClaude(p: Project, what: { notes?: string[]; prompt?: string }): Promise<void> {
  sessions.handoff(p, { notes: what.notes ?? [], prompt: what.prompt ?? '' });
  return go(p.id, 'sessions');
}

/** Conversations Claude Code récentes d'un projet, pour la barre latérale. */
export const sideSessions = (pid: string) => sessions.sideSessions(pid);
/** Choisit la conversation à ouvrir dans l'onglet Claude Code du projet (`null` : la liste). */
export const openSession = (pid: string, id: string | null, agent: string | null = null): void => sessions.select(id, pid, agent);

// ---------- Page ----------
/** Fil d'Ariane : Projets › projet › onglet › conversation Claude Code › sous-agent, chaque niveau ramenant à sa page. */
function trailHTML(): string {
  const p = model.byId(app.viewState().project), tab = curTab();
  const up: [string, string] = ['Projets', 'data-pj-open=""'];
  if (!p) return app.crumb('Projets');
  if (tab === 'overview') return app.crumb(p.name, [up]);
  const home: [string, string] = [p.name, 'data-pj-tab="overview"'], label = TABS.find(x => x[0] === tab)?.[1] ?? '';
  const talk = tab === 'sessions' ? sessions.current(p.id) : null;
  if (!talk) return app.crumb(label, [up, home]);
  const tabUp: [string, string] = [label, 'data-pj-tab="sessions"'];
  return talk.sub ? app.crumb(talk.sub.title, [up, home, tabUp, [talk.title, 'data-pj-talk']]) : app.crumb(talk.title, [up, home, tabUp]);
}

export function mount(main: HTMLElement): void {
  sessions.stop();
  const p = model.byId(app.viewState().project), tab = curTab();
  if (p) sessions.preload(p);
  main.innerHTML = `<header class="toolbar">${app.tbLeft()}${trailHTML()}<div class="tb-side tb-right">${p ? '' : `<button class="btn btn-ghost" data-pj="new">${icon('plus')}<span>Nouveau projet</span></button>`}</div></header>
    <div class="todo pj"><div class="todo-in pj-in">${p ? detailHTML(p, tab) : `<div class="td-head"><h1>Projets</h1><p class="td-sub">Un projet réunit son dossier, son dépôt, ses PR, ses tickets, ses tâches et ses notes.</p></div><div class="pj-list">${listHTML()}</div>`}</div></div>`;
  const root = need('.pj', main);
  $('.toolbar [data-pj=new]', main)?.addEventListener('click', () => void createDialog());
  // Écouté sur la barre d'outils : le fil d'Ariane est redessiné quand la conversation change de nom.
  $('.toolbar', main)?.addEventListener('click', e => {
    const t = target(e);
    if (!t.closest('.crumb')) return;
    if (t.closest('[data-pj-open]')) void go(null);
    else if (p && t.closest('[data-pj-talk]')) sessions.openSub(null);
    else if (p && t.closest('[data-pj-tab="sessions"]')) sessions.open(null);
    else if (p && t.closest('[data-pj-tab]')) void go(p.id, 'overview');
  });
  if (p) void hydrate(root, p, tab);
  root.addEventListener('submit', async e => {
    if (!p) return;
    const f = target(e);
    if (f.closest('.pj-add')) {
      e.preventDefault();
      const i = need<HTMLInputElement>('input', f), v = i.value; if (!v.trim()) return;
      i.value = ''; await todo.add(v, p.id); refresh();
    }
    if (f.closest('.sv-form')) {
      e.preventDefault();
      const v = (n: string) => need<HTMLInputElement>(`[name=${n}]`, f).value.trim();
      const r = await native.call('agent', 'server', { project: p.id, op: 'set', host: v('host'), path: v('path') }, 10000);
      if (!r.ok) { toast(r.message ?? 'Configuration refusée.'); return; }
      toast('Serveur relié au projet'); const box = $('.sv-box', root); if (box) box.innerHTML = '<div class="pj-skel"></div>'; void server(root, p); return;
    }
    if (f.closest('.pj-site-form')) {
      e.preventDefault();
      const v = need<HTMLInputElement>('input', f).value.trim();
      if (!/^https:\/\/[^\s]+$/i.test(v)) { toast('L’adresse doit commencer par https://'); return; }
      await model.setField(p, 'site', v); toast('Site associé au projet');
    }
  });
  root.addEventListener('click', async e => {
    const t = target(e), open = t.closest('[data-pj-open]');
    if (open) { await go(open.dataset.pjOpen || null); return; }
    const tb = t.closest('[data-pj-tab]');
    if (tb && p) { await app.setView({ type: 'projets', project: p.id, tab: tb.dataset.pjTab ?? 'overview' }); return; }
    const ccNote = t.closest('[data-pj-cc-note]'), ccTask = t.closest('[data-pj-cc-task]');
    if ((ccNote || ccTask) && p) { await toClaude(p, ccNote ? { notes: [ccNote.dataset.pjCcNote ?? ''] } : { prompt: ccTask?.dataset.pjCcTask ?? '' }); return; }
    const sv = t.closest('[data-sv]');
    if (sv && p) {
      const act = sv.dataset.sv, box = $('.sv-box', root);
      if (act === 'refresh') { if (box) box.innerHTML = '<div class="pj-skel"></div>'; void server(root, p); }
      if (act === 'terminal') { const r = await native.call('agent', 'server', { project: p.id, op: 'terminal' }, 10000); if (!r.ok) toast(r.message ?? 'Impossible.'); }
      if (act === 'edit' && box) { const h = await native.call('agent', 'server', { project: p.id, op: 'hosts' }, 10000); box.innerHTML = serverForm((h.hosts as { alias: string; hostname: string }[]) ?? [], JSON.parse(box.dataset.st || '{}') as ServerStatus); }
      if (act === 'cancel') void server(root, p);
      return;
    }
    const ag = t.closest('[data-pj-agent]');
    if (ag && p) { sessions.select(ag.dataset.pjAgent || null, p.id); await go(p.id, 'sessions'); return; }
    const issue = t.closest('.lv-row[data-issue]');
    if (issue) { void import('../../integrations/linear/page.ts').then(m => m.openTicket(issue.dataset.issue ?? '')); return; }
    const b = t.closest('[data-pj]'); if (!b) return;
    const act = b.dataset.pj;
    if (act === 'new') { void createDialog(); return; }
    if (!p) return;
    if (act === 'edit') app.openNote(p.id);
    if (act === 'claude') { const id = p.id; void import('../chat.ts').then(m => m.startIn(id)); return; }
    if (act === 'kanban') { todo.showProject(p.id); await app.setView({ type: 'tasks' }); }
    if (act === 'new-note') { const n = await store.createNote({ title: '', body: `\n\n#${p.tag}` }); app.openNote(n.id); }
    if (act === 'pick') { const r = await native.call('project', 'pick', { project: p.id }, 600000); if (r.ok) { folders.delete(p.id); void hydrate(root, p, tab); } }
    if (act === 'vscode' || act === 'finder' || act === 'terminal') { const r = await native.call('project', 'open', { project: p.id, app: act }, 15000); if (!r.ok) toast(r.message ?? 'Impossible d’ouvrir.'); }
    if (act === 'link-repo' && b.dataset.repo) { await model.setField(p, 'dépôts', [...p.repos, b.dataset.repo].join(', ')); toast(`${b.dataset.repo} associé au projet`); }
    if (act === 'review-working') await review.review(p, 'working');
    if (act === 'review-branch') await review.review(p, 'branch');
    if (act === 'site-check') await checkSite(root, p);
    if (act === 'site-edit') { const box = $('[data-sec="site"] .pj-sec-body', root); if (box) box.innerHTML = `<form class="td-add pj-site-form"><span class="td-plus">${icon('link')}</span><input type="url" value="${esc(p.site ?? '')}" aria-label="Adresse du site" required></form>`; }
  });
}

export function refresh(): void {
  const root = $('#main .pj'); if (!root) return;
  const p = model.byId(app.viewState().project);
  if (!p) { const l = $('.pj-list', root); if (l) l.innerHTML = listHTML(); return; }
  const tasks = $('.pj-tasklist', root), notes = $('[data-sec="notes"] .pj-sec-body', root);
  if (tasks) tasks.innerHTML = taskRows(p);
  if (notes) notes.innerHTML = noteRows(p);
  // Le bloc ```projet a changé (site, dépôts) : on redessine l'en-tête et l'onglet.
  const head = $('.pj-links', root), want = `${p.repos.join(',')}|${p.site ?? ''}|${p.linear ?? ''}`;
  if (head && head.dataset.k !== want) mount(need('#main'));
}
