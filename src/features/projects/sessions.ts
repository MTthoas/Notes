// Onglet « Claude Code » d'un projet : donner une consigne à Claude Code, suivre les agents en direct,
// relire et publier leur travail, reprendre une session. Tout s'exécute sur le Mac où se trouve le dossier
// du projet (voir native/Shared/Agents.swift pour les garde-fous).
import * as native from '../../core/native.ts';
import * as bridge from '../../integrations/remote.ts';
import * as usage from '../../integrations/usage.ts';
import * as ai from '../../integrations/ai.ts';
import * as github from '../../integrations/github/api.ts';
import { esc } from '../../lib/markdown.ts';
import { icon, rel, modal, need, toast, confirmBox, errMsg, $ } from '../../ui/kit.ts';
import * as review from './review.ts';
import * as store from '../../core/store.ts';
import * as model from './model.ts';
import { menu } from '../../ui/kit.ts';
import type { Project } from './model.ts';

interface Tokens { input: number; output: number; cacheRead: number; cacheWrite: number }
interface Session { id: string; title: string; branch: string; worktree: string; started: string; updated: string; live: boolean; models: string[]; prompts: number; lastPrompt: string; tokens: Tokens; tools: Record<string, number>; files: string[] }
interface Quota { status?: string; resetsAt?: number; rateLimitType?: string; isUsingOverage?: boolean }
interface Action { at: string; kind: string; text: string }
export interface AgentRun { machine?: string; host?: string; run: string; mode: string; prompt: string; status: string; session: string; worktree: string; started: string; finished: string; result: string; lastText: string; turns: number; denials: string[]; quota?: Quota | null }
interface Worktree { name: string; branch: string; changes: number; ahead: number; pushed: boolean }

