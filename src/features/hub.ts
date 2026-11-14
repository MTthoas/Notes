// Interface des connexions : coffre, IA et agents, Linear, schémas de bases de données,
// appareils liés, et l'accueil en « widgets ». app.js lui fournit quelques fonctions (init).
import * as store from '../core/store.ts';
import * as vault from '../core/vault.ts';
import * as cr from '../core/crypto.ts';
import * as ai from '../integrations/ai.ts';
import * as linear from '../integrations/linear/api.ts';
import * as notifs from '../integrations/linear/notifications.ts';
import * as github from '../integrations/github/api.ts';
import * as bridge from '../integrations/remote.ts';
import * as link from '../integrations/link.ts';
import * as schema from '../lib/schema.ts';
import * as qr from '../lib/qr.ts';
import * as events from '../core/events.ts';
import * as usage from '../integrations/usage.ts';
import * as update from '../core/update.ts';
import * as news from './news.ts';
import * as journal from './journal.ts';
import * as tuning from '../integrations/tuning.ts';
import * as scope from '../integrations/scope.ts';
import { projectOfNote } from './projects/model.ts';
import * as tuningUI from './tuning.ts';
import * as permissionsUI from './permissions.ts';
import * as pluginsUI from './plugins.ts';
import * as registry from '../plugins/registry.ts';
import type { AppEvent } from '../core/events.ts';
import { renderMarkdown, esc, plain } from '../lib/markdown.ts';
import { fold } from '../lib/fuzzy.ts';
import { $, $$, el, icon, kbd, rel, modal, confirmBox, toast, download, need, target, errMsg, num } from '../ui/kit.ts';

import type { Note, SaltedBox, ViewState } from '../types.ts';
import type { BioReply } from '../core/biometric.ts';

/** Ce que le hub attend de l'application. */
export interface HubApi {
  openNote(id: string, opts?: { edit?: boolean }): void;
  setView(v: ViewState): Promise<void>;
  renderMain(): void;
  renderSidebar?(): void;
  flush(id: string): Promise<void>;
  flushAll(): Promise<void>;
  refreshNote(n: Note): void;
  capture(text: string): Promise<unknown>;
  crumb(current: string, trail?: [string, string][]): string;
  theme(): string;
  setTheme(t: string): void;
  exportJSON(): unknown;
  exportZip(): unknown;
  pickFiles(): void;
  openHelp(): void;
  refreshPreview(): void;
  current(): Note | undefined;
  view(): string;
  tbLeft(): string;
  selection(): { text: string; end: number } | null;
  insertAtLineEnd(pos: number, text: string): void;
}
/** État mémorisé d'un agent (dernière exécution). */
interface RunState { last?: number; ok?: boolean; error?: string | null; seen?: number }
type Runs = Record<string, RunState>;
type StepInput = Record<string, unknown>;

let app!: HubApi;
const read = <T>(k: string, d: T): T => { try { return (JSON.parse(localStorage.getItem(k) || 'null') as T | null) ?? d; } catch { return d; } };
const write = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* plein */ } };
const titleOf = (n: Note) => n.title.trim() || 'Sans titre';
const plural = (n: number, w: string) => `${n} ${w}${n > 1 ? 's' : ''}`;

export function init(api: HubApi) {
  app = api;
  // Mise à jour de l'app Mac : l'onglet des réglages suit la recherche, la barre latérale signale une version disponible.
  let shown = '', announced = '';
  update.onChange(() => {
    if (curTab === 'maj') refreshConnections();
    const now = update.ready() ? 'ready' : update.available() ? 'available' : '';
    if (now !== shown) { shown = now; app.renderSidebar?.(); }
    // Une nouvelle version vient d'être trouvée : on le dit une fois, avec le chemin pour l'installer.
    // (Avec l'installation automatique, c'est la fenêtre « Mise à jour prête » qui l'annonce : voir news.ts.)
    const tag = update.current()?.tag ?? '';
    if (update.available() && !update.autoInstall() && tag && tag !== announced) { announced = tag; toast(`Studio ${tag} est disponible`, { label: 'Mettre à jour', run: () => openConnections('maj') }); }
  });
  link.on(e => {
    if (e.type === 'synced' && (e.got || e.sent)) toast(`Synchronisé avec ${e.name} · ${e.got} reçue(s), ${e.sent} envoyée(s)`);
    if (e.type === 'paired') toast(`Appareil lié : ${e.name}`);
    if (e.type === 'remote') {
      // Toute action pilotée à distance est signalée sur le Mac.
      toast(`${e.name} pilote Claude Code : ${e.what}`);
      window.webkit?.messageHandlers?.carnet?.postMessage({ type: 'notify', title: `Claude Code piloté depuis ${e.name}`, body: e.what, url: '' });
    }
    if (e.type === 'status' || e.type === 'devices') { refreshConnections(); if (app.view() === 'home') app.renderMain(); }
  });
  vault.onChange(refreshConnections);
  events.on(onEvent);
  document.addEventListener('pointerdown', erDrag);
  setTimeout(tick, 5000); setInterval(tick, 60e3);
  if (vault.isOpen()) startVaultServices();
  const m = location.hash.match(/lier=([0-9A-Za-z-]+)/);
  if (m) { history.replaceState(null, '', location.pathname + location.search); joinDialog(m[1]); }
}

let services = false;
function startVaultServices() { if (services) return; services = true; vault.startAutoLock(); link.startAll(); }

// ---------- Écran de déverrouillage ----------
export function gate(): Promise<void> {
  if (!vault.enabled()) return Promise.resolve();
  return new Promise<void>(res => {
    const node = el(`<div class="vault-lock"><form class="lock-card">${icon('shield')}<h3>Studio est verrouillé</h3><p>Tes notes sont chiffrées sur cet appareil.</p><input type="password" placeholder="Mot de passe du coffre" autocomplete="current-password" aria-label="Mot de passe du coffre"><button class="btn btn-primary">Déverrouiller</button>${vault.hasPasskey() ? `<button type="button" class="btn" data-pk>${icon('key')}Face ID / Touch ID</button>` : ''}${vault.hasBiometric() ? `<button type="button" class="btn" data-bio>${icon('key')}Ouvrir avec ${esc(vault.biometricKind())}</button>` : ''}<p class="lock-err" role="alert"></p></form></div>`);
    document.body.append(node);
    const form = need('form', node), input = need<HTMLInputElement>('input', form), err = need('.lock-err', form);
    const done = () => { node.remove(); res(); };
    const fail = (msg: string) => { form.classList.remove('busy'); form.classList.add('shake'); setTimeout(() => form.classList.remove('shake'), 400); err.textContent = msg; input.select(); };
    form.addEventListener('submit', async e => {
      e.preventDefault(); if (!input.value) return;
      form.classList.add('busy');
      try { await vault.unlockPassword(input.value); done(); } catch { fail('Mot de passe incorrect.'); }
    });
    // Biométrie de l'app native : proposée d'office à l'ouverture, sauf juste après un verrouillage volontaire.
    const unlockBio = async () => {
      form.classList.add('busy');
      try { await vault.unlockBiometric(); done(); }
      catch (e) { form.classList.remove('busy'); err.textContent = e instanceof vault.UnlockError && e.code === 'cancel' ? '' : errMsg(e); input.focus(); }
    };
    $('[data-bio]', form)?.addEventListener('click', unlockBio);
    let manual = false; try { manual = sessionStorage.getItem('studio.manualLock') === '1'; sessionStorage.removeItem('studio.manualLock'); } catch { /* ignoré */ }
    if (vault.hasBiometric() && !manual) setTimeout(unlockBio, 250);
    $('[data-pk]', form)?.addEventListener('click', async () => {
      try { await vault.unlockPasskey(); done(); } catch (e) { fail(e instanceof Error && e.name === 'NotAllowedError' ? 'Authentification annulée.' : errMsg(e)); }
    });
    input.focus();
  });
}

function askPassword({ title, text, confirm = false, ok = 'Valider' }: { title: string; text: string; confirm?: boolean; ok?: string }): Promise<string | null> {
  return new Promise<string | null>(res => {
    let done = false;
    const m = modal({ title, cls: 'small', onClose: () => { if (!done) res(null); }, html: `<p class="modal-text">${text}</p><form><input type="password" class="field" placeholder="Mot de passe" autocomplete="${confirm ? 'new-password' : 'current-password'}" required autofocus>${confirm ? '<input type="password" class="field" placeholder="Confirmer" autocomplete="new-password" required>' : ''}<p class="lock-err" role="alert"></p><div class="modal-actions"><button type="button" class="btn" data-x>Annuler</button><button class="btn btn-primary">${esc(ok)}</button></div></form>` });
    need('[data-x]', m.node).onclick = m.close;
    need('form', m.node).onsubmit = e => {
      e.preventDefault();
      const [a, b] = $$<HTMLInputElement>('input', m.node);
      if (!a) return;
      if (confirm && a.value !== b?.value) { need('.lock-err', m.node).textContent = 'Les deux mots de passe ne correspondent pas.'; return; }
      if (confirm && a.value.length < 10) { need('.lock-err', m.node).textContent = '10 caractères minimum.'; return; }
      done = true; m.close(); res(a.value);
    };
  });
}

// ---------- Sauvegardes ----------
// Coffre actif : la sauvegarde JSON est elle-même chiffrée par un mot de passe choisi à l'export.
export async function sealBackup(json: string): Promise<string | null> {
  if (!vault.enabled()) return json;
  const pw = await askPassword({ title: 'Sauvegarde chiffrée', text: 'Le coffre est actif : la sauvegarde sera chiffrée. Choisis le mot de passe qui permettra de la restaurer.', confirm: true, ok: 'Exporter' });
  if (!pw) return null;
  return JSON.stringify({ app: 'carnet', format: 2, exportedAt: new Date().toISOString(), sealed: await cr.sealWithPassword(pw, json) });
}
export async function openBackup(text: string): Promise<string> {
  const data = JSON.parse(text) as { sealed?: SaltedBox };
  if (!data.sealed) return text;
  for (;;) {
    const pw = await askPassword({ title: 'Sauvegarde chiffrée', text: 'Saisis le mot de passe choisi lors de l’export.' });
    if (!pw) throw new Error('import annulé');
    try { return await cr.openWithPassword(pw, data.sealed); } catch { toast('Mot de passe incorrect'); }
  }
}
export async function importPacket(text: string): Promise<void> {
  if (!vault.isOpen()) throw new Error('active le coffre et lie l’appareil d’abord');
  const r = await link.openPacket(text);
  toast(`Paquet de ${r.name} : ${plural(r.count, 'note')} mise(s) à jour`);
}

// ---------- Blocs spéciaux dans les notes ----------
const erModels = new Map<number, { m: schema.Model; key: string }>(), agentSpecs = new Map<number, ai.AgentSpec>(), linHTML = new Map<string, string>(), linAt = new Map<string, number>(), running = new Set<string>();
const ER = 'carnet.er';
type SavedLayouts = Record<string, Record<string, { x: number; y: number }>>;

