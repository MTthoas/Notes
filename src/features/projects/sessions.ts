// Onglet « Claude Code » d'un projet : donner une consigne à Claude Code, suivre les agents en direct,
// relire et publier leur travail, reprendre une session. Tout s'exécute sur le Mac où se trouve le dossier
// du projet (voir native/Shared/Agents.swift pour les garde-fous).
import * as native from '../../core/native.ts';
import * as bridge from '../../integrations/remote.ts';
import * as usage from '../../integrations/usage.ts';
import * as ai from '../../integrations/ai.ts';
import * as github from '../../integrations/github/api.ts';
import { esc, renderMarkdown } from '../../lib/markdown.ts';
import { icon, rel, modal, need, toast, confirmBox, errMsg, $ } from '../../ui/kit.ts';
import * as review from './review.ts';
import * as store from '../../core/store.ts';
import * as model from './model.ts';
import * as saved from './drafts.ts';
import { menu } from '../../ui/kit.ts';
import type { Project } from './model.ts';

interface Tokens { input: number; output: number; cacheRead: number; cacheWrite: number }
interface Session { id: string; title: string; /** Titre écrit par Claude Code lui-même, s'il y en a un. */ aiTitle?: string; firstPrompt?: string; branch: string; worktree: string; started: string; updated: string; live: boolean; models: string[]; prompts: number; lastPrompt: string; tokens: Tokens; tools: Record<string, number>; files: string[] }
interface Quota { status?: string; resetsAt?: number; rateLimitType?: string; isUsingOverage?: boolean }
interface Action { at: string; kind: string; text: string }
export interface AgentRun { machine?: string; host?: string; run: string; mode: string; prompt: string; status: string; session: string; worktree: string; started: string; finished: string; result: string; lastText: string; turns: number; denials: string[]; quota?: Quota | null }
interface Worktree {
  name: string; branch: string; changes: number; ahead: number; behind?: number; pushed: boolean; conflicts?: string[];
  /** Titre du dernier commit de la copie, si elle en a un. */ subject?: string;
  /** La branche distante est exactement la copie : rien de nouveau à pousser. */ upToDate?: boolean;
  /** Le travail poussé est déjà fusionné dans la branche principale. */ merged?: boolean;
  /** Branches déjà livrées par cette copie (une discussion peut en livrer plusieurs), les plus récentes d'abord. */
  history?: { branch: string; subject: string; merged: boolean }[];
}
/** Tâche de l'orchestrateur (Orchestrator.swift) : publication ou mise à jour d'une copie. */
interface Job { job: string; kind: 'publish' | 'sync'; worktree: string; status: 'running' | 'done' | 'error' | 'blocked'; step: string; log: string[]; conflicts: string[]; branch: string; message: string }

