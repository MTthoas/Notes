// Linear : appels GraphQL directs depuis le navigateur vers api.linear.app.
// La clé API vit chiffrée dans le coffre ; la politique de sécurité de la page (CSP)
// interdit de l'envoyer vers tout autre domaine.
import * as vault from '../../core/vault.ts';

const URL = 'https://api.linear.app/graphql';

// ---------- Types de l'API (sous-ensemble utilisé par Studio) ----------
export interface State { id?: string; name: string; type: string; color: string; position?: number }
export interface Team { id: string; key: string; name: string }
/** Ticket tel qu'affiché dans les listes. */
export interface Issue {
  id: string; identifier: string; title: string; url: string;
  priority: number; priorityLabel: string; dueDate: string | null; updatedAt: string;
  state: State | null; assignee: { name: string } | null; team: { key: string } | null; project: { id: string; name: string } | null;
}
/** Forme minimale commune aux tickets et sous-tickets. */
export type IssueLike = Pick<Issue, 'identifier' | 'title' | 'state'> & Partial<Issue>;
export interface Comment { id: string; body: string; createdAt: string; user: { name: string } | null }
/** Fiche complète d'un ticket. */
export interface IssueDetail extends Omit<Issue, 'team'> {
  description: string | null; createdAt: string; creator: { name: string } | null; team: Team;
  labels: { nodes: { name: string; color: string }[] };
  parent: { identifier: string; title: string } | null;
  children: { nodes: IssueLike[] };
  comments: { nodes: Comment[] };
}
export interface Project {
  id: string; name: string; description: string; url: string; progress: number;
  targetDate: string | null; startDate: string | null; lead: { name: string } | null;
  status: { name: string; type: string; color: string };
}
export interface Notification {
  id: string; type: string; createdAt: string; readAt: string | null; archivedAt: string | null; snoozedUntilAt: string | null;
  actor: { name: string; displayName: string } | null;
  issue?: { identifier: string; title: string; url: string };
  comment?: { body: string } | null;
  project?: { name: string; url: string };
}
/** Options d'un bloc ```linear. */
export interface Query { assignee?: string; states?: string[]; team?: string; search?: string; project?: string; label?: string; limit: number }

type Nodes<T> = { nodes: T[] };
const cache = new Map<string, { at: number; data: Issue[] }>(); // requête -> résultat

export const connected = (): boolean => !!vault.secret('linear');

export async function gql<T>(query: string, variables: Record<string, unknown> = {}, key: string | null = vault.secret('linear')): Promise<T> {
  if (!key) throw new Error('Linear n’est pas connecté (Réglages → Linear).');
  const r = await fetch(URL, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: key }, body: JSON.stringify({ query, variables }), credentials: 'omit', referrerPolicy: 'no-referrer' });
  const j = await r.json().catch(() => ({})) as { data?: T; errors?: { message?: string }[] };
  if (!r.ok || j.errors?.length || !j.data) throw new Error(j.errors?.[0]?.message || `Linear a répondu ${r.status}`);
  return j.data;
}

export const viewer = (key?: string): Promise<{ viewer: { id: string; name: string; email: string }; organization: { name: string } }> =>
  gql('query { viewer { id name email } organization { name } }', {}, key ?? vault.secret('linear'));
export const teams = async (): Promise<Team[]> => (await gql<{ teams: Nodes<Team> }>('query { teams(first: 50) { nodes { id key name } } }')).teams.nodes;

const STATES: Record<string, string> = { 'à faire': 'unstarted', todo: 'unstarted', 'en cours': 'started', started: 'started', backlog: 'backlog', 'terminé': 'completed', termine: 'completed', done: 'completed', 'annulé': 'canceled', triage: 'triage' };
const FIELDS = 'id identifier title url priority priorityLabel dueDate updatedAt state { name type color } assignee { name } team { key } project { id name }';

// Options d'un bloc ```linear (clé: valeur par ligne) -> filtre GraphQL.
export function parseBlock(src: string): Query {
  const o: Query = { limit: 10 };
  for (const line of src.split('\n')) {
    const m = line.match(/^\s*([\p{L}]+)\s*:\s*(.+?)\s*$/u); if (!m) continue;
    const k = (m[1] ?? '').toLowerCase(), v = m[2] ?? '';
    if (/^assign/.test(k)) o.assignee = v.toLowerCase() === 'moi' || v.toLowerCase() === 'me' ? 'me' : v;
    else if (/^(état|etat|state|statut)$/.test(k)) o.states = v.split(/[,|]/).map(s => STATES[s.trim().toLowerCase()] || s.trim());
    else if (/^(équipe|equipe|team)$/.test(k)) o.team = v.toUpperCase();
    else if (/^(recherche|search|titre)$/.test(k)) o.search = v;
    else if (/^(projet|project)$/.test(k)) o.project = v;
    else if (/^(limite|limit)$/.test(k)) o.limit = Math.min(50, Math.max(1, parseInt(v) || 10));
    else if (/^(label|étiquette|etiquette)$/.test(k)) o.label = v;
  }
  return o;
}