export function fenceFor(note: Note): (lang: string, code: string, idx: number) => string | null {
  erModels.clear(); agentSpecs.clear();
  return (lang: string, code: string, idx: number) => {
    if (lang === 'sql' || lang === 'schema' || lang === 'erd') return erBlock(note, lang, code, idx);
    if (lang === 'agent') return agentBlock(note, code, idx);
    if (lang === 'linear') return linBlock(code);
    return registry.fence(lang, code);
  };
}

function erBlock(note: Note, lang: string, code: string, idx: number): string | null {
  const m = schema.parse(lang === 'sql' ? 'sql' : 'dsl', code);
  if (!m.tables.length) return lang === 'sql' ? null : `<div class="er"><div class="er-bar"><span class="er-stat">${icon('db')}Schéma vide</span></div><p class="er-hint">Une table par ligne, ses colonnes en retrait : <code>id uuid pk</code>, <code>email text unique</code>, <code>bio text?</code>, <code>team_id int &gt; teams.id</code></p></div>`;
  const key = `${note.id}:${idx}`;
  erModels.set(idx, { m, key });
  const pos = schema.layout(m, read<SavedLayouts>(ER, {})[key]);
  return `<div class="er" data-er="${idx}"><div class="er-bar"><span class="er-stat">${icon('db')}${plural(m.tables.length, 'table')} · ${plural(m.rels.length, 'relation')}</span><span class="er-tools">${[['sql', 'Copier SQL'], ['dsl', 'Copier texte'], ['mermaid', 'Copier Mermaid'], ['svg', 'SVG'], ['reset', 'Réorganiser']].map(([a, l]) => `<button data-er-act="${a}">${l}</button>`).join('')}</span></div><div class="er-scroll">${schema.renderSVG(m, pos)}</div>${m.warnings.length ? `<ul class="er-warn">${m.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}<details class="er-src"><summary>Source</summary><pre><code>${esc(code)}</code></pre></details></div>`;
}

function erDrag(e: PointerEvent) {
  const g = target(e).closest('.er .er-table'); if (!g || e.button > 0) return;
  const box = g.closest('.er'), info = box && erModels.get(num(box, 'er')); if (!box || !info) return;
  const scroll = need('.er-scroll', box), pos = schema.layout(info.m, read<SavedLayouts>(ER, {})[info.key]), name = g.dataset.t ?? '', at = pos[name];
  if (!at) return;
  e.preventDefault();
  const s = { x: e.clientX, y: e.clientY, px: at.x, py: at.y };
  scroll.setPointerCapture(e.pointerId); scroll.classList.add('dragging');
  const move = (ev: PointerEvent) => { at.x = Math.max(0, s.px + ev.clientX - s.x); at.y = Math.max(0, s.py + ev.clientY - s.y); scroll.innerHTML = schema.renderSVG(info.m, pos); };
  const up = () => {
    scroll.removeEventListener('pointermove', move); scroll.removeEventListener('pointerup', up); scroll.removeEventListener('pointercancel', up);
    scroll.classList.remove('dragging');
    const all = read<SavedLayouts>(ER, {}); all[info.key] = Object.fromEntries(Object.entries(pos).map(([k, p]) => [k, { x: Math.round(p.x), y: Math.round(p.y) }])); write(ER, all);
  };
  scroll.addEventListener('pointermove', move); scroll.addEventListener('pointerup', up); scroll.addEventListener('pointercancel', up);
}

async function erAction(box: HTMLElement, act: string): Promise<void> {
  const info = erModels.get(num(box, 'er')); if (!info) return;
  const copy = async (t: string, what: string) => { await navigator.clipboard?.writeText(t); toast(`${what} copié`); };
  if (act === 'sql') return copy(schema.toSQL(info.m), 'SQL (PostgreSQL)');
  if (act === 'dsl') return copy(schema.toDSL(info.m), 'Schéma texte');
  if (act === 'mermaid') return copy(schema.toMermaid(info.m), 'Diagramme Mermaid');
  if (act === 'svg') { const pos = schema.layout(info.m, read<SavedLayouts>(ER, {})[info.key]); return download('schema.svg', new Blob([schema.standaloneSVG(info.m, pos, document.documentElement.dataset.theme === 'dark')], { type: 'image/svg+xml' })); }
  if (act === 'reset') { const all = read<SavedLayouts>(ER, {}); delete all[info.key]; write(ER, all); app.refreshPreview(); }
}

function linDesc(o: linear.Query): string {
  const FR: Record<string, string> = { unstarted: 'à faire', started: 'en cours', backlog: 'backlog', completed: 'terminées', canceled: 'annulées', triage: 'triage' };
  return [o.assignee === 'me' ? 'assignées à moi' : o.assignee && `assignées à ${o.assignee}`, o.states?.map((x: string) => FR[x] || x).join(', '), o.team && `équipe ${o.team}`, o.project && `projet ${o.project}`, o.search && `« ${o.search} »`].filter(Boolean).join(' · ') || 'issues récentes';
}
function linBlock(code: string) {
  const o = linear.parseBlock(code), k = JSON.stringify(o);
  return `<div class="lin" data-lin="${esc(k)}"><div class="lin-head">${icon('linear')}<span>Linear · ${esc(linDesc(o))}</span><button class="icon-btn" data-lin-refresh title="Actualiser" aria-label="Actualiser">${icon('refresh')}</button></div><div class="lin-list">${linHTML.get(k) || '<div class="lin-empty">Chargement…</div>'}</div></div>`;
}
const PRIO = ['', '🔴', '🟠', '🟡', '🔵'];
const issueRow = (i: linear.Issue) => `<a class="lin-issue" href="${esc(i.url)}" target="_blank" rel="noopener noreferrer"><i class="lin-dot" style="--c:${esc(i.state?.color || '#999')}" title="${esc(i.state?.name || '')}"></i><span class="lin-id">${esc(i.identifier)}</span><span class="lin-title">${esc(i.title)}</span><span class="lin-meta">${PRIO[i.priority] || ''}${i.dueDate ? ` ${esc(new Date(i.dueDate).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }))}` : ''}${i.assignee ? ` · ${esc(i.assignee.name)}` : ''}</span></a>`;

export async function hydrate(root: ParentNode, fresh = false): Promise<void> {
  for (const box of $$('.lin', root)) {
    const k = box.dataset.lin ?? '', list = need('.lin-list', box);
    if (!linear.connected()) { list.innerHTML = `<div class="lin-empty">Linear n’est pas connecté. <button class="link-btn" data-open-conn="linear">Connecter Linear</button></div>`; continue; }
    if (!fresh && linHTML.has(k) && Date.now() - (linAt.get(k) ?? 0) < 60e3) continue;
    linAt.set(k, Date.now());
    try {
      const items = await linear.issues(JSON.parse(k) as linear.Query, { fresh });
      linHTML.set(k, items.length ? items.map(issueRow).join('') : '<div class="lin-empty">Aucune issue.</div>');
    } catch (e) { linHTML.set(k, `<div class="lin-empty err">${esc(errMsg(e))}</div>`); }
    for (const b of $$(`.lin[data-lin="${CSS.escape(k)}"] .lin-list`)) b.innerHTML = linHTML.get(k) ?? '';
  }
}

// ---------- Agents ----------
const RUNS = 'carnet.agents';
const setRun = (key: string, patch: RunState): void => { const all = read<Runs>(RUNS, {}); all[key] = { ...all[key], ...patch }; write(RUNS, all); };

function agentBlock(note: Note, code: string, idx: number): string {
  const s = ai.parseAgent(code), key = `${note.id}:${s.nom}`, st = read<Runs>(RUNS, {})[key] || {};
  agentSpecs.set(idx, s);
  const prov = ai.PROVIDERS[s.modele || ai.config().provider];
  const last = running.has(key) ? '<span class="ag-live"><span class="spin"></span>En cours…</span>'
    : st.last ? `<span class="${st.ok ? 'ag-ok' : 'ag-err'}">${st.ok ? '✓' : '⚠'} ${esc(rel(st.last))}</span>${st.error ? ` <span class="ag-errmsg">${esc(st.error)}</span>` : ''}` : 'Jamais lancé';
  return `<div class="agent-card" data-agent="${idx}"><div class="ag-head">${icon('bot')}<strong>${esc(s.nom)}</strong><span class="ag-prov">${esc(prov)}</span></div>
    <p class="ag-prompt">${esc(s.consigne.slice(0, 220) || 'Pas encore de consigne : écris-la sous la ligne ---')}${s.consigne.length > 220 ? '…' : ''}</p>
    <div class="ag-meta">${s.outils.map(t => `<span class="ag-chip">${esc(t)}</span>`).join('')}${s.planning ? `<span class="ag-chip">${icon('history')}${esc(s.planning)}</span>` : ''}${s.declencheur ? `<span class="ag-chip">${icon('bolt')}${esc(events.TRIGGERS[s.declencheur])}</span>` : ''}<span class="ag-chip">→ ${esc(s.sortie)}</span></div>
    <div class="ag-foot"><span class="ag-last">${last}</span><button class="btn btn-primary" data-agent-run="${idx}" ${running.has(key) ? 'disabled' : ''}>${icon('play')}Lancer</button></div></div>`;
}

export function approve(action: ai.Approval): Promise<boolean> {
  return new Promise<boolean>(res => {
    let done = false;
    const m = modal({ title: 'Autoriser cette action ?', cls: 'approve', onClose: () => { if (!done) res(false); },
      html: `<p class="modal-text"><strong>${esc(action.title)}</strong></p>${action.preview ? `<div class="approve-prev md">${renderMarkdown(String(action.preview).slice(0, 6000))}</div>` : ''}<p class="modal-hint">${icon('bot')}Demandé par un agent IA. Relis avant d’accepter : une note piégée pourrait tenter de le manipuler.</p><div class="modal-actions"><button class="btn" data-no autofocus>Refuser</button><button class="btn btn-primary" data-ok>Autoriser</button></div>` });
    need('[data-no]', m.node).onclick = () => m.close();
    need('[data-ok]', m.node).onclick = () => { done = true; m.close(); res(true); };
  });
}

const STEP: Record<string, (i: StepInput) => string> = { chercher_notes: (i: StepInput) => `Recherche « ${i.requete || '…'} »`, lire_note: (i: StepInput) => `Lecture de « ${i.titre} »`, lister_taches: () => 'Liste des tâches', creer_note: (i: StepInput) => `Création de « ${i.titre} »`, ajouter_a_note: (i: StepInput) => `Ajout à « ${i.titre} »`, ajouter_tache: (i: StepInput) => `Tâche « ${i.texte} »`, linear_chercher: () => 'Recherche dans Linear', linear_creer_issue: (i: StepInput) => `Issue Linear « ${i.titre} »`, lancer_agent: (i: StepInput) => `Délégation à l’agent « ${i.nom} »`, boite_reception: () => 'Boîte de réception', ranger_note: (i: StepInput) => `Rangement de « ${i.titre} »`, linear_notifications: () => 'Notifications Linear', github_actualite: () => 'Actualité GitHub' };

export const stepLabel = (e: ai.Step): string => (STEP[e.name] ?? (() => e.name))(e.input || {});

function runEntry(title: string) {
  let d = $('#runs'); if (!d) { d = el('<div id="runs" aria-live="polite"></div>'); document.body.append(d); }
  const ctrl = new AbortController();
  const node = el(`<div class="run"><div class="run-head"><span class="spin"></span><strong>${esc(title)}</strong><button class="icon-btn" data-x aria-label="Fermer">✕</button></div><div class="run-steps"></div><div class="run-out md"></div></div>`);
  d.append(node);
  need('[data-x]', node).onclick = () => { ctrl.abort(); node.remove(); };
  const steps = need('.run-steps', node);
  return {
    signal: ctrl.signal,
    step: (e: ai.Step) => { steps.insertAdjacentHTML('beforeend', `<div>${icon('bolt')}${esc(stepLabel(e))}</div>`); },
    done(text: string, target: Note | null) {
      need('.spin', node).outerHTML = `<span class="run-ok">${icon('check')}</span>`;
      need('.run-out', node).innerHTML = renderMarkdown(text.slice(0, 700) + (text.length > 700 ? '…' : '')) + (target ? `<button class="link-btn" data-open-note="${target.id}">Ouvrir « ${esc(titleOf(target))} »</button>` : '');
      if (target) setTimeout(() => { if (!node.matches(':hover')) node.remove(); }, 15000);
    },
    fail(msg: string) { need('.spin', node).outerHTML = `<span class="run-err">⚠</span>`; need('.run-out', node).innerHTML = `<p class="err">${esc(msg)}</p>`; },
  };
}

async function writeOutput(spec: ai.AgentSpec, note: Note, text: string) {
  const s = fold(spec.sortie || 'journal');
  if (!text || /^aucun/.test(s)) return null;
  const m = spec.sortie.match(/\[\[([^\]]+)\]\]/);
  const target = m ? (store.findByTitle(m[1]) || await store.createNote({ title: m[1].trim() })) : s === 'ici' ? note : await store.dailyNote();
  if (store.isLocked(target)) throw new Error('La note de sortie est verrouillée.');
  await app.flush(target.id);
  await ai.appendTo(target, `### ${spec.nom} ·${new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}\n\n${text}`);
  app.refreshNote(target);
  return target;
}

