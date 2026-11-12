// GitHub : actualité de tes dépôts, lue directement sur api.github.com avec un jeton personnel du coffre.
// Ce fichier : accès à l'API et état (événements, non vus). La page est dans page.js.
// Lecture seule : Studio n'écrit jamais sur GitHub. Sans serveur, l'app interroge l'API toutes les 5 minutes.
import * as vault from '../../core/vault.ts';
import { toast, errMsg } from '../../ui/kit.ts';
import type { AppShell } from '../../types.ts';

/** Événement public de l'API GitHub (champs utilisés seulement). */
export interface GhEvent {
  id: string; type: string; created_at: string;
  actor?: { login: string }; repo?: { name: string };
  payload?: {
    action?: string; ref?: string; ref_type?: string; number?: number;
    pull_request?: { number?: number; title?: string; merged?: boolean };
    issue?: { number?: number; title?: string };
    comment?: { body?: string };
    release?: { name?: string; tag_name?: string };
    member?: { login?: string };
  };
}
export interface Described { verb: string; what: string; url: string; kind: string; quote?: string | undefined }

const API = 'https://api.github.com', EVERY = 5 * 60e3, SEEN = 'carnet.github.seen', MAX_REPOS = 12;
let app: AppShell | null = null, events: GhEvent[] = [], me = '', error = '', loaded = false, busy = false;
const listeners = new Set<() => void>();
export const onUpdate = (f: () => void): void => { listeners.add(f); }; // la page s'abonne pour se redessiner
const emit = () => { app?.onCount?.(); listeners.forEach(f => f()); };
export const state = () => ({ events, me, error, loaded, seen: localStorage.getItem(SEEN) || '' });

export const connected = (): boolean => !!vault.secret('github');
export const active = (): boolean => vault.isOpen() && connected();

