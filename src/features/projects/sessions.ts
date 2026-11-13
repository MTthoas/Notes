// Onglet « Claude Code » d'un projet : donner une consigne à Claude Code, suivre les agents en direct,
// relire et publier leur travail, reprendre une session. Tout s'exécute sur le Mac où se trouve le dossier
// du projet (voir native/Shared/Agents.swift pour les garde-fous).
import * as native from '../../core/native.ts';
import * as usage from '../../integrations/usage.ts';
import * as ai from '../../integrations/ai.ts';
import * as github from '../../integrations/github/api.ts';
import { esc } from '../../lib/markdown.ts';
import { icon, rel, modal, need, toast, confirmBox, errMsg, $ } from '../../ui/kit.ts';
import * as review from './review.ts';
import type { Project } from './model.ts';

interface Tokens { input: number; output: number; cacheRead: number; cacheWrite: number }
interface Session { id: string; title: string; branch: string; worktree: string; started: string; updated: string; live: boolean; models: string[]; prompts: number; lastPrompt: string; tokens: Tokens; tools: Record<string, number>; files: string[] }
interface Quota { status?: string; resetsAt?: number; rateLimitType?: string; isUsingOverage?: boolean }
interface Action { at: string; kind: string; text: string }
export interface AgentRun { run: string; mode: string; prompt: string; status: string; session: string; worktree: string; started: string; finished: string; result: string; lastText: string; turns: number; denials: string[]; quota?: Quota | null }
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