/** Comment une automatisation a été lancée. */
export type RunHow = 'manuel' | 'planifié' | 'déclenché';
/** Journal des exécutions : métadonnées seulement (le résultat, lui, est écrit dans la note de sortie). */
export interface LogEntry { ts: number; name: string; noteId: string; how: RunHow; ok: boolean; error?: string }
const LOG = 'carnet.agents.log', PAUSED = 'carnet.agents.paused';
export const runLog = (): LogEntry[] => read<LogEntry[]>(LOG, []);
const keyOf = (spec: ai.AgentSpec, note: Note) => `${note.id}:${spec.nom}`;
export const isPaused = (spec: ai.AgentSpec, note: Note): boolean => read<string[]>(PAUSED, []).includes(keyOf(spec, note));
export function setPaused(spec: ai.AgentSpec, note: Note, paused: boolean): void {
  const k = keyOf(spec, note), list = read<string[]>(PAUSED, []).filter(x => x !== k);
  write(PAUSED, paused ? [...list, k] : list);
}
const listeners = new Set<() => void>();
/** Les pages (accueil, automatisations) se redessinent quand une exécution commence ou finit. */
export const onRunsChange = (f: () => void): void => { listeners.add(f); };
const changed = () => { app.refreshPreview(); if (app.view() === 'home') app.renderMain(); listeners.forEach(f => f()); };

export async function runAgent(spec: ai.AgentSpec, note: Note, how: RunHow = 'manuel', event?: AppEvent): Promise<void> {
  const key = keyOf(spec, note);
  if (running.has(key)) return;
  running.add(key); changed();
  const r = runEntry(spec.nom + (how === 'manuel' ? '' : ` · ${how}`));
  const log = (ok: boolean, error?: string) => write(LOG, [{ ts: Date.now(), name: spec.nom, noteId: note.id, how, ok, ...(error ? { error } : {}) }, ...runLog()].slice(0, 40));
  try {
    const out = await ai.runAgent(spec, { approve, onStep: r.step, onWrite: app.refreshNote, signal: r.signal, ...(event ? { event } : {}) });
    const target = await writeOutput(spec, note, out.text);
    setRun(key, { last: Date.now(), ok: true, error: null }); log(true);
    r.done(out.text || '(réponse vide)', target);
  } catch (e) {
    const aborted = e instanceof Error && e.name === 'AbortError', msg = aborted ? 'Interrompu' : errMsg(e).slice(0, 160);
    setRun(key, { last: Date.now(), ok: false, error: msg }); log(false, msg);
    r.fail(aborted ? 'Interrompu.' : errMsg(e));
  } finally { running.delete(key); changed(); }
}

// Déclencheurs : une automatisation « déclencheur: … » se lance à l'événement, au plus une fois par minute,
// et seulement si l'événement tombe dans son périmètre (une notification Linear du projet, une note du projet…).
const lastTrigger = new Map<string, number>();
function onEvent(e: AppEvent): void {
  if (vault.enabled() && !vault.isOpen()) return;
  for (const { note, spec } of ai.findAgents()) {
    if (spec.declencheur !== e.kind || isPaused(spec, note) || !ai.ready(spec.modele || ai.config().provider)) continue;
    let s: scope.Scope; try { s = scope.byName(spec.projet); } catch { continue; }
    void scope.eventIn(s, e).then(ok => {
      const k = keyOf(spec, note);
      if (!ok || running.has(k) || Date.now() - (lastTrigger.get(k) ?? 0) < 60e3) return;
      lastTrigger.set(k, Date.now());
      void runAgent(spec, note, 'déclenché', e);
    });
  }
}

// Planification : un agent planifié se lance quand son créneau est passé, si l'app est ouverte
// (rattrapage unique si elle était fermée à l'heure prévue).
function tick(): void {
  if (vault.enabled() && !vault.isOpen()) return;
  const all = read<Runs>(RUNS, {}); let dirty = false;
  for (const { note, spec } of ai.findAgents()) {
    if (!spec.planning) continue;
    const key = `${note.id}:${spec.nom}`, st = all[key] ||= {};
    if (!st.seen) { st.seen = Date.now(); dirty = true; continue; }
    const slot = ai.lastSlot(spec.planning);
    if (slot && +slot > Math.max(st.last || 0, st.seen) && !running.has(key) && !isPaused(spec, note) && ai.ready(spec.modele || ai.config().provider)) void runAgent(spec, note, 'planifié');
  }
  if (dirty) write(RUNS, all);
}

// ---------- Demander à l'IA ----------
/** Note ouverte jointe à la demande : bornée, comme une note lue par l'outil lire_note (elle est renvoyée à chaque étape). */
const noteContext = (body: string): string => { const max = tuning.num('ctx.note'); return body.length > max ? body.slice(0, max) + '\n…(note tronquée)' : body; };
export function askAI(prefill = ''): void {
  const n = app.current(), cfg = ai.config();
  // Périmètre : le projet de la note ouverte, sinon Général. La liste des tâches mêle tous les projets : jamais jointe.
  const sc = scope.of(n ? projectOfNote(n) : null), withLinear = scope.hasLinear(sc);
  const canCtx = !!n && !n.deletedAt && !n.todo && !store.isLocked(n) && ai.shareable(n);
  const m = modal({ cls: 'ask', html: `<div class="cap-head">${icon('sparkle')}<span>Demander à l’IA</span><select class="ask-prov" aria-label="Fournisseur">${Object.entries(ai.PROVIDERS).map(([k, l]) => `<option value="${k}"${k === cfg.provider ? ' selected' : ''}>${l}${ai.ready(k as ai.Provider) ? '' : ' — à configurer'}</option>`).join('')}</select></div>
    <textarea rows="3" placeholder="Résume cette note, propose un plan d’action, crée les issues Linear correspondantes…" aria-label="Demande" autofocus>${esc(prefill)}</textarea>
    <p class="ask-scope">${icon('lock')}Périmètre : ${esc(scope.label(sc))}${sc.project ? '' : ' (hors projets)'}</p>
    <div class="ask-opts"><label><input type="checkbox" data-o="ctx"${canCtx ? ' checked' : ' disabled'}> Note ouverte${n && !canCtx ? (n.todo ? ' (liste des tâches : jamais jointe)' : ' (chiffrée ou #privé : jamais envoyée)') : ''}</label><label><input type="checkbox" data-o="notes" checked> ${sc.project ? 'Notes du projet' : 'Notes hors projets'}</label><label title="${withLinear ? '' : 'Linear ne s’ouvre à l’IA que depuis un projet relié à Linear'}"><input type="checkbox" data-o="linear"${withLinear ? '' : ' disabled'}> Linear${sc.project?.linear ? ` · ${esc(sc.project.linear)}` : ''}</label><label><input type="checkbox" data-o="agents"> Mes agents</label></div>
    <div class="ask-steps"></div><div class="ask-out md" hidden></div>
    <div class="cap-foot"><span class="ask-status"></span><span class="ask-actions"><button class="btn" data-ins hidden>Ajouter à la note</button><button class="btn" data-new hidden>Nouvelle note</button><button class="btn btn-primary" data-go>Envoyer ${kbd('mod+enter')}</button></span></div>` });
  const ta = need<HTMLTextAreaElement>('textarea', m.node), out = need('.ask-out', m.node), status = need('.ask-status', m.node), steps = need('.ask-steps', m.node);
  let text = '', busy = false;
  const go = async () => {
    if (busy || !ta.value.trim()) return;
    const p = need<HTMLSelectElement>('.ask-prov', m.node).value as ai.Provider;
    if (!ai.ready(p)) { m.close(); openConnections('ia'); return; }
    busy = true; status.innerHTML = '<span class="spin"></span> Réflexion…'; steps.innerHTML = ''; out.hidden = true;
    const opt = (k: string) => !!$<HTMLInputElement>(`[data-o="${k}"]`, m.node)?.checked;
    try {
      const ctx = n && opt('ctx') ? `Note ouverte : « ${titleOf(n)} »\n\n${noteContext(store.getBody(n) ?? '')}` : '';
      void journal.record(ta.value, n && opt('ctx') ? `Demander à l’IA · ${titleOf(n)}` : 'Demander à l’IA');
      const r = await ai.run({ prompt: ta.value, provider: p, context: ctx, tools: ['notes', 'linear', 'agents'].filter(opt) },
        { approve, scope: sc, onWrite: app.refreshNote, onStep: e => steps.insertAdjacentHTML('beforeend', `<div>${icon('bolt')}${esc(stepLabel(e))}</div>`) });
      text = r.text; out.innerHTML = renderMarkdown(text || '*(réponse vide)*'); out.hidden = false;
      status.textContent = `Réponse de ${ai.PROVIDERS[p]}`;
      need('[data-ins]', m.node).hidden = !canCtx; need('[data-new]', m.node).hidden = false;
    } catch (e) { status.innerHTML = `<span class="err">${esc(errMsg(e))}</span>`; }
    busy = false;
  };
  need('[data-go]', m.node).onclick = () => void go();
  ta.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void go(); } });
  need('[data-ins]', m.node).onclick = async () => { if (!n) return; await app.flush(n.id); await ai.appendTo(n, text); app.refreshNote(n); m.close(); toast('Ajouté à la note'); };
  need('[data-new]', m.node).onclick = async () => { const t = plain(text.split('\n').find(l => l.trim()) || 'Réponse IA').slice(0, 80); const nn = await store.createNote({ title: t, body: text }); m.close(); app.openNote(nn.id); };
}

