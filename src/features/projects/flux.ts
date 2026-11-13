// Onglet « Flux » d'un projet : le parcours de chaque branche, façon gitflow.
//   branche de travail → PR (CI, revue) → prête → fusionnée dans la branche principale → publiée (Release)
// Les données viennent de GitHub ; les branches qui n'existent que sur le Mac sont ajoutées par l'app.
import * as github from '../../integrations/github/api.ts';
import * as native from '../../core/native.ts';
import { esc } from '../../lib/markdown.ts';
import { icon, rel, errMsg, avatar } from '../../ui/kit.ts';
import type { Project } from './model.ts';

interface LocalBranch { name: string; date: string; upstream: string; ahead: number; behind: number }
const COLS: [string, string, string, github.Stage[]][] = [
  ['work', 'En cours', 'gray', ['branche']],
  ['pr', 'PR ouverte', 'blue', ['pr', 'ci', 'revue']],
  ['ready', 'Prête à fusionner', 'green', ['prete']],
  ['merged', 'Fusionnée', 'violet', ['fusionnee']],
  ['released', 'Publiée', 'teal', ['publiee']],
];
const CI: Record<github.CiState, [string, string]> = { success: ['green', 'CI verte'], failure: ['red', 'CI en échec'], pending: ['amber', 'CI en cours'], none: ['gray', 'pas de CI'] };
const REVIEW: Record<github.ReviewState, string> = { approved: 'approuvée', changes: 'modifications demandées', pending: 'revue demandée', none: '' };

function card(it: github.FlowItem, local?: LocalBranch): string {
  const when = it.updated ? rel(Date.parse(it.updated)) : local?.date ? rel(Date.parse(local.date)) : '';
  return `<article class="fx-card">
    <div class="fx-branch">${icon('pr')}<code>${esc(it.branch)}</code>${local && !it.pr && it.stage === 'branche' && !local.upstream ? '<em class="pj-badge">locale</em>' : ''}</div>
    ${it.pr ? `<a class="fx-pr" href="${esc(it.pr.url)}" target="_blank" rel="noopener"><span class="pj-num">#${it.pr.number}</span>${esc(it.pr.title)}</a>` : ''}
    <footer>${it.ci !== 'none' ? `<span class="fx-ci"><i class="pj-ci" style="--c:var(--c-${CI[it.ci][0]})"></i>${CI[it.ci][1]}</span>` : ''}
      ${REVIEW[it.review] ? `<em class="pj-badge ${it.review}">${REVIEW[it.review]}</em>` : ''}${it.pr?.draft ? '<em class="pj-badge">brouillon</em>' : ''}
      ${local && (local.ahead || local.behind) ? `<span class="fx-ab">${local.ahead ? `↑${local.ahead}` : ''}${local.behind ? ` ↓${local.behind}` : ''}</span>` : ''}
      ${it.release ? `<a class="pj-badge approved" href="${esc(it.release.url)}" target="_blank" rel="noopener">${esc(it.release.tag)}</a>` : ''}
      ${it.pr?.author ? avatar(it.pr.author) : ''}<time>${esc(when)}</time></footer></article>`;
}

export async function render(p: Project): Promise<string> {
  if (!p.repos.length) return '<p class="hm-empty">Associe un dépôt GitHub au projet (onglet Code ou note du projet) pour suivre son flux.</p>';
  if (!github.connected()) return `<p class="hm-empty">Connecte GitHub pour suivre le flux des branches. <button class="link-btn" data-open-conn="github">Connecter</button></p>`;
  const locals: LocalBranch[] = native.available() ? (((await native.call('project', 'branches', { project: p.id }, 20000)).branches as LocalBranch[] | undefined) ?? []) : [];
  const out = await Promise.all(p.repos.map(async (repo, i) => {
    try {
      const f = await github.flow(repo);
      const byName = new Map(locals.map(b => [b.name, b]));
      const items = [...f.items];
      if (i === 0) for (const b of locals) if (b.name !== f.base && !items.some(x => x.branch === b.name)) items.push({ branch: b.name, stage: 'branche', updated: b.date, ci: 'none', review: 'none' });
      const visible = items.filter(x => x.stage !== 'fermee');
      return `<div class="fx-repo"><div class="fx-head"><strong>${icon('github')}${esc(f.repo)}</strong>
          <span class="fx-base"><code>${esc(f.base)}</code><i class="pj-ci" style="--c:var(--c-${CI[f.baseCi][0]})"></i>${CI[f.baseCi][1]}</span>
          ${f.releases.length ? `<span class="fx-rels">${f.releases.slice(0, 3).map(r => `<a class="pj-badge approved" href="${esc(r.url)}" target="_blank" rel="noopener" title="${esc(new Date(r.at).toLocaleString('fr-FR'))}">${esc(r.tag)}</a>`).join('')}</span>` : ''}</div>
        <div class="kb fx-board">${COLS.map(([key, label, tone, stages]) => {
          const cards = visible.filter(x => stages.includes(x.stage)).slice(0, key === 'merged' || key === 'released' ? 6 : 30);
          return `<section class="kb-col" data-col="${key}"><header class="kb-head"><i class="kb-dot" style="--c:var(--c-${tone})"></i><span>${label}</span><em class="kb-count">${cards.length}</em></header>
            <div class="kb-cards">${cards.map(x => card(x, i === 0 ? byName.get(x.branch) : undefined)).join('') || '<p class="kb-empty">—</p>'}</div></section>`;
        }).join('')}</div></div>`;
    } catch (e) { return `<p class="nf-empty">${esc(repo)} : ${esc(errMsg(e))}</p>`; }
  }));
  return `<p class="fx-legend">${icon('pr')}Branche de travail → PR (CI verte, revue) → fusion dans la branche principale → Release publiée automatiquement.</p>${out.join('')}`;
}