let selected: string | null = null, timer: ReturnType<typeof setInterval> | undefined, tick = 0;
/** Message secondaire : écrit pendant que l'agent travaillait, remis à la fin de son tour (voir Agents.swift). */
interface Queued { id: string; session: string; text: string; at: string }
let runs: AgentRun[] = [], trees: Worktree[] = [], jobs: Job[] = [], queued: Queued[] = [];
const ms = (iso: string) => Date.parse(iso) || 0;
const short = (path: string, root: string | null) => root && path.includes('/.claude/worktrees/') ? path.replace(/^.*\/\.claude\/worktrees\/[^/]+\//, '') : root && path.startsWith(root + '/') ? path.slice(root.length + 1) : path.replace(/^\/Users\/[^/]+/, '~');
const modelName = (m: string) => m.replace(/^claude-/, '').replace(/-(\d)-(\d)$/, ' $1.$2').replace(/-/g, ' ');
const live = (r: AgentRun) => r.status === 'running' || r.status === 'starting';
const elapsed = (r: AgentRun) => { const s = Math.max(0, Math.round(((r.finished ? ms(r.finished) : Date.now()) - ms(r.started)) / 1000)); return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')}`; };
const STATUS: Record<string, [string, string]> = { starting: ['amber', 'Démarrage'], running: ['amber', 'En cours'], done: ['green', 'Terminé'], error: ['red', 'Erreur'], stopped: ['gray', 'Arrêté'] };
const pill = (s: string) => { const [c, l] = STATUS[s] ?? ['gray', s]; return `<span class="ag-pill${s === 'running' || s === 'starting' ? ' live' : ''}" style="--c:var(--c-${c})">${l}</span>`; };

// ---------- Conversation ouverte, et ce qu'en montrent la barre latérale et le fil d'Ariane ----------
/** Onglet affiché (pour le redessiner d'ailleurs : fil d'Ariane, suppression). */
let cur: { box: HTMLElement; p: Project } | null = null;
/** Projet de la conversation sélectionnée, et son nom une fois connu. */
let selFor = '', selTitle = '';
/** Dernières sessions lues, par projet. */
const known = new Map<string, { list: Session[]; at: number }>();

// Sous-agents : les tâches que Claude délègue pendant une conversation ont chacune leur propre fil (voir Sessions.swift).
// On en ouvre un depuis sa conversation, on passe de l'un à l'autre, et on peut l'épingler dans la barre latérale.
interface SubAgent { id: string; title: string; type: string; started: string; updated: string; live: boolean; tokens: number; steps: number }
/** Sous-agent ouvert dans la conversation sélectionnée, et son nom une fois connu. */
let sub: string | null = null, subTitle = '';
/** Derniers sous-agents lus, par conversation. */
const subsOf = new Map<string, SubAgent[]>();
/** Sous-agents épinglés dans la barre latérale : projet, conversation, sous-agent, et son nom au moment de l'épingler. */
interface Pin { p: string; s: string; a: string; t: string }
const PINS = 'studio.cc.subpins';
let pins: Pin[] = (() => {
  try {
    const v = JSON.parse(localStorage.getItem(PINS) || '[]') as unknown;
    return Array.isArray(v) ? (v as Partial<Pin>[]).filter(x => x && typeof x.p === 'string' && typeof x.s === 'string' && typeof x.a === 'string').map(x => ({ p: x.p ?? '', s: x.s ?? '', a: x.a ?? '', t: typeof x.t === 'string' ? x.t : '' })) : [];
  } catch { return []; }
})();
function savePins(): void {
  pins = pins.slice(-40);
  try { localStorage.setItem(PINS, JSON.stringify(pins)); } catch { /* stockage plein */ }
}
const pinned = (session: string, agent: string): boolean => pins.some(x => x.s === session && x.a === agent);
const subName = (session: string, agent: string): string => subsOf.get(session)?.find(x => x.id === agent)?.title || pins.find(x => x.s === session && x.a === agent)?.t || 'Sous-agent';
/** Retient les sous-agents d'une conversation ; le nom de ceux qui sont épinglés suit celui lu sur le Mac. */
function noteSubs(session: string, list: unknown): void {
  const subs = Array.isArray(list) ? list as SubAgent[] : [];
  subsOf.set(session, subs);
  let renamed = false;
  for (const x of pins) {
    const a = x.s === session ? subs.find(y => y.id === x.a) : undefined;
    if (a && a.title !== x.t) { x.t = a.title; renamed = true; }
  }
  if (renamed) savePins();
}
/** Ferme les sous-agents des conversations qu'on ne regarde plus : leur liste n'est plus tenue à jour une fois
 *  la conversation quittée (un point « en cours » y resterait allumé pour rien). Les épinglés gardent leur nom. */
function closeSubs(keep: string | null): void {
  for (const k of [...subsOf.keys()]) if (k !== keep) subsOf.delete(k);
}
/** Fil (conversation, ou conversation/sous-agent) vu au repos au dernier passage : il est relu moins souvent. */
let calm = '';
function togglePin(pid: string, session: string, agent: string): void {
  const had = pinned(session, agent), t = subName(session, agent);
  pins = pins.filter(x => !(x.s === session && x.a === agent));
  if (!had) pins.push({ p: pid, s: session, a: agent, t });
  savePins(); notify();
  toast(had ? 'Retiré de la barre latérale' : 'Épinglé dans la barre latérale, sous sa conversation');
}

let listener: (() => void) | null = null, lastSig = '';
/** Prévient l'application quand la liste des conversations, leurs noms ou la sélection changent. */
export const onChange = (f: () => void): void => { listener = f; };
function notify(): void {
  const sig = JSON.stringify([selFor, selected, selTitle, sub, subTitle, pins, (selected ? subsOf.get(selected) ?? [] : []).filter(a => a.live).map(a => a.id),
    [...known].map(([k, v]) => [k, v.list.slice(0, 8).map(s => [s.id, nameOf(s), s.live])]), runs.filter(live).map(r => r.session)]);
  if (sig === lastSig) return;
  lastSig = sig; listener?.();
}
/** Conversation ouverte dans ce projet, s'il y en a une, et le sous-agent qu'on y regarde. */
export function current(pid: string): { id: string; title: string; sub?: { id: string; title: string } } | null {
  if (!selected || selFor !== pid) return null;
  const s = known.get(pid)?.list.find(x => x.id === selected);
  return { id: selected, title: selTitle || (s ? nameOf(s) : 'Conversation'), ...(sub ? { sub: { id: sub, title: subTitle || subName(selected, sub) } } : {}) };
}
export interface SideSub { id: string; title: string; live: boolean; sel: boolean }
/** Conversations récentes d'un projet, pour la barre latérale, chacune avec ses sous-agents épinglés (et celui qui est ouvert). */
export function sideSessions(pid: string): { id: string; title: string; live: boolean; sel: boolean; subs: SideSub[] }[] {
  const list = known.get(pid)?.list ?? [], sel = selFor === pid ? selected : null, mine = pins.filter(x => x.p === pid);
  const top = list.slice(0, 6), extra = list.slice(6).filter(s => s.id === sel || mine.some(x => x.s === s.id));
  const subs = (sid: string): SideSub[] => {
    const ids = mine.filter(x => x.s === sid).map(x => x.a);
    if (sid === sel && sub && !ids.includes(sub)) ids.push(sub);
    return ids.map(a => ({ id: a, title: sid === sel && a === sub && subTitle ? subTitle : subName(sid, a), live: !!subsOf.get(sid)?.find(x => x.id === a)?.live, sel: sid === sel && a === sub }));
  };
  return [...top, ...extra].map(s => ({ id: s.id, title: s.id === sel && selTitle ? selTitle : nameOf(s), live: s.live || runs.some(r => r.session === s.id && live(r)), sel: s.id === sel, subs: subs(s.id) }));
}
async function loadList(p: Project): Promise<Session[] | null> {
  const r = await bridge.call('project', 'sessions', { project: p.id }, 20000);
  if (!r.ok) return null;
  const list = r.found ? (r.sessions as Session[] | undefined) ?? [] : [];
  known.set(p.id, { list, at: Date.now() });
  quota = (r.quota as Quota | null | undefined) ?? runs.find(x => x.quota)?.quota ?? null;
  notify();
  return list;
}
/** Lit les conversations du projet si on ne les connaît pas encore (pour la barre latérale, hors de l'onglet Claude Code). */
export function preload(p: Project): void {
  if (!bridge.where() || Date.now() - (known.get(p.id)?.at ?? 0) < 30000) return;
  void loadList(p);
}

// ---------- Nom des conversations ----------
// Comme sur les sites d'IA : un nom court qui résume toute la conversation, rédigé par l'IA branchée dans Studio et
// remis à jour quand la conversation avance. Sans IA, on garde le titre de Claude Code, sinon la première demande.
const TITLES = 'studio.cc.titles';
/** Nom donné par Studio, et nombre de demandes de la conversation à ce moment-là. */
interface Named { t: string; n: number }
let titles: Record<string, Named> = (() => { try { const v = JSON.parse(localStorage.getItem(TITLES) || '{}') as unknown; return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, Named> : {}; } catch { return {}; } })();
function saveTitles(): void {
  titles = Object.fromEntries(Object.entries(titles).slice(-300));
  try { localStorage.setItem(TITLES, JSON.stringify(titles)); } catch { /* stockage plein */ }
}
/** Première ligne d'un texte, nettoyée et coupée à un mot près. */
function neat(text: string, max = 60): string {
  const c = (text.split('\n').map(x => x.trim()).find(Boolean) ?? '').replace(/[#*`>"«»]/g, '').replace(/\s+/g, ' ').trim();
  if (c.length <= max) return c;
  const cut = c.slice(0, max), sp = cut.lastIndexOf(' ');
  return `${(sp > max / 2 ? cut.slice(0, sp) : cut).replace(/[\s,;:.]+$/, '')}…`;
}
type Nameable = Pick<Session, 'id' | 'title' | 'aiTitle' | 'firstPrompt' | 'prompts'>;
const nameOf = (s: Nameable): string => titles[s.id]?.t || s.aiTitle || (s.firstPrompt ? neat(s.firstPrompt) : '') || neat(s.title) || 'Conversation';

const TITLE_SYSTEM = `Tu donnes un nom à une conversation entre un développeur et un agent de code, comme dans la liste des conversations d’un assistant IA.
Réponds uniquement par le nom : 3 à 7 mots, dans la langue des demandes, sans guillemets, sans point final, sans préfixe.
Il résume le sujet de toute la conversation, pas seulement la dernière demande. Ignore les demandes de pure forme (« continue », « ok », « résous le conflit »).`;
let naming = false;
const nameFailed = new Map<string, number>();
/** Faut-il (re)nommer cette conversation ? Oui si elle n'a pas de nom, ou si elle a avancé depuis et que l'agent a fini de répondre. */
function wantsName(s: Nameable, working: boolean): boolean {
  if (!s.id || s.aiTitle || !s.prompts || !ai.ready()) return false;
  const have = titles[s.id];
  if (have && (s.prompts <= have.n || working)) return false;
  return Date.now() - (nameFailed.get(s.id) ?? 0) > 3e5;
}
/** Demande un nom à l'IA, d'après les demandes de l'utilisateur et la dernière réponse. Une conversation à la fois. */
async function nameSession(p: Project, s: Nameable, actions?: Action[]): Promise<void> {
  if (naming) return;
  naming = true;
  try {
    if (!actions) { const d = await bridge.call('project', 'session', { project: p.id, session: s.id }, 20000); actions = d.ok ? (d.actions as Action[] | undefined) ?? [] : []; }
    // Les notes jointes à une consigne ne font pas partie de la demande.
    const asks = actions.filter(a => a.kind === 'prompt').map(a => (a.text.split('\n---\nNotes du projet')[0] ?? '').trim().slice(0, 400)).filter(Boolean);
    const first = (s.firstPrompt ?? '').replace(/…$/, '').slice(0, 400);
    if (first && !asks.some(a => a.startsWith(first.slice(0, 120)))) asks.unshift(first);
    if (!asks.length) { nameFailed.set(s.id, Date.now()); return; }
    const picked = asks.length > 7 ? [...asks.slice(0, 2), ...asks.slice(-5)] : asks;
    const last = [...actions].reverse().find(a => a.kind === 'text')?.text.slice(0, 600) ?? '', have = titles[s.id];
    const user = `Demandes de l’utilisateur, dans l’ordre :\n${picked.map((a, i) => `${i + 1}. ${a}`).join('\n')}${last ? `\n\nDernière réponse de l’agent (extrait) :\n${last}` : ''}${have ? `\n\nNom actuel : ${have.t}\nGarde-le tel quel s’il résume toujours la conversation ; sinon adapte-le.` : ''}`;
    const t = neat((await ai.complete(TITLE_SYSTEM, user)).replace(/^(nom|titre)\s*:\s*/i, ''), 70).replace(/[.\s]+$/, '');
    if (!t) { nameFailed.set(s.id, Date.now()); return; }
    delete titles[s.id]; titles[s.id] = { t, n: s.prompts }; saveTitles();
    if (s.id === selected) selTitle = t;
    notify();
  } catch { nameFailed.set(s.id, Date.now()); }
  finally { naming = false; }
}

// ---------- Notes jointes ----------
// Une note du projet peut servir de contexte ou de cahier des charges : son contenu est ajouté à la consigne.
// Les notes chiffrées ou marquées #privé ne sont jamais envoyées.
const MAX_NOTE = 20000, MAX_ALL = 60000;
let pending: { project: string; notes: string[]; prompt: string } | null = null;
const titleOf = (id: string) => store.get(id)?.title.trim() || 'Sans titre';
const chip = (id: string) => `<span class="ag-note" data-note-id="${esc(id)}">${icon('notes')}${esc(titleOf(id))}<button type="button" data-ag-unnote="${esc(id)}" aria-label="Retirer la note">×</button></span>`;
/** Notes du projet qu'on peut joindre (lisibles, ni chiffrées ni privées). */
function attachable(p: Project): { id: string; title: string }[] {
  return model.notesOf(p).filter(n => n.id !== p.id && ai.shareable(n) && store.getBody(n) != null).map(n => ({ id: n.id, title: n.title.trim() || 'Sans titre' }));
}
/** Ouvre l'onglet Claude Code du projet avec des notes déjà jointes et, éventuellement, une consigne. */
export function handoff(p: Project, { notes = [] as string[], prompt = '' } = {}): void { pending = { project: p.id, notes, prompt }; selected = null; sub = null; }
/** Consigne finale : le texte de l'utilisateur, puis le contenu des notes jointes. */
function withNotes(prompt: string, ids: string[]): { text: string; refused: string[] } {
  const parts: string[] = [], refused: string[] = []; let total = 0;
  for (const id of ids) {
    const n = store.get(id), body = n ? store.getBody(n) : null;
    if (!n || body == null || !ai.shareable(n)) { refused.push(titleOf(id)); continue; }
    const chunk = body.length > MAX_NOTE ? body.slice(0, MAX_NOTE) + '\n…(tronquée)' : body;
    if (total + chunk.length > MAX_ALL) { refused.push(titleOf(id)); continue; }
    total += chunk.length; parts.push(`## Note « ${n.title.trim() || 'Sans titre'} »\n\n${chunk}`);
  }
  const head = prompt || (parts.length === 1 ? 'Réalise ce que décrit la note jointe.' : 'Réalise ce que décrivent les notes jointes.');
  return { text: parts.length ? `${head}\n\n---\nNotes du projet jointes par l’utilisateur (contexte et cahier des charges) :\n\n${parts.join('\n\n')}` : head, refused };
}

// ---------- Abonnement : ce qu'il reste ----------
// Bandeau au pied de la consigne : part restante de la session de 5 heures et de la semaine, comme « /usage » dans
// Claude Code. Les chiffres viennent du Mac (voir ClaudeUsage.swift), si l'utilisateur a accepté leur lecture.
// À défaut, on affiche l'état de la limite que Claude Code note lui-même quand elle approche ou est atteinte.
const LIMS: Record<string, [string, string]> = { five_hour: ['Session 5 h', 'Session de 5 heures'], seven_day: ['Semaine', 'Semaine, tous les modèles'], seven_day_opus: ['Semaine · Opus', 'Semaine, modèle Opus'], seven_day_sonnet: ['Semaine · Sonnet', 'Semaine, modèle Sonnet'], extra: ['Crédit supp.', 'Crédit supplémentaire'] };
let limits: ai.CcLimits | null = null, limitsAt = 0, limitsBusy = false, limitsWait = false, quota: Quota | null = null;

/** Délai avant une réinitialisation : « dans 2 h 14 », ou le jour et l'heure au-delà d'une journée. */
function resetIn(sec: number): string {
  const d = sec * 1000 - Date.now();
  if (d < 6e4) return 'dans un instant';
  if (d < 36e5) return `dans ${Math.ceil(d / 6e4)} min`;
  if (d < 864e5) { const m = Math.round(d / 6e4); return `dans ${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`; }
  return new Date(sec * 1000).toLocaleString('fr-FR', { weekday: 'long', hour: '2-digit', minute: '2-digit' });
}
const resetAt = (sec: number) => new Date(sec * 1000).toLocaleString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });

function limsHTML(): string {
  const l = limits, here = bridge.local();
  // Claude Code n'écrit l'état de la limite que lorsqu'elle approche : passé l'heure de réinitialisation, il est périmé.
  const q = quota?.status && !(quota.resetsAt && quota.resetsAt * 1000 <= Date.now()) ? quota : null;
  const refresh = `<button type="button" class="icon-btn" data-ag-lim="refresh" title="Actualiser" aria-label="Actualiser l’utilisation de l’abonnement">${icon('refresh')}</button>`;
  if (limitsWait) return '<em><span class="spin"></span>Lecture de ton abonnement…</em>';
  if (l?.enabled && l.ready && l.windows?.length) {
    return l.windows.map(w => {
      const [label, full] = LIMS[w.key] ?? [w.key, w.key];
      const used = Math.round(w.pct), left = Math.max(0, 100 - used), tone = used >= 90 ? ' err' : used >= 70 ? ' warn' : '';
      const reset = w.resetsAt && w.resetsAt * 1000 > Date.now() ? w.resetsAt : 0;
      return `<span class="ag-lim${tone}" title="${esc(`${full} : ${used} % utilisés${reset ? ` · se réinitialise ${resetAt(reset)}` : ''}`)}"><span>${esc(label)}</span><span class="bar ag-lim-bar"><i style="width:${left}%"></i></span><strong>${left} %</strong><em>restant${left > 1 ? 's' : ''}${reset ? ` · réinit. ${esc(resetIn(reset))}` : ''}</em></span>`;
    }).join('') + (q?.isUsingOverage && !l.windows.some(w => w.key === 'extra') ? '<em>crédit supplémentaire en cours d’utilisation</em>' : '') + refresh;
  }
  let out = '';
  if (q && q.status !== 'allowed') {
    const kind = LIMS[q.rateLimitType ?? '']?.[1] ?? 'Limite d’utilisation';
    out += `<span class="ag-lim ${q.status === 'rejected' ? 'err' : 'warn'}"><i class="ag-lim-dot"></i><strong>${esc(kind)} : ${q.status === 'rejected' ? 'limite atteinte' : 'limite bientôt atteinte'}</strong>${q.resetsAt ? `<em>réinit. ${esc(resetIn(q.resetsAt))}</em>` : ''}${q.isUsingOverage ? '<em>· crédit supplémentaire en cours d’utilisation</em>' : ''}</span>`;
  }
  if (!l) return out;
  if (!l.enabled) return out + (here ? `<button type="button" class="link-btn" data-ag-lim="on">Afficher ce qu’il reste de mon abonnement</button>` : '<em>Pour voir ici ce qu’il reste de ton abonnement, active la lecture des limites sur le Mac (Réglages → Intelligence artificielle).</em>');
  return out + `<em>${esc(l.message ?? 'Utilisation de l’abonnement illisible pour l’instant.')}</em>${here ? refresh : ''}`;
}
/** Redessine le bandeau de toutes les consignes affichées, seulement s'il a changé. */
function paintLimits(): void {
  const html = limsHTML();
  document.querySelectorAll<HTMLElement>('.ag-lims').forEach(x => { if (drawn.get(x) !== html) { x.innerHTML = html; drawn.set(x, html); } });
}
/** Lit l'utilisation de l'abonnement, au plus une fois par minute. `op` : 'enable' (accord donné) ou 'refresh' (sans cache), sur le Mac seulement. */
async function loadLimits(op = ''): Promise<void> {
  if (limitsBusy || !bridge.where() || (!op && Date.now() - limitsAt < 55000)) return;
  const here = bridge.local();
  limitsBusy = true; limitsAt = Date.now();
  if (op) { limitsWait = true; paintLimits(); }
  try {
    const r = await bridge.call('claude', 'limits', here ? { op } : {}, here ? 180000 : 30000);
    if (r.ok) { limits = r as unknown as ai.CcLimits; if (here) ai.cc.limits = limits; }
  } finally { limitsBusy = false; limitsWait = false; paintLimits(); }
}
async function limitsAction(op: string): Promise<void> {
  if (op === 'refresh') { await loadLimits('refresh'); return; }
  if (op !== 'on' || !bridge.local()) return;
  if (await confirmBox({ title: 'Afficher ce qu’il reste de ton abonnement ?', text: 'Anthropic ne donne l’utilisation qu’au compte connecté : Studio lira la connexion de Claude Code dans le trousseau de ce Mac (macOS te demandera ton accord) et interrogera api.anthropic.com, rien d’autre. Tu peux revenir en arrière dans Réglages → Intelligence artificielle.', ok: 'Afficher' })) await loadLimits('enable');
}

// ---------- Consigne ----------
const HINT_IDLE = `${icon('history')}Reprend la conversation là où elle s’est arrêtée, dans le même dossier.`;
const HINT_BUSY = '<span class="spin"></span>Claude travaille : écris la suite, elle lui sera remise d’un bloc à la fin de son tour. Pour corriger le tir tout de suite, arrête-le.';
const SEND_IDLE = `${icon('play')}Envoyer<kbd>⌘↩</kbd>`, SEND_BUSY = `${icon('history')}Mettre en attente<kbd>⌘↩</kbd>`;
/** Zone de réponse d'une conversation : pendant que son agent travaille, on peut l'arrêter, ou lui écrire
 *  des messages secondaires qu'il lira ensemble à la fin de son tour. */
function syncStop(box: HTMLElement): void {
  const f = $('.ag-continue', box); if (!f) return;
  const run = runs.find(r => r.session === selected && live(r)), state = run ? run.run : '';
  if (f.dataset.busy === state) return;
  f.dataset.busy = state;
  const stopBtn = $<HTMLButtonElement>('.ag-stop', f), send = $<HTMLButtonElement>('button.btn-primary', f), hint = $('[data-hint]', f);
  if (stopBtn) { stopBtn.hidden = !run; stopBtn.dataset.run = state; }
  if (send && !send.disabled) send.innerHTML = run ? SEND_BUSY : SEND_IDLE;
  if (hint) hint.innerHTML = run ? HINT_BUSY : HINT_IDLE;
}

const HINT_EDIT = `${icon('shield')}Copie isolée du dépôt : ton dossier reste intact.`, HINT_READ = `${icon('eye')}Lecture seule : analyse et propose, sans rien modifier.`;

// Modèle et niveau d'effort : choisis à chaque consigne, retenus pour la suivante. Une conversation garde les siens
// (ceux de son lancement, ou ceux qu'on lui donne en lui répondant). Voir drafts.ts.
const EFFORTS: [string, string][] = [['', 'Effort par défaut'], ['low', 'Effort faible'], ['medium', 'Effort moyen'], ['high', 'Effort élevé'], ['xhigh', 'Effort très élevé'], ['max', 'Effort maximal']];
/** Valeur de l'entrée « Autre modèle… » (jamais envoyée : elle ouvre la saisie d'un identifiant). */
const OTHER = '+';
function modelOptions(cur: string): string {
  const list: [string, string][] = ai.CC_MODELS.map(([v, l]): [string, string] => [v, v ? l : 'Modèle par défaut']);
  for (const v of [...saved.extraModels(), cur]) if (v && !list.some(x => x[0] === v)) list.push([v, modelName(v)]);
  return list.map(([v, l]) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(l)}</option>`).join('') + `<option value="${OTHER}">Autre modèle…</option>`;
}
const tuneHTML = (c: saved.Choice): string => `<select class="field" name="model" aria-label="Modèle" title="Modèle utilisé par Claude Code" data-prev="${esc(c.model)}">${modelOptions(c.model)}</select><select class="field" name="effort" aria-label="Niveau d’effort" title="Niveau d’effort : plus il est élevé, plus Claude réfléchit, et plus il consomme">${EFFORTS.map(([v, l]) => `<option value="${v}"${v === c.effort ? ' selected' : ''}>${l}</option>`).join('')}</select>`;
/** Demande l'identifiant d'un modèle absent de la liste ; il y reste ensuite proposé. `null` si l'utilisateur renonce. */
function askModel(): Promise<string | null> {
  return new Promise<string | null>(res => {
    let out: string | null = null;
    const m = modal({ title: 'Autre modèle', cls: 'small', onClose: () => res(out), html: `<form>
      <label class="pj-field"><span>Identifiant ou alias du modèle</span><input class="field" name="id" placeholder="claude-opus-5-5" spellcheck="false" autocomplete="off" autocapitalize="off" required></label>
      <p class="modal-hint">Tel que l’accepte <code>claude --model</code>. Il reste ensuite proposé dans la liste, sur cet appareil.</p>
      <p class="lock-err"></p>
      <div class="modal-actions"><button type="button" class="btn" data-x>Annuler</button><button class="btn btn-primary">Ajouter</button></div></form>` });
    need('[data-x]', m.node).onclick = m.close;
    need<HTMLFormElement>('form', m.node).onsubmit = e => {
      e.preventDefault();
      const v = need<HTMLInputElement>('[name=id]', m.node).value.trim().toLowerCase();
      if (!saved.MODEL_RE.test(v)) { need('.lock-err', m.node).textContent = 'Identifiant invalide : minuscules, chiffres, points et tirets (ex. claude-opus-5-5).'; return; }
      saved.addModel(v); out = v; m.close();
    };
  });
}
/** Suite d'un changement de modèle ou d'effort : saisie d'un autre modèle au besoin, puis le choix est retenu. */
async function tune(f: HTMLFormElement, t: HTMLSelectElement): Promise<void> {
  if (t.name === 'model' && t.value === OTHER) {
    const id = await askModel(), next = id ?? t.dataset.prev ?? '';
    // Le nouveau modèle est proposé dans tous les formulaires affichés ; sans saisie, la liste revient au choix d'avant.
    document.querySelectorAll<HTMLSelectElement>('.ag-compose select[name=model]').forEach(s => { s.innerHTML = modelOptions(s === t ? next : s.value === OTHER ? '' : s.value); });
    if (!f.isConnected) return;
  }
  const pick = (n: string) => f.querySelector<HTMLSelectElement>(`select[name=${n}]`)?.value ?? '';
  const c = { model: pick('model'), effort: pick('effort') };
  if (t.name === 'model') t.dataset.prev = c.model;
  if (f.dataset.session) saved.setSession(f.dataset.session, c); else saved.setDefaults(c);
}

/** Retient ce qui est écrit dans le formulaire, pour le retrouver après avoir navigué ailleurs (voir drafts.ts). */
function keepDraft(f: HTMLFormElement): void {
  const key = f.dataset.draft; if (!key) return;
  saved.saveDraft(key, { text: f.querySelector('textarea')?.value ?? '', notes: (f.dataset.notes || '').split(',').filter(Boolean),
    mode: f.querySelector<HTMLInputElement>('[name=mode]:checked')?.value ?? 'edit', tests: !!f.querySelector<HTMLInputElement>('[name=tests]')?.checked });
}

export function composerHTML(p: Project, { session = '', compact = false, machine = '' } = {}): string {
  // Un agent lancé sur un serveur utilise la connexion Claude du serveur, pas l'abonnement lu sur le Mac.
  const lims = machine === 'server' ? '' : `<div class="ag-lims" aria-label="Utilisation de l’abonnement Claude">${limsHTML()}</div>`;
  // Chaque formulaire a son brouillon : un par conversation, un pour la nouvelle consigne, un pour celle de l'aperçu, un pour le serveur.
  const key = `${p.id}|${session ? `s:${session}` : machine === 'server' ? 'server' : compact ? 'quick' : 'new'}`, d = saved.draft(key);
  if (session) return `<form class="ag-compose ag-continue" data-draft="${esc(key)}" data-session="${esc(session)}"${machine ? ` data-machine="${esc(machine)}"` : ''}><textarea name="prompt" rows="2" placeholder="Réponds à Claude : précise, corrige, tranche, demande la suite…" aria-label="Répondre dans la session">${esc(d?.text ?? '')}</textarea>
    <div class="ag-opts"><span class="ag-hint" data-hint>${HINT_IDLE}</span>${tuneHTML(saved.ofSession(session) ?? { model: '', effort: '' })}<button type="button" class="btn btn-danger ag-stop" data-ag="stop" hidden>${icon('stop')}Arrêter</button><button class="btn btn-primary">${SEND_IDLE}</button></div>${lims}</form>`;
  const pre = pending?.project === p.id ? pending : null; if (pre && !compact) pending = null;
  // Une note ou une tâche confiée à Claude s'ajoute au brouillon en cours, sans l'effacer.
  const hand = pre && !compact ? pre : null;
  const notes = compact ? [] : [...new Set([...(hand?.notes ?? []), ...(d?.notes ?? [])])].filter(id => store.get(id));
  const mine = d?.text ?? '', given = hand?.prompt ?? '';
  const text = given && mine.trim() && !mine.includes(given) ? `${mine.trimEnd()}\n\n${given}` : given || mine;
  const read = d?.mode === 'read', tests = !read && !!d?.tests;
  if (hand) saved.saveDraft(key, { text, notes, mode: read ? 'read' : 'edit', tests });
  return `<form class="ag-compose${compact ? ' compact' : ''}" data-draft="${esc(key)}" data-notes="${esc(notes.join(','))}"><textarea name="prompt" rows="${compact ? 1 : 3}" placeholder="Que doit faire Claude Code dans ${esc(p.name)} ? Ex. « Ajoute des tests au parseur de dates »" aria-label="Consigne pour Claude Code">${esc(text)}</textarea>
    <div class="ag-ctx">${notes.map(chip).join('')}<button type="button" class="ag-addnote" data-ag-note>${icon('plus')}Joindre une note</button></div>
    <div class="ag-opts">
      <div class="ag-seg" role="radiogroup" aria-label="Mode"><label><input type="radio" name="mode" value="edit"${read ? '' : ' checked'}><span>${icon('pencil')}Modifier</span></label><label><input type="radio" name="mode" value="read"${read ? ' checked' : ''}><span>${icon('search')}Analyser</span></label></div>
      ${bridge.local() && machine !== 'server' ? `<label class="ag-check" title="Autorise npm test et npm run … : le code du projet peut alors s’exécuter"><input type="checkbox" name="tests"${tests ? ' checked' : ''}${read ? ' disabled' : ''}>Tests npm</label>` : ''}
      <select class="field" name="machine" aria-label="Où travailler"${machine === 'server' ? '' : ' hidden'}><option value="mac">Sur le Mac</option>${machine === 'server' ? '<option value="server" selected>Sur le serveur</option>' : ''}</select>
      ${tuneHTML(saved.defaults())}
      <span class="ag-hint" data-hint>${read ? HINT_READ : HINT_EDIT}</span>
      <button class="btn btn-primary">${icon('play')}Lancer<kbd>⌘↩</kbd></button></div>${lims}</form>`;
}

/** Branche les formulaires de consigne présents dans `root` (lancement, reprise, raccourci ⌘↩). */
export function bindComposer(root: HTMLElement, p: Project, onStarted: (r: AgentRun) => void): void {
  void loadLimits();
  if (root.dataset.agBound) return;
  root.dataset.agBound = '1';
  root.addEventListener('input', e => {
    const t = e.target as HTMLElement, f = t.closest<HTMLFormElement>('.ag-compose');
    if (f && t.tagName === 'TEXTAREA') keepDraft(f);
  });
  root.addEventListener('change', e => {
    const t = e.target as HTMLInputElement, f = t.closest<HTMLFormElement>('.ag-compose'); if (!f) return;
    if (t.name === 'model' || t.name === 'effort') { void tune(f, t as unknown as HTMLSelectElement); return; }
    if (t.name === 'tests') { keepDraft(f); return; }
    if (t.name !== 'mode') return;
    const hint = $('[data-hint]', f), tests = $<HTMLInputElement>('[name=tests]', f);
    if (hint) hint.innerHTML = t.value === 'edit' ? HINT_EDIT : HINT_READ;
    if (tests) { tests.disabled = t.value !== 'edit'; if (tests.disabled) tests.checked = false; }
    keepDraft(f);
  });
  root.addEventListener('click', e => {
    const t = e.target as HTMLElement, f = t.closest<HTMLFormElement>('.ag-compose'); if (!f) return;
    const lim = t.closest<HTMLElement>('[data-ag-lim]');
    if (lim) { void limitsAction(lim.dataset.agLim ?? ''); return; }
    const ids = () => (f.dataset.notes || '').split(',').filter(Boolean);
    const un = t.closest<HTMLElement>('[data-ag-unnote]');
    if (un) { f.dataset.notes = ids().filter(x => x !== un.dataset.agUnnote).join(','); un.closest('.ag-note')?.remove(); keepDraft(f); return; }
    const add = t.closest<HTMLElement>('[data-ag-note]'); if (!add) return;
    const have = new Set(ids()), list = attachable(p).filter(n => !have.has(n.id));
    menu(add, list.length ? [{ label: 'Joindre une note du projet' }, ...list.map(n => ({ label: n.title, icon: 'notes', run: () => { f.dataset.notes = [...ids(), n.id].join(','); add.insertAdjacentHTML('beforebegin', chip(n.id)); keepDraft(f); } }))]
      : [{ label: model.notesOf(p).length > 1 ? 'Toutes les notes lisibles sont déjà jointes' : `Aucune note dans ce projet : ajoute #${p.tag} à une note` }]);
  });
  root.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && (e.target as HTMLElement).closest('.ag-compose')) { e.preventDefault(); (e.target as HTMLElement).closest<HTMLFormElement>('form')?.requestSubmit(); }
  });
  root.addEventListener('submit', async e => {
    const f = (e.target as HTMLElement).closest<HTMLFormElement>('.ag-compose'); if (!f) return;
    e.preventDefault(); e.stopPropagation();
    if (f.querySelector<HTMLButtonElement>('button.btn-primary')?.disabled) return; // envoi déjà parti
    const ta = need<HTMLTextAreaElement>('textarea', f), noteIds = (f.dataset.notes || '').split(',').filter(Boolean);
    if (!ta.value.trim() && !noteIds.length) { ta.focus(); return; }
    const built = withNotes(ta.value.trim(), noteIds), prompt = built.text;
    if (built.refused.length) toast(`Non jointe${built.refused.length > 1 ? 's' : ''} (verrouillée, privée ou trop longue) : ${built.refused.join(', ')}`);
    const btn = need<HTMLButtonElement>('button.btn-primary', f), label = btn.innerHTML;
    const val = (n: string) => (f.elements.namedItem(n) as HTMLInputElement | null);
    // Modèle et effort : envoyés aussi quand on répond, pour que la conversation garde (ou change) les siens.
    const picked: saved.Choice = { model: val('model')?.value ?? '', effort: val('effort')?.value ?? '' };
    if (picked.model === OTHER) picked.model = '';
    const body: Record<string, unknown> = { project: p.id, prompt, ...picked };
    if (f.dataset.session) { body.session = f.dataset.session; if (f.dataset.machine) body.machine = f.dataset.machine; }
    else { body.mode = f.querySelector<HTMLInputElement>('[name=mode]:checked')?.value ?? 'edit'; body.tests = !!val('tests')?.checked; const mc = val('machine'); if (mc && !mc.hidden) body.machine = mc.value; }
    btn.disabled = true; btn.innerHTML = '<span class="spin"></span>Envoi…';
    const r = await bridge.call('agent', 'start', body, 60000);
    btn.disabled = false; btn.innerHTML = label; delete f.dataset.busy;
    // En cas d'échec, le texte reste dans le formulaire et dans son brouillon.
    if (!r.ok) { toast(r.message ?? 'Lancement impossible.'); return; }
    ta.value = ''; f.dataset.notes = ''; f.querySelectorAll('.ag-note').forEach(x => x.remove());
    if (f.dataset.draft) saved.dropDraft(f.dataset.draft);
    // La conversation lancée garde le modèle et l'effort de sa première consigne : ils sont proposés pour la suite.
    if (!f.dataset.session && typeof r.session === 'string' && r.session) saved.setSession(r.session, picked);
    // L'agent travaille encore : le message attend la fin de son tour (il apparaît dans le fil, « en attente »).
    if (typeof r.queued === 'number') {
      toast(r.queued > 1 ? `${r.queued} messages en attente : Claude les lira ensemble à la fin de son tour` : 'Message en attente : Claude le lira à la fin de son tour');
      if (cur) void paint(cur.box, cur.p);
      return;
    }
    toast(f.dataset.session ? 'Session reprise' : 'Claude Code est au travail');
    onStarted(r as unknown as AgentRun);
  });
}