// ---------- Linear depuis une note ----------
export async function issueFromSelection(): Promise<void> {
  if (!linear.connected()) { openConnections('linear'); return; }
  const sel = app.selection(); if (!sel) { toast('Ouvre une note et sélectionne du texte (ou place le curseur sur une tâche).'); return; }
  const lines = sel.text.split('\n').map((l: string) => plain(l)).filter(Boolean);
  let teams: linear.Team[] = []; try { teams = await linear.teams(); } catch (e) { toast('Linear : ' + errMsg(e)); return; }
  const m = modal({ title: 'Nouvelle issue Linear', html: `<form><input class="field" name="t" value="${esc(lines[0] || '')}" placeholder="Titre" required autofocus><textarea class="field area" name="d" rows="4" placeholder="Description (Markdown)">${esc(lines.slice(1).join('\n'))}</textarea><select class="field" name="team">${teams.map(t => `<option value="${t.id}">${esc(t.key)} · ${esc(t.name)}</option>`).join('')}</select><p class="modal-hint">Le lien vers l’issue sera ajouté au bout de la ligne.</p><div class="modal-actions"><button type="button" class="btn" data-x>Annuler</button><button class="btn btn-primary">Créer l’issue</button></div></form>` });
  need('[data-x]', m.node).onclick = m.close;
  need('form', m.node).onsubmit = async e => {
    e.preventDefault(); const f = target(e) as HTMLFormElement;
    const field = (n: string) => (f.elements.namedItem(n) as HTMLInputElement | null)?.value ?? '';
    try {
      const d = field('d');
      const i = await linear.createIssue({ teamId: field('team'), title: field('t'), ...(d ? { description: d } : {}) });
      m.close(); app.insertAtLineEnd(sel.end, ` [${i.identifier}](${i.url})`); toast(`Issue ${i.identifier} créée`);
    } catch (err) { toast('Linear : ' + errMsg(err)); }
  };
}

// ---------- Accueil ----------
// Peu de cartes, chacune utile : ce qu'il y a à faire, les agents, les notes récentes, les appareils.
// État des agents pour l'accueil et la page Agents.
export function agentList(): { note: Note; spec: ai.AgentSpec; index: number; live: boolean; last?: number | undefined; ok?: boolean | undefined; paused: boolean }[] {
  const runs = read<Runs>(RUNS, {});
  return ai.findAgents().map(({ note, spec }, index) => { const key = `${note.id}:${spec.nom}`, st = runs[key] || {}; return { note, spec, index, live: running.has(key), last: st.last, ok: st.ok, paused: isPaused(spec, note) }; });
}

// ---------- Clics délégués (renvoie true si traité) ----------
export async function click(e: MouseEvent): Promise<boolean> {
  const t = target(e);
  let x: HTMLElement | null;
  if ((x = t.closest('[data-er-act]'))) { const box = x.closest('.er'); if (box) await erAction(box, x.dataset.erAct ?? ''); return true; }
  if ((x = t.closest('[data-agent-run]'))) { const s = agentSpecs.get(num(x, 'agentRun')), n = app.current(); if (s && n) void runAgent(s, n); return true; }
  if ((x = t.closest('[data-lin-refresh]'))) { const box = x.closest('.lin'); if (box) { linHTML.delete(box.dataset.lin ?? ''); if (box.parentElement) void hydrate(box.parentElement, true); } return true; }
  if ((x = t.closest('[data-open-conn]'))) { openConnections(x.dataset.openConn); return true; }
  if ((x = t.closest('[data-open-note]'))) { if (x.dataset.openNote) app.openNote(x.dataset.openNote); return true; }
  if ((x = t.closest('[data-home-agent]'))) { const a = ai.findAgents()[num(x, 'homeAgent')]; if (a) void runAgent(a.spec, a.note); return true; }
  if ((x = t.closest('[data-home]'))) {
    const a = x.dataset.home;
    if (a === 'today') void app.setView({ type: 'today' });
    if (a === 'sync') { link.syncNow(); toast('Recherche des appareils…'); }
    if (a === 'pair') void pairDialog();
    if (a === 'new-agent') void newAgentNote();
    return true;
  }
  return false;
}

export const AGENT_TEMPLATE = '```agent\nnom: Mon automatisation\noutils: notes, linear, github\nprojet:\nplanning:\ndéclencheur:\nsortie: journal\n---\nDécris ici, comme à un assistant, ce que Studio doit faire. Exemple : « Chaque matin, liste mes tâches en retard et crée une note avec mes trois priorités. »\n```\n';
export const SCHEMA_TEMPLATE = '```schema\nusers\n  id uuid pk\n  email text unique\n  name text?\n\nposts\n  id uuid pk\n  author_id uuid > users.id\n  title text\n  published_at timestamptz?\n```\n';
export async function newAgentNote(): Promise<void> {
  const n = await store.createNote({ title: 'Nouvel agent', body: `${AGENT_TEMPLATE}\n#agents` });
  app.openNote(n.id, { edit: true });
}

// ---------- Page « Réglages » ----------
const TABS: [string, string, string, string][] = [
  ['coffre', 'shield', 'Sécurité', 'Chiffrement de tout le carnet, déverrouillage et verrouillage automatique.'],
  ['ia', 'sparkle', 'Intelligence artificielle', 'Ton abonnement Claude via Claude Code, ou une clé Claude, OpenAI, ou un modèle local.'],
  ['consignes', 'gear', 'Consignes et contexte', 'Tout ce que Studio envoie à l’IA en plus de ta demande : consignes, limites de contexte, modèles. Modifiable, et rétablissable d’un clic.'],
  ['autorisations', 'terminal', 'Autorisations des agents', 'Ce que les agents Claude Code des projets ont le droit de faire sur ce Mac : commandes, accès au web, notes et tâches du projet, dossiers des outils.'],
  ['linear', 'linear', 'Linear', 'Tickets, projets et notifications Linear, sans intermédiaire.'],
  ['github', 'github', 'GitHub', 'L’actualité de tes dépôts, en lecture seule.'],
  ['extensions', 'plug', 'Extensions', 'Des fonctions en plus, à activer une par une : Spotify, n8n… Tout tourne sur cet appareil, sans serveur.'],
  ['appareils', 'devices', 'Appareils', 'Relie ton téléphone et tes ordinateurs, sans serveur, chiffré de bout en bout.'],
  ['apparence', 'palette', 'Apparence', 'Thème de l’interface.'],
  ['donnees', 'database', 'Données', 'Sauvegardes, import et export.'],
  ['maj', 'download', 'Mises à jour', 'Version installée et nouvelles versions de Studio.'],
];
let curTab = 'coffre';
const root = () => $('#main .settings');

export function openConnections(tab = 'coffre'): void { void app.setView({ type: 'settings', tab }); }

export function mountSettings(main: HTMLElement, tab: string): void {
  curTab = TABS.some(t => t[0] === tab) ? tab : 'coffre';
  main.innerHTML = `<header class="toolbar">${app.tbLeft()}${app.crumb(TABS.find(t => t[0] === curTab)?.[2] ?? 'Réglages', [['Réglages', '']])}<div class="tb-side tb-right"></div></header>
    <div class="settings"><nav class="set-nav" aria-label="Sections">${TABS.map(([k, ic, l]) => `<button data-tab="${k}"${k === curTab ? ' aria-current="page"' : ''}>${icon(ic)}<span>${l}</span></button>`).join('')}</nav>
    <div class="set-scroll"><div class="set-body"></div></div></div>`;
  const r = root(); if (!r) return;
  r.addEventListener('click', e => void onConnClick(e));
  r.addEventListener('submit', e => void onConnSubmit(e));
  r.addEventListener('change', onConnChange);
  refreshConnections();
}

const TAB_BODY: Record<string, () => string> = { coffre: () => tabVault(), ia: () => tabAI(), consignes: () => tuningUI.html(), autorisations: () => permissionsUI.html(), linear: () => tabLinear(), github: () => tabGithub(), extensions: () => pluginsUI.html(), appareils: () => tabDevices(), apparence: () => tabLook(), donnees: () => tabData(), maj: () => tabUpdate() };
/** Pour les plugins : redessine l'onglet Extensions s'il est à l'écran. */
export function refreshSettings(): void { if (curTab === 'extensions') refreshConnections(); }
function refreshConnections(): void {
  const r = root(); if (!r) return;
  const active = document.activeElement as HTMLInputElement | null;
  const body = need('.set-body', r), focus = active?.closest('.set-body') ? active.name : null;
  const [, , label, lead] = TABS.find(t => t[0] === curTab) ?? TABS[0] ?? ['', '', '', ''];
  $$('.set-nav [data-tab]', r).forEach(b => b.toggleAttribute('aria-current', b.dataset.tab === curTab));
  body.innerHTML = `<h1>${label}</h1><p class="set-lead">${lead}</p>` + (TAB_BODY[curTab] ?? tabVault)();
  if (focus) $(`[name="${focus}"]`, body)?.focus();
  if (curTab === 'github' && github.connected()) github.viewer().then(v => { const x = $('[data-gh-who]', body); if (x) x.textContent = `Connecté : ${v.login}`; }).catch(e => { const x = $('[data-gh-who]', body); if (x) x.textContent = 'Erreur : ' + e.message; });
  if (curTab === 'linear' && linear.connected()) linear.viewer().then(v => { const x = $('.cx-who', body); if (x) x.textContent = `Connecté : ${v.viewer.name} · ${v.organization.name}`; }).catch(e => { const x = $('.cx-who', body); if (x) x.textContent = 'Erreur : ' + e.message; });
  if (curTab === 'ia') ccRefresh();
  if (curTab === 'consignes') tuningUI.mount();
  if (curTab === 'autorisations') permissionsUI.mount();
  if (curTab === 'maj' && update.supported() && !update.current() && !update.working() && !update.outdatedShell()) void update.check();
  if (curTab === 'donnees') navigator.storage?.estimate?.().then(e => { const x = $('.cx-usage', body); if (x) x.textContent = `${((e.usage ?? 0) / 1048576).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} Mo utilisés sur cet appareil.`; });
}