// ---------- Consigne ----------
export function composerHTML(p: Project, { session = '', compact = false } = {}): string {
  const models = ai.CC_MODELS.map(([v, l]) => `<option value="${v}">${v ? l : 'Modèle par défaut'}</option>`).join('');
  if (session) return `<form class="ag-compose ag-continue" data-session="${esc(session)}"><textarea name="prompt" rows="2" placeholder="Continuer cette session : précise, corrige, demande la suite…" aria-label="Continuer la session"></textarea>
    <div class="ag-opts"><span class="ag-hint">${icon('history')}Reprend la session là où elle s’est arrêtée, dans le même dossier.</span><button class="btn btn-primary">${icon('play')}Envoyer<kbd>⌘↩</kbd></button></div></form>`;
  return `<form class="ag-compose${compact ? ' compact' : ''}"><textarea name="prompt" rows="${compact ? 1 : 3}" placeholder="Que doit faire Claude Code dans ${esc(p.name)} ? Ex. « Ajoute des tests au parseur de dates »" aria-label="Consigne pour Claude Code"></textarea>
    <div class="ag-opts">
      <div class="ag-seg" role="radiogroup" aria-label="Mode"><label><input type="radio" name="mode" value="edit" checked><span>${icon('pencil')}Modifier</span></label><label><input type="radio" name="mode" value="read"><span>${icon('search')}Analyser</span></label></div>
      <label class="ag-check" title="Autorise npm test et npm run … : le code du projet peut alors s’exécuter"><input type="checkbox" name="tests">Tests npm</label>
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
  root.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && (e.target as HTMLElement).closest('.ag-compose')) { e.preventDefault(); (e.target as HTMLElement).closest<HTMLFormElement>('form')?.requestSubmit(); }
  });
  root.addEventListener('submit', async e => {
    const f = (e.target as HTMLElement).closest<HTMLFormElement>('.ag-compose'); if (!f) return;
    e.preventDefault(); e.stopPropagation();
    const ta = need<HTMLTextAreaElement>('textarea', f), prompt = ta.value.trim(); if (!prompt) { ta.focus(); return; }
    const btn = need<HTMLButtonElement>('button.btn-primary', f), label = btn.innerHTML;
    const val = (n: string) => (f.elements.namedItem(n) as HTMLInputElement | null);
    const body: Record<string, unknown> = { project: p.id, prompt };
    if (f.dataset.session) body.session = f.dataset.session;
    else { body.mode = f.querySelector<HTMLInputElement>('[name=mode]:checked')?.value ?? 'edit'; body.tests = !!val('tests')?.checked; body.model = val('model')?.value ?? ''; }
    btn.disabled = true; btn.innerHTML = '<span class="spin"></span>Démarrage…';
    const r = await native.call('agent', 'start', body, 60000);
    btn.disabled = false; btn.innerHTML = label;
    if (!r.ok) { toast(r.message ?? 'Lancement impossible.'); return; }
    ta.value = '';
    toast(f.dataset.session ? 'Session reprise' : 'Claude Code est au travail');
    onStarted(r as unknown as AgentRun);
  });
}

// ---------- Vues ----------
function quotaHTML(q: Quota | null): string {
  if (!q?.status) return '';
  const kind = q.rateLimitType === 'five_hour' ? 'Limite des 5 heures' : q.rateLimitType === 'seven_day' ? 'Limite de la semaine' : q.rateLimitType === 'seven_day_opus' ? 'Limite Opus de la semaine' : 'Limite d’utilisation';
  const at = q.resetsAt ? new Date(q.resetsAt * 1000) : null;
  const when = at ? at.toLocaleString('fr-FR', { weekday: at.getTime() - Date.now() > 864e5 ? 'long' : undefined, hour: '2-digit', minute: '2-digit' }) : '';
  const state = q.status === 'rejected' ? ['err', 'atteinte'] : q.status === 'allowed_warning' ? ['warn', 'bientôt atteinte'] : ['ok', 'disponible'];
  return `<div class="ss-quota ${state[0]}"><i></i><strong>${kind} : ${state[1]}</strong>${at && q.status !== 'allowed' ? `<span>se réinitialise ${esc(when)}</span>` : ''}${q.isUsingOverage ? '<span>· crédit supplémentaire en cours d’utilisation</span>' : ''}</div>`;
}

function runCard(r: AgentRun): string {
  return `<article class="ag-run${live(r) ? ' live' : ''}">
    <header>${pill(r.status)}<span class="ag-mode">${r.mode === 'edit' ? `${icon('pencil')}Modifier` : `${icon('search')}Analyser`}</span><time>${esc(elapsed(r))}${r.turns ? ` · ${r.turns} étape${r.turns > 1 ? 's' : ''}` : ''}</time></header>
    <p class="ag-prompt">${esc(r.prompt)}</p>
    ${live(r) && r.lastText ? `<p class="ag-last">${esc(r.lastText)}</p>` : ''}
    ${!live(r) && r.result ? `<p class="ag-last">${esc(r.result.replace(/[#*`>]/g, '').slice(0, 220))}</p>` : ''}
    ${r.denials.length ? `<p class="ag-denied">${icon('shield')}${r.denials.length} action${r.denials.length > 1 ? 's' : ''} refusée${r.denials.length > 1 ? 's' : ''} par les garde-fous</p>` : ''}
    <footer>${r.worktree ? `<code>${esc(r.worktree)}</code>` : ''}${r.session ? `<button class="btn" data-ss="${esc(r.session)}">${icon('eye')}Suivre</button>` : ''}${live(r) ? `<button class="btn" data-ag="stop" data-run="${esc(r.run)}">${icon('stop')}Arrêter</button>` : ''}</footer></article>`;
}

