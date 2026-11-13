// Plugins livrés avec Studio. Ils passent par le même registre que les futurs plugins.
import * as registry from './registry.ts';
import { spotify } from './spotify.ts';
import { n8n } from './n8n.ts';
import * as github from '../integrations/github/api.ts';
import * as linear from '../integrations/linear/api.ts';
import { issueRow } from '../integrations/linear/render.ts';
import { esc } from '../lib/markdown.ts';
import { icon, rel, errMsg, avatar } from '../ui/kit.ts';

const CI: Record<github.CiState, [string, string]> = { success: ['green', 'CI verte'], failure: ['red', 'CI en échec'], pending: ['amber', 'CI en cours'], none: ['gray', 'Pas de CI'] };
const REVIEW: Record<github.ReviewState, string> = { approved: 'approuvée', changes: 'modifications demandées', pending: 'revue demandée', none: '' };

export function registerBuiltins(): void {
  // Plugins optionnels : inactifs tant qu'on ne les a pas activés dans Réglages → Extensions.
  registry.register(spotify);
  registry.register(n8n);

  registry.register({
    id: 'github', name: 'GitHub',
    projectPanels: [{
      id: 'github.pulls', title: 'Pull requests et activité', icon: 'github', order: 10, tab: 'code',
      when: p => p.repos.length > 0,
      async render(p) {
        if (!github.connected()) return `<p class="nf-empty">Connecte GitHub pour voir les PR, la CI et l’activité. <button class="link-btn" data-open-conn="github">Connecter</button></p>`;
        const parts = await Promise.all(p.repos.map(async repo => {
          try {
            const { info, pulls } = await github.project(repo);
            const act = github.activityOf(repo, 5);
            return `<div class="pj-repo"><div class="pj-repo-h"><a href="${esc(info.html_url)}" target="_blank" rel="noopener">${icon('github')}${esc(info.full_name)}</a><em>${esc(info.default_branch)} · poussé ${esc(rel(Date.parse(info.pushed_at)))}</em></div>
              ${pulls.length ? pulls.map(pr => `<a class="pj-pr" href="${esc(pr.url)}" target="_blank" rel="noopener"><i class="pj-ci" style="--c:var(--c-${CI[pr.ci][0]})" title="${CI[pr.ci][1]}"></i><span class="pj-num">#${pr.number}</span><span class="pj-prt">${esc(pr.title)}</span>${pr.draft ? '<em class="pj-badge">brouillon</em>' : ''}${REVIEW[pr.review] ? `<em class="pj-badge ${pr.review}">${REVIEW[pr.review]}</em>` : ''}${avatar(pr.author)}</a>`).join('') : '<p class="nf-empty">Aucune PR ouverte.</p>'}
              ${act.length ? `<div class="pj-act">${act.map(({ e, d }) => `<span>${esc(e.actor?.login ?? '')} ${esc(d.verb)} <strong>${esc(d.what)}</strong> · ${esc(rel(Date.parse(e.created_at)))}</span>`).join('')}</div>` : ''}</div>`;
          } catch (e) { return `<p class="nf-empty">${esc(repo)} : ${esc(errMsg(e))}</p>`; }
        }));
        return parts.join('');
      },
    }],
  });

  registry.register({
    id: 'linear', name: 'Linear',
    projectPanels: [{
      id: 'linear.tickets', title: 'Tickets Linear', icon: 'linear', order: 20, tab: 'tasks',
      when: p => !!p.linear,
      async render(p) {
        if (!linear.connected()) return `<p class="nf-empty">Connecte Linear pour voir les tickets du projet. <button class="link-btn" data-open-conn="linear">Connecter</button></p>`;
        try {
          const list = (await linear.issues({ project: p.linear ?? '', states: ['triage', 'backlog', 'unstarted', 'started'], limit: 30 }));
          if (!list.length) return '<p class="nf-empty">Aucun ticket ouvert dans ce projet Linear.</p>';
          const started = list.filter(i => i.state?.type === 'started').length;
          return `<p class="pj-meta">${list.length} ouvert(s) · ${started} en cours</p>${list.slice(0, 12).map(issueRow).join('')}`;
        } catch (e) { return `<p class="nf-empty">Linear : ${esc(errMsg(e))}</p>`; }
      },
    }],
  });
}