function tabLook() {
  const t = app.theme();
  return `<section class="cx-sec"><h4>Thème</h4><div class="look">${[['auto', 'Système'], ['light', 'Clair'], ['dark', 'Sombre']].map(([k, l]) => `<label class="look-opt"><input type="radio" name="theme" value="${k}"${t === k ? ' checked' : ''}><span class="look-prev look-${k}"><i></i><i></i><i></i></span><span>${l}</span></label>`).join('')}</div></section>`;
}
// ---------- Mises à jour ----------
// La version web se met à jour seule ; l'app Mac se met à jour d'ici, depuis les Releases du dépôt (voir core/update.ts).
const RELEASES = 'https://github.com/MTthoas/Studio/releases/latest';
function tabUpdate(): string {
  if (!update.supported()) return `<section class="cx-sec"><h4>${icon('check')}Rien à faire ici</h4><p>${document.documentElement.dataset.native === 'ios'
    ? 'L’app iPhone se met à jour en la réinstallant depuis Xcode, comme à la première installation.'
    : 'La version web se met à jour toute seule : à chaque ouverture en ligne, Studio charge la dernière version, puis la garde pour le hors ligne.'}</p></section>`;
  if (update.outdatedShell()) return `<section class="cx-sec"><h4>${icon('download')}Une dernière mise à jour à la main</h4>
    <p>L’app installée sur ce Mac date d’avant les mises à jour intégrées. Installe la version actuelle une dernière fois à la main : <code>studio update</code> dans le Terminal, ou <code>Studio-macOS.zip</code> depuis les <a href="${RELEASES}" target="_blank" rel="noopener">Releases</a>. Les suivantes s’installeront d’ici.</p></section>`;
  const s = update.current(), w = update.working();
  const installed = s ? `<p class="up-ver">Version installée : <strong>${esc(s.current || 'inconnue')}</strong>${s.commit ? ` <code>${esc(s.commit)}</code>` : ''}</p>` : '';
  const date = s?.published ? new Date(s.published).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
  const page = s?.page?.startsWith('https://github.com/') ? s.page : RELEASES;
  const again = `<button class="btn" data-v="update-check"${w ? ' disabled' : ''}>${icon('refresh')}Chercher maintenant</button>`;
  // Ce qui change : la liste lisible tirée des notes de version, sinon les notes telles quelles.
  const raw = s?.notes?.trim() ?? '';
  const notes = raw ? news.changeList(raw, 8) || `<details class="up-notes"><summary>Ce qui change</summary><pre class="cx-code">${esc(raw)}</pre></details>` : '';
  const onGithub = `<a class="btn" href="${esc(page)}" target="_blank" rel="noopener">${icon('github')}Voir sur GitHub</a>`;
  const body = w === 'install' ? `<h4><span class="spin"></span>Installation de ${esc(s?.tag ?? 'la mise à jour')}…</h4><p>Vérification du paquet, remplacement de l’app, puis Studio se relance tout seul. Tes notes sont enregistrées avant.</p>`
    : w === 'download' ? `<h4><span class="spin"></span>Téléchargement de ${esc(s?.tag ?? 'la mise à jour')}…</h4><p>Studio télécharge et vérifie la nouvelle version en arrière-plan. Tu peux continuer à travailler.</p>${installed}`
    : !s ? '<p class="cc-wait"><span class="spin"></span>Recherche de la dernière version…</p>'
    : !s.ok ? `<h4>${icon('shield')}Recherche impossible</h4><p>${esc(s.message ?? 'La dernière version n’a pas pu être lue.')}</p>${installed}<div class="cx-grid">${again}</div>`
    : s.available && s.staged ? `<h4>${icon('check')}Studio ${esc(s.tag ?? '')} est prête</h4><p>Téléchargée et vérifiée. Elle s’installera toute seule quand tu quitteras Studio, ou tout de suite si tu relances.</p>${installed}${notes}
        <div class="cx-grid"><button class="btn btn-primary" data-v="update-install">${icon('refresh')}Relancer et installer</button>${onGithub}</div>`
    : s.available ? `<h4>${icon('download')}Studio ${esc(s.tag ?? '')} est disponible</h4><p>${date ? `Publiée le ${esc(date)}. ` : ''}L’app est téléchargée depuis les Releases du dépôt, vérifiée, remplacée, puis relancée.</p>${installed}
        ${update.problem() ? `<p class="up-ver up-warn">Le téléchargement automatique a échoué : ${esc(update.problem())}</p>` : ''}${notes}
        <div class="cx-grid"><button class="btn btn-primary" data-v="update-install">${icon('download')}Mettre à jour et relancer</button>${onGithub}</div>`
    : `<h4>${icon('check')}Studio est à jour</h4>${installed}${s.tag ? `<p>Dernière version publiée : ${esc(s.tag)}${date ? `, le ${esc(date)}` : ''}.</p>` : '<p>Aucune version publiée pour l’instant.</p>'}<div class="cx-grid">${again}<button class="btn" data-v="news-open">${icon('bolt')}Voir les nouveautés</button></div>`;
  return `<section class="cx-sec up">${body}</section>
    <section class="cx-sec"><label class="cx-check"><input type="checkbox" data-update-auto${update.auto() ? ' checked' : ''}> Chercher les mises à jour automatiquement</label>
    <p class="modal-hint">Au lancement puis toutes les 6 heures, Studio demande à <code>api.github.com</code> la dernière version publiée du dépôt.</p>
    <label class="cx-check"><input type="checkbox" data-update-install${update.autoInstall() ? ' checked' : ''}> Télécharger et installer automatiquement</label>
    <p class="modal-hint">Une version trouvée est téléchargée et vérifiée en arrière-plan (même identifiant, signature intacte), puis installée quand tu relances Studio ou quand tu le quittes. Décochée, rien n’est téléchargé ni installé sans ton clic. Après une mise à jour, macOS peut redemander certains accords (trousseau, micro) : l’app n’est pas signée par un compte développeur Apple.</p></section>`;
}

function tabData() {
  const n = store.index().live.length;
  return `<section class="cx-sec"><h4>Sauvegarde</h4><p>${plural(n, 'note')}. <span class="cx-usage"></span></p>
    <div class="cx-grid"><button class="btn btn-primary" data-v="export-json">${icon('download')}Exporter une sauvegarde${vault.enabled() ? ' chiffrée' : ''}</button><button class="btn" data-v="export-md">${icon('download')}Markdown (.zip)</button><button class="btn" data-v="import">${icon('upload')}Importer…</button></div>
    <p class="modal-hint">L’import accepte les fichiers Markdown, les sauvegardes JSON (chiffrées ou non) et les paquets <code>.carnet</code> d’un appareil lié.</p></section>`;
}

const needVault = (what: string) => `<div class="cx-need">${icon('shield')}<p>${what} sont gardées chiffrées dans le coffre. Active-le d’abord : c’est ce qui garantit qu’aucun secret n’est stocké en clair.</p><button class="btn btn-primary" data-tab="coffre">Activer le coffre</button></div>`;
const keyField = (name: string, label: string, ph: string) => vault.secret(name)
  ? `<div class="cx-key">${icon('key')}<span>${label} enregistrée <code>••••${esc(String(vault.secret(name)).slice(-4))}</code></span><button class="btn btn-danger" data-del-key="${name}">Supprimer</button></div>`
  : `<form class="cx-row" data-key="${name}"><input type="password" class="field" name="k-${name}" placeholder="${ph}" autocomplete="off" spellcheck="false" required><button class="btn btn-primary">Enregistrer</button></form>`;

function tabVault() {
  if (!vault.enabled()) return `<section class="cx-sec"><h4>${icon('shield')}Chiffrer tout le carnet</h4>
    <p>Le coffre chiffre <strong>toutes</strong> les notes, l’historique, les clés API et les appareils liés (AES-256-GCM) avec une clé maîtresse que seul ton mot de passe — ou Face ID / Touch ID — peut ouvrir. Sans lui, les données sur le disque sont illisibles.</p>
    <form data-f="create"><input type="password" class="field" name="p1" placeholder="Mot de passe (10 caractères minimum)" autocomplete="new-password" required><input type="password" class="field" name="p2" placeholder="Confirmer" autocomplete="new-password" required><p class="lock-err" role="alert"></p><button class="btn btn-primary">Activer le coffre</button></form>
    <p class="modal-hint">Aucune récupération possible en cas d’oubli : garde une sauvegarde.</p></section>`;
  const s = vault.settings();
  return `<section class="cx-sec"><h4>${icon('shield')}Coffre actif</h4><p>Base de notes, historique, clés et appareils : chiffrés sur le disque. Restent lisibles : les identifiants techniques des notes et tes préférences d’affichage.</p>
    <div class="cx-grid"><button class="btn" data-v="lock">${icon('lock')}Verrouiller maintenant</button><button class="btn" data-v="pw">Changer le mot de passe…</button></div></section>
    ${biometricSection()}
    ${vault.biometricPossibleSync() ? '' : `<section class="cx-sec"><h4>${icon('key')}Face ID / Touch ID</h4>${vault.hasPasskey() ? `<p>Une passkey de cet appareil peut ouvrir le coffre.</p><button class="btn" data-v="pk-del">Retirer la passkey</button>`
      : vault.passkeyPossible() ? `<p>Ouvre le coffre avec ta biométrie : une passkey dérive une clé (extension PRF) qui emballe la clé maîtresse. Safari 18+, Chrome récents.</p><button class="btn btn-primary" data-v="pk-add">Ajouter Face ID / Touch ID</button>` : '<p>Ce navigateur ne gère pas les passkeys.</p>'}</section>`}
    <section class="cx-sec"><h4>${icon('history')}Verrouillage automatique</h4><select class="field" data-autolock>${[[5, '5 minutes'], [15, '15 minutes'], [30, '30 minutes'], [60, '1 heure'], [0, 'Jamais']].map(([v, l]) => `<option value="${v}"${s.autolock === v ? ' selected' : ''}>Après ${l} d’inactivité</option>`).join('').replace('Après Jamais d’inactivité', 'Jamais')}</select></section>
    <section class="cx-sec"><button class="btn btn-danger" data-v="off">Désactiver le coffre…</button></section>`;
}