let selected: string | null = null, timer: ReturnType<typeof setInterval> | undefined, tick = 0;
let runs: AgentRun[] = [], trees: Worktree[] = [];
const ms = (iso: string) => Date.parse(iso) || 0;
const short = (path: string, root: string | null) => root && path.includes('/.claude/worktrees/') ? path.replace(/^.*\/\.claude\/worktrees\/[^/]+\//, '') : root && path.startsWith(root + '/') ? path.slice(root.length + 1) : path.replace(/^\/Users\/[^/]+/, '~');
const modelName = (m: string) => m.replace(/^claude-/, '').replace(/-(\d)-(\d)$/, ' $1.$2').replace(/-/g, ' ');
const live = (r: AgentRun) => r.status === 'running' || r.status === 'starting';
const elapsed = (r: AgentRun) => { const s = Math.max(0, Math.round(((r.finished ? ms(r.finished) : Date.now()) - ms(r.started)) / 1000)); return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')}`; };
const STATUS: Record<string, [string, string]> = { starting: ['amber', 'Démarrage'], running: ['amber', 'En cours'], done: ['green', 'Terminé'], error: ['red', 'Erreur'], stopped: ['gray', 'Arrêté'] };
const pill = (s: string) => { const [c, l] = STATUS[s] ?? ['gray', s]; return `<span class="ag-pill${s === 'running' || s === 'starting' ? ' live' : ''}" style="--c:var(--c-${c})">${l}</span>`; };

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
export function handoff(p: Project, { notes = [] as string[], prompt = '' } = {}): void { pending = { project: p.id, notes, prompt }; selected = null; }
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

// ---------- Consigne ----------
export function composerHTML(p: Project, { session = '', compact = false, machine = '' } = {}): string {
  const models = ai.CC_MODELS.map(([v, l]) => `<option value="${v}">${v ? l : 'Modèle par défaut'}</option>`).join('');
  if (session) return `<form class="ag-compose ag-continue" data-session="${esc(session)}"${machine ? ` data-machine="${esc(machine)}"` : ''}><textarea name="prompt" rows="2" placeholder="Continuer cette session : précise, corrige, demande la suite…" aria-label="Continuer la session"></textarea>
    <div class="ag-opts"><span class="ag-hint">${icon('history')}Reprend la session là où elle s’est arrêtée, dans le même dossier.</span><button class="btn btn-primary">${icon('play')}Envoyer<kbd>⌘↩</kbd></button></div></form>`;
  const pre = pending?.project === p.id ? pending : null; if (pre && !compact) pending = null;
  const notes = pre && !compact ? pre.notes : [];
  return `<form class="ag-compose${compact ? ' compact' : ''}" data-notes="${esc(notes.join(','))}"><textarea name="prompt" rows="${compact ? 1 : 3}" placeholder="Que doit faire Claude Code dans ${esc(p.name)} ? Ex. « Ajoute des tests au parseur de dates »" aria-label="Consigne pour Claude Code">${pre && !compact ? esc(pre.prompt) : ''}</textarea>
    <div class="ag-ctx">${notes.map(chip).join('')}<button type="button" class="ag-addnote" data-ag-note>${icon('plus')}Joindre une note</button></div>
    <div class="ag-opts">
      <div class="ag-seg" role="radiogroup" aria-label="Mode"><label><input type="radio" name="mode" value="edit" checked><span>${icon('pencil')}Modifier</span></label><label><input type="radio" name="mode" value="read"><span>${icon('search')}Analyser</span></label></div>
      ${bridge.local() && machine !== 'server' ? '<label class="ag-check" title="Autorise npm test et npm run … : le code du projet peut alors s’exécuter"><input type="checkbox" name="tests">Tests npm</label>' : ''}
      <select class="field" name="machine" aria-label="Où travailler"${machine === 'server' ? '' : ' hidden'}><option value="mac">Sur le Mac</option>${machine === 'server' ? '<option value="server" selected>Sur le serveur</option>' : ''}</select>
      <select class="field" name="model" aria-label="Modèle">${models}</select>
      <span class="ag-hint" data-hint>${icon('shield')}Copie isolée du dépôt : ton dossier reste intact.</span>
      <button class="btn btn-primary">${icon('play')}Lancer<kbd>⌘↩</kbd></button></div></form>`;
}

/** Branche les formulaires de consigne présents dans `root` (lancement, reprise, raccourci ⌘↩). */
export function bindComposer(root: HTMLElement, p: Project, onStarted: (r: AgentRun) => void): void {
  if (root.dataset.agBound) return;
  root.dataset.agBound = '1';
  root.addEventListener('change', e => {
    const t = e.target as HTMLInputElement, f = t.closest('.ag-compose'); if (!f || t.name !== 'mode') return;
    const hint = $('[data-hint]', f), tests = $<HTMLInputElement>('[name=tests]', f);
    if (hint) hint.innerHTML = t.value === 'edit' ? `${icon('shield')}Copie isolée du dépôt : ton dossier reste intact.` : `${icon('eye')}Lecture seule : analyse et propose, sans rien modifier.`;
    if (tests) { tests.disabled = t.value !== 'edit'; if (tests.disabled) tests.checked = false; }
  });
  root.addEventListener('click', e => {
    const t = e.target as HTMLElement, f = t.closest<HTMLFormElement>('.ag-compose'); if (!f) return;
    const ids = () => (f.dataset.notes || '').split(',').filter(Boolean);
    const un = t.closest<HTMLElement>('[data-ag-unnote]');
    if (un) { f.dataset.notes = ids().filter(x => x !== un.dataset.agUnnote).join(','); un.closest('.ag-note')?.remove(); return; }
    const add = t.closest<HTMLElement>('[data-ag-note]'); if (!add) return;
    const have = new Set(ids()), list = attachable(p).filter(n => !have.has(n.id));
    menu(add, list.length ? [{ label: 'Joindre une note du projet' }, ...list.map(n => ({ label: n.title, icon: 'notes', run: () => { f.dataset.notes = [...ids(), n.id].join(','); add.insertAdjacentHTML('beforebegin', chip(n.id)); } }))]
      : [{ label: model.notesOf(p).length > 1 ? 'Toutes les notes lisibles sont déjà jointes' : `Aucune note dans ce projet : ajoute #${p.tag} à une note` }]);
  });
  root.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && (e.target as HTMLElement).closest('.ag-compose')) { e.preventDefault(); (e.target as HTMLElement).closest<HTMLFormElement>('form')?.requestSubmit(); }
  });
  root.addEventListener('submit', async e => {
    const f = (e.target as HTMLElement).closest<HTMLFormElement>('.ag-compose'); if (!f) return;
    e.preventDefault(); e.stopPropagation();
    const ta = need<HTMLTextAreaElement>('textarea', f), noteIds = (f.dataset.notes || '').split(',').filter(Boolean);
    if (!ta.value.trim() && !noteIds.length) { ta.focus(); return; }
    const built = withNotes(ta.value.trim(), noteIds), prompt = built.text;
    if (built.refused.length) toast(`Non jointe${built.refused.length > 1 ? 's' : ''} (verrouillée, privée ou trop longue) : ${built.refused.join(', ')}`);
    const btn = need<HTMLButtonElement>('button.btn-primary', f), label = btn.innerHTML;
    const val = (n: string) => (f.elements.namedItem(n) as HTMLInputElement | null);
    const body: Record<string, unknown> = { project: p.id, prompt };
    if (f.dataset.session) { body.session = f.dataset.session; if (f.dataset.machine) body.machine = f.dataset.machine; }
    else { body.mode = f.querySelector<HTMLInputElement>('[name=mode]:checked')?.value ?? 'edit'; body.tests = !!val('tests')?.checked; body.model = val('model')?.value ?? ''; const mc = val('machine'); if (mc && !mc.hidden) body.machine = mc.value; }
    btn.disabled = true; btn.innerHTML = '<span class="spin"></span>Démarrage…';
    const r = await bridge.call('agent', 'start', body, 60000);
    btn.disabled = false; btn.innerHTML = label;
    if (!r.ok) { toast(r.message ?? 'Lancement impossible.'); return; }
    ta.value = ''; f.dataset.notes = ''; f.querySelectorAll('.ag-note').forEach(x => x.remove());
    toast(f.dataset.session ? 'Session reprise' : 'Claude Code est au travail');
    onStarted(r as unknown as AgentRun);
  });
}

