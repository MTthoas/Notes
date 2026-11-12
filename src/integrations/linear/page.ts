// Page Linear : mes tickets, projets, notifications, et la fiche d'un ticket ouverte dans Studio.
// Tout passe par api.linear.app avec la clé du coffre ; rien n'est stocké sur le disque.
import * as linear from './api.ts';
import * as notifs from './notifications.ts';
import * as todo from '../../features/tasks.ts';
import { esc, renderMarkdown } from '../../lib/markdown.ts';
import { $, icon, toast, rel, modal, menu, need, target, errMsg, num } from '../../ui/kit.ts';
import type { AppShell, ViewState } from '../../types.ts';

let app!: AppShell;
export const init = (shell: AppShell): void => { app = shell; };

const data: { issues: linear.Issue[] | null; projects: linear.Project[] | null; byProject: Map<string, linear.Issue[]>; error: string } = { issues: null, projects: null, byProject: new Map(), error: '' };
const GROUPS: [string, string][] = [['started', 'En cours'], ['unstarted', 'À faire'], ['triage', 'À trier'], ['backlog', 'Backlog'], ['completed', 'Terminé'], ['canceled', 'Annulé']];
const PSTATE: Record<string, string> = { backlog: 'Backlog', planned: 'Planifié', started: 'En cours', paused: 'En pause', completed: 'Terminé', canceled: 'Annulé' };
const color = (c?: string | null): string => c && /^#[0-9a-f]{3,8}$/i.test(c) ? c : 'var(--text-3)';
const day = (iso?: string | null): string => iso ? new Date(iso.length > 10 ? iso : iso + 'T00:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }) : '';
const safe = (u?: string | null): string => u && /^https:\/\/linear\.app\//.test(u) ? u : '';
const view = () => app.viewState();
const go = (patch: Partial<ViewState>) => app.setView({ type: 'linear', tab: view().tab || 'issues', ...patch });

// ---------- Listes ----------
const issueRow = (i: linear.IssueLike): string => `<button class="lv-row" data-issue="${esc(i.identifier)}">
  <i class="st" style="background:${color(i.state?.color)}" title="${esc(i.state?.name || '')}"></i><span class="lv-id">${esc(i.identifier)}</span><span class="lv-title">${esc(i.title)}</span>
  <em>${[i.project?.name, i.priority ? i.priorityLabel : '', i.assignee?.name, day(i.dueDate)].filter(Boolean).map(esc).join(' · ')}</em></button>`;

function grouped(list: linear.Issue[]): string {
  if (!list.length) return '<p class="nf-empty">Aucun ticket.</p>';
  return GROUPS.map(([type, label]) => { const l = list.filter(i => i.state?.type === type); return l.length ? `<section class="td-sec"><h2>${label}<span>${l.length}</span></h2>${l.map(issueRow).join('')}</section>` : ''; }).join('');
}

function projectCard(p: linear.Project): string {
  const pct = Math.round((p.progress || 0) * 100);
  return `<button class="lv-proj" data-project="${esc(p.id)}"><div class="lv-proj-top"><strong>${esc(p.name)}</strong><span class="lv-chip"><i class="st" style="background:${color(p.status?.color)}"></i>${esc(PSTATE[p.status?.type] || p.status?.name || '')}</span></div>
    ${p.description ? `<p>${esc(p.description)}</p>` : ''}
    <div class="lv-proj-meta"><span class="bar"><i style="width:${pct}%"></i></span><span>${pct} %</span>${p.lead ? `<span>${esc(p.lead.name)}</span>` : ''}${p.targetDate ? `<span>échéance ${esc(day(p.targetDate))}</span>` : ''}</div></button>`;
}

function projectPage(p: linear.Project, list: linear.Issue[] | undefined): string {
  const pct = Math.round((p.progress || 0) * 100);
  return `<button class="lv-back" data-lv-back>${icon('back')}Projets</button>
    <div class="lv-phead"><h2>${esc(p.name)}</h2>${safe(p.url) ? `<a class="btn" href="${esc(p.url)}" target="_blank" rel="noopener">Ouvrir dans Linear</a>` : ''}</div>
    ${p.description ? `<p class="lv-desc">${esc(p.description)}</p>` : ''}
    <div class="lv-proj-meta lv-pmeta"><span class="lv-chip"><i class="st" style="background:${color(p.status?.color)}"></i>${esc(PSTATE[p.status?.type] || p.status?.name || '')}</span><span class="bar"><i style="width:${pct}%"></i></span><span>${pct} %</span>${p.lead ? `<span>${esc(p.lead.name)}</span>` : ''}${p.startDate ? `<span>début ${esc(day(p.startDate))}</span>` : ''}${p.targetDate ? `<span>échéance ${esc(day(p.targetDate))}</span>` : ''}</div>
    ${list ? grouped(list) : '<p class="nf-empty">Chargement des tickets…</p>'}`;
}

async function load(fresh = false) {
  const v = view(), tab = v.tab || 'issues';
  try {
    if (tab === 'issues' && (fresh || !data.issues)) data.issues = await linear.issues({ assignee: 'me', states: ['started', 'unstarted', 'triage', 'backlog'], limit: 50 }, { fresh });
    if (tab === 'projects') {
      if (fresh || !data.projects) data.projects = await linear.projects();
      if (v.project && (fresh || !data.byProject.has(v.project))) { paint(); data.byProject.set(v.project, await linear.projectIssues(v.project)); }
    }
    data.error = '';
  } catch (e) { data.error = errMsg(e); }
  paint();
}

function paint() {
  const box = $('#main .lv-body'); if (!box) return;
  const v = view(), tab = v.tab || 'issues';
  for (const b of document.querySelectorAll<HTMLElement>('#main .lv-tabs button')) b.classList.toggle('sel', b.dataset.lvTab === tab);
  const c = notifs.unreadCount(), badge = $('#main .lv-tabs [data-lv-tab="notifs"] span'); if (badge) { badge.textContent = c ? String(c) : ''; badge.hidden = !c; }
  if (tab === 'notifs') { if (!$('.notifs', box)) notifs.mountInto(box); return; }
  if (data.error) { box.innerHTML = `<p class="nf-empty">Linear ne répond pas : ${esc(data.error)}</p>`; return; }
  if (tab === 'issues') box.innerHTML = data.issues ? grouped(data.issues) : '<p class="nf-empty">Chargement…</p>';
  else if (!data.projects) box.innerHTML = '<p class="nf-empty">Chargement…</p>';
  else if (v.project) { const p = data.projects.find(x => x.id === v.project); box.innerHTML = p ? projectPage(p, data.byProject.get(v.project)) : '<p class="nf-empty">Projet introuvable.</p>'; }
  else box.innerHTML = data.projects.length ? `<div class="lv-projs">${data.projects.map(projectCard).join('')}</div>` : '<p class="nf-empty">Aucun projet.</p>';
}

export function mount(main: HTMLElement): void {
  const on = linear.connected();
  main.innerHTML = `<header class="toolbar">${app.tbLeft()}${app.crumb('Linear')}<div class="tb-side tb-right"></div></header>
    <div class="todo lv"><div class="todo-in lv-in">
      <div class="td-head nf-head"><div><h1>Linear</h1></div>${on ? `<div class="nf-actions"><button class="icon-btn" data-lv-refresh title="Actualiser" aria-label="Actualiser">${icon('refresh')}</button></div>` : ''}</div>
      ${on ? `<nav class="lv-tabs"><button data-lv-tab="issues">Mes tickets</button><button data-lv-tab="projects">Projets</button><button data-lv-tab="notifs">Notifications<span hidden></span></button></nav><div class="lv-body"></div>`
        : `<div class="nf-empty"><p>Connecte Linear pour voir ici tes tickets, tes projets et tes notifications, et ouvrir un ticket sans quitter Studio.</p><button class="btn btn-primary" data-open-conn="linear">Connecter Linear</button></div>`}
    </div></div>`;
  if (!on) return;
  need('.lv', main).addEventListener('click', e => {
    let x: HTMLElement | null;
    if ((x = target(e).closest('[data-lv-tab]'))) { void go({ tab: x.dataset.lvTab ?? 'issues', project: null }); return; }
    if (target(e).closest('[data-lv-refresh]')) { void ((view().tab || 'issues') === 'notifs' ? notifs.poll({ quiet: false }) : load(true)); return; }
    if (target(e).closest('[data-lv-back]')) { void go({ project: null }); return; }
    if ((x = target(e).closest('[data-project]'))) { void go({ tab: 'projects', project: x.dataset.project ?? null }); return; }
    if ((x = target(e).closest('.lv-row[data-issue]'))) void openTicket(x.dataset.issue ?? '');
  });
  paint(); void load();
}
export const refreshCount = (): void => { const b = $('#main .lv-tabs [data-lv-tab="notifs"] span'); if (b) { const c = notifs.unreadCount(); b.textContent = c ? String(c) : ''; b.hidden = !c; } };

// ---------- Fiche d'un ticket ----------
export async function openTicket(identifier: string): Promise<void> {
  if (!linear.connected()) { toast('Connecte Linear dans Réglages.'); return; }
  const m = modal({ html: '<p class="nf-empty">Chargement du ticket…</p>', cls: 'ticket' });
  let i: linear.IssueDetail | null = null;
  const fetchIt = async () => { try { i = await linear.issue(identifier); } catch (e) { m.body.innerHTML = `<p class="nf-empty">Ticket ${esc(identifier)} : ${esc(errMsg(e))}</p>`; i = null; } };
  const mine = () => {
    const t = todo.forTicket(identifier);
    return `<section class="tk-sec"><h4>Mes sous-tâches<span>privées, dans Studio</span></h4>
      ${t ? t.subs.map((s, k) => `<label class="tk-sub${s.done ? ' done' : ''}"><input type="checkbox" data-tk-sub="${k}"${s.done ? ' checked' : ''}><span>${esc(s.text)}</span></label>`).join('') : ''}
      <form class="td-subadd tk-add"><span class="td-plus">${icon('plus')}</span><input class="td-subinput" placeholder="${t ? 'Ajouter une sous-tâche' : 'Première sous-tâche : le ticket sera suivi dans tes tâches'}" aria-label="Nouvelle sous-tâche" autocomplete="off"></form></section>`;
  };
  const draw = (): void => {
    if (!i) return;
    const meta = [i.assignee?.name && `Assigné à ${i.assignee.name}`, i.priority ? i.priorityLabel : '', i.project?.name, i.dueDate && `échéance ${day(i.dueDate)}`, i.creator?.name && `créé par ${i.creator.name}`].filter(Boolean);
    m.body.innerHTML = `<div class="tk-top"><span class="lv-id">${esc(i.identifier)}</span><button class="lv-chip tk-state" data-tk-state title="Changer l’état"><i class="st" style="background:${color(i.state?.color)}"></i>${esc(i.state?.name || '')}${icon('chevron')}</button>
        <span class="tk-grow"></span>${safe(i.url) ? `<a class="btn" href="${esc(i.url)}" target="_blank" rel="noopener">Ouvrir dans Linear</a>` : ''}<button class="icon-btn" data-x aria-label="Fermer">✕</button></div>
      <h2 class="tk-title">${esc(i.title)}</h2>
      <p class="tk-meta">${meta.map(esc).join(' · ')}</p>
      ${i.labels?.nodes.length ? `<p class="tk-labels">${i.labels.nodes.map(l => `<span class="lv-chip"><i class="st" style="background:${color(l.color)}"></i>${esc(l.name)}</span>`).join('')}</p>` : ''}
      ${i.parent ? `<button class="lv-row" data-issue="${esc(i.parent.identifier)}">${icon('back')}<span class="lv-id">${esc(i.parent.identifier)}</span><span class="lv-title">${esc(i.parent.title)}</span><em>ticket parent</em></button>` : ''}
      ${i.description ? `<div class="md tk-desc">${renderMarkdown(i.description)}</div>` : '<p class="tk-meta">Pas de description.</p>'}
      ${i.children?.nodes.length ? `<section class="tk-sec"><h4>Sous-tickets<span>${i.children.nodes.length}</span></h4>${i.children.nodes.map(issueRow).join('')}</section>` : ''}
      <div class="tk-mine">${mine()}</div>
      <section class="tk-sec"><h4>Commentaires<span>${i.comments?.nodes.length || ''}</span></h4>
        ${(i.comments?.nodes || []).slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(c => `<div class="tk-com"><div class="tk-com-h"><strong>${esc(c.user?.name || 'Linear')}</strong><span>${esc(rel(Date.parse(c.createdAt)))}</span></div><div class="md">${renderMarkdown(c.body || '')}</div></div>`).join('')}
        <form class="tk-comform"><textarea class="field area" rows="2" placeholder="Écrire un commentaire…" aria-label="Commentaire"></textarea><button class="btn">Commenter</button></form></section>`;
  };
  await fetchIt(); draw();
  const redrawMine = () => { const b = $('.tk-mine', m.body); if (b) b.innerHTML = mine(); };
  m.node.addEventListener('click', async e => {
    let x: HTMLElement | null;
    if (target(e).closest('[data-x]')) { m.close(); return; }
    if ((x = target(e).closest('.lv-row[data-issue]'))) { m.close(); void openTicket(x.dataset.issue ?? ''); return; }
    const cur = i;
    if ((x = target(e).closest('[data-tk-state]')) && cur) {
      try {
        const st = await linear.states(cur.team.id);
        menu(x, st.map(s => ({ label: s.name, checked: s.name === cur.state?.name, run: async () => { try { await linear.setState(cur.id, s.id ?? ''); data.issues = null; data.byProject.clear(); await fetchIt(); draw(); void load(); toast(`${cur.identifier} → ${s.name}`); } catch (err) { toast('Linear : ' + errMsg(err)); } } })));
      } catch (err) { toast('Linear : ' + errMsg(err)); }
    }
  });
  m.node.addEventListener('change', async e => {
    const cb = target(e).closest('[data-tk-sub]'); if (!cb) return;
    const t = todo.forTicket(identifier), s = t?.subs[num(cb, 'tkSub')]; if (s) { await todo.toggle(s); redrawMine(); }
  });
  m.node.addEventListener('submit', async e => {
    e.preventDefault();
    if (!i) return;
    const form = target(e);
    if (form.closest('.tk-add')) { const inp = need<HTMLInputElement>('input', form), v = inp.value; if (!v.trim()) return; inp.value = ''; await todo.addForTicket(i.identifier, i.title, v); redrawMine(); $('.tk-add input', m.body)?.focus(); return; }
    if (target(e).closest('.tk-comform')) {
      const ta = need<HTMLTextAreaElement>('textarea', form), v = ta.value.trim(); if (!v) return;
      try { await linear.addComment(i.id, v); await fetchIt(); draw(); toast('Commentaire publié'); } catch (err) { toast('Linear : ' + errMsg(err)); }
    }
  });
}
