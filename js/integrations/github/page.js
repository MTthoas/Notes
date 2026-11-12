// Page GitHub : l'actualité des dépôts, groupée par jour, filtrable par dépôt.
import * as gh from './api.js';
import * as vault from '../../core/vault.js';
import { esc } from '../../lib/markdown.js';
import { $, icon, rel } from '../../ui/kit.js';

let app = null, filter = '', last = '';
export const init = api => { app = api; gh.onUpdate(refresh); };
const KIND_ICON = { push: 'upload', pr: 'split', issue: 'check', comment: 'sparkle', release: 'bolt', branch: 'graph', star: 'pin' };
const clean = s => (s || '').replace(/[#*_`>\[\]()!]/g, '').replace(/\s+/g, ' ').trim().slice(0, 160);

const dayLabel = iso => { const d = new Date(iso), t = new Date(); t.setHours(0, 0, 0, 0); const diff = Math.floor((t - new Date(d).setHours(0, 0, 0, 0)) / 864e5); return diff <= 0 ? 'Aujourd’hui' : diff === 1 ? 'Hier' : d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }); };
const rowHTML = (e, d, last, me) => `<a class="nf-row gh-row${e.created_at > last && e.actor?.login !== me ? '' : ' read'}" href="${esc(/^https:\/\/github\.com\//.test(d.url) ? d.url : 'https://github.com')}" target="_blank" rel="noopener">
  <span class="gh-kind">${icon(KIND_ICON[d.kind] || 'pin')}</span>
  <div class="nf-body"><div class="nf-line"><span class="nf-who">${esc(e.actor?.login || '')}</span> ${esc(d.verb)} <strong>${esc(d.what)}</strong></div>
  ${d.quote ? `<div class="nf-quote">${esc(clean(d.quote))}</div>` : ''}<div class="gh-repo">${esc(e.repo?.name || '')}</div></div>
  <span class="nf-time">${esc(rel(Date.parse(e.created_at)))}</span></a>`;

function body() {
  const { events, me, error, loaded } = gh.state();
  if (!vault.enabled() || !gh.connected()) return `<div class="nf-empty"><p>Connecte GitHub pour suivre ici l’actualité de tes dépôts : commits poussés, pull requests, issues, commentaires, versions publiées.</p><button class="btn btn-primary" data-open-conn="github">Connecter GitHub</button></div>`;
  if (error && !events.length) return `<p class="nf-empty">GitHub ne répond pas : ${esc(error)}</p>`;
  if (!loaded) return '<p class="nf-empty">Chargement…</p>';
  const list = filter ? events.filter(e => e.repo?.name === filter) : events;
  if (!list.length) return '<p class="nf-empty">Rien de récent sur tes dépôts.</p>';
  const days = new Map();
  for (const e of list) { const k = dayLabel(e.created_at); if (!days.has(k)) days.set(k, []); days.get(k).push(e); }
  return [...days].map(([k, l]) => `<section class="td-sec"><h2>${esc(k)}<span>${l.length}</span></h2>${l.map(e => rowHTML(e, gh.describe(e), last, me)).join('')}</section>`).join('');
}

export function refresh() {
  const root = $('#main .gh'); if (!root) return;
  const { events, me } = gh.state();
  const repos = [...new Set(events.map(e => e.repo?.name).filter(Boolean))];
  if (filter && !repos.includes(filter)) filter = '';
  $('.gh-filters', root).innerHTML = repos.length > 1 ? `<button class="lv-chip${filter ? '' : ' sel'}" data-gh-repo="">Tous</button>` + repos.map(r => `<button class="lv-chip${filter === r ? ' sel' : ''}" data-gh-repo="${esc(r)}">${esc(r.split('/')[1] || r)}</button>`).join('') : '';
  $('.nf-list', root).innerHTML = body();
  $('.td-sub', root).textContent = gh.active() ? `${me ? me + ' · ' : ''}actualisé toutes les 5 minutes` : '';
}

export function mount(main) {
  last = gh.state().seen; // ce qui était nouveau à l'ouverture reste marqué pendant la visite
  main.innerHTML = `<header class="toolbar">${app.tbLeft()}${app.crumb('GitHub')}<div class="tb-side tb-right"></div></header>
    <div class="todo gh"><div class="todo-in">
      <div class="td-head nf-head"><div><h1>GitHub</h1><p class="td-sub"></p></div><div class="nf-actions"><button class="icon-btn" data-gh-refresh title="Actualiser" aria-label="Actualiser">${icon('refresh')}</button></div></div>
      <div class="gh-filters"></div><div class="nf-list"></div>
    </div></div>`;
  $('.gh', main).addEventListener('click', e => {
    if (e.target.closest('[data-gh-refresh]')) return gh.poll({ quiet: false });
    const f = e.target.closest('[data-gh-repo]'); if (f) { filter = f.dataset.ghRepo; refresh(); }
  });
  refresh(); gh.markSeen();
  if (!gh.state().loaded) gh.poll();
}