// ---------- Vues ----------
function quotaHTML(q: Quota | null): string {
  // Claude Code n'écrit l'état de la limite que lorsqu'elle est atteinte : passé l'heure de réinitialisation, il est périmé.
  if (!q?.status || (q.resetsAt && q.resetsAt * 1000 <= Date.now())) return '';
  const kind = q.rateLimitType === 'five_hour' ? 'Limite des 5 heures' : q.rateLimitType === 'seven_day' ? 'Limite de la semaine' : q.rateLimitType === 'seven_day_opus' ? 'Limite Opus de la semaine' : 'Limite d’utilisation';
  const at = q.resetsAt ? new Date(q.resetsAt * 1000) : null;
  const when = at ? at.toLocaleString('fr-FR', { weekday: at.getTime() - Date.now() > 864e5 ? 'long' : undefined, hour: '2-digit', minute: '2-digit' }) : '';
  const state = q.status === 'rejected' ? ['err', 'atteinte'] : q.status === 'allowed_warning' ? ['warn', 'bientôt atteinte'] : ['ok', 'disponible'];
  return `<div class="ss-quota ${state[0]}"><i></i><strong>${kind} : ${state[1]}</strong>${at && q.status !== 'allowed' ? `<span>se réinitialise ${esc(when)}</span>` : ''}${q.isUsingOverage ? '<span>· crédit supplémentaire en cours d’utilisation</span>' : ''}</div>`;
}