function treeRow(w: Worktree): string {
  return `<div class="ag-tree"><span class="ag-tree-main"><code>${esc(w.branch || w.name)}</code><em>${w.changes ? `${w.changes} fichier${w.changes > 1 ? 's' : ''} modifié${w.changes > 1 ? 's' : ''}` : 'aucun changement en attente'}${w.ahead ? ` · ${w.ahead} commit${w.ahead > 1 ? 's' : ''}` : ''}${w.pushed ? ' · poussée' : ''}</em></span>
    <span class="ag-tree-act"><button class="btn" data-ag="review" data-wt="${esc(w.name)}">${icon('sparkle')}Revue</button><button class="btn" data-ag="vscode" data-wt="${esc(w.name)}">${icon('code')}VS Code</button><button class="btn" data-ag="push" data-wt="${esc(w.name)}"${w.changes || w.ahead ? '' : ' disabled'}>${icon('upload')}Publier</button><button class="icon-btn" data-ag="discard" data-wt="${esc(w.name)}" title="Supprimer la copie" aria-label="Supprimer la copie">${icon('trash')}</button></span></div>`;
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
    ${tree ? `<div class="ag-trees">${treeRow(tree)}</div>` : `<div class="ss-actions"><button class="btn" data-pj="review-working">${icon('sparkle')}Revue des changements en cours</button><button class="btn" data-pj="vscode">${icon('code')}Ouvrir dans VS Code</button></div>`}
    ${s.files.length ? `<h3 class="ss-h">Fichiers modifiés <span>${s.files.length}</span></h3><div class="ss-files">${s.files.map(f => `<code>${esc(short(f, root))}</code>`).join('')}</div>` : ''}
    <h3 class="ss-h">Fil de la session <span>les ${s.actions.length} dernières étapes</span></h3>
    <div class="ss-feed">${s.actions.map(a => { const [c, who] = kind(a.kind); return `<div class="ss-step ${c}"><span class="ss-who">${c === 'tool' ? icon('bolt') : ''}${esc(who ?? '')}</span><p>${esc(c === 'tool' ? short(a.text, root) : a.text)}</p><time>${esc(rel(ms(a.at)))}</time></div>`; }).join('')}</div>`;
}

// ---------- Actions sur les copies ----------
async function publish(p: Project, wt: string, root: HTMLElement): Promise<void> {
  const run = runs.find(r => r.worktree === wt), repo = p.repos[0];
  const title = (run?.prompt ?? wt.replace(/^studio-|-\d{4}-\d{4}$/g, '').replace(/-/g, ' ')).split('\n')[0]?.slice(0, 72) ?? wt;
  const canPR = !!repo && github.connected();
  const m = modal({ cls: 'ag-pub', title: 'Publier le travail de l’agent', html: `
    <label class="pj-field">Message de commit<input class="field" name="msg" value="${esc(title)}" required></label>
    ${canPR ? `<label class="cx-check"><input type="checkbox" name="pr" checked> Ouvrir une pull request sur <strong>${esc(repo)}</strong></label>
    <label class="pj-field">Titre de la PR<input class="field" name="title" value="${esc(title)}"></label>` : `<p class="modal-hint">${repo ? 'Connecte GitHub pour ouvrir la pull request depuis Studio.' : 'Associe un dépôt GitHub au projet pour ouvrir une pull request.'}</p>`}
    <p class="modal-hint">${icon('shield')}Les changements de la copie sont validés puis la branche est poussée avec tes identifiants Git habituels. Ton dossier de travail n’est pas touché.</p>
    <p class="rv-status"></p>
    <div class="modal-actions"><button class="btn" data-x>Annuler</button><button class="btn btn-primary" data-go>${icon('upload')}Publier</button></div>` });
  need('[data-x]', m.node).onclick = m.close;
  need('[data-go]', m.node).onclick = async () => {
    const go = need<HTMLButtonElement>('[data-go]', m.node), st = need('.rv-status', m.node), f = (n: string) => m.node.querySelector<HTMLInputElement>(`[name=${n}]`);
    go.disabled = true; st.innerHTML = '<span class="spin"></span>Commit et push…';
    const r = await native.call('agent', 'push', { project: p.id, worktree: wt, message: f('msg')?.value ?? title }, 120000);
    if (!r.ok) { st.innerHTML = `<span class="err">${esc(r.message ?? 'Échec.')}</span>`; go.disabled = false; return; }
    if (canPR && f('pr')?.checked && repo) {
      st.innerHTML = '<span class="spin"></span>Ouverture de la pull request…';
      try {
        const info = await github.project(repo), pr = await github.createPull(repo, { head: String(r.branch), base: info.info.default_branch, title: f('title')?.value || title, body: `${run?.result ? `${run.result}\n\n` : ''}---\nPréparé par Claude Code depuis Studio.` });
        m.close(); toast(`PR #${pr.number} ouverte`); window.open(pr.html_url, '_blank', 'noopener');
      } catch (e) { st.innerHTML = `<span class="err">Branche poussée, mais la PR n’a pas pu être ouverte : ${esc(errMsg(e))}</span>`; go.hidden = true; }
    } else { m.close(); toast(`Branche ${String(r.branch)} poussée`); }
    void refreshTrees(p).then(() => paint(root, p));
  };
}

