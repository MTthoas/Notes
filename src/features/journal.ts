// Journal : toutes les demandes faites à Claude Code (dans chaque projet, terminal compris) et à l'IA de Studio,
// rangées par journée, avec un résumé de chaque journée écrit par l'IA.
//
// Les demandes sont lues sur le Mac dans les journaux de Claude Code (~/.claude/projects, voir Sessions.swift),
// puis recopiées ici, dans la base locale (chiffrée quand le coffre est ouvert) : Claude Code efface ses
// journaux au bout de 30 jours, le journal de Studio les garde. Une fiche par jour : { id: AAAA-MM-JJ, demandes, activité, résumé }.
//
// Mise en page : celle du reste de l'app — colonne de liste à gauche (comme les notes), page à la manière
// de l'Accueil à droite (date, titre, phrase de situation, sections). Pas de style propre au journal.
import * as db from '../core/db.ts';
import * as store from '../core/store.ts';
import * as native from '../core/native.ts';
import * as ai from '../integrations/ai.ts';
import * as tuning from '../integrations/tuning.ts';
import * as projectsModel from './projects/model.ts';
import { renderMarkdown, esc } from '../lib/markdown.ts';
import { fold } from '../lib/fuzzy.ts';
import { $, $$, icon, need, target, menu, toast, confirmBox, download, rel, errMsg, hue } from '../ui/kit.ts';
import type { AppShell } from '../types.ts';

// ---------- Modèle ----------
export interface JPrompt {
  /** Unique par demande : session + horodatage. */
  id: string;
  /** Horodatage ISO 8601. */
  at: string;
  text: string;
  /** Identifiant du projet (vide pour une demande à l'IA de Studio hors projet). */
  project: string;
  /** Nom du projet au moment de la demande (le projet a pu être renommé ou supprimé depuis). */
  pname: string;
  session: string;
  /** Titre de la conversation. */
  title: string;
  worktree: string;
  branch: string;
  source: 'claude' | 'studio';
}
interface JStat { project: string; tokens: number; files: string[]; sessions: number }
interface JSummary { headline: string; md: string; at: number; provider: string; ai: boolean; /** Nombre de demandes résumées. */ count: number }
interface JDay { id: string; prompts: JPrompt[]; stats: JStat[]; summary: JSummary | null; updated: number }

let app!: AppShell;
const days = new Map<string, JDay>();
let loaded: Promise<void> | null = null;
let syncing: Promise<number> | null = null;
let lastSync = 0, lastError = '';

const PREF = 'studio.journal';
interface Prefs { synced: string; auto: boolean; view: 'projects' | 'timeline' }
const prefs = (): Prefs => { try { return { synced: '', auto: true, view: 'projects', ...JSON.parse(localStorage.getItem(PREF) || '{}') as Partial<Prefs> }; } catch { return { synced: '', auto: true, view: 'projects' }; } };
const setPrefs = (p: Partial<Prefs>): void => { try { localStorage.setItem(PREF, JSON.stringify({ ...prefs(), ...p })); } catch { /* stockage indisponible */ } };