export async function issues(o: Query, { fresh = false } = {}): Promise<Issue[]> {
  const filter: Record<string, unknown> = {};
  if (o.assignee === 'me') filter.assignee = { isMe: { eq: true } };
  else if (o.assignee) filter.assignee = { name: { containsIgnoreCase: o.assignee } };
  if (o.states?.length) filter.state = { type: { in: o.states } };
  if (o.team) filter.team = { key: { eq: o.team } };
  if (o.search) filter.title = { containsIgnoreCase: o.search };
  if (o.project) filter.project = { name: { containsIgnoreCase: o.project } };
  if (o.label) filter.labels = { name: { eqIgnoreCase: o.label } };
  const k = JSON.stringify([filter, o.limit]), hit = cache.get(k);
  if (!fresh && hit && Date.now() - hit.at < 60e3) return hit.data;
  const d = await gql<{ issues: Nodes<Issue> }>(`query($f: IssueFilter, $n: Int) { issues(filter: $f, first: $n, orderBy: updatedAt) { nodes { ${FIELDS} } } }`, { f: filter, n: o.limit || 10 });
  cache.set(k, { at: Date.now(), data: d.issues.nodes });
  return d.issues.nodes;
}

// Détails de tickets à partir de leurs identifiants (ENG-42). Les identifiants inconnus sont simplement absents du résultat.
export async function issuesByIds(ids: string[]): Promise<Issue[]> {
  const or = ids.flatMap(id => { const m = id.match(/^([A-Z][A-Z0-9]*)-(\d+)$/); return m ? [{ team: { key: { eq: m[1] } }, number: { eq: Number(m[2]) } }] : []; }).slice(0, 40);
  if (!or.length) return [];
  const d = await gql<{ issues: Nodes<Issue> }>(`query($f: IssueFilter) { issues(filter: $f, first: 50) { nodes { ${FIELDS} } } }`, { f: { or } });
  return d.issues.nodes;
}

export async function createIssue({ teamId, title, description }: { teamId: string; title: string; description?: string }): Promise<{ identifier: string; url: string; title: string }> {
  const d = await gql<{ issueCreate: { issue: { identifier: string; url: string; title: string } } }>('mutation($i: IssueCreateInput!) { issueCreate(input: $i) { success issue { identifier url title } } }', { i: { teamId, title, description } });
  cache.clear();
  return d.issueCreate.issue;
}

export async function teamByKey(key?: string): Promise<Team | undefined> {
  const all = await teams();
  return key ? all.find(t => t.key.toLowerCase() === key.toLowerCase()) : all[0];
}

// ---------- Notifications (boîte de réception Linear) ----------
// Sans serveur, pas de webhook possible : l'app interroge Linear à intervalle régulier.
const NOTIF = `id type createdAt readAt archivedAt snoozedUntilAt actor { name displayName }
  ... on IssueNotification { issue { identifier title url } comment { body } }
  ... on ProjectNotification { project { name url } }`;

export async function notifications(): Promise<Notification[]> {
  const d = await gql<{ notifications: Nodes<Notification> }>(`query { notifications(first: 80) { nodes { ${NOTIF} } } }`);
  const now = new Date().toISOString();
  return d.notifications.nodes
    .filter(n => !n.archivedAt && !(n.snoozedUntilAt && n.snoozedUntilAt > now) && (n.issue || n.project))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// Marque lues plusieurs notifications en une seule requête (alias GraphQL).
export async function markRead(ids: string[], at = new Date().toISOString()): Promise<void> {
  ids = ids.filter(id => /^[\w-]+$/.test(id)).slice(0, 60);
  if (!ids.length) return;
  await gql(`mutation($t: DateTime) { ${ids.map((id, i) => `m${i}: notificationUpdate(id: "${id}", input: { readAt: $t }) { success }`).join(' ')} }`, { t: at });
}

// ---------- Projets, fiche de ticket, actions ----------
const PROJECT = 'id name description url progress targetDate startDate lead { name }';
type RawProject = Omit<Project, 'status'> & { status?: Project['status']; state?: string };
export async function projects(): Promise<Project[]> {
  const q = (extra: string) => gql<{ projects: Nodes<RawProject> }>(`query { projects(first: 60, orderBy: updatedAt) { nodes { ${PROJECT} ${extra} } } }`);
  let d; try { d = await q('status { name type color }'); } catch { d = await q('state'); } // anciens espaces : « state » seulement
  return d.projects.nodes.map(({ state, ...p }) => ({ ...p, status: p.status || { name: state || '', type: state || '', color: '' } }));
}
export async function projectIssues(id: string): Promise<Issue[]> {
  const d = await gql<{ project: { issues: Nodes<Issue> } }>(`query($id: String!) { project(id: $id) { issues(first: 150) { nodes { ${FIELDS} } } } }`, { id });
  return d.project.issues.nodes;
}
export async function issue(identifier: string): Promise<IssueDetail | null> {
  const d = await gql<{ issue: IssueDetail | null }>(`query($id: String!) { issue(id: $id) { ${FIELDS} description createdAt creator { name } team { id key name }
    labels { nodes { name color } } parent { identifier title } children { nodes { identifier title state { name type color } } }
    comments(first: 60) { nodes { id body createdAt user { name } } } } }`, { id: identifier });
  return d.issue;
}
export async function states(teamId: string): Promise<State[]> {
  const d = await gql<{ team: { states: Nodes<State> } }>('query($id: String!) { team(id: $id) { states { nodes { id name type color position } } } }', { id: teamId });
  const order = ['triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled'];
  return d.team.states.nodes.sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type) || (a.position ?? 0) - (b.position ?? 0));
}
export async function setState(issueId: string, stateId: string): Promise<void> {
  await gql('mutation($id: String!, $s: String!) { issueUpdate(id: $id, input: { stateId: $s }) { success } }', { id: issueId, s: stateId });
  cache.clear();
}
export async function addComment(issueId: string, body: string): Promise<void> {
  await gql('mutation($i: CommentCreateInput!) { commentCreate(input: $i) { success } }', { i: { issueId, body } });
}
