// Page GitHub : l'actualité des dépôts, groupée par jour, filtrable par dépôt.
import * as gh from './api.ts';
import * as vault from '../../core/vault.ts';
import { esc } from '../../lib/markdown.ts';
import { $, icon, rel, need, target } from '../../ui/kit.ts';
import type { AppShell } from '../../types.ts';
import type { GhEvent, Described } from './api.ts';

let app!: AppShell, filter = '', last = '';
export const init = (shell: AppShell): void => { app = shell; gh.onUpdate(refresh); };
const KIND_ICON: Record<string, string> = { push: 'upload', pr: 'split', issue: 'check', comment: 'sparkle', release: 'bolt', branch: 'graph', star: 'pin' };
const clean = (s?: string) => (s || '').replace(/[#*_`>\[\]()!]/g, '').replace(/\s+/g, ' ').trim().slice(0, 160);

const dayLabel = (iso: string) => { const d = new Date(iso), t = new Date(); t.setHours(0, 0, 0, 0); const diff = Math.floor((t.getTime() - new Date(d).setHours(0, 0, 0, 0)) / 864e5); return diff <= 0 ? 'Aujourd’hui' : diff === 1 ? 'Hier' : d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }); };
const rowHTML = (e: GhEvent, d: Described, last: string, me: string) => `<a class="nf-row gh-row${e.created_at > last && e.actor?.login !== me ? '' : ' read'}" href="${esc(/^https:\/\/github\.com\//.test(d.url) ? d.url : 'https://github.com')}" target="_blank" rel="noopener">
  <span class="gh-kind">${icon(KIND_ICON[d.kind] || 'pin')}</span>
  <div class="nf-body"><div class="nf-line"><span class="nf-who">${esc(e.actor?.login || '')}</span> ${esc(d.verb)} <strong>${esc(d.what)}</strong></div>
  ${d.quote ? `<div class="nf-quote">${esc(clean(d.quote))}</div>` : ''}<div class="gh-repo">${esc(e.repo?.name || '')}</div></div>
  <span class="nf-time">${esc(rel(Date.parse(e.created_at)))}</span></a>`;

function body(): string {
  const { events, me, error, loaded } = gh.state();
  if (!vault.enabled() || !gh.connected()) return `<div class="nf-empty"><p>Connecte GitHub pour suivre ici l’actualité de tes dépôts : commits poussés, pull requests, issues, commentaires, versions publiées.</p><button class="btn btn-primary" data-open-conn="github">Connecter GitHub</button></div>`;
  if (error && !events.length) return `<p class="nf-empty">GitHub ne répond pas : ${esc(error)}</p>`;
  if (!loaded) return '<p class="nf-empty">Chargement…</p>';
  const list = filter ? events.filter(e => e.repo?.name === filter) : events;
  if (!list.length) return '<p class="nf-empty">Rien de récent sur tes dépôts.</p>';
  const days = new Map<string, GhEvent[]>();
  for (const e of list) { const k = dayLabel(e.created_at); let l = days.get(k); if (!l) days.set(k, l = []); l.push(e); }
  return [...days].map(([k, l]) => `<section class="td-sec"><h2>${esc(k)}<span>${l.length}</span></h2>${l.map(e => rowHTML(e, gh.describe(e), last, me)).join('')}</section>`).join('');
}

export function refresh(): void {
  const root = $('#main .gh'); if (!root) return;
  const { events, me } = gh.state();
  const repos = [...new Set(events.flatMap(e => e.repo?.name ? [e.repo.name] : []))];
  if (filter && !repos.includes(filter)) filter = '';
  need('.gh-filters', root).innerHTML = repos.length > 1 ? `<button class="lv-chip${filter ? '' : ' sel'}" data-gh-repo="">Tous</button>` + repos.map(r => `<button class="lv-chip${filter === r ? ' sel' : ''}" data-gh-repo="${esc(r)}">${esc(r.split('/')[1] || r)}</button>`).join('') : '';
  need('.nf-list', root).innerHTML = body();
  need('.td-sub', root).textContent = gh.active() ? `${me ? me + ' · ' : ''}actualisé toutes les 5 minutes` : '';
}

export function mount(main: HTMLElement): void {
  last = gh.state().seen; // ce qui était nouveau à l'ouverture reste marqué pendant la visite
  main.innerHTML = `<header class="toolbar">${app.tbLeft()}${app.crumb('GitHub')}<div class="tb-side tb-right"></div></header>
    <div class="todo gh"><div class="todo-in">
      <div class="td-head nf-head"><div><h1>GitHub</h1><p class="td-sub"></p></div><div class="nf-actions"><button class="icon-btn" data-gh-refresh title="Actualiser" aria-label="Actualiser">${icon('refresh')}</button></div></div>
      <div class="gh-filters"></div><div class="nf-list"></div>
    </div></div>`;
  need('.gh', main).addEventListener('click', e => {
    if (target(e).closest('[data-gh-refresh]')) { void gh.poll({ quiet: false }); return; }
    const f = target(e).closest<HTMLElement>('[data-gh-repo]'); if (f) { filter = f.dataset.ghRepo ?? ''; refresh(); }
  });
  refresh(); gh.markSeen();
  if (!gh.state().loaded) gh.poll();
}
