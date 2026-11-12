// Linear : appels GraphQL directs depuis le navigateur vers api.linear.app.
// La clé API vit chiffrée dans le coffre ; la politique de sécurité de la page (CSP)
// interdit de l'envoyer vers tout autre domaine.
import * as vault from '../../core/vault.js';

const URL = 'https://api.linear.app/graphql';
const cache = new Map(); // requête -> { at, data }

export const connected = () => !!vault.secret('linear');

export async function gql(query, variables = {}, key = vault.secret('linear')) {
  if (!key) throw new Error('Linear n’est pas connecté (Réglages → Linear).');
  const r = await fetch(URL, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: key }, body: JSON.stringify({ query, variables }), credentials: 'omit', referrerPolicy: 'no-referrer' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.errors?.length) throw new Error(j.errors?.[0]?.message || `Linear a répondu ${r.status}`);
  return j.data;
}

export const viewer = key => gql('query { viewer { id name email } organization { name } }', {}, key);
export const teams = async () => (await gql('query { teams(first: 50) { nodes { id key name } } }')).teams.nodes;

const STATES = { 'à faire': 'unstarted', todo: 'unstarted', 'en cours': 'started', started: 'started', backlog: 'backlog', 'terminé': 'completed', termine: 'completed', done: 'completed', 'annulé': 'canceled', triage: 'triage' };
const FIELDS = 'id identifier title url priority priorityLabel dueDate updatedAt state { name type color } assignee { name } team { key } project { id name }';

// Options d'un bloc ```linear (clé: valeur par ligne) -> filtre GraphQL.
export function parseBlock(src) {
  const o = { limit: 10 };
  for (const line of src.split('\n')) {
    const m = line.match(/^\s*([\p{L}]+)\s*:\s*(.+?)\s*$/u); if (!m) continue;
    const k = m[1].toLowerCase(), v = m[2];
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

export async function issues(o, { fresh = false } = {}) {
  const filter = {};
  if (o.assignee === 'me') filter.assignee = { isMe: { eq: true } };
  else if (o.assignee) filter.assignee = { name: { containsIgnoreCase: o.assignee } };
  if (o.states?.length) filter.state = { type: { in: o.states } };
  if (o.team) filter.team = { key: { eq: o.team } };
  if (o.search) filter.title = { containsIgnoreCase: o.search };
  if (o.project) filter.project = { name: { containsIgnoreCase: o.project } };
  if (o.label) filter.labels = { name: { eqIgnoreCase: o.label } };
  const k = JSON.stringify([filter, o.limit]), hit = cache.get(k);
  if (!fresh && hit && Date.now() - hit.at < 60e3) return hit.data;
  const d = await gql(`query($f: IssueFilter, $n: Int) { issues(filter: $f, first: $n, orderBy: updatedAt) { nodes { ${FIELDS} } } }`, { f: filter, n: o.limit || 10 });
  cache.set(k, { at: Date.now(), data: d.issues.nodes });
  return d.issues.nodes;
}

// Détails de tickets à partir de leurs identifiants (ENG-42). Les identifiants inconnus sont simplement absents du résultat.
export async function issuesByIds(ids) {
  const or = ids.map(id => id.match(/^([A-Z][A-Z0-9]*)-(\d+)$/)).filter(Boolean).slice(0, 40).map(m => ({ team: { key: { eq: m[1] } }, number: { eq: +m[2] } }));
  if (!or.length) return [];
  const d = await gql(`query($f: IssueFilter) { issues(filter: $f, first: 50) { nodes { ${FIELDS} } } }`, { f: { or } });
  return d.issues.nodes;
}

export async function createIssue({ teamId, title, description }) {
  const d = await gql('mutation($i: IssueCreateInput!) { issueCreate(input: $i) { success issue { identifier url title } } }', { i: { teamId, title, description } });
  cache.clear();
  return d.issueCreate.issue;
}

export async function teamByKey(key) {
  const all = await teams();
  return key ? all.find(t => t.key.toLowerCase() === key.toLowerCase()) : all[0];
}

// ---------- Notifications (boîte de réception Linear) ----------
// Sans serveur, pas de webhook possible : l'app interroge Linear à intervalle régulier.
const NOTIF = `id type createdAt readAt archivedAt snoozedUntilAt actor { name displayName }
  ... on IssueNotification { issue { identifier title url } comment { body } }
  ... on ProjectNotification { project { name url } }`;

export async function notifications() {
  const d = await gql(`query { notifications(first: 80) { nodes { ${NOTIF} } } }`);
  return d.notifications.nodes.filter(n => !n.archivedAt && !(n.snoozedUntilAt && n.snoozedUntilAt > new Date().toISOString()) && (n.issue || n.project)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// Marque lues plusieurs notifications en une seule requête (alias GraphQL).
export async function markRead(ids, at = new Date().toISOString()) {
  ids = ids.filter(id => /^[\w-]+$/.test(id)).slice(0, 60);
  if (!ids.length) return;
  await gql(`mutation($t: DateTime) { ${ids.map((id, i) => `m${i}: notificationUpdate(id: "${id}", input: { readAt: $t }) { success }`).join(' ')} }`, { t: at });
}

// ---------- Projets, fiche de ticket, actions ----------
const PROJECT = 'id name description url progress targetDate startDate lead { name }';
export async function projects() {
  const q = extra => gql(`query { projects(first: 60, orderBy: updatedAt) { nodes { ${PROJECT} ${extra} } } }`);
  let d; try { d = await q('status { name type color }'); } catch { d = await q('state'); } // anciens espaces : « state » seulement
  return d.projects.nodes.map(p => ({ ...p, status: p.status || { name: p.state || '', type: p.state || '', color: '' } }));
}
export async function projectIssues(id) {
  const d = await gql(`query($id: String!) { project(id: $id) { issues(first: 150) { nodes { ${FIELDS} } } } }`, { id });
  return d.project.issues.nodes;
}
export async function issue(identifier) {
  const d = await gql(`query($id: String!) { issue(id: $id) { ${FIELDS} description createdAt creator { name } team { id key name }
    labels { nodes { name color } } parent { identifier title } children { nodes { identifier title state { name type color } } }
    comments(first: 60) { nodes { id body createdAt user { name } } } } }`, { id: identifier });
  return d.issue;
}
export async function states(teamId) {
  const d = await gql('query($id: String!) { team(id: $id) { states { nodes { id name type color position } } } }', { id: teamId });
  const order = ['triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled'];
  return d.team.states.nodes.sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type) || a.position - b.position);
}
export async function setState(issueId, stateId) {
  await gql('mutation($id: String!, $s: String!) { issueUpdate(id: $id, input: { stateId: $s }) { success } }', { id: issueId, s: stateId });
  cache.clear();
}
export async function addComment(issueId, body) {
  await gql('mutation($i: CommentCreateInput!) { commentCreate(input: $i) { success } }', { i: { issueId, body } });
}