export async function api<T>(path: string, token: string | null = vault.secret('github')): Promise<T> {
  if (!token) throw new Error('GitHub n’est pas connecté (Réglages → GitHub).');
  const r = await fetch(API + path, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' });
  if (r.status === 401) throw new Error('jeton refusé ou expiré');
  if (r.status === 403 || r.status === 429) throw new Error('limite de requêtes atteinte, réessaie plus tard');
  if (!r.ok) throw new Error(`GitHub a répondu ${r.status}`);
  return r.json() as Promise<T>;
}
export const viewer = (token?: string): Promise<{ login: string }> => api('/user', token ?? vault.secret('github'));

// ---------- Événements -> phrases ----------
const ACTION: Record<string, string> = { opened: 'a ouvert', closed: 'a fermé', reopened: 'a rouvert', merged: 'a fusionné', created: 'a créé', published: 'a publié', edited: 'a modifié', submitted: 'a relu', started: 'a mis une étoile à', labeled: 'a étiqueté', assigned: 'a assigné', synchronize: 'a mis à jour' };
const branch = (ref?: string) => (ref || '').replace(/^refs\/(heads|tags)\//, '');
export function describe(e: GhEvent): Described {
  const p = e.payload || {}, repo = e.repo?.name || '', base = `https://github.com/${repo}`, act = (p.action && ACTION[p.action]) || p.action || '';
  const pr = p.pull_request, is = p.issue;
  switch (e.type) {
    case 'PushEvent': return { verb: 'a poussé sur', what: branch(p.ref), url: `${base}/commits/${encodeURIComponent(branch(p.ref))}`, kind: 'push' };
    case 'PullRequestEvent': return { verb: `${p.action === 'closed' && pr?.merged ? 'a fusionné' : act} la PR`, what: `#${p.number ?? pr?.number ?? ''} ${pr?.title || ''}`.trim(), url: `${base}/pull/${p.number ?? pr?.number ?? ''}`, kind: 'pr' };
    case 'PullRequestReviewEvent': return { verb: 'a relu la PR', what: `#${pr?.number ?? ''} ${pr?.title || ''}`.trim(), url: `${base}/pull/${pr?.number ?? ''}`, kind: 'pr' };
    case 'PullRequestReviewCommentEvent': return { verb: 'a commenté la PR', what: `#${pr?.number ?? ''} ${pr?.title || ''}`.trim(), quote: p.comment?.body, url: `${base}/pull/${pr?.number ?? ''}`, kind: 'comment' };
    case 'IssuesEvent': return { verb: `${act} l’issue`, what: `#${is?.number ?? ''} ${is?.title || ''}`.trim(), url: `${base}/issues/${is?.number ?? ''}`, kind: 'issue' };
    case 'IssueCommentEvent': return { verb: 'a commenté', what: `#${is?.number ?? ''} ${is?.title || ''}`.trim(), quote: p.comment?.body, url: `${base}/issues/${is?.number ?? ''}`, kind: 'comment' };
    case 'ReleaseEvent': return { verb: 'a publié la version', what: p.release?.name || p.release?.tag_name || '', url: `${base}/releases`, kind: 'release' };
    case 'CreateEvent': return { verb: p.ref_type === 'repository' ? 'a créé le dépôt' : p.ref_type === 'tag' ? 'a créé le tag' : 'a créé la branche', what: p.ref || '', url: base, kind: 'branch' };
    case 'DeleteEvent': return { verb: p.ref_type === 'tag' ? 'a supprimé le tag' : 'a supprimé la branche', what: p.ref || '', url: base, kind: 'branch' };
    case 'ForkEvent': return { verb: 'a forké le dépôt', what: '', url: base, kind: 'star' };
    case 'WatchEvent': return { verb: 'a mis une étoile', what: '', url: base, kind: 'star' };
    case 'MemberEvent': return { verb: 'a ajouté un membre', what: p.member?.login || '', url: base, kind: 'star' };
    case 'PublicEvent': return { verb: 'a rendu le dépôt public', what: '', url: base, kind: 'star' };
    case 'CommitCommentEvent': return { verb: 'a commenté un commit', what: '', quote: p.comment?.body, url: base, kind: 'comment' };
    default: return { verb: e.type.replace(/Event$/, '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase(), what: '', url: base, kind: 'star' };
  }
}

// ---------- Chargement ----------
export const unseenCount = (): number => { const last = localStorage.getItem(SEEN) || ''; return events.filter(e => e.created_at > last && e.actor?.login !== me).length; };
export const latest = (n = 5): { e: GhEvent; d: Described }[] => events.slice(0, n).map(e => ({ e, d: describe(e) }));
export function markSeen(): void { const first = events[0]; if (first && first.created_at > (localStorage.getItem(SEEN) || '')) { localStorage.setItem(SEEN, first.created_at); app?.onCount?.(); } }

export async function poll({ quiet = true } = {}): Promise<void> {
  if (!active() || busy) return;
  busy = true;
  try {
    if (!me) me = (await viewer()).login;
    const repos = await api<{ full_name: string }[]>(`/user/repos?sort=pushed&per_page=${MAX_REPOS}&affiliation=owner,collaborator,organization_member`);
    const lists = await Promise.all(repos.map(r => api<GhEvent[]>(`/repos/${r.full_name}/events?per_page=20`).catch((): GhEvent[] => [])));
    const seen = new Set<string>();
    events = lists.flat().filter(e => e?.id && !seen.has(e.id) && seen.add(e.id)).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 120);
    if (!localStorage.getItem(SEEN) && events[0]) localStorage.setItem(SEEN, events[0].created_at); // premier passage : rien n'est « nouveau »
    error = ''; loaded = true;
  } catch (e) { error = errMsg(e); if (!quiet) toast('GitHub : ' + error); }
  busy = false;
  emit();
}

export function init(shell: AppShell): void {
  app = shell;
  setInterval(() => poll(), EVERY);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && active()) poll(); });
  vault.onChange(() => { if (!active()) { events = []; loaded = false; me = ''; emit(); } else if (!loaded) poll(); });
  poll();
}