function runCard(r: AgentRun): string {
  return `<article class="ag-run${live(r) ? ' live' : ''}">
    <header>${pill(r.status)}${r.machine === 'server' ? `<span class="ag-mode">${icon('server')}${esc(r.host ?? 'serveur')}</span>` : ''}<span class="ag-mode">${r.mode === 'edit' ? `${icon('pencil')}Modifier` : `${icon('search')}Analyser`}</span><time>${esc(elapsed(r))}${r.turns ? ` · ${r.turns} étape${r.turns > 1 ? 's' : ''}` : ''}</time></header>
    <p class="ag-prompt">${esc(r.prompt)}</p>
    ${live(r) && r.lastText ? `<p class="ag-last">${esc(r.lastText)}</p>` : ''}
    ${!live(r) && r.result ? `<p class="ag-last">${esc(r.result.replace(/[#*`>]/g, '').slice(0, 220))}</p>` : ''}
    ${r.denials.length ? `<p class="ag-denied">${icon('shield')}${r.denials.length} action${r.denials.length > 1 ? 's' : ''} refusée${r.denials.length > 1 ? 's' : ''} par les garde-fous</p>` : ''}
    <footer>${r.worktree ? `<code>${esc(r.worktree)}</code>` : ''}${r.session ? `<button class="btn" data-ss="${esc(r.session)}">${icon('eye')}Suivre</button>` : ''}${live(r) ? `<button class="btn" data-ag="stop" data-run="${esc(r.run)}">${icon('stop')}Arrêter</button>` : ''}</footer></article>`;
}

function treeRow(w: Worktree): string {
  return `<div class="ag-tree"><span class="ag-tree-main"><code>${esc(w.branch || w.name)}</code><em>${w.changes ? `${w.changes} fichier${w.changes > 1 ? 's' : ''} modifié${w.changes > 1 ? 's' : ''}` : 'aucun changement en attente'}${w.ahead ? ` · ${w.ahead} commit${w.ahead > 1 ? 's' : ''}` : ''}${w.pushed ? ' · poussée' : ''}</em></span>
    <span class="ag-tree-act">${remote ? '<em class="ag-onmac">sur le Mac</em>' : `<button class="btn" data-ag="review" data-wt="${esc(w.name)}">${icon('sparkle')}Revue</button><button class="btn" data-ag="vscode" data-wt="${esc(w.name)}">${icon('code')}VS Code</button><button class="btn" data-ag="push" data-wt="${esc(w.name)}"${w.changes || w.ahead ? '' : ' disabled'}>${icon('upload')}Publier</button>${w.pushed ? `<button class="btn" data-ag="pr" data-wt="${esc(w.name)}" title="Ouvrir la page de la pull request sur GitHub">${icon('github')}PR</button>` : ''}<button class="icon-btn" data-ag="discard" data-wt="${esc(w.name)}" title="Supprimer la copie" aria-label="Supprimer la copie">${icon('trash')}</button>`}</span></div>`;
}

function listHTML(list: Session[], quota: Quota | null): string {
  const running = runs.filter(live), recent = runs.filter(r => !live(r)).slice(0, 4);
  const tot = list.reduce((t, s) => ({ input: t.input + s.tokens.input + s.tokens.cacheWrite, output: t.output + s.tokens.output, cacheRead: t.cacheRead + s.tokens.cacheRead }), { input: 0, output: 0, cacheRead: 0 });
  return `${quotaHTML(quota)}
    ${running.length || recent.length ? `<h3 class="ss-h">Agents <span>${running.length ? `${running.length} en cours` : 'lancés depuis Studio'}</span></h3><div class="ag-runs">${[...running, ...recent].map(runCard).join('')}</div>` : ''}
    ${trees.length ? `<h3 class="ss-h">Copies à relire <span>travail des agents, isolé de ton dossier</span></h3><div class="ag-trees">${trees.map(treeRow).join('')}</div>` : ''}
    <h3 class="ss-h">Sessions <span>tout ce que Claude Code a fait dans ce projet</span></h3>
    <div class="ss-totals"><div><strong>${list.length}</strong><span>session${list.length > 1 ? 's' : ''}</span></div><div><strong>${usage.fmt(tot.output)}</strong><span>tokens écrits</span></div><div><strong>${usage.fmt(tot.input)}</strong><span>tokens lus</span></div><div><strong>${usage.fmt(tot.cacheRead)}</strong><span>relus du cache</span></div></div>
    <div class="ss-list">${list.map(s => {
      const top = Object.entries(s.tools).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${esc(k)} ${v}`).join(' · ');
      return `<button class="ss-row${s.id === selected ? ' sel' : ''}" data-ss="${esc(s.id)}"><i class="ss-live${s.live ? ' on' : ''}" title="${s.live ? 'En cours' : 'Inactive'}"></i>
        <span class="ss-main"><strong>${esc(s.title)}</strong><em>${s.worktree ? `${icon('pencil')}copie · ` : s.branch ? `${icon('pr')}${esc(s.branch)} · ` : ''}${esc(s.models.map(modelName).join(', '))} · ${s.prompts} demande${s.prompts > 1 ? 's' : ''}${top ? ` · ${top}` : ''}</em></span>
        <span class="ss-tok">${usage.fmt(s.tokens.output)}<small>écrits</small></span><time>${esc(rel(ms(s.updated)))}</time></button>`;
    }).join('') || '<p class="hm-empty">Aucune session Claude Code dans ce dossier pour l’instant. Donne une consigne ci-dessus pour lancer la première.</p>'}</div>`;
}

function detailHTML(raw: Partial<Session> & { actions?: Action[] }, root: string | null): string {
  // Une session qui vient de démarrer peut ne pas avoir encore toutes ses informations.
  const s: Session & { actions: Action[] } = { id: '', title: 'Session qui démarre…', branch: '', worktree: '', started: '', updated: '', live: true, models: [], prompts: 0, lastPrompt: '', files: [], tools: {}, ...raw, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...raw.tokens }, actions: raw.actions ?? [] };
  const dur = ms(s.updated) - ms(s.started), h = Math.floor(dur / 36e5), mn = Math.round(dur % 36e5 / 6e4);
  const kind = (k: string) => k === 'prompt' ? ['user', 'Toi'] : k === 'text' ? ['ai', 'Claude'] : ['tool', k.slice(5)];
  const run = runs.find(r => r.session === s.id && live(r)), tree = s.worktree ? trees.find(t => t.name === s.worktree) : undefined;
  return `<div class="ss-dhead"><i class="ss-live${s.live || run ? ' on' : ''}"></i><h2>${esc(s.title)}</h2>${run ? `${pill(run.status)}<button class="btn" data-ag="stop" data-run="${esc(run.run)}">${icon('stop')}Arrêter</button>` : ''}</div>
    <p class="ss-meta">${s.worktree ? `${icon('pencil')}copie isolée <code>${esc(s.worktree)}</code> · ` : s.branch ? `${icon('pr')}${esc(s.branch)} · ` : ''}${esc(s.models.map(modelName).join(', '))} · ${h ? `${h} h ` : ''}${mn} min · ${s.prompts} demande${s.prompts > 1 ? 's' : ''}</p>
    <div class="ss-totals"><div><strong>${usage.fmt(s.tokens.output)}</strong><span>tokens écrits</span></div><div><strong>${usage.fmt(s.tokens.input + s.tokens.cacheWrite)}</strong><span>tokens lus</span></div><div><strong>${usage.fmt(s.tokens.cacheRead)}</strong><span>relus du cache</span></div><div><strong>${Object.values(s.tools).reduce((a, b) => a + b, 0)}</strong><span>actions</span></div></div>
    ${tree ? `<div class="ag-trees">${treeRow(tree)}</div>` : remote ? '' : `<div class="ss-actions"><button class="btn" data-pj="review-working">${icon('sparkle')}Revue des changements en cours</button><button class="btn" data-pj="vscode">${icon('code')}Ouvrir dans VS Code</button></div>`}
    ${s.files.length ? `<h3 class="ss-h">Fichiers modifiés <span>${s.files.length}</span></h3><div class="ss-files">${s.files.map(f => `<code>${esc(short(f, root))}</code>`).join('')}</div>` : ''}
    <h3 class="ss-h">Fil de la session <span>les ${s.actions.length} dernières étapes</span></h3>
    <div class="ss-feed">${s.actions.map(a => { const [c, who] = kind(a.kind); return `<div class="ss-step ${c}"><span class="ss-who">${c === 'tool' ? icon('bolt') : ''}${esc(who ?? '')}</span><p>${esc(c === 'tool' ? short(a.text, root) : a.text)}</p><time>${esc(rel(ms(a.at)))}</time></div>`; }).join('')}</div>`;
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
/** Proposition immédiate, sans IA : type, puis la consigne résumée. */
function draftMessage(prompt: string, files: string[]): string {
  const first = prompt.split('\n')[0]?.replace(/[.!…]+$/, '').trim() ?? '';
  const summary = (first.charAt(0).toLowerCase() + first.slice(1)).slice(0, 64) || 'update from Claude Code';
  return `${guessType(prompt, files)}: ${summary}`;
}
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
Écris dans la même langue que les commits récents du dépôt, et dans le même style.`;
async function suggestMessage(p: Project, wt: string, run: AgentRun | undefined): Promise<{ draft: string; ai: Promise<string> | null; files: string[] }> {
  const d = await native.call('project', 'diff', { project: p.id, scope: 'working', worktree: wt }, 30000);
  const stat = String(d.stat ?? ''), files = statFiles(stat), prompt = run?.prompt ?? wt.replace(/^studio-|-\d{4}-\d{4}$/g, '').replace(/-/g, ' ');
  const draft = draftMessage(prompt, files);
  if (!d.ok || !ai.ready() || !String(d.patch ?? '').trim()) return { draft, ai: null, files };
  const user = `Consigne donnée à l’agent : ${prompt}\n\n${run?.result ? `Compte rendu de l’agent :\n${run.result.slice(0, 1500)}\n\n` : ''}Commits récents du dépôt :\n${String(d.log ?? '').trim() || '(aucun)'}\n\nFichiers modifiés :\n${stat}\n\nDiff (extrait) :\n\`\`\`diff\n${String(d.patch).slice(0, 20000)}\n\`\`\``;
  return { draft, files, ai: ai.complete(COMMIT_SYSTEM, user).then(t => cleanMessage(t, guessType(prompt, files))) };
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
const prBody = (run: AgentRun | undefined, detail: string) => `${detail ? `${detail}\n\n` : ''}${run?.result ? `${run.result}\n\n` : ''}---\nPréparé par Claude Code depuis Studio.`;

async function publish(p: Project, wt: string, root: HTMLElement): Promise<void> {
  const run = runs.find(r => r.worktree === wt), repo = p.repos[0];
  const canPR = !!repo && github.connected();
  const m = modal({ cls: 'ag-pub', title: 'Publier le travail de l’agent', html: `
    <div class="pub-type"><span>Type</span><div class="ag-seg" role="radiogroup" aria-label="Type de changement">${KINDS.map(([k, l]) => `<label title="${esc(l)}"><input type="radio" name="ctype" value="${k}"><span>${k}</span></label>`).join('')}</div></div>
    <label class="pj-field"><span class="ag-msg-h">Message de commit<em class="ag-sug" hidden>${icon('sparkle')}proposé par l’IA</em></span><textarea class="field ag-msg" name="msg" rows="3" spellcheck="false" required></textarea></label>
    <div class="ag-sug-row"><span class="ag-sug-st"><span class="spin"></span>Lecture des changements…</span><button type="button" class="link-btn" data-resug hidden>${icon('refresh')}Reproposer</button></div>
    <label class="pj-field"><span>Branche</span><input class="field ag-branch" name="branch" spellcheck="false" autocomplete="off" required></label>
    ${repo ? `<label class="cx-check"><input type="checkbox" name="pr" checked> Ouvrir une pull request sur <strong>${esc(repo)}</strong></label>
    <label class="pj-field"><span>Titre de la PR</span><input class="field" name="title"></label>` : '<p class="modal-hint">Associe un dépôt GitHub au projet pour ouvrir une pull request.</p>'}
    <p class="modal-hint">${icon('shield')}Les changements de la copie sont validés puis la branche est poussée avec tes identifiants Git habituels. Ton dossier de travail n’est pas touché.</p>
    <div class="rv-status"></div>
    <div class="modal-actions"><button class="btn" data-x>Annuler</button><button class="btn btn-primary" data-go>${icon('upload')}Publier</button></div>` });
  const msg = need<HTMLTextAreaElement>('[name=msg]', m.node), title = m.node.querySelector<HTMLInputElement>('[name=title]');
  const sugSt = need('.ag-sug-st', m.node), sugTag = need('.ag-sug', m.node), resug = need<HTMLButtonElement>('[data-resug]', m.node);
  const branchIn = need<HTMLInputElement>('[name=branch]', m.node);
  let editedMsg = false, editedTitle = false, editedBranch = false;
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
  const propose = async () => {
    resug.hidden = true; sugSt.innerHTML = '<span class="spin"></span>Lecture des changements…';
    const s = await suggestMessage(p, wt, run);
    if (!m.node.isConnected) return;
    if (!editedMsg) { msg.value = s.draft; sync(); }
    if (!s.ai) { sugSt.textContent = ai.ready() ? 'Proposition tirée de la consigne.' : 'Proposition tirée de la consigne · connecte une IA pour un message rédigé d’après le diff.'; resug.hidden = !ai.ready(); return; }
    sugSt.innerHTML = `<span class="spin"></span>L’IA rédige le message d’après le diff (${esc(ai.PROVIDERS[ai.config().provider])})…`;
    try {
      const text = await s.ai; if (!m.node.isConnected) return;
      if (text && !editedMsg) { msg.value = text; sugTag.hidden = false; sync(); }
      sugSt.textContent = editedMsg ? 'Tu as modifié le message : la proposition de l’IA n’a pas été appliquée.' : `${s.files.length} fichier${s.files.length > 1 ? 's' : ''} modifié${s.files.length > 1 ? 's' : ''}.`;
    } catch (e) { sugSt.innerHTML = `<span class="err">Pas de proposition de l’IA : ${esc(errMsg(e))}</span>`; }
    resug.hidden = false;
  };
  resug.onclick = () => { editedMsg = false; void propose(); };
  void propose();
  need('[data-x]', m.node).onclick = m.close;
  need('[data-go]', m.node).onclick = async () => {
    const go = need<HTMLButtonElement>('[data-go]', m.node), st = need('.rv-status', m.node), wantPR = !!repo && !!m.node.querySelector<HTMLInputElement>('[name=pr]')?.checked;
    const message = msg.value.trim(); if (!message) { msg.focus(); return; }
    const prTitle = title?.value.trim() || subject(), detail = message.split('\n').slice(1).join('\n').trim();
    go.disabled = true; st.innerHTML = '<p class="rv-status"><span class="spin"></span>Commit et push…</p>';
    const wanted = branchIn.value.trim();
    if (!/^[a-z0-9][a-z0-9._/-]{0,89}$/.test(wanted) || wanted.includes('..') || wanted.endsWith('/')) { st.innerHTML = '<p class="rv-status err">Nom de branche invalide : minuscules, chiffres, - _ . / (ex. feat/export-pdf).</p>'; branchIn.focus(); return; }
    const r = await native.call('agent', 'push', { project: p.id, worktree: wt, message, branch: wanted }, 120000);
    if (!r.ok) { st.innerHTML = `<p class="rv-status err">${esc(r.message ?? 'Échec.')}</p>`; go.disabled = false; return; }
    const branch = String(r.branch);
    void refreshTrees(p).then(() => paint(root, p));
    if (!wantPR || !repo) { m.close(); toast(`Branche ${branch} poussée`); return; }
    st.innerHTML = '<p class="rv-status"><span class="spin"></span>Ouverture de la pull request…</p>';
    let base = 'main';
    try {
      if (!canPR) throw new Error('GitHub n’est pas connecté dans Studio');
      base = (await github.project(repo)).info.default_branch;
      const pr = await github.createPull(repo, { head: branch, base, title: prTitle, body: prBody(run, detail) });
      m.close(); toast(`PR #${pr.number} ouverte`); window.open(pr.html_url, '_blank', 'noopener');
    } catch (e) {
      const why = errMsg(e), perm = /not accessible|403|permission/i.test(why);
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
  const run = runs.find(r => r.worktree === w.name), t = draftMessage(run?.prompt ?? w.name, []);
  window.open(compareURL(repo, base, w.branch, t, prBody(run, '')), '_blank', 'noopener');
}

async function refreshTrees(p: Project): Promise<void> {
  const r = await bridge.call('agent', 'worktrees', { project: p.id }, 30000);
  trees = r.ok ? (r.worktrees as Worktree[]) : [];
}

// ---------- Montage ----------
let folderPath: string | null = null, remote = '';
async function paint(box: HTMLElement, p: Project): Promise<void> {
  const zone = $('.ag-zone', box); if (!zone || !box.isConnected) { clearInterval(timer); return; }
  const l = await bridge.call('agent', 'list', { project: p.id }, 10000); runs = l.ok ? (l.runs as AgentRun[]) : runs;
  if (tick++ % 4 === 0) await refreshTrees(p);
  if (selected) {
    const d = await bridge.call('project', 'session', { project: p.id, session: selected }, 20000);
    if (!box.isConnected) return;
    if (!d.ok) {
      // Agent sur un serveur : on suit les étapes reçues de son flux.
      const r = runs.find(x => x.session === selected);
      if (r) {
        const rd = await bridge.call('agent', 'run', { run: r.run }, 10000);
        if (rd.ok && box.isConnected) { zone.innerHTML = detailHTML({ id: selected, title: r.prompt, worktree: r.worktree, branch: r.host ? `sur ${r.host}` : '', started: r.started, updated: r.finished || new Date().toISOString(), live: live(r), actions: (rd.actions as Action[]) ?? [] }, folderPath); return; }
      }
      zone.innerHTML = `<p class="hm-empty">${esc(d.message ?? 'Session introuvable.')}</p>`; return;
    }
    const feed = $('.ss-feed', zone), atEnd = !feed || feed.scrollHeight - feed.scrollTop - feed.clientHeight < 40;
    zone.innerHTML = detailHTML({ ...(d as unknown as Partial<Session> & { actions?: Action[] }), id: selected }, folderPath); // « id » de la réponse = numéro de demande
    const nf = $('.ss-feed', zone); if (nf && atEnd) nf.scrollTop = nf.scrollHeight;
    return;
  }
  const r = await bridge.call('project', 'sessions', { project: p.id }, 20000);
  if (!box.isConnected) return;
  zone.innerHTML = listHTML(r.found ? (r.sessions as Session[]) ?? [] : [], (r.quota as Quota | null) ?? runs.find(x => x.quota)?.quota ?? null);
}

let serverLabel = '';
function shell(box: HTMLElement, p: Project): void {
  const selRun = selected ? runs.find(r => r.session === selected) : undefined;
  box.innerHTML = (remote ? `<p class="ag-remote">${icon('devices')}Piloté à distance sur <strong>${esc(remote)}</strong> · relecture et publication depuis le Mac</p>` : '') + (selected
    ? `<button class="lv-back" data-ss="">${icon('back')}Toutes les sessions</button><div class="ag-zone"><p class="hm-empty">Chargement…</p></div>${composerHTML(p, { session: selected, machine: selRun?.machine === 'server' ? 'server' : '' })}`
    : `${composerHTML(p)}<div class="ag-zone"><p class="hm-empty">Chargement…</p></div>`);
  const mc = $<HTMLSelectElement>('select[name=machine]', box);
  if (mc && serverLabel && !selected) { mc.insertAdjacentHTML('beforeend', `<option value="server">Sur ${esc(serverLabel)}</option>`); mc.hidden = false; }
}

/** Dessine l'onglet et le garde à jour toutes les 3 secondes tant qu'il est affiché. */
export function mount(box: HTMLElement, p: Project, folder: string | null): void {
  clearInterval(timer); folderPath = folder; tick = 0;
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
  bindComposer(box, p, r => { if (r.session) selected = r.session; shell(box, p); void paint(box, p); });
  box.onclick = async e => {
    const t = e.target as HTMLElement;
    const row = t.closest<HTMLElement>('[data-ss]');
    if (row) { selected = row.dataset.ss || null; shell(box, p); void paint(box, p); return; }
    const b = t.closest<HTMLElement>('[data-ag]'); if (!b) return;
    const wt = b.dataset.wt ?? '';
    if (b.dataset.ag === 'stop') { const r = await bridge.call('agent', 'stop', { run: b.dataset.run }, 10000); toast(r.ok ? 'Agent arrêté' : r.message ?? 'Impossible.'); void paint(box, p); }
    if (b.dataset.ag === 'review') await review.review(p, 'working', wt);
    if (b.dataset.ag === 'vscode') { const r = await native.call('project', 'open', { project: p.id, app: 'vscode', worktree: wt }, 15000); if (!r.ok) toast(r.message ?? 'Impossible d’ouvrir.'); }
    if (b.dataset.ag === 'push') await publish(p, wt, box);
    if (b.dataset.ag === 'pr') { const w = trees.find(x => x.name === wt); if (w) await openPR(p, w); }
    if (b.dataset.ag === 'discard' && await confirmBox({ title: 'Supprimer cette copie ?', text: 'Les changements non publiés de l’agent seront perdus. Une branche déjà poussée sur GitHub reste en place.', ok: 'Supprimer', danger: true })) {
      const r = await native.call('agent', 'discard', { project: p.id, worktree: wt }, 30000);
      toast(r.ok ? 'Copie supprimée' : r.message ?? 'Impossible.');
      if (r.ok && selected) { selected = null; shell(box, p); }
      await refreshTrees(p); void paint(box, p);
    }
  };
  void paint(box, p);
  timer = setInterval(() => { if (!document.hidden) void paint(box, p); }, 3000);
}
export const stop = (): void => { clearInterval(timer); };
export const select = (id: string | null): void => { selected = id; };
