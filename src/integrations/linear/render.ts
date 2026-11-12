// Rendu partagé des tickets Linear (page Linear, page Tâches, Kanban).
import { esc } from '../../lib/markdown.ts';
import { avatar } from '../../ui/kit.ts';
import type { Issue, IssueLike } from './api.ts';

export const GROUPS: [string, string][] = [['started', 'En cours'], ['unstarted', 'À faire'], ['triage', 'À trier'], ['backlog', 'Backlog'], ['completed', 'Terminé'], ['canceled', 'Annulé']];
/** Couleur fournie par Linear, acceptée seulement si c'est une vraie couleur hexadécimale. */
export const color = (c?: string | null): string => c && /^#[0-9a-f]{3,8}$/i.test(c) ? c : 'var(--text-3)';
export const day = (iso?: string | null): string => iso ? new Date(iso.length > 10 ? iso : iso + 'T00:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }) : '';

/** Priorité Linear (1 urgente … 4 basse) : une petite marque colorée. */
export const prio = (p?: number, label?: string): string => p && p >= 1 && p <= 4 ? `<i class="prio p${p}" title="${esc(label || '')}"></i>` : '';

export const issueRow = (i: IssueLike): string => `<button class="lv-row" data-issue="${esc(i.identifier)}">
  <i class="st" style="background:${color(i.state?.color)}" title="${esc(i.state?.name || '')}"></i>${prio(i.priority, i.priorityLabel)}<span class="lv-id">${esc(i.identifier)}</span><span class="lv-title">${esc(i.title)}</span>
  <em>${[i.project?.name, i.assignee?.name, day(i.dueDate)].filter(Boolean).map(esc).join(' · ')}</em>${i.assignee ? avatar(i.assignee.name) : ''}</button>`;

export function grouped(list: Issue[]): string {
  if (!list.length) return '<p class="nf-empty">Aucun ticket.</p>';
  return GROUPS.map(([type, label]) => { const l = list.filter(i => i.state?.type === type); return l.length ? `<section class="td-sec"><h2>${label}<span>${l.length}</span></h2>${l.map(issueRow).join('')}</section>` : ''; }).join('');
}
