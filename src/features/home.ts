// Accueil : ce qui compte maintenant. Une phrase de situation, la capture, puis deux colonnes :
// à gauche ce que tu dois faire et tes notes en cours, à droite ce qui bouge (Linear, GitHub, agents, appareils).
import * as store from '../core/store.ts';
import * as vault from '../core/vault.ts';
import * as link from '../integrations/link.ts';
import * as todo from './tasks.ts';
import * as linear from '../integrations/linear/api.ts';
import * as notifs from '../integrations/linear/notifications.ts';
import * as github from '../integrations/github/api.ts';
import * as voice from './voice.ts';
import * as hub from './hub.ts';
import * as onboarding from './onboarding.ts';
import * as docker from './projects/docker.ts';
import { esc, plain } from '../lib/markdown.ts';
import { $, icon, rel, need, target } from '../ui/kit.ts';
import type { AppShell, Note } from '../types.ts';
import type { Agenda, Task } from './tasks.ts';

let app!: AppShell;
export const init = (shell: AppShell): void => { app = shell; };
const titleOf = (n: Note) => n.title.trim() || 'Sans titre';
const section = (title: string, body: string, { view = '', meta = '' } = {}): string => `<section class="hm-sec"><header>${view ? `<button class="hm-h" data-view="${view}">${title}${icon('chevronRight')}</button>` : `<span class="hm-h">${title}</span>`}${meta ? `<span class="hm-meta">${meta}</span>` : ''}</header>${body}</section>`;

function summary(a: Agenda): string {
  const bits = [];
  if (a.late) bits.push(`<button data-view="tasks" class="late">${a.late} tâche${a.late > 1 ? 's' : ''} en retard</button>`);
  if (a.today) bits.push(`<button data-view="tasks">${a.today} pour aujourd’hui</button>`);
  if (!a.late && !a.today) bits.push(a.total ? `<button data-view="tasks">${a.total} tâche${a.total > 1 ? 's' : ''} en cours</button>` : 'Rien d’urgent');
  const n = notifs.unreadCount(); if (n) bits.push(`<button data-view="linear">${n} notification${n > 1 ? 's' : ''} Linear</button>`);
  const g = github.unseenCount(); if (g) bits.push(`<button data-view="github">${g} nouveauté${g > 1 ? 's' : ''} GitHub</button>`);
  return bits.join('<i>·</i>');
}

function tasks(a: Agenda): string {
  if (!a.items.length) return '<p class="hm-empty">Rien à faire pour l’instant. Écris une tâche ci-dessus avec <code>#todo</code>.</p>';
  return a.items.map((t: Task) => `<label class="tg-task hm-task"><input type="checkbox" data-note="${t.note.id}" data-line="${t.line}"><span>${esc(plain(t.text))}</span>
    ${t.subs?.length ? `<em>${t.subs.filter(s => s.done).length}/${t.subs.length}</em>` : ''}${t.ticket ? `<em class="hm-ticket">${esc(t.ticket)}</em>` : ''}${t.due ? `<em class="td-due${a.isLate(t) ? ' late' : ''}">${esc(todo.dueLabel(t.due))}</em>` : !t.own ? `<em>${esc(titleOf(t.note))}</em>` : ''}</label>`).join('')
    + (a.total > a.items.length ? `<button class="hm-more" data-view="tasks">${a.total - a.items.length} de plus</button>` : '');
}

function notes() {
  const recent = [...store.index().live].filter(n => !n.todo).sort((x, y) => (Number(y.pinned) - Number(x.pinned)) || (y.updated - x.updated)).slice(0, 4);
  if (!recent.length) return '<p class="hm-empty">Aucune note pour l’instant.</p>';
  return `<div class="hm-notes">${recent.map(n => `<button class="hm-note" data-open-note="${n.id}"><strong>${n.pinned ? icon('pin') : ''}${esc(titleOf(n))}</strong><p>${store.isLocked(n) ? 'Note chiffrée' : esc(store.meta(n).snippet || 'Note vide')}</p><span>${esc(rel(n.updated))}</span></button>`).join('')}</div>`;
}

function feed() {
  const rows = [
    ...notifs.latest(4).map(x => ({ at: x.at, html: `<button class="hm-feed${x.unread ? '' : ' read'}" ${x.issue ? `data-feed-issue="${esc(x.issue)}"` : 'data-view="linear"'}>${icon('linear')}<span>${esc(x.text)}</span><em>${esc(rel(Date.parse(x.at)))}</em></button>` })),
    ...github.latest(4).map(({ e, d }) => ({ at: e.created_at, html: `<a class="hm-feed read" href="${esc(/^https:\/\/github\.com\//.test(d.url) ? d.url : 'https://github.com')}" target="_blank" rel="noopener">${icon('github')}<span>${esc(`${e.actor?.login || ''} ${d.verb} ${d.what}`.trim())} <small>${esc((e.repo?.name || '').split('/')[1] || '')}</small></span><em>${esc(rel(Date.parse(e.created_at)))}</em></a>` })),
  ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 6);
  return rows.length ? rows.map(r => r.html).join('') : '<p class="hm-empty">Rien de neuf.</p>';
}