/** Consommation du mois et ce qu'il reste du budget. */
export function usageHTML(): string {
  const c = ai.config(), { rows, total, subscription } = usage.month(), used = usage.billable(total), budget = (c.budgetM || 0) * 1e6;
  const left = budget ? Math.max(0, budget - used) : 0, pct = budget ? Math.min(100, Math.round(used / budget * 100)) : 0;
  return `<div class="us-sum"><div><strong>${usage.fmt(used)}</strong><span>tokens API ce mois-ci</span><em>${total.calls} appel${total.calls > 1 ? 's' : ''}</em></div>
      ${budget ? `<div><strong class="${pct >= 90 ? 'err' : pct >= 70 ? 'warn' : 'ok'}">${usage.fmt(left)}</strong><span>restants sur ${usage.fmt(budget)}</span></div>` : '<div><strong>—</strong><span>pas de budget fixé</span></div>'}${subscription.calls ? `<div><strong>${usage.fmt(usage.billable(subscription))}</strong><span>via Claude Code</span><em>${subscription.calls} appel${subscription.calls > 1 ? 's' : ''} · abonnement</em></div>` : ''}</div>
    ${budget ? `<span class="bar us-bar"><i style="width:${pct}%" class="${pct >= 90 ? 'err' : pct >= 70 ? 'warn' : ''}"></i></span>` : ''}
    ${rows.length ? `<div class="us-rows">${rows.map(([k, r]) => `<div class="us-row"><span>${esc(k.replace(/^(\w+):/, (_, p: string) => (ai.PROVIDERS[p as ai.Provider] ?? p) + ' · '))}</span><em>${usage.fmt(r.input + r.cacheWrite)} entrée · ${usage.fmt(r.output)} sortie${r.cacheRead ? ` · ${usage.fmt(r.cacheRead)} cache` : ''}</em></div>`).join('')}</div>` : '<p class="modal-hint">Aucun appel ce mois-ci.</p>'}`;
}

// ---------- Claude Code (abonnement, app Mac) ----------
const CC_INSTALL = 'curl -fsSL https://claude.ai/install.sh | bash';
let ccChecked = 0;
const pill = (tone: string, html: string) => `<span class="cc-pill" style="--c:var(--c-${tone})">${html}</span>`;