// ---------- Vues ----------
// Cartes d'agents terminés retirées de la liste par l'utilisateur (la conversation, elle, reste dans « Sessions »).
const HIDDEN = 'studio.cc.hiddenruns';
let hiddenRuns: string[] = (() => { try { const v = JSON.parse(localStorage.getItem(HIDDEN) || '[]') as unknown; return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []; } catch { return []; } })();
function hideRuns(ids: string[]): void {
  hiddenRuns = [...new Set([...hiddenRuns, ...ids])].slice(-200);
  try { localStorage.setItem(HIDDEN, JSON.stringify(hiddenRuns)); } catch { /* stockage plein */ }
}

function runCard(r: AgentRun): string {
  return `<article class="ag-run${live(r) ? ' live' : ''}">
    <header>${pill(r.status)}${r.machine === 'server' ? `<span class="ag-mode">${icon('server')}${esc(r.host ?? 'serveur')}</span>` : ''}<span class="ag-mode">${r.mode === 'edit' ? `${icon('pencil')}Modifier` : `${icon('search')}Analyser`}</span><time>${esc(elapsed(r))}${r.turns ? ` · ${r.turns} étape${r.turns > 1 ? 's' : ''}` : ''}</time>${live(r) ? '' : `<button class="icon-btn ag-hide" data-ag="hide-run" data-run="${esc(r.run)}" title="Retirer de la liste (la conversation reste dans Sessions)" aria-label="Retirer cet agent de la liste">${icon('x')}</button>`}</header>
    <p class="ag-prompt">${esc(r.prompt)}</p>
    ${live(r) && r.lastText ? `<p class="ag-last">${esc(r.lastText)}</p>` : ''}
    ${!live(r) && r.result ? `<p class="ag-last">${esc(r.result.replace(/[#*`>]/g, '').slice(0, 220))}</p>` : ''}
    ${r.denials.length ? `<p class="ag-denied">${icon('shield')}${r.denials.length} action${r.denials.length > 1 ? 's' : ''} refusée${r.denials.length > 1 ? 's' : ''} par les garde-fous</p>` : ''}
    <footer>${r.worktree ? `<code>${esc(r.worktree)}</code>` : ''}${r.session ? `<button class="btn" data-ss="${esc(r.session)}">${icon('eye')}Suivre</button>` : ''}${live(r) ? `<button class="btn" data-ag="stop" data-run="${esc(r.run)}">${icon('stop')}Arrêter</button>` : ''}</footer></article>`;
}

function treeRow(w: Worktree): string {
  const job = jobs.find(j => j.worktree === w.name), busy = job?.status === 'running';
  const conflicts = w.conflicts?.length ? `<span class="err"> · conflits : ${esc(w.conflicts.join(', '))}</span>` : '';
  const state = busy ? ` · <span class="spin"></span>${esc(job.step)}` : job?.status === 'error' || job?.status === 'blocked' ? `<span class="err"> · ${esc(job.step)}</span>` : conflicts;
  // Ce qui est déjà poussé ou fusionné n'est plus proposé : « Publier » ne sert qu'à du travail nouveau.
  const pending = w.pushed && !w.merged, fresh = w.changes > 0 || (w.ahead > 0 && !w.merged && !w.upToDate);
  const where = w.merged ? ' · <b class="ag-ok">déjà fusionnée dans la branche principale</b>' : pending ? (w.upToDate ? ' · poussée, PR en attente de fusion' : ' · poussée, changements à republier') : '';
  // Avec retard sur la branche principale, une copie fusionnée ou sans travail n'a rien à « mettre à jour » de visible.
  const canSync = !!w.behind && !busy && (w.changes > 0 || pending);
  const hist = w.history?.length ? `<span class="ag-hist">${w.history.map(h => `<span class="ag-hist-b${h.merged ? ' ok' : ''}" title="${esc(h.subject || h.branch)}">${icon(h.merged ? 'check' : 'pr')}<code>${esc(h.branch)}</code>${h.merged ? 'fusionnée' : 'PR en attente'}</span>`).join('')}</span>` : '';
  return `<div class="ag-tree"><span class="ag-tree-main"><code>${esc(w.branch || w.name)}</code><em>${w.changes ? `${w.changes} fichier${w.changes > 1 ? 's' : ''} modifié${w.changes > 1 ? 's' : ''}` : 'aucun changement en attente'}${w.ahead && !w.merged ? ` · ${w.ahead} commit${w.ahead > 1 ? 's' : ''}` : ''}${where}${w.behind && !w.merged && (w.changes || pending) ? ` · ${w.behind} commit${w.behind > 1 ? 's' : ''} de retard sur la branche principale` : ''}${state}</em>${hist}</span>
    <span class="ag-tree-act">${remote ? '<em class="ag-onmac">sur le Mac</em>' : `${canSync ? `<button class="btn" data-ag="sync" data-wt="${esc(w.name)}" title="Remettre la copie sur la dernière version de la branche principale ; l'agent résout les conflits éventuels">${icon('refresh')}Mettre à jour</button>` : ''}<button class="btn" data-ag="review" data-wt="${esc(w.name)}">${icon('sparkle')}Revue</button><button class="btn" data-ag="vscode" data-wt="${esc(w.name)}">${icon('code')}VS Code</button><button class="btn" data-ag="push" data-wt="${esc(w.name)}"${fresh && !busy ? '' : ' disabled'} title="${fresh ? 'Publier le nouveau travail de l’agent' : w.merged ? 'Déjà fusionné : rien de nouveau à publier' : pending ? 'Déjà poussé : rien de nouveau à publier' : 'Rien à publier'}">${icon('upload')}Publier</button>${pending ? `<button class="btn" data-ag="pr" data-wt="${esc(w.name)}" title="Ouvrir la page de la pull request sur GitHub">${icon('github')}PR</button>` : ''}${pending && !w.changes && !busy ? `<button class="btn" data-ag="newbranch" data-wt="${esc(w.name)}" title="Garder cette branche pour sa PR et repartir de la dernière version de la branche principale, sur une nouvelle branche, dans la même discussion">${icon('plus')}Nouvelle branche</button>` : ''}<button class="icon-btn" data-ag="discard" data-wt="${esc(w.name)}" title="Supprimer la copie" aria-label="Supprimer la copie">${icon('trash')}</button>`}</span></div>`;
}

function listHTML(list: Session[]): string {
  const running = runs.filter(live), recent = runs.filter(r => !live(r) && !hiddenRuns.includes(r.run)).slice(0, 4);
  const canClean = !remote && list.some(s => idle(s));
  const tot =list.reduce((t, s) => ({ input: t.input + s.tokens.input + s.tokens.cacheWrite, output: t.output + s.tokens.output, cacheRead: t.cacheRead + s.tokens.cacheRead }), { input: 0, output: 0, cacheRead: 0 });
  return `${running.length || recent.length ? `<h3 class="ss-h">Agents <span>${running.length ? `${running.length} en cours` : 'lancés depuis Studio'}</span>${recent.length > 1 ? `<button class="link-btn ss-h-act" data-ag="hide-runs">Retirer les terminés</button>` : ''}</h3><div class="ag-runs">${[...running, ...recent].map(runCard).join('')}</div>` : ''}
    ${trees.length ? `<h3 class="ss-h">Copies à relire <span>travail des agents, isolé de ton dossier</span></h3><div class="ag-trees">${trees.map(treeRow).join('')}</div>` : ''}
    <h3 class="ss-h">Sessions <span>tout ce que Claude Code a fait dans ce projet</span>${canClean ? `<button class="link-btn ss-h-act" data-ag="clean" title="Supprimer plusieurs conversations terminées d’un coup">Faire le ménage</button>` : ''}</h3>
    <div class="ss-totals"><div><strong>${list.length}</strong><span>session${list.length > 1 ? 's' : ''}</span></div><div><strong>${usage.fmt(tot.output)}</strong><span>tokens écrits</span></div><div><strong>${usage.fmt(tot.input)}</strong><span>tokens lus</span></div><div><strong>${usage.fmt(tot.cacheRead)}</strong><span>relus du cache</span></div></div>
    <div class="ss-list">${list.map(s => {
      const top = Object.entries(s.tools).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${esc(k)} ${v}`).join(' · ');
      return `<div class="ss-row${s.id === selected ? ' sel' : ''}"><button class="ss-open" data-ss="${esc(s.id)}"><i class="ss-live${s.live ? ' on' : ''}" title="${s.live ? 'En cours' : 'Inactive'}"></i>
        <span class="ss-main"><strong>${esc(nameOf(s))}</strong><em>${s.worktree ? `${icon('pencil')}copie · ` : s.branch ? `${icon('pr')}${esc(s.branch)} · ` : ''}${esc(s.models.map(modelName).join(', '))} · ${s.prompts} demande${s.prompts > 1 ? 's' : ''}${top ? ` · ${top}` : ''}</em></span>
        <span class="ss-tok">${usage.fmt(s.tokens.output)}<small>écrits</small></span><time>${esc(rel(ms(s.updated)))}</time></button>${remote ? '' : `<button class="icon-btn ss-del" data-ag="delete" data-session="${esc(s.id)}" title="Supprimer la conversation" aria-label="Supprimer la conversation ${esc(nameOf(s))}">${icon('trash')}</button>`}</div>`;
    }).join('') || '<p class="hm-empty">Aucune session Claude Code dans ce dossier pour l’instant. Donne une consigne ci-dessus pour lancer la première.</p>'}</div>`;
}

// ---------- Fil d'une session ----------
type Detail = Session & { actions: Action[] };
interface Block { key: string; html: string }
const FEED_MAX = 80; // nombre d'étapes renvoyées par le Mac (voir Sessions.swift)

/** Heure d'une étape ; avec la date si ce n'est pas aujourd'hui. */
function clock(iso: string): string {
  const t = ms(iso); if (!t) return '';
  const d = new Date(t), today = d.toDateString() === new Date().toDateString();
  return d.toLocaleString('fr-FR', today ? { hour: '2-digit', minute: '2-digit' } : { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** Markdown d'une réponse de Claude, sans les blocs propres aux notes (tags, liens entre notes, cases cochables). */
const answerHTML = (text: string): string => renderMarkdown(text)
  .replace(/<a class="(?:tag|wikilink)[^>]*>(.*?)<\/a>/g, '$1')
  .replace(/<input type="checkbox"/g, '<input type="checkbox" disabled');

/** Découpe les étapes en blocs de conversation : demandes, réponses, et outils consécutifs regroupés. */
function feedBlocks(actions: Action[], root: string | null, working: boolean, waiting: Queued[] = [], stalled = false, sidechain = false): Block[] {
  // Dans le fil d'un sous-agent, c'est Claude qui donne la consigne et le sous-agent qui répond.
  const asker = sidechain ? 'Claude' : 'Toi', answerer = sidechain ? 'Sous-agent' : 'Claude';
  const out: Block[] = [], seen = new Map<string, number>();
  const key = (a: Action, c: string) => { const k = `${c}|${a.at}`, n = seen.get(k) ?? 0; seen.set(k, n + 1); return n ? `${k}|${n}` : k; };
  const toolRow = (a: Action) => `<li><b>${esc(a.kind.slice(5))}</b><span>${esc(short(a.text, root))}</span></li>`;
  let group: Action[] = [];
  const flush = (last: boolean) => {
    const first = group[0], latest = group[group.length - 1]; if (!first || !latest) return;
    const k = key(first, 'tools');
    if (group.length === 1) out.push({ key: k, html: `<div class="ss-tools"><ul>${toolRow(first)}</ul></div>` });
    else {
      const counts = new Map<string, number>();
      for (const a of group) counts.set(a.kind.slice(5), (counts.get(a.kind.slice(5)) ?? 0) + 1);
      const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([n, c]) => `${esc(n)} ${c}`).join(' · ');
      const now = last && working ? `<em>${esc(`${latest.kind.slice(5)} ${short(latest.text, root)}`)}</em>` : '';
      out.push({ key: k, html: `<details class="ss-tools"><summary>${icon('bolt')}<strong>${group.length} actions</strong><span>${top}</span>${now}${icon('chevron')}</summary><ul>${group.map(toolRow).join('')}</ul></details>` });
    }
    group = [];
  };
  if (actions.length >= FEED_MAX) out.push({ key: 'cut', html: '<p class="ss-cut">Début de la session masqué : seules les dernières étapes sont affichées.</p>' });
  for (const a of actions) {
    if (a.kind.startsWith('tool:')) { group.push(a); continue; }
    flush(false);
    if (a.kind === 'prompt') out.push({ key: key(a, 'user'), html: `<div class="ss-msg user"><header><strong>${asker}</strong><time>${esc(clock(a.at))}</time></header><p>${esc(a.text)}</p></div>` });
    else out.push({ key: key(a, 'ai'), html: `<div class="ss-msg ai"><header><strong>${answerer}</strong><time>${esc(clock(a.at))}</time><button class="icon-btn ss-copy" data-ag="copy" title="Copier la réponse" aria-label="Copier la réponse">${icon('copy')}</button></header><div class="md">${answerHTML(a.text)}</div></div>` });
  }
  flush(true);
  if (!actions.length) out.push({ key: 'empty', html: `<p class="ss-cut">${working ? 'La session démarre…' : 'Aucune étape dans cette session.'}</p>` });
  if (working) out.push({ key: 'working', html: `<div class="ss-working"><span class="spin"></span>${sidechain ? 'Le sous-agent' : 'Claude'} travaille…</div>` });
  // Messages secondaires, pas encore lus par Claude : remis ensemble à la fin de son tour.
  for (const q of waiting) out.push({ key: `queued|${q.id}`, html: `<div class="ss-msg user queued"><header><strong>Toi</strong><em class="ss-wait">${icon('history')}en attente</em><time>${esc(clock(q.at))}</time><button class="icon-btn" data-ag="unqueue" data-q="${esc(q.id)}" title="Retirer ce message" aria-label="Retirer ce message">${icon('trash')}</button></header><p>${esc(q.text)}</p></div>` });
  // Le tour s'est fini sans eux (agent arrêté ou en erreur) : ils partent quand l'utilisateur le décide.
  if (waiting.length && stalled) out.push({ key: 'queued-send', html: `<p class="ss-cut">${waiting.length > 1 ? 'Ces messages n’ont pas été transmis' : 'Ce message n’a pas été transmis'} : l’agent s’est arrêté avant la fin de son tour. <button class="link-btn" data-ag="flush">${icon('play')}Envoyer maintenant</button></p>` });
  return out;
}

/** Met le fil à jour bloc par bloc : ce qui n'a pas changé n'est pas redessiné (sélection, blocs dépliés et défilement conservés). */
const drawn = new WeakMap<Element, string>();
function syncFeed(feed: HTMLElement, blocks: Block[]): boolean {
  const old = new Map<string, HTMLElement>();
  for (const el of Array.from(feed.children) as HTMLElement[]) old.set(el.dataset.k ?? '', el);
  let changed = false;
  blocks.forEach((b, i) => {
    const prev = old.get(b.key);
    let el = prev;
    if (!prev || drawn.get(prev) !== b.html) {
      const t = document.createElement('template'); t.innerHTML = b.html.trim();
      el = t.content.firstElementChild as HTMLElement;
      el.dataset.k = b.key; drawn.set(el, b.html);
      if (prev?.tagName === 'DETAILS' && el.tagName === 'DETAILS') (el as HTMLDetailsElement).open = (prev as HTMLDetailsElement).open;
    }
    if (el && feed.children[i] !== el) { feed.insertBefore(el, feed.children[i] ?? null); changed = true; }
  });
  while (feed.children.length > blocks.length) { feed.lastElementChild?.remove(); changed = true; }
  return changed;
}

/** Sous-agents de la conversation : chacun ouvre son fil ; celui qui est affiché est en surbrillance. */
function subsHTML(session: string, curId = ''): string {
  const list = subsOf.get(session) ?? []; if (!list.length) return '';
  const running = list.filter(a => a.live).length, n = list.length;
  return `<h3 class="ss-h">Sous-agents <span>${n} tâche${n > 1 ? 's' : ''} déléguée${n > 1 ? 's' : ''} par Claude${running ? ` · ${running} en cours` : ''}</span></h3>
    <div class="ss-subs">${list.map(a => `<button class="ss-sub${a.id === curId ? ' sel' : ''}" data-sa="${esc(a.id)}"${a.id === curId ? ' aria-current="true"' : ''} title="${esc(a.title)}"><i class="ss-live${a.live ? ' on' : ''}"></i><span>${esc(a.title)}</span>${a.type ? `<em>${esc(a.type)}</em>` : ''}${pinned(session, a.id) ? icon('pin') : ''}</button>`).join('')}</div>`;
}
/** En-tête du fil d'un sous-agent : son nom, l'épingle, et ses voisins pour passer de l'un à l'autre. */
function subTopHTML(s: Detail, a: SubAgent): string {
  const mn = Math.max(0, Math.round((ms(s.updated) - ms(s.started)) / 6e4)), acts = Object.values(s.tools).reduce((x, y) => x + y, 0), pin = pinned(s.id, a.id);
  return `<div class="ss-dhead"><i class="ss-live${a.live ? ' on' : ''}"></i><h2>${esc(a.title)}</h2>${a.type ? `<span class="ag-mode">${icon('bolt')}${esc(a.type)}</span>` : ''}<button class="btn ss-pin${pin ? ' on' : ''}" data-ag="pin-sub" aria-pressed="${pin}" title="${pin ? 'Retirer de la barre latérale' : 'Garder ce sous-agent dans la barre latérale, sous sa conversation'}">${icon('pin')}${pin ? 'Épinglé' : 'Épingler'}</button></div>
    <p class="ss-meta">${icon('eye')}Fil d’un sous-agent, en lecture seule · ${s.models.length ? `${esc(s.models.map(modelName).join(', '))} · ` : ''}${mn} min · ${acts} action${acts > 1 ? 's' : ''} · ${usage.fmt(s.tokens.output)} tokens écrits</p>
    ${subsHTML(s.id, a.id)}`;
}

function topHTML(s: Detail, root: string | null, open: boolean): string {
  const dur = ms(s.updated) - ms(s.started), h = Math.floor(dur / 36e5), mn = Math.round(dur % 36e5 / 6e4);
  const run = runs.find(r => r.session === s.id && live(r)), tree = s.worktree ? trees.find(t => t.name === s.worktree) : undefined;
  const acts = Object.values(s.tools).reduce((a, b) => a + b, 0);
  return `<div class="ss-dhead"><i class="ss-live${s.live || run ? ' on' : ''}"></i><h2>${esc(nameOf(s))}</h2>${run ? `${pill(run.status)}<button class="btn" data-ag="stop" data-run="${esc(run.run)}">${icon('stop')}Arrêter</button>` : ''}${remote || !s.id ? '' : `<button class="icon-btn" data-ag="delete" title="Supprimer la conversation" aria-label="Supprimer la conversation">${icon('trash')}</button>`}</div>
    <p class="ss-meta">${s.worktree ? `${icon('pencil')}copie isolée <code>${esc(s.worktree)}</code> · ` : s.branch ? `${icon('pr')}${esc(s.branch)} · ` : ''}${s.models.length ? `${esc(s.models.map(modelName).join(', '))} · ` : ''}${h ? `${h} h ` : ''}${mn} min · ${s.prompts} demande${s.prompts > 1 ? 's' : ''}</p>
    ${tree ? `<div class="ag-trees ss-tree">${treeRow(tree)}</div>` : remote ? '' : `<div class="ss-actions"><button class="btn" data-pj="review-working">${icon('sparkle')}Revue des changements en cours</button><button class="btn" data-pj="vscode">${icon('code')}Ouvrir dans VS Code</button></div>`}
    ${subsHTML(s.id)}
    <details class="ss-more"${open ? ' open' : ''}><summary>${icon('chevron')}Détails<span>${usage.fmt(s.tokens.output)} tokens écrits · ${acts} action${acts > 1 ? 's' : ''}${s.files.length ? ` · ${s.files.length} fichier${s.files.length > 1 ? 's' : ''} modifié${s.files.length > 1 ? 's' : ''}` : ''}</span></summary>
      <div class="ss-totals"><div><strong>${usage.fmt(s.tokens.output)}</strong><span>tokens écrits</span></div><div><strong>${usage.fmt(s.tokens.input + s.tokens.cacheWrite)}</strong><span>tokens lus</span></div><div><strong>${usage.fmt(s.tokens.cacheRead)}</strong><span>relus du cache</span></div><div><strong>${acts}</strong><span>actions</span></div></div>
      ${s.files.length ? `<h3 class="ss-h">Fichiers modifiés <span>${s.files.length}</span></h3><div class="ss-files">${s.files.map(f => `<code>${esc(short(f, root))}</code>`).join('')}</div>` : ''}</details>`;
}

const atEnd = (feed: HTMLElement) => feed.scrollHeight - feed.scrollTop - feed.clientHeight < 40;

/** Affiche une session dans `zone` ; les appels suivants ne touchent que ce qui a changé. */
function showDetail(zone: HTMLElement, raw: Partial<Session> & { actions?: Action[] }, root: string | null, agent?: SubAgent): void {
  // Une session qui vient de démarrer peut ne pas avoir encore toutes ses informations.
  const s: Detail = { id: '', title: 'Session qui démarre…', branch: '', worktree: '', started: '', updated: '', live: true, models: [], prompts: 0, lastPrompt: '', files: [], tools: {}, ...raw, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...raw.tokens }, actions: raw.actions ?? [] };
  let feed = $('.ss-feed', zone);
  const feedId = agent ? `${s.id}/${agent.id}` : s.id;
  if (!feed || feed.dataset.id !== feedId) {
    zone.innerHTML = `<div class="ss-top"></div><div class="ss-thread"><div class="ss-feed" role="log" aria-label="Fil de la session" tabindex="0"></div><button class="ss-jump" data-ag="end" hidden>${icon('chevron')}Nouvelles étapes</button></div>`;
    const f = need('.ss-feed', zone), jump = need('.ss-jump', zone);
    f.dataset.id = feedId;
    f.addEventListener('scroll', () => { if (atEnd(f)) jump.hidden = true; }, { passive: true });
    feed = f;
  }
  const top = need('.ss-top', zone), html = agent ? subTopHTML(s, agent) : topHTML(s, root, !!$<HTMLDetailsElement>('.ss-more', top)?.open);
  if (drawn.get(top) !== html) { top.innerHTML = html; drawn.set(top, html); }
  // « En cours » : l'agent lancé depuis Studio tourne encore, ou une session du terminal vient d'agir sans avoir répondu.
  // Un sous-agent, lui, travaille tant que son journal bouge et qu'il n'a pas rendu sa réponse.
  const own = agent ? [] : runs.filter(r => r.session === s.id), last = s.actions[s.actions.length - 1];
  const working = agent ? agent.live && !!last && last.kind !== 'text' : own.length ? own.some(live) : s.live && !!last && last.kind !== 'text';
  if (agent) { subTitle = agent.title; notify(); }
  else if (s.id === selected) {
    // Une session suivie par le flux de son agent (serveur) n'a pas de compteur de demandes : on les compte dans le fil.
    const named: Nameable = { ...s, prompts: s.prompts || s.actions.filter(a => a.kind === 'prompt').length };
    selTitle = nameOf(named); notify();
    if (cur && wantsName(named, working)) void nameSession(cur.p, named, s.actions);
  }
  const first = !feed.children.length, end = atEnd(feed);
  // Messages en attente restés en plan : le dernier tour s'est terminé autrement que normalement (arrêt, erreur).
  const latest = own.reduce<AgentRun | undefined>((a, r) => !a || ms(r.started) > ms(a.started) ? r : a, undefined);
  const stalled = !working && !!latest && !live(latest) && latest.status !== 'done';
  if (!syncFeed(feed, feedBlocks(s.actions, root, working, agent ? [] : queued.filter(q => q.session === s.id), stalled, !!agent))) return;
  if (first || end) feed.scrollTop = feed.scrollHeight;
  else need('.ss-jump', zone).hidden = false;
}

// ---------- Actions sur les copies ----------
// ---------- Message de commit (Conventional Commits) ----------
const TYPES = 'feat|fix|chore|docs|refactor|test|perf|style|build|ci';
const COMMIT_RE = new RegExp(`^(${TYPES})(\\([\\w./-]+\\))?!?: \\S`);
/** Types proposés en un clic dans la fenêtre de publication. */
const KINDS: [string, string][] = [['feat', 'Nouvelle fonctionnalité'], ['fix', 'Correction de bug'], ['chore', 'Entretien, configuration, dépendances'], ['refactor', 'Refonte sans changement de comportement'], ['docs', 'Documentation'], ['test', 'Tests']];
/** Remplace le type d'un titre en gardant sa portée et son résumé : « feat(ui): x » → « fix(ui): x ». */
const retype = (type: string, line: string): string => { const m = line.match(new RegExp(`^(?:${TYPES})(\\([^)]*\\))?!?:\\s*(.*)$`)); return m ? `${type}${m[1] ?? ''}: ${m[2] ?? ''}` : `${type}: ${line}`; };
/** Type probable d'après la consigne et les fichiers touchés. */
function guessType(text: string, files: string[]): string {
  if (files.length && files.every(f => /\.(md|txt)$|^docs?\//i.test(f))) return 'docs';
  if (files.length && files.every(f => /(^|\/)(tests?|__tests__)\/|\.(test|spec)\.\w+$/.test(f))) return 'test';
  if (/\b(corrig|répar|repar|bug|fix|erreur|crash|plante|régression)/i.test(text)) return 'fix';
  if (/\b(refacto|nettoi|simplifi|réorganis|renomm)/i.test(text)) return 'refactor';
  if (/\b(doc|readme|documentation)\b/i.test(text)) return 'docs';
  if (/\btests?\b/i.test(text)) return 'test';
  if (/\b(dépendances?|mise à jour|mettre à jour|upgrade|bump|config|workflow|ci)\b/i.test(text)) return 'chore';
  return 'feat';
}
/** Fichiers listés par `git diff --stat`. */
const statFiles = (stat: string): string[] => stat.split('\n').map(l => l.split('|')[0]?.trim() ?? '').filter(f => f && !/files? changed/.test(f));
/** Proposition de dernier recours, sans agent ni IA : le type, puis ce qui a changé d'après les fichiers.
 *  La consigne ne sert qu'à deviner le type ; elle n'est jamais recopiée dans le message. */
function draftMessage(prompt: string, files: string[]): string {
  const type = guessType(prompt, files), verb = type === 'fix' ? 'correct' : type === 'refactor' ? 'rework' : 'update';
  // `git diff --stat` abrège les chemins longs (« .../x.ts ») et note les renommages (« a => b ») : on garde la cible.
  const paths = files.map(f => (f.split(' => ').pop() ?? f).replace(/[{}]/g, '').replace(/^\.\.\.\//, ''));
  const names = paths.map(f => f.split('/').pop() ?? f);
  const dirs = [...new Set(paths.map(f => f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : ''))];
  const what = !names.length ? 'project files'
    : names.length === 1 ? names[0]
    : names.length === 2 ? `${names[0]} and ${names[1]}`
    : dirs.length === 1 && dirs[0] ? `${dirs[0]} (${names.length} files)` : `${names.length} files`;
  const line = `${type}: ${verb} ${what}`;
  return line.length > 72 ? `${type}: ${verb} ${names.length} file${names.length > 1 ? 's' : ''}` : line;
}
/** Ligne « Commit: … » que l'agent écrit à la fin de son compte rendu (il sait ce qu'il a fait, sur toute la copie). */
function agentMessage(result: string): string {
  const line = result.split('\n').reverse().map(l => l.trim().replace(/^[-*>\s]+/, '').replace(/[`*]/g, '')).find(l => /^commit\s*:/i.test(l));
  const msg = line?.replace(/^commit\s*:\s*/i, '').replace(/[.\s]+$/, '').replace(/^[A-Za-z]+/, t => t.toLowerCase()) ?? '';
  return COMMIT_RE.test(msg) ? (msg.length > 72 ? msg.slice(0, 71).trimEnd() + '…' : msg) : '';
}
/** Message de l'agent retrouvé dans le fil de sa session, sur disque : les comptes rendus des agents
 *  ne sont gardés qu'en mémoire, et disparaissent au redémarrage de Studio. */
async function sessionMessage(p: Project, wt: string): Promise<string> {
  try {
    const l = await native.call('project', 'sessions', { project: p.id }, 20000);
    const s = ((l.sessions as Session[] | undefined) ?? []).find(x => x.worktree === wt);
    if (!s) return '';
    const d = await native.call('project', 'session', { project: p.id, session: s.id }, 20000);
    if (!d.ok) return '';
    return ((d.actions as Action[] | undefined) ?? []).filter(a => a.kind === 'text').reverse().map(a => agentMessage(a.text)).find(Boolean) ?? '';
  } catch { return ''; }
}
/** Titre tiré d'une branche déjà nommée par Studio : « feat/tasks-add-parser-tests » → « feat: tasks add parser tests ». */
const subjectFromBranch = (branch: string): string => { const m = branch.match(new RegExp(`^(${TYPES})/(.+)$`)); return m ? `${m[1]}: ${m[2]!.replace(/[-_/]+/g, ' ')}` : ''; };
/** Compte rendu sans la ligne de commit (pour la description de la PR). */
const withoutCommitLine = (result: string) => result.split('\n').filter(l => !/^[-*>\s`]*commit\s*:/i.test(l.trim())).join('\n').trim();
/** Nettoie la réponse de l'IA : 1 ligne de titre conforme, et au plus 1 ligne de détail. */
function cleanMessage(raw: string, fallbackType: string): string {
  const lines = raw.replace(/```\w*/g, '').split('\n').map(l => l.trim().replace(/^["'`]+|["'`]+$/g, '')).filter(Boolean);
  let subject = lines[0] ?? '';
  if (!subject) return '';
  if (!COMMIT_RE.test(subject)) subject = `${fallbackType}: ${subject.replace(/^\w+(\(.*?\))?:\s*/, '')}`;
  subject = subject.length > 72 ? subject.slice(0, 71).trimEnd() + '…' : subject;
  const detail = lines.slice(1).find(l => !COMMIT_RE.test(l));
  return detail ? `${subject}\n\n${detail.slice(0, 160)}` : subject;
}
const COMMIT_SYSTEM = `Tu écris des messages de commit au format Conventional Commits.
Réponds uniquement par le message, sans guillemets, sans bloc de code, sans explication.
Ligne 1 : type(portée): résumé — types : feat, fix, chore, docs, refactor, test, perf, style, build, ci ; portée facultative et courte ; 72 caractères au plus ; à l’impératif ; sans point final.
Ligne 2 (facultative) : une seule phrase de détail, seulement si elle apporte quelque chose.
Écris dans la même langue que les commits récents du dépôt, et dans le même style.
Décris ce que fait le diff dans son ensemble. La consigne n'est qu'un contexte, ne la recopie et ne la paraphrase jamais : elle peut être une simple demande de suivi (« résous le conflit », « continue ») ; ne parle jamais de conflit, de fusion ni de l'agent.`;
async function suggestMessage(p: Project, wt: string, run: AgentRun | undefined, forceAI = false): Promise<{ draft: string; fromAgent: boolean; ai: Promise<string> | null; files: string[] }> {
  const d = await native.call('project', 'diff', { project: p.id, scope: 'working', worktree: wt }, 30000);
  const stat = String(d.stat ?? ''), files = statFiles(stat), prompt = run?.prompt ?? wt.replace(/^studio-|-\d{4}-\d{4}$/g, '').replace(/-/g, ' ');
  // 1. le message écrit par l'agent (compte rendu le plus récent qui en contient un, sinon le fil de sa session) ;
  // 2. l'IA d'après le diff ; 3. en dernier recours, un résumé des fichiers modifiés. Jamais la consigne telle quelle.
  // Un message qui a déjà servi à une branche livrée par cette copie décrit du travail fusionné : il n'est plus proposé.
  const tree = trees.find(t => t.name === wt), shipped = new Set((tree?.history ?? []).map(h => h.subject).concat(tree?.merged && tree.subject ? [tree.subject] : []));
  const fresh = (m: string) => m && !shipped.has(m) ? m : '';
  const fromAgent = runs.filter(r => r.worktree === wt && r.result).map(r => fresh(agentMessage(r.result))).find(Boolean) || fresh(await sessionMessage(p, wt));
  const draft = fromAgent || draftMessage(prompt, files);
  if ((fromAgent && !forceAI) || !d.ok || !ai.ready() || !String(d.patch ?? '').trim()) return { draft, fromAgent: !!fromAgent, ai: null, files };
  const user = `Consigne donnée à l’agent : ${prompt}\n\n${run?.result ? `Compte rendu de l’agent :\n${run.result.slice(0, 1500)}\n\n` : ''}Commits récents du dépôt :\n${String(d.log ?? '').trim() || '(aucun)'}\n\nFichiers modifiés :\n${stat}\n\nDiff (extrait) :\n\`\`\`diff\n${String(d.patch).slice(0, 20000)}\n\`\`\``;
  return { draft, fromAgent: !!fromAgent, files, ai: ai.complete(COMMIT_SYSTEM, user).then(t => cleanMessage(t, guessType(prompt, files))) };
}

/** Nom de branche conventionnel tiré du titre du commit : « feat(tasks): add parser tests » → feat/tasks-add-parser-tests. */
export function branchName(subject: string): string {
  const m = subject.match(new RegExp(`^(${TYPES})(?:\\(([^)]+)\\))?!?:\\s*(.*)$`));
  const type = m?.[1] ?? 'feat', words = `${m?.[2] ?? ''} ${m?.[3] ?? subject}`.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  let slug = '';
  for (const w of words) { if ((slug + '-' + w).length > 44) break; slug = slug ? `${slug}-${w}` : w; }
  return `${type}/${slug || 'update'}`;
}

/** Page GitHub de création de la PR, déjà remplie (marche avec n'importe quel jeton, ou sans). */
const compareURL = (repo: string, base: string, branch: string, title: string, body: string) =>
  `https://github.com/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(branch)}?quick_pull=1&title=${encodeURIComponent(title)}&body=${encodeURIComponent(body.slice(0, 3500))}`;
const prBody = (run: AgentRun | undefined, detail: string) => `${detail ? `${detail}\n\n` : ''}${run?.result ? `${withoutCommitLine(run.result)}\n\n` : ''}---\nPréparé par Claude Code depuis Studio.`;

async function publish(p: Project, wt: string, root: HTMLElement): Promise<void> {
  // La première demande faite dans cette copie (les suivantes sont souvent « continue », « résous le conflit »…).
  const mine = runs.filter(r => r.worktree === wt), run = mine[mine.length - 1], repo = p.repos[0];
  const canPR = !!repo && github.connected();
  const m = modal({ cls: 'ag-pub', title: 'Publier le travail de l’agent', html: `
    <div class="pub-type"><span>Type</span><div class="ag-seg" role="radiogroup" aria-label="Type de changement">${KINDS.map(([k, l]) => `<label title="${esc(l)}"><input type="radio" name="ctype" value="${k}"><span>${k}</span></label>`).join('')}</div></div>
    <label class="pj-field"><span class="ag-msg-h">Message de commit<em class="ag-sug" hidden>${icon('sparkle')}proposé par l’IA</em></span><textarea class="field ag-msg" name="msg" rows="3" spellcheck="false" required></textarea></label>
    <div class="ag-sug-row"><span class="ag-sug-st"><span class="spin"></span>Lecture des changements…</span><button type="button" class="link-btn" data-resug hidden>${icon('refresh')}Reproposer</button></div>
    <label class="pj-field"><span>Branche</span><input class="field ag-branch" name="branch" spellcheck="false" autocomplete="off" required></label>
    ${repo ? `<label class="cx-check"><input type="checkbox" name="pr" checked> Ouvrir une pull request sur <strong>${esc(repo)}</strong></label>
    <label class="pj-field"><span>Titre de la PR</span><input class="field" name="title"></label>` : '<p class="modal-hint">Associe un dépôt GitHub au projet pour ouvrir une pull request.</p>'}
    <p class="modal-hint">${icon('shield')}Studio remet d’abord la copie sur la dernière version de la branche principale (l’agent résout les conflits s’il y en a), puis fait un seul commit avec ce message et pousse la branche avec tes identifiants Git habituels. Ton dossier de travail n’est pas touché.</p>
    <div class="rv-status"></div>
    <div class="modal-actions"><button class="btn" data-x>Annuler</button><button class="btn btn-primary" data-go>${icon('upload')}Publier</button></div>` });
  const msg = need<HTMLTextAreaElement>('[name=msg]', m.node), title = m.node.querySelector<HTMLInputElement>('[name=title]');
  const sugSt = need('.ag-sug-st', m.node), sugTag = need('.ag-sug', m.node), resug = need<HTMLButtonElement>('[data-resug]', m.node);
  const branchIn = need<HTMLInputElement>('[name=branch]', m.node);
  let editedMsg = false, editedTitle = false, editedBranch = false;
  // Branche déjà poussée et pas encore fusionnée : publier la met à jour (et sa PR) ; un autre nom crée une branche à part.
  const tree = trees.find(t => t.name === wt);
  if (tree?.pushed && !tree.merged && tree.branch) {
    branchIn.value = tree.branch; editedBranch = true;
    branchIn.closest('.pj-field')?.insertAdjacentHTML('beforeend', `<em class="modal-hint">${esc(tree.branch)} est déjà poussée : publier met à jour sa PR. Un autre nom crée une nouvelle branche (qui contiendra aussi ce travail déjà poussé).</em>`);
  }
  const subject = () => msg.value.split('\n')[0]?.trim() ?? '';
  const typeOf = () => new RegExp(`^(${TYPES})`).exec(subject())?.[1] ?? '';
  const sync = () => {
    if (title && !editedTitle) title.value = subject();
    if (!editedBranch) branchIn.value = branchName(subject());
    m.node.querySelectorAll<HTMLInputElement>('[name=ctype]').forEach(r => { r.checked = r.value === typeOf(); });
  };
  // Changer de type réécrit seulement le préfixe du message (la portée et le résumé restent).
  m.node.addEventListener('change', e => {
    const t = e.target as HTMLInputElement; if (t.name !== 'ctype') return;
    const lines = msg.value.split('\n'); lines[0] = retype(t.value, lines[0] ?? ''); msg.value = lines.join('\n'); sync();
  });
  branchIn.addEventListener('input', () => { editedBranch = true; });
  msg.addEventListener('input', () => { editedMsg = true; sugTag.hidden = true; sync(); });
  title?.addEventListener('input', () => { editedTitle = true; });
  const go = need<HTMLButtonElement>('[data-go]', m.node), st = need('.rv-status', m.node);
  let drafting = false;
  const ready = () => { go.disabled = drafting && !editedMsg; };
  msg.addEventListener('input', ready);
  const propose = async (forceAI = false) => {
    resug.hidden = true; drafting = true; ready(); sugSt.innerHTML = '<span class="spin"></span>Lecture des changements…';
    try {
      const s = await suggestMessage(p, wt, run, forceAI);
      if (!m.node.isConnected) return;
      if (!editedMsg) { msg.value = s.draft; sync(); }
      if (!s.ai) {
        sugSt.textContent = s.fromAgent ? 'Message rédigé par l’agent à partir de son travail.' : ai.ready() ? 'Proposition tirée des fichiers modifiés : précise-la.' : 'Proposition tirée des fichiers modifiés : précise-la · connecte une IA pour un message rédigé d’après le diff.';
        resug.hidden = !ai.ready(); return;
      }
      sugSt.innerHTML = `<span class="spin"></span>L’IA rédige le message d’après le diff (${esc(ai.PROVIDERS[ai.config().provider])})…`;
      const text = await s.ai; if (!m.node.isConnected) return;
      if (text && !editedMsg) { msg.value = text; sugTag.hidden = false; sync(); }
      sugSt.textContent = editedMsg ? 'Tu as modifié le message : la proposition de l’IA n’a pas été appliquée.' : `${s.files.length} fichier${s.files.length > 1 ? 's' : ''} modifié${s.files.length > 1 ? 's' : ''}.`;
    } catch (e) { sugSt.innerHTML = `<span class="err">Pas de proposition de l’IA : ${esc(errMsg(e))}</span>`; }
    finally { drafting = false; ready(); }
    resug.hidden = !ai.ready();
  };
  resug.onclick = () => { editedMsg = false; void propose(true); };
  void propose();
  need('[data-x]', m.node).onclick = m.close;

  /** Suit la tâche de l'orchestrateur jusqu'à sa fin (elle continue côté Mac si la fenêtre est fermée). */
  const follow = async (id: string): Promise<Job | null> => {
    for (;;) {
      const j = await native.call('agent', 'job', { job: id }, 10000) as unknown as Job & { ok: boolean };
      if (!m.node.isConnected) return null;
      if (!j.ok) { st.innerHTML = '<p class="rv-status err">Tâche perdue.</p>'; return null; }
      st.innerHTML = `<ol class="ag-steps">${j.log.map((l, i) => `<li${i === j.log.length - 1 && j.status === 'running' ? ' class="on"' : ''}>${i === j.log.length - 1 && j.status === 'running' ? '<span class="spin"></span>' : ''}${esc(l)}</li>`).join('')}</ol>`;
      if (j.status !== 'running') return j;
      await new Promise(r => setTimeout(r, 1500));
    }
  };

  go.onclick = async () => {
    const wantPR = !!repo && !!m.node.querySelector<HTMLInputElement>('[name=pr]')?.checked;
    const message = msg.value.trim(); if (!message) { msg.focus(); return; }
    const prTitle = title?.value.trim() || subject(), detail = message.split('\n').slice(1).join('\n').trim();
    const wanted = branchIn.value.trim();
    if (!/^[a-z0-9][a-z0-9._/-]{0,89}$/.test(wanted) || wanted.includes('..') || wanted.endsWith('/')) { st.innerHTML = '<p class="rv-status err">Nom de branche invalide : minuscules, chiffres, - _ . / (ex. feat/export-pdf).</p>'; branchIn.focus(); return; }
    go.disabled = true; st.innerHTML = '<p class="rv-status"><span class="spin"></span>Démarrage…</p>';
    const started = await native.call('agent', 'publish', { project: p.id, worktree: wt, message, branch: wanted }, 30000);
    if (!started.ok) { st.innerHTML = `<p class="rv-status err">${esc(started.message ?? 'Échec.')}</p>`; go.disabled = false; return; }
    void refreshTrees(p).then(() => paint(root, p));
    const j = await follow(String(started.job));
    void refreshTrees(p).then(() => paint(root, p));
    if (!j) return;
    if (j.status === 'blocked') {
      st.insertAdjacentHTML('beforeend', `<div class="ag-prfail"><p class="err">L’agent n’a pas pu résoudre ces conflits : ${j.conflicts.map(f => `<code>${esc(f)}</code>`).join(', ')}.</p><p>Retire les marqueurs <code>&lt;&lt;&lt;&lt;&lt;&lt;&lt;</code> / <code>&gt;&gt;&gt;&gt;&gt;&gt;&gt;</code> dans VS Code, ou réponds à l’agent dans sa session, puis publie à nouveau.</p><div class="ag-prfail-act"><button class="btn" data-ag-open>${icon('code')}Ouvrir dans VS Code</button></div></div>`);
      st.querySelector<HTMLElement>('[data-ag-open]')!.onclick = async () => { const r = await native.call('project', 'open', { project: p.id, app: 'vscode', worktree: wt }, 15000); if (!r.ok) toast(r.message ?? 'Impossible d’ouvrir.'); };
      go.disabled = false; go.innerHTML = `${icon('upload')}Réessayer`; return;
    }
    if (j.status !== 'done') { go.disabled = false; return; }
    const branch = j.branch;
    // Rien n'a été poussé : le travail était déjà fusionné dans la branche principale.
    if (!branch) { m.close(); toast(j.step); return; }
    if (!wantPR || !repo) { m.close(); toast(`Branche ${branch} poussée`); return; }
    st.insertAdjacentHTML('beforeend', '<p class="rv-status"><span class="spin"></span>Ouverture de la pull request…</p>');
    let base = 'main';
    try {
      if (!canPR) throw new Error('GitHub n’est pas connecté dans Studio');
      base = (await github.project(repo)).info.default_branch;
      const pr = await github.createPull(repo, { head: branch, base, title: prTitle, body: prBody(run, detail) });
      m.close(); toast(`PR #${pr.number} ouverte`); window.open(pr.html_url, '_blank', 'noopener');
    } catch (e) {
      const why = errMsg(e), perm = /not accessible|403|permission/i.test(why), exists = /already exists/i.test(why);
      if (exists) { m.close(); toast('Branche poussée : sa pull request est à jour.'); return; }
      st.innerHTML = `<div class="ag-prfail"><p>${icon('check')}Branche <code>${esc(branch)}</code> poussée sur GitHub.</p>
        <p class="err">${perm ? 'Ton jeton GitHub n’a pas le droit d’ouvrir une pull request (permission « Pull requests : lecture et écriture »).' : `La pull request n’a pas pu être ouverte d’ici : ${esc(why)}.`}</p>
        <div class="ag-prfail-act"><a class="btn btn-primary" href="${esc(compareURL(repo, base, branch, prTitle, prBody(run, detail)))}" target="_blank" rel="noopener">${icon('github')}Ouvrir la PR sur GitHub</a>${perm || !canPR ? '<button class="btn" data-open-conn="github">Régler le jeton</button>' : ''}</div></div>`;
      go.hidden = true; need('[data-x]', m.node).textContent = 'Fermer';
      st.querySelector('a.btn-primary')?.addEventListener('click', () => setTimeout(m.close, 300));
    }
  };
}

/** Copie déjà poussée : ouvre la page GitHub de création de sa PR, déjà remplie. */
async function openPR(p: Project, w: Worktree): Promise<void> {
  const repo = p.repos[0]; if (!repo) { toast('Associe un dépôt GitHub au projet.'); return; }
  let base = 'main';
  try { if (github.connected()) base = (await github.project(repo)).info.default_branch; } catch { /* main par défaut */ }
  // Titre de la PR : celui du commit publié, à défaut le message de l'agent, à défaut le nom de la branche. Jamais la consigne.
  const run = runs.find(r => r.worktree === w.name);
  const t = w.subject || runs.filter(r => r.worktree === w.name && r.result).map(r => agentMessage(r.result)).find(Boolean) || subjectFromBranch(w.branch) || draftMessage(run?.prompt ?? '', []);
  window.open(compareURL(repo, base, w.branch, t, prBody(run, '')), '_blank', 'noopener');
}

async function refreshTrees(p: Project): Promise<void> {
  const [r, j] = await Promise.all([bridge.call('agent', 'worktrees', { project: p.id }, 30000), bridge.call('agent', 'jobs', { project: p.id }, 10000)]);
  trees = r.ok ? (r.worktrees as Worktree[]) : [];
  jobs = j.ok ? (j.jobs as Job[]) : [];
  // Copies dont la branche vient d'être fusionnée : elles repartent de la branche principale, on le dit une fois.
  for (const x of (r.recycled as { worktree: string; branch: string }[] | undefined) ?? []) toast(`${x.branch} est fusionnée : la copie repart de la branche principale, sur une nouvelle branche`);
}

// ---------- Montage ----------
let folderPath: string | null = null, remote = '';
/** Un seul rafraîchissement à la fois : si le Mac répond lentement, les requêtes ne s'empilent plus toutes les 3 secondes. */
let painting = false, again = false;
async function paint(box: HTMLElement, p: Project): Promise<void> {
  if (painting) return;
  painting = true;
  try { await paintOnce(box, p); } finally { painting = false; }
  // On a changé de conversation pendant la lecture : on redessine tout de suite, sans attendre le prochain tour.
  if (again) { again = false; void paint(box, p); }
}
async function paintOnce(box: HTMLElement, p: Project): Promise<void> {
  const zone = $('.ag-zone', box); if (!zone || !box.isConnected) { clearInterval(timer); return; }
  void loadLimits(); paintLimits(); // le bandeau de l'abonnement suit son propre rythme (une lecture par minute)
  const wasLive = new Set(runs.filter(live).map(r => r.run));
  const l = await bridge.call('agent', 'list', { project: p.id }, 10000); runs = l.ok ? (l.runs as AgentRun[]) : runs;
  if (l.ok) queued = (l.queued as Queued[] | undefined) ?? [];
  // Fin d'une discussion avec un agent : l'état de sa copie (poussée, fusionnée…) est relu tout de suite.
  const ended = runs.some(r => wasLive.has(r.run) && !live(r));
  if (tick++ % 4 === 0 || ended || (tick % 2 === 0 && jobs.some(j => j.status === 'running'))) await refreshTrees(p);
  const sel = selected, sb = sub;
  if (sel) {
    syncStop(box);
    // La liste sert encore à la barre latérale : on la relit de temps en temps, sans attendre.
    if (!known.has(p.id) || tick % 5 === 0) void loadList(p);
    // Fil au repos (plus rien ne s'y écrit, aucun agent n'y travaille) : relu une fois sur quatre seulement.
    const feedId = sb ? `${sel}/${sb}` : sel;
    if (calm === feedId && tick % 4 !== 0 && !runs.some(r => r.session === sel && live(r)) && $('.ss-feed', zone)?.dataset.id === feedId) return;
    if (sb) {
      // Fil d'un sous-agent de la conversation.
      const a = await bridge.call('project', 'subagent', { project: p.id, session: sel, agent: sb }, 20000);
      if (!box.isConnected || sel !== selected || sb !== sub) return;
      if (!a.ok || !a.agent) { zone.innerHTML = `<p class="hm-empty">${esc(a.message === 'Action inconnue.' || a.message === 'Action non autorisée à distance.' ? 'Mets à jour l’app Studio pour Mac pour lire les fils des sous-agents.' : a.message ?? 'Sous-agent introuvable.')}</p>`; return; }
      noteSubs(sel, a.subagents);
      showDetail(zone, { ...(a as unknown as Partial<Session> & { actions?: Action[] }), id: sel }, folderPath, a.agent as SubAgent);
      calm = (a.agent as SubAgent).live ? '' : feedId;
      return;
    }
    const d = await bridge.call('project', 'session', { project: p.id, session: sel }, 20000);
    if (!box.isConnected || sel !== selected || sb !== sub) return; // on a changé de conversation entre-temps
    if (!d.ok) {
      // Agent sur un serveur : on suit les étapes reçues de son flux.
      const r = runs.find(x => x.session === selected);
      if (r) {
        const rd = await bridge.call('agent', 'run', { run: r.run }, 10000);
        if (sel !== selected) return;
        if (rd.ok && box.isConnected) { showDetail(zone, { id: selected, title: r.prompt, worktree: r.worktree, branch: r.host ? `sur ${r.host}` : '', started: r.started, updated: r.finished || new Date(Math.floor(Date.now() / 6e4) * 6e4).toISOString(), live: live(r), actions: (rd.actions as Action[]) ?? [] }, folderPath); return; }
      }
      zone.innerHTML = `<p class="hm-empty">${esc(d.message ?? 'Session introuvable.')}</p>`; return;
    }
    noteSubs(sel, d.subagents);
    showDetail(zone, { ...(d as unknown as Partial<Session> & { actions?: Action[] }), id: selected }, folderPath); // « id » de la réponse = numéro de demande
    // Un sous-agent peut travailler longtemps sans que le journal de la conversation bouge : elle n'est alors pas au repos.
    calm = d.live || queued.some(q => q.session === sel) || (subsOf.get(sel) ?? []).some(x => x.live) ? '' : feedId;
    return;
  }
  const list = await loadList(p) ?? [];
  if (!box.isConnected || selected) return;
  paintLimits();
  zone.innerHTML = listHTML(list);
  // Les conversations récentes sans nom en reçoivent un, une à la fois.
  const unnamed = list.slice(0, 8).find(s => wantsName(s, s.live || runs.some(r => r.session === s.id && live(r))));
  if (unnamed) void nameSession(p, unnamed);
}

let serverLabel = '';
function shell(box: HTMLElement, p: Project): void {
  const selRun = selected ? runs.find(r => r.session === selected) : undefined;
  box.innerHTML = (remote ? `<p class="ag-remote">${icon('devices')}Piloté à distance sur <strong>${esc(remote)}</strong> · relecture et publication depuis le Mac</p>` : '') + (selected && sub
    // Fil d'un sous-agent : en lecture seule (on répond à Claude dans la conversation, pas à ses sous-agents).
    ? `<button class="lv-back" data-sa="">${icon('back')}${esc(current(p.id)?.title ?? 'Conversation')}</button><div class="ag-zone"><p class="hm-empty">Chargement…</p></div>`
    : selected
    ? `<button class="lv-back" data-ss="">${icon('back')}Toutes les sessions</button><div class="ag-zone"><p class="hm-empty">Chargement…</p></div>${composerHTML(p, { session: selected, machine: selRun?.machine === 'server' ? 'server' : '' })}`
    : `${composerHTML(p)}<div class="ag-zone"><p class="hm-empty">Chargement…</p></div>`);
  const mc = $<HTMLSelectElement>('select[name=machine]', box);
  if (mc && serverLabel && !selected) { mc.insertAdjacentHTML('beforeend', `<option value="server">Sur ${esc(serverLabel)}</option>`); mc.hidden = false; }
}

/** Ouvre une conversation dans l'onglet affiché (`null` : retour à la liste). */
export function open(id: string | null): void {
  selected = id; selTitle = ''; sub = null; subTitle = ''; calm = '';
  closeSubs(id);
  if (cur?.box.isConnected) { selFor = cur.p.id; shell(cur.box, cur.p); again = painting; void paint(cur.box, cur.p); }
  notify();
}
/** Ouvre le fil d'un sous-agent de la conversation affichée (`null` : retour à la conversation). */
export function openSub(agent: string | null): void {
  if (!selected) return;
  sub = agent; subTitle = ''; calm = '';
  if (cur?.box.isConnected) { shell(cur.box, cur.p); again = painting; void paint(cur.box, cur.p); }
  notify();
}

/** Conversation au repos : ni session active, ni agent de Studio qui y travaille. */
const idle = (s: Session): boolean => !s.live && !runs.some(r => r.session === s.id && live(r));

/** Supprime une conversation sur le Mac (journal à la corbeille) et l'oublie dans Studio. Renvoie '' si c'est fait, sinon la raison de l'échec. */
async function dropSession(p: Project, id: string): Promise<string> {
  const r = await native.call('project', 'deleteSession', { project: p.id, session: id }, 20000);
  if (!r.ok) return r.message === 'Action inconnue.' ? 'Mets à jour l’app Studio pour Mac pour supprimer une conversation.' : r.message ?? 'Suppression impossible.';
  delete titles[id]; saveTitles();
  saved.dropDraft(`${p.id}|s:${id}`); saved.forgetSession(id);
  if (pins.some(x => x.s === id)) { pins = pins.filter(x => x.s !== id); savePins(); }
  subsOf.delete(id); nameFailed.delete(id);
  const k = known.get(p.id); if (k) k.list = k.list.filter(s => s.id !== id);
  runs = runs.filter(x => x.session !== id || live(x));
  return '';
}

/** Supprime une conversation (ouverte, ou choisie dans la liste) : son agent est arrêté s'il tourne, son journal part dans la corbeille du Mac. */
async function removeSession(p: Project, id: string): Promise<void> {
  const busy = runs.filter(r => r.session === id && live(r));
  const s = known.get(p.id)?.list.find(x => x.id === id), name = id === selected && selTitle ? selTitle : s ? nameOf(s) : '';
  if (!await confirmBox({ title: 'Supprimer cette conversation ?', text: `${busy.length ? 'L’agent qui y travaille sera arrêté. ' : ''}${name ? `« ${name} » disparaît` : 'Elle disparaît'} de Studio et son journal part dans la corbeille du Mac. La copie du dépôt et ses changements ne sont pas touchés.`, ok: 'Supprimer', danger: true })) return;
  for (const r of busy) await bridge.call('agent', 'stop', { run: r.run }, 10000);
  if (busy.length) await new Promise(r => setTimeout(r, 1500)); // le temps que Claude Code rende la main
  const err = await dropSession(p, id);
  if (err) { toast(err); return; }
  toast('Conversation supprimée');
  if (selected === id) open(null);
  else { notify(); if (cur?.box.isConnected) void paint(cur.box, cur.p); }
}

/** Ménage : choisir d'un coup les conversations au repos à supprimer (celles qui travaillent ne sont pas proposées). */
function cleanUp(p: Project): void {
  const list = (known.get(p.id)?.list ?? []).filter(idle);
  if (!list.length) { toast('Aucune conversation terminée à supprimer.'); return; }
  const week = Date.now() - 7 * 864e5;
  const m = modal({ title: 'Faire le ménage', cls: 'ss-clean', html: `
    <p class="modal-text">Coche les conversations à supprimer. Celles où un agent travaille encore ne sont pas proposées.</p>
    <div class="ss-pick-bar"><button type="button" class="link-btn" data-pick="all">Tout cocher</button><button type="button" class="link-btn" data-pick="old">Plus de 7 jours</button><button type="button" class="link-btn" data-pick="none">Tout décocher</button></div>
    <div class="ss-picks">${list.map(s => `<label class="ss-pick"><input type="checkbox" value="${esc(s.id)}"${ms(s.updated) < week ? ' data-old' : ''}><span>${esc(nameOf(s))}</span><time>${esc(rel(ms(s.updated)))}</time></label>`).join('')}</div>
    <p class="modal-hint">${icon('shield')}Leurs journaux partent dans la corbeille du Mac. Les copies du dépôt et leurs changements ne sont pas touchés.</p>
    <div class="rv-status"></div>
    <div class="modal-actions"><button class="btn" data-x>Annuler</button><button class="btn btn-danger" data-go disabled>Supprimer</button></div>` });
  const boxes = Array.from(m.node.querySelectorAll<HTMLInputElement>('.ss-pick input')), go = need<HTMLButtonElement>('[data-go]', m.node), st = need('.rv-status', m.node);
  const picked = () => boxes.filter(b => b.checked).map(b => b.value);
  let working = false;
  const sync = () => { const n = picked().length; go.disabled = working || !n; go.textContent = n ? `Supprimer (${n})` : 'Supprimer'; };
  m.node.addEventListener('change', sync);
  m.node.querySelectorAll<HTMLElement>('[data-pick]').forEach(b => { b.onclick = () => {
    if (working) return;
    const how = b.dataset.pick;
    for (const x of boxes) x.checked = how === 'all' || (how === 'old' && x.dataset.old !== undefined);
    sync();
  }; });
  need('[data-x]', m.node).onclick = m.close;
  go.onclick = async () => {
    const ids = picked(); if (!ids.length || working) return;
    working = true; sync(); boxes.forEach(b => { b.disabled = true; });
    let done = 0, why = '';
    for (const id of ids) {
      st.innerHTML = `<span class="spin"></span>Suppression ${done + 1} sur ${ids.length}…`;
      const err = await dropSession(p, id);
      if (err) { why = err; if (/Mets à jour/.test(err)) break; continue; }
      done++;
      m.node.querySelector(`.ss-pick input[value="${id}"]`)?.closest('.ss-pick')?.remove();
    }
    const failed = ids.length - done;
    notify(); if (cur?.box.isConnected) void paint(cur.box, cur.p);
    if (done) toast(`${done} conversation${done > 1 ? 's' : ''} supprimée${done > 1 ? 's' : ''}${failed ? ` · ${failed} en échec` : ''}`);
    if (!failed) { m.close(); return; }
    // Ce qui n'a pas pu être supprimé reste coché, avec la raison.
    working = false;
    for (const b of boxes) b.disabled = false;
    st.innerHTML = `<span class="err">${esc(why)}</span>`;
    sync();
  };
}

/** Dessine l'onglet et le garde à jour toutes les 3 secondes tant qu'il est affiché. */
export function mount(box: HTMLElement, p: Project, folder: string | null): void {
  clearInterval(timer); folderPath = folder; tick = 0;
  // La conversation sélectionnée appartient à un projet : on ne la garde pas en changeant de projet.
  if (selFor !== p.id) { selected = null; selTitle = ''; sub = null; subTitle = ''; }
  calm = ''; closeSubs(selected);
  selFor = p.id; cur = { box, p };
  const at = bridge.where();
  if (!at) { box.innerHTML = `<div class="ag-empty">${icon('terminal')}<h3>Claude Code tourne sur ton Mac</h3><p>Ouvre ce projet dans l’app Studio pour Mac. Pour le piloter d’ici, lie cet appareil au Mac (Réglages → Appareils) et autorise-le, sur le Mac, à piloter Claude Code.</p></div>`; return; }
  remote = at.kind === 'remote' ? at.name : '';
  if (remote && !folder) { void bridge.call('project', 'info', { project: p.id }, 15000).then(r => mount(box, p, typeof r.path === 'string' ? r.path : '')); box.innerHTML = '<p class="hm-empty">Connexion au Mac…</p>'; return; }
  if (!folder) { box.innerHTML = `<div class="ag-empty">${icon('folder')}<h3>Choisis le dossier du projet</h3><p>Claude Code travaille dans le dépôt du projet sur ce Mac, toujours dans une copie isolée quand il modifie quelque chose.</p><button class="btn btn-primary" data-pj="pick">Choisir le dossier</button></div>`; return; }
  shell(box, p);
  void bridge.call('agent', 'server', { project: p.id, op: 'status' }, 25000).then(r => {
    serverLabel = r.ok && r.configured ? String(r.host) : '';
    const mc = $<HTMLSelectElement>('.ag-compose:not(.ag-continue) select[name=machine]', box);
    if (mc && serverLabel && !mc.querySelector('[value=server]')) { mc.insertAdjacentHTML('beforeend', `<option value="server">Sur ${esc(serverLabel)}</option>`); mc.hidden = false; }
  });
  bindComposer(box, p, r => { open(r.session || selected); });
  box.onclick = async e => {
    const t = e.target as HTMLElement;
    const sa = t.closest<HTMLElement>('[data-sa]');
    if (sa) { if ((sa.dataset.sa || null) !== sub) openSub(sa.dataset.sa || null); return; }
    const row = t.closest<HTMLElement>('[data-ss]');
    if (row) { open(row.dataset.ss || null); return; }
    const b = t.closest<HTMLElement>('[data-ag]'); if (!b) return;
    calm = ''; // une action de l'utilisateur : le fil est relu tout de suite
    const wt = b.dataset.wt ?? '';
    if (b.dataset.ag === 'pin-sub') { if (selected && sub) { togglePin(p.id, selected, sub); again = painting; void paint(box, p); } return; }
    if (b.dataset.ag === 'end') { const f = $('.ss-feed', box); f?.scrollTo({ top: f.scrollHeight, behavior: 'smooth' }); b.hidden = true; return; }
    if (b.dataset.ag === 'copy') {
      const text = b.closest('.ss-msg')?.querySelector<HTMLElement>('.md')?.innerText ?? '';
      try { await navigator.clipboard.writeText(text); toast('Réponse copiée'); } catch { toast('Copie impossible.'); }
      return;
    }
    if (b.dataset.ag === 'stop') { const r = await bridge.call('agent', 'stop', { run: b.dataset.run }, 10000); toast(r.ok ? 'Agent arrêté' : r.message ?? 'Impossible.'); void paint(box, p); }
    if (b.dataset.ag === 'unqueue') {
      const r = await bridge.call('agent', 'unqueue', { project: p.id, queued: b.dataset.q }, 10000);
      if (!r.ok) toast(r.message ?? 'Impossible.');
      else queued = queued.filter(q => q.id !== b.dataset.q);
      void paint(box, p); return;
    }
    if (b.dataset.ag === 'flush' && selected) {
      // Reprise sans nouveau texte : le Mac joint tous les messages en attente de la discussion.
      const run = runs.find(r => r.session === selected);
      b.setAttribute('disabled', '');
      const r = await bridge.call('agent', 'start', { project: p.id, session: selected, prompt: '', ...(run?.machine === 'server' ? { machine: 'server' } : {}) }, 60000);
      toast(r.ok ? 'Messages transmis à Claude' : r.message ?? 'Envoi impossible.');
      void paint(box, p); return;
    }
    if (b.dataset.ag === 'delete') { const sid = b.dataset.session || selected; if (sid) await removeSession(p, sid); return; }
    if (b.dataset.ag === 'clean') { cleanUp(p); return; }
    if (b.dataset.ag === 'hide-run' || b.dataset.ag === 'hide-runs') {
      hideRuns(b.dataset.ag === 'hide-run' ? [b.dataset.run ?? ''].filter(Boolean) : runs.filter(r => !live(r)).map(r => r.run));
      again = painting; void paint(box, p); return;
    }
    if (b.dataset.ag === 'review') await review.review(p, 'working', wt);
    if (b.dataset.ag === 'vscode') { const r = await native.call('project', 'open', { project: p.id, app: 'vscode', worktree: wt }, 15000); if (!r.ok) toast(r.message ?? 'Impossible d’ouvrir.'); }
    if (b.dataset.ag === 'push') await publish(p, wt, box);
    if (b.dataset.ag === 'sync') {
      const r = await native.call('agent', 'sync', { project: p.id, worktree: wt }, 30000);
      toast(r.ok ? 'Mise à jour de la copie lancée' : r.message ?? 'Impossible.');
      await refreshTrees(p); void paint(box, p);
    }
    if (b.dataset.ag === 'pr') { const w = trees.find(x => x.name === wt); if (w) await openPR(p, w); }
    if (b.dataset.ag === 'newbranch') {
      const w = trees.find(x => x.name === wt);
      if (!await confirmBox({ title: 'Repartir sur une nouvelle branche ?', text: `${w?.branch ? `La branche ${w.branch} reste poussée avec sa PR. ` : ''}La copie repart de la dernière version de la branche principale : la discussion avec l’agent continue, et son prochain travail sera publié sur une nouvelle branche.`, ok: 'Nouvelle branche' })) return;
      const r = await native.call('agent', 'newbranch', { project: p.id, worktree: wt }, 60000);
      toast(r.ok ? `Nouvelle branche : ${String(r.branch)}` : r.message === 'Action inconnue.' ? 'Mets à jour l’app Studio pour Mac.' : r.message ?? 'Impossible.');
      await refreshTrees(p); void paint(box, p);
    }
    if (b.dataset.ag === 'discard' && await confirmBox({ title: 'Supprimer cette copie ?', text: `${runs.some(r => live(r) && r.worktree === wt) ? 'L’agent qui y travaille sera arrêté. ' : ''}Les changements non publiés de l’agent seront perdus. Une branche déjà poussée sur GitHub reste en place.`, ok: 'Supprimer', danger: true })) {
      for (const r of runs.filter(x => live(x) && x.worktree === wt)) await bridge.call('agent', 'stop', { run: r.run }, 10000);
      const r = await native.call('agent', 'discard', { project: p.id, worktree: wt }, 30000);
      toast(r.ok ? 'Copie supprimée' : r.message ?? 'Impossible.');
      if (r.ok && selected) { selected = null; sub = null; shell(box, p); }
      await refreshTrees(p); void paint(box, p);
    }
  };
  void paint(box, p);
  timer = setInterval(() => { if (!document.hidden) void paint(box, p); }, 3000);
}
export const stop = (): void => { clearInterval(timer); cur = null; calm = ''; };
/** Choisit la conversation à afficher à la prochaine ouverture de l'onglet Claude Code du projet. */
export const select = (id: string | null, pid: string, agent: string | null = null): void => { selected = id; selFor = pid; selTitle = ''; sub = id ? agent : null; subTitle = ''; calm = ''; closeSubs(id); notify(); };