const dayOf = (at: string | number): string => store.dayKey(new Date(at));
const shift = (key: string, n: number): string => { const [y, m, d] = key.split('-').map(Number); return store.dayKey(new Date(y ?? 0, (m ?? 1) - 1, (d ?? 1) + n)); };
const dateOf = (key: string): Date => { const [y, m, d] = key.split('-').map(Number); return new Date(y ?? 0, (m ?? 1) - 1, d ?? 1); };
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const hm = (at: string): string => new Date(at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
const fmtNum = (n: number): string => n >= 1e6 ? `${(n / 1e6).toFixed(1).replace('.', ',')} M` : n >= 1e3 ? `${Math.round(n / 1e3)} k` : String(n);
const plural = (n: number, one: string, many = one + 's'): string => `${n} ${n > 1 ? many : one}`;
function dayTitle(key: string, withYear = false): string {
  const d = dateOf(key), y = d.getFullYear() !== new Date().getFullYear();
  return cap(d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', ...(y || withYear ? { year: 'numeric' } : {}) }));
}
function relDay(key: string): string {
  const today = store.dayKey();
  return key === today ? 'Aujourd’hui' : key === shift(today, -1) ? 'Hier' : '';
}

function blank(id: string): JDay { return { id, prompts: [], stats: [], summary: null, updated: Date.now() }; }
async function save(d: JDay): Promise<void> { d.updated = Date.now(); days.set(d.id, d); await db.put('journal', d); }

function load(): Promise<void> {
  return loaded ||= db.all<JDay>('journal').then(list => {
    for (const d of list) if (d && /^\d{4}-\d{2}-\d{2}$/.test(d.id) && Array.isArray(d.prompts)) days.set(d.id, { ...blank(d.id), ...d, stats: d.stats ?? [] });
  }).catch(e => { console.error('journal', e); });
}

/** Nom affiché d'un projet (son nom actuel s'il existe encore). */
const projectName = (id: string, fallback = ''): string => projectsModel.byId(id)?.name ?? (fallback || (id ? 'Projet supprimé' : 'Studio'));
const projectHue = (id: string, name: string): string => projectsModel.byId(id)?.hue ?? hue(name || 'studio');

// ---------- Collecte ----------
/** Recopie les demandes faites à Claude Code depuis la dernière collecte (sur le Mac uniquement). Renvoie le nombre de nouvelles demandes. */
export function sync(): Promise<number> {
  if (!native.available()) return Promise.resolve(0);
  return syncing ||= (async () => {
    await load();
    const today = store.dayKey(), p = prefs();
    // On relit toujours la veille de la dernière collecte : une session ouverte tard a pu continuer après minuit.
    const since = p.synced ? shift(p.synced, -1) : shift(today, -60);
    const ids = projectsModel.projects().map(x => x.id);
    if (!ids.length) { lastSync = Date.now(); return 0; }
    const r = await native.call('project', 'journal', { projects: ids, since }, 180000);
    if (!r.ok) { lastError = r.message ?? 'Collecte impossible.'; throw new Error(lastError); }
    lastError = '';
    const prompts = (r.prompts as Record<string, unknown>[] | undefined) ?? [], stats = (r.stats as Record<string, unknown>[] | undefined) ?? [];
    const touched = new Map<string, JDay>();
    const dayFor = (k: string): JDay => { let d = touched.get(k); if (!d) { const cur = days.get(k); d = cur ? { ...cur, prompts: [...cur.prompts], stats: [...cur.stats] } : blank(k); touched.set(k, d); } return d; };
    let added = 0;
    for (const x of prompts) {
      const at = String(x.at ?? ''), text = String(x.text ?? '').trim(), session = String(x.session ?? '');
      if (!at || !text || Number.isNaN(Date.parse(at))) continue;
      const d = dayFor(dayOf(at)), id = `${session}|${at}`;
      if (d.prompts.some(y => y.id === id)) continue;
      const project = String(x.project ?? '');
      d.prompts.push({ id, at, text, project, pname: projectName(project), session, title: String(x.title ?? ''), worktree: String(x.worktree ?? ''), branch: String(x.branch ?? ''), source: 'claude' });
      added++;
    }
    for (const s of stats) {
      const k = String(s.day ?? ''); if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) continue;
      const d = dayFor(k), project = String(s.project ?? '');
      const st: JStat = { project, tokens: Number(s.tokens) || 0, files: Array.isArray(s.files) ? (s.files as unknown[]).map(String).slice(0, 120) : [], sessions: Number(s.sessions) || 0 };
      const i = d.stats.findIndex(y => y.project === project);
      // Les journaux de Claude Code ont pu être effacés : on ne remplace jamais par moins que ce qu'on savait déjà.
      if (i < 0) d.stats.push(st);
      else { const old = d.stats[i]!; d.stats[i] = { project, tokens: Math.max(old.tokens, st.tokens), files: [...new Set([...old.files, ...st.files])].slice(0, 160), sessions: Math.max(old.sessions, st.sessions) }; }
    }
    for (const d of touched.values()) { d.prompts.sort((a, b) => a.at.localeCompare(b.at)); await save(d); }
    setPrefs({ synced: today });
    lastSync = Date.now();
    return added;
  })().finally(() => { syncing = null; });
}

/** Note une demande faite à l'IA de Studio (« Demander à l'IA »). */
export async function record(text: string, context = ''): Promise<void> {
  const t = text.trim(); if (!t) return;
  await load();
  const at = new Date().toISOString(), k = dayOf(at), cur = days.get(k);
  const d = cur ? { ...cur, prompts: [...cur.prompts] } : blank(k);
  d.prompts.push({ id: `studio|${at}`, at, text: t.slice(0, 6000), project: '', pname: 'Studio', session: '', title: context || 'Demander à l’IA', worktree: '', branch: '', source: 'studio' });
  await save(d);
  if (app?.view() === 'journal') rerender();
}

// ---------- Résumé ----------
// La consigne du résumé, le modèle utilisé et la taille des demandes envoyées se règlent dans
// Réglages → Consignes et contexte (voir integrations/tuning.ts).

function digest(d: JDay): string {
  const lines = [`Journée : ${dayTitle(d.id, true)}`];
  const st = d.stats.filter(s => s.tokens || s.files.length || s.sessions);
  if (st.length) lines.push('Activité :', ...st.map(s => `- ${projectName(s.project)} : ${plural(s.sessions, 'session')}, ${plural(s.files.length, 'fichier modifié', 'fichiers modifiés')}${s.files.length ? ` (${s.files.slice(0, 12).join(', ')})` : ''}`));
  lines.push('', `Demandes (${d.prompts.length}), dans l'ordre :`);
  let budget = tuning.num('ctx.journal');
  for (const p of d.prompts) {
    const where = p.source === 'studio' ? 'Assistant Studio' : `${p.pname || projectName(p.project)}${p.title ? ` · ${p.title}` : ''}`;
    const body = p.text.length > 900 ? p.text.slice(0, 900) + '…' : p.text;
    const line = `[${hm(p.at)}] (${where}) ${body.replace(/\s*\n\s*/g, ' ⏎ ')}`;
    if ((budget -= line.length) < 0) { lines.push('(demandes suivantes omises)'); break; }
    lines.push(line);
  }
  return lines.join('\n');
}

/** Résumé sans IA : chiffres et premières demandes de chaque projet. */
function plainSummary(d: JDay): { headline: string; md: string } {
  const groups = byProject(d), first = d.prompts[0], last = d.prompts[d.prompts.length - 1];
  const top = groups[0];
  const headline = groups.length === 1 && top ? top.name : groups.length ? `${groups.length} projets` : 'Journée calme';
  const intro = d.prompts.length
    ? `${plural(d.prompts.length, 'demande')} ${groups.length > 1 ? `dans ${groups.length} projets` : top ? `dans ${top.name}` : ''}${first && last ? `, de ${hm(first.at)} à ${hm(last.at)}` : ''}.${top && groups.length > 1 ? ` Le plus actif : **${top.name}** (${plural(top.prompts.length, 'demande')}).` : ''}`
    : 'Aucune demande ce jour-là.';
  const bullets = groups.map(g => `- **${g.name}** : ${g.prompts.slice(0, 3).map(p => p.text.split('\n')[0]!.slice(0, 90)).join(' · ')}`);
  return { headline, md: [intro, '', ...bullets].join('\n') };
}

const pending = new Set<string>();
export async function summarize(key: string, { quiet = false } = {}): Promise<void> {
  const d = days.get(key); if (!d || !d.prompts.length || pending.has(key)) return;
  if (!ai.ready()) { if (!quiet) toast('Connecte une IA pour résumer tes journées (Réglages → Intelligence artificielle).'); return; }
  pending.add(key); rerender();
  try {
    const out = (await ai.complete(tuning.text('small.journalPrompt'), digest(d), { light: tuning.on('small.journal') })).trim();
    const m = out.match(/^#\s+(.+)\n?([\s\S]*)$/);
    const headline = (m?.[1] ?? '').trim().replace(/^journ[ée]e\s*:\s*/i, '').slice(0, 90) || plainSummary(d).headline;
    const cur = days.get(key) ?? d;
    await save({ ...cur, summary: { headline, md: (m ? m[2] ?? '' : out).trim(), at: Date.now(), provider: ai.PROVIDERS[ai.config().provider], ai: true, count: cur.prompts.length } });
  } catch (e) { if (!quiet) toast('Résumé impossible : ' + errMsg(e)); else console.warn('journal', e); }
  finally { pending.delete(key); rerender(); }
}

/** Résume, une à une, les journées passées qui n'ont pas encore de résumé (ou dont le résumé est dépassé). */
let autoRunning = false;
async function autoSummaries(): Promise<void> {
  if (autoRunning || !prefs().auto || !ai.ready()) return;
  autoRunning = true;
  try {
    const today = store.dayKey();
    const todo = [...days.values()].filter(d => d.id < today && d.id >= shift(today, -14) && d.prompts.length && (!d.summary || (d.summary.ai && d.summary.count < d.prompts.length)))
      .sort((a, b) => b.id.localeCompare(a.id)).slice(0, 4);
    for (const d of todo) await summarize(d.id, { quiet: true });
  } finally { autoRunning = false; }
}

// ---------- Regroupements ----------
interface Group { project: string; name: string; hue: string; prompts: JPrompt[]; stat: JStat | undefined }
function byProject(d: JDay): Group[] {
  const map = new Map<string, Group>();
  for (const p of d.prompts) {
    const key = p.source === 'studio' ? '' : p.project;
    let g = map.get(key);
    if (!g) { const name = key ? projectName(key, p.pname) : 'Assistant Studio'; g = { project: key, name, hue: key ? projectHue(key, name) : 'gray', prompts: [], stat: d.stats.find(s => s.project === key) }; map.set(key, g); }
    g.prompts.push(p);
  }
  for (const s of d.stats) if (!map.has(s.project) && (s.files.length || s.sessions)) { const name = projectName(s.project); map.set(s.project, { project: s.project, name, hue: projectHue(s.project, name), prompts: [], stat: s }); }
  return [...map.values()].sort((a, b) => b.prompts.length - a.prompts.length || a.name.localeCompare(b.name, 'fr'));
}
const bySession = (list: JPrompt[]): JPrompt[][] => {
  const m = new Map<string, JPrompt[]>();
  for (const p of list) { const k = p.session || p.id; m.set(k, [...(m.get(k) ?? []), p]); }
  return [...m.values()];
};

// ---------- Export ----------
function dayMarkdown(d: JDay): string {
  const s = d.summary ?? plainSummary(d), groups = byProject(d);
  const out = [`# Journal — ${dayTitle(d.id, true)}`, '', `**${s.headline}**`, '', s.md, '', '## Toutes les demandes'];
  for (const g of groups) {
    if (!g.prompts.length) continue;
    out.push('', `### ${g.name}`);
    for (const ses of bySession(g.prompts)) {
      const f = ses[0]!;
      if (f.title) out.push('', `*${f.title}${f.branch ? ` · ${f.branch}` : ''}*`);
      for (const p of ses) out.push(`- **${hm(p.at)}** ${p.text.replace(/\n+/g, ' ').slice(0, 600)}`);
    }
  }
  return out.join('\n') + '\n\n#journal\n';
}

async function saveAsNote(d: JDay): Promise<void> {
  const title = `Journal — ${dayTitle(d.id, true)}`, body = dayMarkdown(d).replace(/^# .*\n\n/, '');
  const existing = store.findByTitle(title);
  if (existing && store.getBody(existing) != null) {
    store.touch(existing); store.setBody(existing, body); existing.updated = Date.now(); await store.saveNote(existing);
    toast('Note du journal mise à jour', { label: 'Ouvrir', run: () => app.openNote(existing.id) });
  } else {
    const n = await store.createNote({ title, body });
    toast('Journée enregistrée dans tes notes', { label: 'Ouvrir', run: () => app.openNote(n.id) });
  }
}

// ---------- Rendu ----------
let root: HTMLElement | null = null, sel = '', query = '', timer = 0;
const section = (title: string, body: string, meta = ''): string => `<section class="hm-sec"><header><span class="hm-h">${title}</span>${meta ? `<span class="hm-meta">${meta}</span>` : ''}</header>${body}</section>`;

/** Activité des 17 dernières semaines, une case par jour (teintes neutres, comme le reste de l'interface). */
function heatmap(): string {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const weeks = 17, start = new Date(today); start.setDate(start.getDate() - ((today.getDay() + 6) % 7) - (weeks - 1) * 7);
  const cells: string[] = [];
  for (let i = 0; i < weeks * 7; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    const k = store.dayKey(d), n = days.get(k)?.prompts.length ?? 0;
    if (d > today) { cells.push('<i class="jr-hc"></i>'); continue; }
    const lvl = n === 0 ? 0 : n < 3 ? 1 : n < 8 ? 2 : n < 16 ? 3 : 4;
    cells.push(`<button class="jr-hc l${lvl}${k === sel ? ' sel' : ''}" data-jr-day="${k}" title="${esc(`${dayTitle(k)} · ${plural(n, 'demande')}`)}" aria-label="${esc(`${dayTitle(k)}, ${plural(n, 'demande')}`)}"></button>`);
  }
  return `<div class="jr-heat">${cells.join('')}</div>`;
}

/** Les journées, comme la liste des notes : titre, nombre de demandes, titre du résumé. */
function sideList(): string {
  const today = store.dayKey();
  const keys = [...days.values()].filter(d => d.prompts.length).map(d => d.id);
  if (!keys.includes(today)) keys.push(today);
  keys.sort((a, b) => b.localeCompare(a));
  let month = '', out = '';
  for (const k of keys) {
    const d = days.get(k), m = cap(dateOf(k).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' }));
    if (m !== month) { month = m; out += `<div class="list-label">${esc(m)}</div>`; }
    const n = d?.prompts.length ?? 0;
    const sub = d?.summary?.headline || (d ? byProject(d).slice(0, 3).map(g => g.name).join(', ') : '') || 'Rien pour l’instant';
    const title = relDay(k) ? `${relDay(k)} · ${dateOf(k).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })}` : cap(dateOf(k).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric' }));
    out += `<button class="note-item${k === sel ? ' sel' : ''}" data-jr-day="${k}"><span class="ni-row"><span class="ni-title"><span>${esc(title)}</span></span><span class="ni-date">${n ? plural(n, 'demande') : ''}</span></span><span class="ni-sub">${esc(sub)}</span></button>`;
  }
  return out;
}

function promptRow(p: JPrompt, { project = false, q = '' } = {}): string {
  let text = esc(p.text);
  // Surlignage sur le texte déjà échappé, avec la recherche échappée de la même façon.
  if (q) { const re = new RegExp(esc(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'); text = text.replace(re, m => `<mark>${m}</mark>`); }
  const where = project ? `<small><i class="tag-dot" style="--c:var(--c-${p.source === 'studio' ? 'gray' : projectHue(p.project, p.pname)})"></i>${esc(p.source === 'studio' ? 'Assistant Studio' : projectName(p.project, p.pname))}</small>` : '';
  return `<div class="hm-feed jr-p" data-jr-p="${esc(p.id)}" title="Cliquer pour tout afficher">${icon(p.source === 'studio' ? 'sparkle' : 'terminal')}<span>${where}${text}</span><em>${hm(p.at)}</em><button class="icon-btn jr-copy" data-jr-copy title="Copier la demande" aria-label="Copier la demande">${icon('copy')}</button></div>`;
}

function sessionBlock(list: JPrompt[]): string {
  const f = list[0]!; if (f.source === 'studio') return list.map(p => promptRow(p)).join('');
  const exists = !!projectsModel.byId(f.project);
  const meta = [f.worktree ? 'copie isolée' : '', f.branch].filter(Boolean).join(' · ');
  return `<div class="jr-ses"><p class="hm-meta">${esc(f.title || 'Conversation')}${meta ? ` · ${esc(meta)}` : ''}${exists && f.session ? ` · <button class="hm-link" data-pj-open="${esc(f.project)}" data-pj-tab="sessions" data-pj-session="${esc(f.session)}">Ouvrir</button>` : ''}</p>${list.map(p => promptRow(p)).join('')}</div>`;
}

/** Phrase de situation, comme sur l'Accueil : chiffres de la journée et projets touchés. */
function situation(d: JDay): string {
  if (!d.prompts.length && !d.stats.length) return 'Aucune demande pour l’instant';
  const groups = byProject(d), first = d.prompts[0], last = d.prompts[d.prompts.length - 1];
  const sessions = d.stats.reduce((n, s) => n + s.sessions, 0) || new Set(d.prompts.filter(p => p.session).map(p => p.session)).size;
  const files = d.stats.reduce((n, s) => n + s.files.length, 0), tokens = d.stats.reduce((n, s) => n + s.tokens, 0);
  const bits = [plural(d.prompts.length, 'demande'), sessions ? plural(sessions, 'session') : '', first && last ? `${hm(first.at)} → ${hm(last.at)}` : '', files ? plural(files, 'fichier modifié', 'fichiers modifiés') : '', tokens ? `${fmtNum(tokens)} tokens écrits` : ''].filter(Boolean);
  const daily = [...store.notes.values()].find(n => n.daily === d.id && !n.deletedAt);
  if (daily) bits.push(`<button data-open-note="${daily.id}">Note du jour</button>`);
  return bits.join('<i>·</i>') + (groups.length ? `<i>·</i>${groups.map(g => `<span class="jr-proj"><i class="tag-dot" style="--c:var(--c-${g.hue})"></i>${esc(g.name)}</span>`).join('')}` : '');
}

function summarySection(d: JDay): string {
  if (!d.prompts.length) return section('Résumé', `<p class="hm-empty">Chaque demande faite à Claude Code dans tes projets arrive ici, puis l’IA résume la journée.${native.available() ? '' : ' Les demandes sont recueillies par l’app Studio pour Mac.'}</p>`);
  const busy = pending.has(d.id), s = d.summary, stale = !!s && s.count < d.prompts.length, canAI = ai.ready();
  const shown = s ?? plainSummary(d);
  const meta = busy ? '<span class="spin"></span>L’IA rédige le résumé…'
    : (s ? `${esc(s.provider)} · ${esc(rel(s.at))}${stale ? ` · ${plural(d.prompts.length - s.count, 'nouvelle demande', 'nouvelles demandes')}` : ''}` : 'Aperçu sans IA')
      + (canAI ? ` · <button class="hm-link" data-jr-sum>${s ? (stale ? 'Mettre à jour' : 'Régénérer') : 'Résumer avec l’IA'}</button>` : ' · <button class="hm-link" data-open-conn="ia">Connecter une IA</button>');
  return section('Résumé', `<h2 class="jr-headline">${esc(shown.headline)}</h2><div class="md jr-sum${busy ? ' busy' : ''}">${renderMarkdown(shown.md || '')}</div>`, meta);
}

function promptsSection(d: JDay): string {
  const groups = byProject(d); if (!groups.length) return '';
  const view = prefs().view;
  const seg = `<div class="seg" role="tablist">${([['projects', 'Par projet', 'folder'], ['timeline', 'Chronologie', 'list']] as const).map(([k, l, ic]) => `<button role="tab" data-jr-view="${k}" aria-selected="${view === k}" aria-label="${l}" title="${l}">${icon(ic)}</button>`).join('')}</div>`;
  const body = view === 'timeline'
    ? d.prompts.map(p => promptRow(p, { project: true })).join('')
    : groups.map(g => `<details class="jr-group" open><summary class="list-label"><i class="tag-dot" style="--c:var(--c-${g.hue})"></i>${esc(g.name)}<em>${[plural(g.prompts.length, 'demande'), g.stat?.sessions ? plural(g.stat.sessions, 'session') : ''].filter(Boolean).join(' · ')}</em></summary>
        ${g.stat?.files.length ? `<details class="up-notes jr-files"><summary>${plural(g.stat.files.length, 'fichier modifié', 'fichiers modifiés')}</summary><p class="hm-meta">${g.stat.files.map(f => `<code>${esc(f)}</code>`).join(' ')}</p></details>` : ''}
        ${bySession(g.prompts).map(sessionBlock).join('')}
      </details>`).join('');
  return `<section class="hm-sec"><header><span class="hm-h">Demandes</span>${seg}</header>${body}</section>`;
}

function dayPage(d: JDay): string {
  return `<p class="hm-date">${esc(relDay(d.id) || 'Journal')}</p>
    <h1 class="hm-hello">${esc(dayTitle(d.id))}</h1>
    <p class="hm-sum">${situation(d)}</p>
    <div class="hm-col">${summarySection(d)}${promptsSection(d)}</div>`;
}

function searchPage(q: string): string {
  const f = fold(q), hits = [...days.values()].flatMap(d => d.prompts.filter(p => fold(p.text).includes(f) || fold(p.title).includes(f))).sort((a, b) => b.at.localeCompare(a.at));
  const head = `<p class="hm-date">Journal</p><h1 class="hm-hello">Recherche</h1><p class="hm-sum">${hits.length ? `${plural(Math.min(hits.length, 300), 'demande trouvée', 'demandes trouvées')}${hits.length > 300 ? ' (300 premières)' : ''}` : `Aucune demande ne contient « ${esc(q)} »`}</p>`;
  const byDay = new Map<string, JPrompt[]>();
  for (const p of hits.slice(0, 300)) { const k = dayOf(p.at); byDay.set(k, [...(byDay.get(k) ?? []), p]); }
  return head + `<div class="hm-col">${[...byDay].map(([k, list]) => `<section class="hm-sec"><header><button class="hm-h" data-jr-day="${k}">${esc(dayTitle(k))}${icon('chevronRight')}</button></header>${list.map(p => promptRow(p, { project: true, q })).join('')}</section>`).join('')}</div>`;
}

function paintSide(): void {
  if (!root) return;
  const side = $('.jr-list', root); if (!side) return;
  const total = [...days.values()].reduce((s, d) => s + d.prompts.length, 0), count = $('.jr-count', root);
  if (count) count.textContent = plural(total, 'demande');
  side.innerHTML = heatmap() + sideList();
}
function paintPage(): void {
  if (!root) return;
  const page = $('.jr-page', root); if (!page) return;
  page.innerHTML = query.trim() ? searchPage(query.trim()) : dayPage(days.get(sel) ?? blank(sel));
  $$<HTMLInputElement>('.jr-sum input[type=checkbox]', page).forEach(i => { i.disabled = true; });
  const days_ = [...days.keys()].filter(k => days.get(k)!.prompts.length).sort();
  const prev = days_.filter(k => k < sel).pop(), next = days_.find(k => k > sel);
  const p = $<HTMLButtonElement>('[data-jr-prev]', root), n = $<HTMLButtonElement>('[data-jr-next]', root);
  if (p) { p.disabled = !prev; p.dataset.jrDay = prev ?? ''; }
  if (n) { n.disabled = !next; n.dataset.jrDay = next ?? ''; }
}
function paintStatus(): void {
  if (!root) return;
  const b = $('[data-jr-sync]', root); if (!b) return;
  b.classList.toggle('jr-busy', !!syncing);
  b.title = syncing ? 'Collecte en cours…' : lastError ? `Dernière collecte en échec : ${lastError}` : lastSync ? `Collecté ${rel(lastSync)} — collecter maintenant` : 'Collecter les demandes maintenant';
}
function rerender(): void { if (!root || !$('.jr', root)) { root = null; return; } paintSide(); paintPage(); paintStatus(); }

async function runSync(manual = false): Promise<void> {
  const p = sync(); paintStatus();
  try {
    const n = await p;
    if (manual) toast(n ? `${plural(n, 'nouvelle demande', 'nouvelles demandes')} dans le journal` : 'Journal à jour');
  } catch (e) { if (manual) toast(errMsg(e)); }
  rerender();
  void autoSummaries();
}

function moreMenu(anchor: HTMLElement): void {
  const d = days.get(sel), p = prefs();
  menu(anchor, [
    ...(d?.prompts.length ? [
      { label: 'Enregistrer la journée dans les notes', icon: 'notes', run: () => saveAsNote(d) },
      { label: 'Exporter la journée (Markdown)', icon: 'download', run: () => download(`journal-${d.id}.md`, dayMarkdown(d)) },
      { label: 'Copier le résumé', icon: 'copy', run: async () => { const s = d.summary ?? plainSummary(d); await navigator.clipboard.writeText(`${s.headline}\n\n${s.md}`); toast('Résumé copié'); } },
      '-' as const,
    ] : []),
    { label: 'Résumer automatiquement les journées passées', checked: p.auto, run: () => { setPrefs({ auto: !p.auto }); if (!p.auto) void autoSummaries(); } },
    ...(native.available() ? [{ label: 'Tout recollecter (60 derniers jours)', icon: 'refresh', run: () => { setPrefs({ synced: '' }); void runSync(true); } }] : []),
    ...(d && (d.prompts.length || d.summary) ? ['-' as const, { label: 'Effacer cette journée du journal', icon: 'trash', danger: true, run: async () => {
      if (!await confirmBox({ title: 'Effacer cette journée ?', text: `Les demandes et le résumé du ${dayTitle(d.id).toLowerCase()} sont retirés du journal de Studio. Les journaux de Claude Code ne sont pas touchés : une collecte complète peut les reprendre tant qu’ils existent.`, ok: 'Effacer', danger: true })) return;
      days.delete(d.id); await db.del('journal', d.id); rerender();
    } }] : []),
  ]);
}

export function mount(main: HTMLElement): void {
  if (!sel) { const today = store.dayKey(); sel = days.get(today)?.prompts.length ? today : [...days.values()].filter(d => d.prompts.length).map(d => d.id).sort().pop() ?? today; }
  main.innerHTML = `<header class="toolbar">${app.tbLeft()}${app.crumb('Journal')}<div class="tb-side tb-right">
      <button class="icon-btn jr-prev" data-jr-prev title="Journée précédente" aria-label="Journée précédente">${icon('back')}</button>
      <button class="icon-btn jr-next" data-jr-next title="Journée suivante" aria-label="Journée suivante">${icon('back')}</button>
      <button class="btn btn-ghost" data-jr-today>${icon('today')}<span>Aujourd’hui</span></button>
      <button class="icon-btn" data-jr-menu title="Plus d’actions" aria-label="Plus d’actions">${icon('more')}</button></div></header>
    <div class="jr">
      <aside class="jr-side">
        <div class="list-head"><div class="lh-text"><h2>${icon('journal')}Journal</h2><span class="jr-count"></span></div>${native.available() ? `<button class="icon-btn" data-jr-sync aria-label="Collecter les demandes">${icon('refresh')}</button>` : ''}</div>
        <div class="jr-search"><input class="field" type="search" placeholder="Rechercher une demande" aria-label="Rechercher dans le journal" value="${esc(query)}"></div>
        <div class="list-scroll jr-list"></div>
      </aside>
      <div class="home"><div class="home-in jr-page"></div></div>
    </div>`;
  root = main;
  rerender();
  const input = need<HTMLInputElement>('.jr-search input', main);
  input.addEventListener('input', () => { query = input.value; clearTimeout(timer); timer = window.setTimeout(paintPage, 120); });
  const pick = (k: string): void => { if (!k) return; sel = k; query = ''; input.value = ''; paintSide(); paintPage(); need('.home', main).scrollTop = 0; };
  // Écouteurs posés sur les éléments de la page (pas sur #main, qui sert à toutes les vues).
  const onClick = (e: MouseEvent): void => {
    const t = target(e); let x: HTMLElement | null;
    if ((x = t.closest('[data-jr-copy]'))) {
      const id = x.closest<HTMLElement>('[data-jr-p]')?.dataset.jrP, p = [...days.values()].flatMap(d => d.prompts).find(y => y.id === id);
      if (p) void navigator.clipboard.writeText(p.text).then(() => toast('Demande copiée'), () => toast('Copie impossible'));
      return;
    }
    if ((x = t.closest('[data-jr-day]'))) { pick(x.dataset.jrDay ?? ''); return; }
    if (t.closest('[data-jr-today]')) { pick(store.dayKey()); return; }
    if (t.closest('[data-jr-sync]')) { void runSync(true); return; }
    if ((x = t.closest('[data-jr-menu]'))) { moreMenu(x); return; }
    if (t.closest('[data-jr-sum]')) { void summarize(sel); return; }
    if ((x = t.closest('[data-jr-view]'))) { setPrefs({ view: x.dataset.jrView === 'timeline' ? 'timeline' : 'projects' }); paintPage(); return; }
    // Une demande longue : un clic l'affiche en entier (sauf si on sélectionne du texte).
    if ((x = t.closest('.jr-p')) && !t.closest('a, button') && !getSelection()?.toString()) x.classList.toggle('open');
  };
  need('.toolbar', main).addEventListener('click', onClick);
  need('.jr', main).addEventListener('click', onClick);
  void load().then(() => { if (!days.get(sel)?.prompts.length) { const last = [...days.values()].filter(d => d.prompts.length).map(d => d.id).sort().pop(); if (last && !days.get(store.dayKey())?.prompts.length) sel = last; } rerender(); });
  if (Date.now() - lastSync > 60_000) void runSync(); else void autoSummaries();
}

export function init(shell: AppShell): void {
  app = shell;
  void load();
  // Collecte en arrière-plan : Claude Code efface ses journaux après 30 jours, le journal doit les recopier avant.
  if (native.available()) {
    setTimeout(() => { void sync().then(() => autoSummaries()).catch(() => {}); }, 8000);
    setInterval(() => { if (!document.hidden) void sync().then(() => { if (app.view() === 'journal') rerender(); }).catch(() => {}); }, 15 * 60_000);
  }
}