function ccHTML(): string {
  const s = ai.cc.last, c = ai.config(), active = c.provider === 'claudecode';
  const head = (state: string) => `<div class="cc-head"><span class="cc-logo">${icon('terminal')}</span><div class="cc-title"><h4>Claude Code</h4><p>Ton abonnement Claude, sans clé API.</p></div>${state}</div>`;
  if (!ai.cc.onMac()) return head(pill('gray', 'App Mac')) + '<p class="cc-text">Claude Code se branche depuis l’app Studio pour Mac, là où il est installé. Ici, utilise une clé API.</p>';
  if (!s) return head(pill('gray', '<span class="spin"></span>Recherche'));
  if (!s.installed) return head(pill('amber', 'Non installé')) + `<ol class="cc-steps">
      <li><span>Colle cette commande dans le Terminal pour installer Claude Code.</span><div class="cc-cmd"><code>${esc(CC_INSTALL)}</code><button class="btn" data-v="cc-copy">${icon('copy')}Copier</button></div></li>
      <li><span>Reviens ici une fois l’installation terminée.</span><button class="btn" data-v="cc-check">${icon('refresh')}Vérifier à nouveau</button></li></ol>`;
  const facts = `<dl class="cc-facts"><div><dt>Version</dt><dd>${esc(s.version || '—')}</dd></div><div><dt>Installé via</dt><dd>${s.source === 'extension' ? 'Extension VS Code' : 'Terminal'}</dd></div>${s.loggedIn ? `<div><dt>Offre</dt><dd>${esc(ai.cc.plan(s) || 'Claude')}</dd></div>` : ''}</dl>`;
  if (!s.loggedIn) return head(pill('amber', 'Non connecté')) + facts + `<div class="cc-act"><p>Connecte Claude Code à ton abonnement : la page de connexion de Claude s’ouvre dans ton navigateur.</p><button class="btn btn-primary" data-v="cc-login">Se connecter</button></div>`;
  return head(pill('green', 'Connecté')) + facts + `<div class="cc-usage" data-cc-usage>${ccUsageHTML()}</div><div class="cc-act">${active
      ? `<p>${icon('check')}Claude Code répond à toutes les demandes d’IA de Studio sur ce Mac.</p>`
      : '<p>Fais de Claude Code le fournisseur par défaut : revue de code, automatisations et questions passeront par ton abonnement.</p><button class="btn btn-primary" data-v="cc-use">Utiliser Claude Code</button>'}</div>
    <label class="cc-model"><span>Modèle</span><select class="field" data-cfg="ccModel">${ai.CC_MODELS.map(([v, l]) => `<option value="${v}"${c.ccModel === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
    <p class="modal-hint">${icon('shield')}Claude Code tourne sans ses propres outils : il ne lance aucune commande et ne lit aucun fichier. Seules les actions de Studio sont possibles, et toujours avec ton accord. Les demandes comptent dans les limites de ton abonnement.</p>`;
}
function ccRefresh(force = false): void {
  if (!ai.cc.onMac() || (!force && Date.now() - ccChecked < 15000)) return;
  ccChecked = Date.now();
  void ai.cc.status().then(() => { const x = $('#main .settings [data-cc]'); if (x) x.innerHTML = ccHTML(); });
  ccUsageRefresh();
}

// Utilisation de l'abonnement Claude : limites (session de 5 heures, semaine) et tokens consommés par Claude Code sur ce Mac.
const CC_WINDOWS: Record<string, string> = { five_hour: 'Session en cours · 5 heures', seven_day: 'Semaine · tous les modèles', seven_day_opus: 'Semaine · Opus', seven_day_sonnet: 'Semaine · Sonnet', extra: 'Crédit supplémentaire' };
function ccUsageHTML(): string {
  const l = ai.cc.limits, u = ai.cc.local;
  if (!l && !u && ai.cc.usageError) return `<h5>Utilisation de ton abonnement</h5><p class="modal-hint">${esc(ai.cc.usageError)}</p>`;
  const when = (s: number) => { const at = new Date(s * 1000); return at.toLocaleString('fr-FR', { weekday: at.getTime() - Date.now() > 20 * 36e5 ? 'long' : undefined, hour: '2-digit', minute: '2-digit' }); };
  const limits = !l ? '<p class="cc-wait"><span class="spin"></span>Lecture des limites…</p>'
    : !l.enabled ? `<div class="cc-ask"><p>Affiche la part utilisée de ta <strong>session de 5 heures</strong> et de ta <strong>semaine</strong>, comme <code>/usage</code> dans Claude Code. Anthropic ne la donne qu’au compte connecté : Studio lira la connexion de Claude Code dans le trousseau de ce Mac (macOS te demandera ton accord) et interrogera <code>api.anthropic.com</code>, rien d’autre.</p><button class="btn btn-primary" data-v="cc-limits-on">Afficher mes limites</button></div>`
    : !l.ready ? `<div class="cc-ask"><p>${icon('shield')}${esc(l.message ?? 'Limites illisibles pour l’instant.')}</p><button class="btn" data-v="cc-limits-off">Ne plus lire les limites</button></div>`
    : `<div class="cc-lims">${(l.windows ?? []).map(w => { const pct = Math.round(w.pct), tone = pct >= 90 ? 'err' : pct >= 70 ? 'warn' : ''; return `<div class="cc-lim"><div><span>${esc(CC_WINDOWS[w.key] ?? w.key)}</span><strong class="${tone}">${pct} % utilisés</strong></div><span class="bar cc-bar"><i style="width:${Math.min(100, pct)}%" class="${tone}"></i></span>${w.resetsAt && w.resetsAt * 1000 > Date.now() ? `<em>se réinitialise ${esc(when(w.resetsAt))}</em>` : ''}</div>`; }).join('')}</div>`;
  const tile = (c: ai.CcCounts, label: string) => `<div><strong>${usage.fmt(usage.billable(c))}</strong><span>${label}</span><em>${usage.fmt(c.output)} écrits · ${c.calls} réponse${c.calls > 1 ? 's' : ''}</em></div>`;
  const tokens = !u ? (ai.cc.usageError ? `<p class="modal-hint">${esc(ai.cc.usageError)}</p>` : '<p class="cc-wait"><span class="spin"></span>Lecture des journaux de Claude Code…</p>')
    : `<div class="us-sum">${tile(u.h5, 'tokens · 5 dernières heures')}${tile(u.today, 'tokens · aujourd’hui')}${tile(u.d7, 'tokens · 7 jours')}</div>
      ${u.models.length ? `<div class="us-rows">${u.models.map(m => `<div class="us-row"><span>${esc(m.model)}</span><em>${usage.fmt(m.input + m.cacheWrite)} entrée · ${usage.fmt(m.output)} sortie${m.cacheRead ? ` · ${usage.fmt(m.cacheRead)} cache` : ''}</em></div>`).join('')}</div>` : '<p class="modal-hint">Aucune activité de Claude Code sur ce Mac ces 7 derniers jours.</p>'}`;
  return `<div class="cc-uh"><h5>Utilisation de ton abonnement</h5><button class="btn" data-v="cc-usage-refresh">${icon('refresh')}Actualiser</button></div>${limits}
    <h5 class="cc-sub">Tokens consommés par Claude Code <span>toutes les sessions de ce Mac, lues en local</span></h5>${tokens}
    ${l?.enabled && l.ready ? '<p class="cc-off"><button class="link-btn" data-v="cc-limits-off">Ne plus lire les limites de l’abonnement</button></p>' : ''}`;
}
function ccUsagePaint(): void { const x = $('#main .settings [data-cc-usage]'); if (x) x.innerHTML = ccUsageHTML(); }
function ccUsageRefresh(op = ''): void {
  if (!ai.cc.onMac()) return;
  void ai.cc.usage().then(ccUsagePaint);
  void ai.cc.limitsCall(op).then(ccUsagePaint);
}

function tabAI() {
  const cc = `<section class="cx-sec cc" data-cc>${ccHTML()}</section>`;
  if (!vault.enabled()) return cc + needVault('Les clés des fournisseurs d’IA');
  const c = ai.config();
  return `${cc}<section class="cx-sec"><h4>${icon('bolt')}Consommation des clés API</h4>${usageHTML()}
    <label class="cx-row us-budget"><span>Budget mensuel</span><input class="field" type="number" min="0" step="0.5" data-cfg="budgetM" value="${c.budgetM || ''}" placeholder="0"><span>millions de tokens</span></label>
    <p class="modal-hint">Compté par Studio à chaque réponse. Les fournisseurs n’exposent pas ton crédit restant à une simple clé : fixe ici le budget que tu t’accordes pour les clés API, Studio t’indique ce qu’il en reste. Ce qui passe par Claude Code relève de ton abonnement, pas de ce budget : son utilisation et ses limites sont dans la carte Claude Code, plus haut.</p></section>
    <section class="cx-sec"><h4>${icon('sparkle')}Fournisseur par défaut</h4><div class="cx-seg">${Object.entries(ai.PROVIDERS).map(([k, l]) => `<label><input type="radio" name="provider" value="${k}"${c.provider === k ? ' checked' : ''}>${l}</label>`).join('')}</div>
    <p class="modal-hint">Avec une clé, les requêtes partent directement de Studio vers le fournisseur ; avec Claude Code, elles passent par ton Mac. Les notes chiffrées et celles taguées <code>#privé</code> ne sont jamais envoyées. Les actions qui modifient quelque chose demandent ton accord.</p></section>
    <section class="cx-sec"><h4>Claude · clé API</h4>${keyField('anthropic', 'Clé Anthropic', 'sk-ant-…')}
      <div class="cx-grid"><select class="field" data-cfg="anthropicModel">${ai.CLAUDE_MODELS.map(([v, l]) => `<option value="${v}"${c.anthropicModel === v ? ' selected' : ''}>${l}</option>`).join('')}</select><select class="field" data-cfg="effort">${[['low', 'Effort : faible'], ['medium', 'Effort : moyen'], ['high', 'Effort : élevé'], ['xhigh', 'Effort : très élevé']].map(([v, l]) => `<option value="${v}"${c.effort === v ? ' selected' : ''}>${l}</option>`).join('')}</select></div></section>
    <section class="cx-sec"><h4>OpenAI (ChatGPT)</h4>${keyField('openai', 'Clé OpenAI', 'sk-…')}<input class="field" data-cfg="openaiModel" value="${esc(c.openaiModel)}" placeholder="Modèle, ex. gpt-5" aria-label="Modèle OpenAI"></section>
    <section class="cx-sec"><h4>Modèle local — rien ne quitte ta machine</h4><p class="modal-hint">Ollama ou LM Studio (API compatible OpenAI). Pour Ollama, autorise l’origine de Studio : <code>OLLAMA_ORIGINS=${esc(location.origin)}</code></p><div class="cx-grid"><input class="field" data-cfg="localUrl" value="${esc(c.localUrl)}" placeholder="http://localhost:11434/v1" aria-label="Adresse du serveur local"><input class="field" data-cfg="localModel" value="${esc(c.localModel)}" placeholder="Modèle" aria-label="Modèle local"></div></section>
    <section class="cx-sec"><button class="btn" data-v="test">${icon('play')}Tester le fournisseur par défaut</button><span class="cx-test"></span></section>`;
}

// Réglages → Sécurité : Touch ID / Face ID de l'app native (le navigateur utilise la section passkey juste dessous).
let bioInfo: BioReply | null = null;
function biometricSection() {
  if (!vault.biometricPossibleSync()) return '';
  const kind = vault.hasBiometric() ? vault.biometricKind() : (bioInfo?.kind || 'Touch ID / Face ID');
  bioInfo || vault.biometricPossible().then(i => { bioInfo = i; refreshConnections(); });
  return `<section class="cx-sec"><h4>${icon('key')}${esc(kind)}</h4>${vault.hasBiometric()
    ? `<p>${esc(kind)} ouvre le coffre à l’ouverture de l’app. Le mot de passe reste valable à tout moment.</p><button class="btn" data-v="bio-del">Retirer ${esc(kind)}</button>`
    : bioInfo?.available === false ? `<p>${esc(bioInfo.reason || 'La biométrie n’est pas disponible sur cet appareil.')}</p>`
    : `<p>Ouvre le coffre avec ton empreinte ou ton visage. Un secret aléatoire est gardé dans le trousseau du système et n’en sort qu’après la vérification ; ton mot de passe n’est jamais enregistré.</p><button class="btn btn-primary" data-v="bio-add"${bioInfo ? '' : ' disabled'}>Activer ${esc(kind)}</button>`}</section>`;
}

function tabGithub() {
  if (!vault.enabled()) return needVault('Le jeton GitHub');
  return `<section class="cx-sec"><h4>${icon('github')}GitHub</h4>${keyField('github', 'Jeton GitHub', 'github_pat_…')}${github.connected() ? '<p class="cx-who" data-gh-who>Vérification…</p>' : ''}
    <p class="modal-hint">GitHub → Settings → Developer settings → Personal access tokens → <strong>Fine-grained tokens</strong>. Choisis les dépôts à suivre et donne des droits en <strong>lecture</strong> : Metadata, Contents, Issues, Pull requests. Pour que Studio ouvre les pull requests des agents Claude Code, passe <strong>Pull requests</strong> en <strong>lecture et écriture</strong> ; c’est la seule écriture que fait Studio, et seulement quand tu cliques sur Publier. Sans ce droit, Studio t’ouvre la page de la PR sur GitHub, déjà remplie. Le jeton ne part que vers <code>api.github.com</code>.</p></section>
    <section class="cx-sec"><h4>Ce que tu verras</h4><p class="modal-hint">La page <button class="link-btn" data-view="github">GitHub</button> réunit l’activité de tes ${12} dépôts les plus récemment actifs : commits poussés, pull requests, issues, commentaires, versions. Elle se met à jour toutes les 5 minutes tant que Studio est ouverte.</p></section>`;
}

function tabLinear() {
  if (!vault.enabled()) return needVault('Les clés Linear');
  return `<section class="cx-sec"><h4>${icon('linear')}Linear</h4>${keyField('linear', 'Clé Linear', 'lin_api_…')}${linear.connected() ? '<p class="cx-who">Vérification…</p>' : ''}
    <p class="modal-hint">Linear → Settings → Security &amp; access → Personal API keys. Donne à la clé <strong>le minimum de droits</strong> (lecture seule suffit pour voir issues et notifications ; l’écriture sert à créer des issues et à marquer les notifications comme lues) et limite-la aux équipes utiles. La clé ne part que vers <code>api.linear.app</code> : la politique de sécurité de la page bloque tout autre domaine.</p></section>
    ${linear.connected() ? `<section class="cx-sec"><h4>${icon('bell')}Notifications</h4>
      <p class="modal-hint">Tes notifications Linear (assignations, mentions, commentaires, changements d’état) arrivent dans la page <button class="link-btn" data-view="linear">Linear</button>, onglet Notifications, avec le nombre de non lues dans la barre latérale. Studio interroge Linear toutes les minutes <strong>tant qu’il est ouvert</strong> : sans serveur, rien ne peut arriver quand l’app est fermée.</p>
      <label class="cx-check"><input type="checkbox" data-nf-sys${notifs.systemOn() ? ' checked' : ''}> Afficher aussi une notification système quand Studio est en arrière-plan</label>
      ${notifs.systemOn() && notifs.systemState() === 'denied' ? '<p class="modal-hint">Les notifications sont bloquées pour ce site : autorise-les dans les réglages du navigateur.</p>' : ''}
      ${notifs.systemState() === 'absent' ? '<p class="modal-hint">Ce navigateur n’affiche pas de notifications système : elles restent visibles dans Studio.</p>' : ''}</section>` : ''}
    <section class="cx-sec"><h4>Dans une note</h4><pre class="cx-code">\`\`\`linear\nassigné: moi\nétat: en cours, à faire\néquipe: ENG\nlimite: 10\n\`\`\`</pre><p class="modal-hint">Palette → « Linear : créer une issue depuis la sélection ». Les agents avec <code>outils: linear</code> peuvent chercher et proposer des issues (création soumise à ton accord).</p></section>`;
}

function tabDevices() {
  if (!vault.enabled()) return needVault('Les clés de liaison des appareils');
  const devs = link.devices(), mine = link.me();
  return `<section class="cx-sec"><h4>${icon('devices')}Cet appareil</h4><form class="cx-row" data-f="rename"><input class="field" name="devname" value="${esc(mine.name)}" aria-label="Nom de cet appareil"><button class="btn">Renommer</button></form></section>
    <section class="cx-sec"><h4>Appareils liés</h4>${devs.length ? devs.map(d => `<div class="cx-dev"><span class="dot ${link.status(d.secret) === 'connecté' ? 'on' : ''}"></span><div><strong>${esc(d.name)}</strong><span>${esc(link.status(d.secret))}${d.lastSync ? ` · synchro ${esc(rel(d.lastSync))}` : ''}</span>${bridge.local() ? `<label class="cx-remote"><input type="checkbox" data-dev-remote="${d.secret}"${d.remote ? ' checked' : ''}>Peut piloter Claude Code sur ce Mac</label>` : ''}</div><button class="icon-btn" data-dev-packet="${d.secret}" title="Envoyer un paquet chiffré (AirDrop…)" aria-label="Paquet chiffré">${icon('share')}</button><button class="icon-btn" data-dev-forget="${d.secret}" title="Oublier" aria-label="Oublier">${icon('trash')}</button></div>`).join('') : '<p>Aucun pour l’instant.</p>'}
      ${bridge.local() && devs.length ? `<p class="modal-hint">${icon('shield')}Pilotage à distance : un appareil autorisé peut lancer, suivre, reprendre et arrêter les agents Claude Code de tes projets, tant que Studio est ouvert sur ce Mac. Il ne peut ni publier, ni supprimer une copie, ni autoriser les commandes ; chaque action est signalée ici.</p>` : ''}
      <div class="cx-grid"><button class="btn btn-primary" data-v="pair">${icon('phone')}Lier un appareil</button><button class="btn" data-v="join">J’ai un code</button>${devs.length ? `<button class="btn" data-v="sync">${icon('refresh')}Synchroniser</button>` : ''}<button class="btn" data-v="packet-in">Importer un paquet</button></div></section>
    <section class="cx-sec"><label class="cx-check"><input type="checkbox" data-lan${link.lanOnly() ? ' checked' : ''}> Même réseau Wi-Fi uniquement (aucun serveur STUN)</label>
    <p class="modal-hint">Comment ça marche : le code de liaison (128 bits) ne transite par aucun réseau. Il sert à chiffrer une courte poignée de main relayée par <code>ntfy.sh</code> — qui ne voit que du chiffré — puis les notes passent en direct d’appareil à appareil (WebRTC), et en temps réel tant que les deux sont ouverts. Sans réseau : « Paquet chiffré » via AirDrop.</p></section>`;
}

async function onConnClick(e: MouseEvent) {
  const t = target(e);
  const tab = t.closest('[data-tab]'); if (tab) { openConnections(tab.dataset.tab); return; }
  if (curTab === 'consignes' && await tuningUI.onClick(t, refreshConnections)) return;
  if (curTab === 'autorisations' && await permissionsUI.onClick(t, refreshConnections)) return;
  if (curTab === 'extensions' && await pluginsUI.onClick(t, refreshConnections)) return;
  const del = t.closest('[data-del-key]'); if (del) { if (await confirmBox({ title: 'Supprimer la clé ?', text: 'Elle sera effacée du coffre de cet appareil.', ok: 'Supprimer', danger: true })) await vault.setSecret(del.dataset.delKey ?? '', null); return; }
  const fg = t.closest('[data-dev-forget]'); if (fg) { if (await confirmBox({ title: 'Oublier cet appareil ?', text: 'La liaison sera supprimée ici. Fais de même sur l’autre appareil.', ok: 'Oublier', danger: true })) await link.forget(fg.dataset.devForget ?? ''); return; }
  const pk = t.closest('[data-dev-packet]'); if (pk) { const dev = link.devices().find(d => d.secret === pk.dataset.devPacket); if (dev) await sendPacket(dev); return; }
  const v = t.closest('[data-v]')?.dataset.v; if (!v) return;
  if (v === 'lock') { await app.flushAll(); try { sessionStorage.setItem('studio.manualLock', '1'); } catch { /* ignoré */ } vault.lock(); }
  if (v === 'pw') {
    const old = await askPassword({ title: 'Mot de passe actuel', text: 'Saisis le mot de passe actuel du coffre.' }); if (!old) return;
    const nw = await askPassword({ title: 'Nouveau mot de passe', text: 'Choisis le nouveau mot de passe.', confirm: true }); if (!nw) return;
    try { await vault.changePassword(old, nw); toast('Mot de passe changé'); } catch { toast('Mot de passe actuel incorrect'); }
  }
  if (v === 'bio-add') { try { await vault.addBiometric(); toast(`${vault.biometricKind()} activé`); } catch (err) { toast(errMsg(err)); } }
  if (v === 'bio-del') { await vault.removeBiometric(); toast('Déverrouillage biométrique retiré'); }
  if (v === 'pk-add') { try { await vault.addPasskey(); toast('Face ID / Touch ID activé'); } catch (err) { toast(err instanceof Error && err.name === 'NotAllowedError' ? 'Opération annulée' : errMsg(err)); } }
  if (v === 'pk-del') vault.removePasskey();
  if (v === 'off') {
    const pw = await askPassword({ title: 'Désactiver le coffre', text: 'Les notes seront réécrites <strong>en clair</strong> sur le disque, et les clés API comme les appareils liés seront effacés.', ok: 'Désactiver' }); if (!pw) return;
    try { await app.flushAll(); await vault.disable(pw); toast('Coffre désactivé'); } catch { toast('Mot de passe incorrect'); }
  }
  if (v === 'test') {
    const r = root(), out = r && $('.cx-test', r); if (!out) return;
    out.innerHTML = ' <span class="spin"></span>';
    try { const r = await ai.run({ prompt: 'Réponds uniquement : « Connexion OK ».', tools: [] }); out.textContent = ' ' + r.text.slice(0, 80); } catch (err) { out.innerHTML = ` <span class="err">${esc(errMsg(err))}</span>`; }
  }
  if (v === 'cc-use') { ai.setConfig({ provider: 'claudecode' }); refreshConnections(); toast('Claude Code est maintenant ton fournisseur d’IA'); }
  if (v === 'cc-check') { ai.cc.last = null; refreshConnections(); ccRefresh(true); }
  if (v === 'cc-usage-refresh') { const b = t.closest<HTMLButtonElement>('[data-v]'); if (b) b.disabled = true; ccUsageRefresh('refresh'); }
  if (v === 'cc-limits-on') { ai.cc.limits = null; ccUsagePaint(); ccUsageRefresh('enable'); }
  if (v === 'cc-limits-off') ccUsageRefresh('disable');
  if (v === 'cc-copy') { try { await navigator.clipboard.writeText(CC_INSTALL); toast('Commande copiée'); } catch { toast('Copie impossible : sélectionne la commande'); } }
  if (v === 'cc-login') {
    const b = t.closest<HTMLButtonElement>('[data-v]'); if (b) { b.disabled = true; b.innerHTML = '<span class="spin"></span>Connexion dans le navigateur…'; }
    try { const s = await ai.cc.login(); toast(s?.loggedIn ? 'Claude Code est connecté' : 'Connexion non terminée'); } catch (err) { toast(errMsg(err)); }
    refreshConnections();
  }
  if (v === 'update-check') void update.check();
  if (v === 'news-open') news.open();
  if (v === 'update-install') {
    await app.flushAll();
    const r = await update.install();
    if (!r.ok) toast(r.message ?? 'Mise à jour impossible.');
    else if (!r.restarting) toast('Mise à jour installée : quitte puis rouvre Studio.');
  }
  if (v === 'export-json') void app.exportJSON();
  if (v === 'export-md') void app.exportZip();
  if (v === 'import') app.pickFiles();
  if (v === 'pair') void pairDialog();
  if (v === 'join') joinDialog();
  if (v === 'sync') { link.syncNow(); toast('Recherche des appareils…'); }
  if (v === 'packet-in') { const i = el<HTMLInputElement>('<input type="file" accept=".carnet" hidden>'); i.onchange = async () => { const file = i.files?.[0]; if (!file) return; try { await importPacket(await file.text()); } catch (err) { toast(errMsg(err)); } }; i.click(); }
}

async function onConnSubmit(e: SubmitEvent) {
  e.preventDefault();
  const f = target(e) as HTMLFormElement;
  const field = (n: string) => (f.elements.namedItem(n) as HTMLInputElement | null)?.value ?? '';
  if (curTab === 'extensions' && await pluginsUI.onSubmit(f, refreshConnections)) return;
  if (f.dataset.f === 'create') {
    const a = field('p1'), b = field('p2'), err = need('.lock-err', f);
    if (a.length < 10) return void (err.textContent = '10 caractères minimum.');
    if (a !== b) return void (err.textContent = 'Les deux mots de passe ne correspondent pas.');
    f.classList.add('busy'); need<HTMLButtonElement>('button', f).disabled = true; need('button', f).textContent = 'Chiffrement de la base…';
    try { await app.flushAll(); await vault.create(a); startVaultServices(); toast('Coffre activé : tout est chiffré'); const p = sessionStorage.getItem('carnet.pending-link'); if (p) { sessionStorage.removeItem('carnet.pending-link'); joinDialog(p); } }
    catch (x) { err.textContent = errMsg(x); f.classList.remove('busy'); }
    return;
  }
  if (f.dataset.f === 'rename') { link.rename(field('devname')); toast('Appareil renommé'); refreshConnections(); return; }
  if (f.dataset.key) {
    const name = f.dataset.key, val = need<HTMLInputElement>('input', f).value.trim(); if (!val) return;
    if (name === 'linear') { try { const v = await linear.viewer(val); toast(`Linear connecté : ${v.viewer.name}`); } catch (x) { toast('Clé refusée par Linear : ' + errMsg(x)); return; } }
    if (name === 'github') { try { const v = await github.viewer(val); toast(`GitHub connecté : ${v.login}`); } catch (x) { toast('Jeton refusé par GitHub : ' + errMsg(x)); return; } }
    await vault.setSecret(name, val);
    if (name === 'linear') void notifs.poll();
    if (name === 'github') void github.poll();
    app.renderSidebar?.();
  }
}

function onConnChange(e: Event): void {
  const t = target(e) as HTMLInputElement;
  if (curTab === 'consignes' && tuningUI.onChange(t)) return;
  if (curTab === 'autorisations' && permissionsUI.onChange(t)) return;
  if (curTab === 'extensions' && pluginsUI.onChange(t, refreshConnections)) return;
  if (t.name === 'provider') ai.setConfig({ provider: t.value as ai.Provider });
  else if (t.name === 'theme') app.setTheme(t.value);
  else if (t.dataset.cfg === 'budgetM') { ai.setConfig({ budgetM: Math.max(0, Number(t.value) || 0) }); refreshConnections(); }
  else if (t.dataset.cfg) ai.setConfig({ [t.dataset.cfg]: t.value.trim() });
  else if (t.matches('[data-autolock]')) vault.setSetting('autolock', Number(t.value));
  else if (t.matches('[data-lan]')) link.setLanOnly(t.checked);
  else if (t.matches('[data-update-auto]')) update.setAuto(t.checked);
  else if (t.matches('[data-update-install]')) update.setAutoInstall(t.checked);
  else if (t.dataset.devRemote) void link.setRemote(t.dataset.devRemote, t.checked).then(() => toast(t.checked ? 'Cet appareil peut piloter Claude Code sur ce Mac' : 'Pilotage à distance retiré'));
  else if (t.matches('[data-nf-sys]')) { notifs.setSystem(t.checked); if (t.checked && notifs.systemState() === 'default') void notifs.askPermission().then(refreshConnections); }
}

// ---------- Liaison ----------
async function pairDialog(): Promise<void> {
  if (!vault.isOpen()) { openConnections('coffre'); return; }
  const inv = await link.invite();
  const m = modal({ title: 'Lier un appareil', cls: 'pair', html: `<div class="pair-qr">${qr.svg(inv.url)}</div>
    <ol class="pair-steps"><li>Sur l’autre appareil : Réglages → Appareils → <strong>J’ai un code</strong>.</li><li>Colle le lien copié ici (presse-papiers universel entre Mac et iPhone), ou scanne le QR code.</li></ol>
    <div class="pair-code"><code>${inv.pretty}</code><button class="btn" data-copy>${icon('copy')}Copier</button></div>
    <p class="pair-wait"><span class="spin"></span>En attente de l’autre appareil…</p>
    <p class="modal-hint">Ce code est une clé secrète : ne le donne qu’à toi-même. Sur iPhone, si Studio est installé sur l’écran d’accueil, préfère copier-coller : un QR code scanné s’ouvre dans Safari, qui a un stockage séparé.</p>
    <div class="modal-actions"><button class="btn btn-primary" data-x>Fermer</button></div>` });
  need('[data-x]', m.node).onclick = m.close;
  need('[data-copy]', m.node).onclick = () => void navigator.clipboard?.writeText(inv.url).then(() => toast('Lien de liaison copié'));
  link.on(e => { if (e.type === 'paired' && m.node.isConnected) need('.pair-wait', m.node).innerHTML = `${icon('check')}Lié à <strong>${esc(e.name)}</strong> — synchronisation en cours.`; });
}

export function joinDialog(prefill = ''): void {
  if (!vault.isOpen()) {
    if (prefill) sessionStorage.setItem('carnet.pending-link', prefill);
    toast('Active d’abord le coffre : la clé de liaison y sera gardée.');
    openConnections('coffre'); return;
  }
  const m = modal({ title: 'Rejoindre un appareil', cls: 'small', html: `<p class="modal-text">Colle le lien ou saisis le code affiché sur l’autre appareil.</p><form><input class="field" placeholder="XXXX-XXXX-…" value="${esc(prefill)}" autocomplete="off" spellcheck="false" required autofocus><p class="lock-err" role="alert"></p><div class="modal-actions"><button type="button" class="btn" data-x>Annuler</button><button class="btn btn-primary">Lier</button></div></form>` });
  need('[data-x]', m.node).onclick = m.close;
  need('form', m.node).onsubmit = async e => {
    e.preventDefault();
    try { await link.join(need<HTMLInputElement>('input', m.node).value); m.close(); toast('Connexion à l’autre appareil…'); }
    catch (x) { need('.lock-err', m.node).textContent = errMsg(x); }
  };
}

async function sendPacket(dev: link.Device): Promise<void> {
  await app.flushAll();
  const file = await link.packet(dev);
  if (navigator.canShare?.({ files: [file] })) { try { await navigator.share({ files: [file], title: 'Paquet Studio' }); return; } catch (e) { if (e instanceof Error && e.name === 'AbortError') return; } }
  download(file.name, file);
  toast('Paquet chiffré téléchargé : envoie-le sur l’autre appareil');
}