async function refreshTrees(p: Project): Promise<void> {
  const r = await native.call('agent', 'worktrees', { project: p.id }, 30000);
  trees = r.ok ? (r.worktrees as Worktree[]) : [];
}

// ---------- Montage ----------
let folderPath: string | null = null;
async function paint(box: HTMLElement, p: Project): Promise<void> {
  const zone = $('.ag-zone', box); if (!zone || !box.isConnected) { clearInterval(timer); return; }
  const l = await native.call('agent', 'list', { project: p.id }, 10000); runs = l.ok ? (l.runs as AgentRun[]) : runs;
  if (tick++ % 4 === 0) await refreshTrees(p);
  if (selected) {
    const d = await native.call('project', 'session', { project: p.id, session: selected }, 20000);
    if (!box.isConnected) return;
    if (!d.ok) { zone.innerHTML = `<p class="hm-empty">${esc(d.message ?? 'Session introuvable.')}</p>`; return; }
    const feed = $('.ss-feed', zone), atEnd = !feed || feed.scrollHeight - feed.scrollTop - feed.clientHeight < 40;
    zone.innerHTML = detailHTML({ ...(d as unknown as Partial<Session> & { actions?: Action[] }), id: selected }, folderPath); // « id » de la réponse = numéro de demande
    const nf = $('.ss-feed', zone); if (nf && atEnd) nf.scrollTop = nf.scrollHeight;
    return;
  }
  const r = await native.call('project', 'sessions', { project: p.id }, 20000);
  if (!box.isConnected) return;
  zone.innerHTML = listHTML(r.found ? (r.sessions as Session[]) ?? [] : [], (r.quota as Quota | null) ?? runs.find(x => x.quota)?.quota ?? null);
}

function shell(box: HTMLElement, p: Project): void {
  box.innerHTML = selected
    ? `<button class="lv-back" data-ss="">${icon('back')}Toutes les sessions</button><div class="ag-zone"><p class="hm-empty">Chargement…</p></div>${composerHTML(p, { session: selected })}`
    : `${composerHTML(p)}<div class="ag-zone"><p class="hm-empty">Chargement…</p></div>`;
}

/** Dessine l'onglet et le garde à jour toutes les 3 secondes tant qu'il est affiché. */
export function mount(box: HTMLElement, p: Project, folder: string | null): void {
  clearInterval(timer); folderPath = folder; tick = 0;
  if (!ai.cc.onMac()) { box.innerHTML = `<div class="ag-empty">${icon('terminal')}<h3>Claude Code tourne sur ton Mac</h3><p>Ouvre ce projet dans l’app Studio pour Mac : tu pourras y donner des consignes à Claude Code, suivre ses sessions en direct et publier son travail.</p></div>`; return; }
  if (!folder) { box.innerHTML = `<div class="ag-empty">${icon('folder')}<h3>Choisis le dossier du projet</h3><p>Claude Code travaille dans le dépôt du projet sur ce Mac, toujours dans une copie isolée quand il modifie quelque chose.</p><button class="btn btn-primary" data-pj="pick">Choisir le dossier</button></div>`; return; }
  shell(box, p);
  bindComposer(box, p, r => { if (r.session) selected = r.session; shell(box, p); void paint(box, p); });
  box.onclick = async e => {
    const t = e.target as HTMLElement;
    const row = t.closest<HTMLElement>('[data-ss]');
    if (row) { selected = row.dataset.ss || null; shell(box, p); void paint(box, p); return; }
    const b = t.closest<HTMLElement>('[data-ag]'); if (!b) return;
    const wt = b.dataset.wt ?? '';
    if (b.dataset.ag === 'stop') { const r = await native.call('agent', 'stop', { run: b.dataset.run }, 10000); toast(r.ok ? 'Agent arrêté' : r.message ?? 'Impossible.'); void paint(box, p); }
    if (b.dataset.ag === 'review') await review.review(p, 'working', wt);
    if (b.dataset.ag === 'vscode') { const r = await native.call('project', 'open', { project: p.id, app: 'vscode', worktree: wt }, 15000); if (!r.ok) toast(r.message ?? 'Impossible d’ouvrir.'); }
    if (b.dataset.ag === 'push') await publish(p, wt, box);
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