function connections() {
  const row = (ic: string, name: string, text: string, tab: string, on: boolean) => `<div class="hm-conn">${icon(ic)}<div><strong>${name}</strong><span>${text}</span></div>${on ? `<i class="st ok"></i>` : `<button class="btn" data-open-conn="${tab}">Connecter</button>`}</div>`;
  const devs = vault.isOpen() ? link.devices() : [];
  return row('linear', 'Linear', 'Tickets, projets, notifications', 'linear', linear.connected())
    + row('github', 'GitHub', 'Actualité de tes dépôts', 'github', github.connected())
    + row('phone', 'Téléphone', devs.length ? devs.map(d => d.name).join(', ') : 'Synchronisation chiffrée, sans serveur', vault.enabled() ? 'appareils' : 'coffre', devs.length > 0);
}

function firstSteps(): string {
  if (!onboarding.visible()) return '';
  const st = onboarding.steps(), done = st.filter(s => s.done).length;
  return `<section class="hm-sec hm-ob"><header><span class="hm-h">Premiers pas</span><span class="hm-meta">${done}/${st.length} <button class="hm-link" data-ob-dismiss>Masquer</button></span></header>
    <span class="bar hm-obbar"><i style="width:${Math.round(done / st.length * 100)}%"></i></span>
    <div class="hm-steps">${st.map(s => `<button class="hm-step${s.done ? ' done' : ''}" ${s.action}><i class="hm-tick">${s.done ? icon('check') : ''}</i><span><strong>${esc(s.label)}</strong><em>${esc(s.hint)}</em></span></button>`).join('')}</div>
    <p class="hm-help">Perdu ? <button class="link-btn" data-view="help">L’aide explique tout en cinq minutes</button>.</p></section>`;
}

function agents() {
  return hub.agentList().slice(0, 4).map(a => `<div class="hm-agent"><i class="st ${a.live ? 'live' : a.last ? (a.ok ? 'ok' : 'err') : ''}"></i><button data-open-note="${a.note.id}">${esc(a.spec.nom)}</button><em>${a.live ? 'en cours' : a.spec.planning ? esc(a.spec.planning) : a.last ? esc(rel(a.last)) : 'manuel'}</em><button class="icon-btn" data-home-agent="${a.index}" title="Lancer" aria-label="Lancer ${esc(a.spec.nom)}"${a.live ? ' disabled' : ''}>${icon('play')}</button></div>`).join('');
}

export function mount(main: HTMLElement): void {
  const now = new Date(), h = now.getHours(), a = todo.agenda(6);
  const hello = h < 5 ? 'Bonne nuit' : h < 12 ? 'Bonjour' : h < 18 ? 'Bon après-midi' : 'Bonsoir';
  const linked = linear.connected() || github.connected(), hasAgents = hub.agentList().length > 0;
  const devs = vault.isOpen() ? link.devices() : [];
  main.innerHTML = `<header class="toolbar">${app.tbLeft()}${app.crumb('Accueil')}<div class="tb-side tb-right"><button class="btn btn-ghost" data-view="help" title="Aide et raccourcis">${icon('help')}<span>Aide</span></button><button class="btn btn-ghost" data-ask-home title="Demander à l’IA">${icon('sparkle')}<span>Demander</span></button></div></header>
  <div class="home"><div class="home-in">
    <p class="hm-date">${esc(now.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }))}</p>
    <h1 class="hm-hello">${hello}.</h1>
    <p class="hm-sum">${summary(a)}</p>
    <form class="w-capture hm-capture"><input placeholder="Note une idée ou une tâche… (#todo pour une tâche, #tag pour ranger)" aria-label="Capture rapide">${voice.available() ? `<button type="button" class="icon-btn" data-act="voice" title="Note vocale" aria-label="Note vocale">${icon('mic')}</button>` : ''}<kbd>↵</kbd></form>
    <div class="hm-grid">
      <div class="hm-col">
        ${firstSteps()}
        ${section('À faire', tasks(a), { view: 'tasks' })}
        ${section('Reprendre', notes(), { view: 'all' })}
      </div>
      <div class="hm-col">
        ${linked ? section('Quoi de neuf', feed()) : ''}
        ${section('Automatisations', hasAgents ? agents() : `<p class="hm-empty">Fais travailler Studio pour toi : une revue chaque matin, le tri des captures, tes notifications Linear changées en tâches…</p><button class="btn" data-view="agents">${icon('bot')}Choisir un modèle</button>`, { view: 'agents' })}
        ${docker.supported() ? '<div data-hm-docker></div>' : ''}
        ${section('Connexions', connections(), { meta: devs.length ? `<button class="hm-link" data-home="sync">Synchroniser</button>` : '' })}
      </div>
    </div>
  </div></div>`;
  need('.hm-capture', main).onsubmit = async e => { e.preventDefault(); const i = need<HTMLInputElement>('input', target(e)); if (!i.value.trim()) return; await app.capture(i.value); i.value = ''; };
  need('[data-ask-home]', main).onclick = () => hub.askAI();
  $('[data-ob-dismiss]', main)?.addEventListener('click', () => { onboarding.dismiss(); mount(main); });
  need('.home', main).addEventListener('click', e => {
    const f = target(e).closest('[data-feed-issue]'); if (f) void import('../integrations/linear/page.ts').then(m => m.openTicket(f.dataset.feedIssue ?? ''));
    const d = target(e).closest('[data-dk-project]'); if (d) void app.setView({ type: 'projets', project: d.dataset.dkProject ?? null, tab: 'docker' });
  });
  // Docker (app Mac) : les conteneurs en cours, avec leur projet ; rien si Docker n'est pas là.
  void docker.status().then(st => { const box = $('[data-hm-docker]', main), h = docker.homeHTML(st); if (box?.isConnected) box.outerHTML = h ? section('Docker', h.body, { meta: h.meta }) : ''; });
}
