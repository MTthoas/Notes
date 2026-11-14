// Réglages → Consignes et contexte : tout ce que Studio envoie à l'IA en plus de la demande, au même endroit.
// - Agents Claude Code des projets : consignes ajoutées et réglages de contexte, gardés sur le Mac (là où les agents
//   sont lancés, y compris par l'orchestrateur ou depuis un appareil lié). Voir AgentTuning dans Agents.swift.
// - Automatisations, tâches de fond, limites de contexte : gardés sur cet appareil. Voir integrations/tuning.ts.
// Chaque valeur s'enregistre dès qu'on quitte son champ ; chaque consigne peut être rétablie, et tout d'un coup.
import * as tuning from '../integrations/tuning.ts';
import * as ai from '../integrations/ai.ts';
import * as native from '../core/native.ts';
import { esc } from '../lib/markdown.ts';
import { $, icon, toast, confirmBox } from '../ui/kit.ts';

type Attr = 'tn' | 'tna';
interface Field { key: string; kind: tuning.Item['kind']; label: string; hint: string; value: unknown; changed: boolean; min?: number; max?: number; step?: number; unit?: string; options?: [string, string][] }

// ---------- Agents Claude Code (réglages gardés sur le Mac) ----------
interface AgentState { values: Record<string, unknown>; defaults: Record<string, unknown>; changed: string[] }
let agent: AgentState | null = null, agentErr = '';
const AGENT_ITEMS: Omit<Field, 'value' | 'changed'>[] = [
  { key: 'intro', kind: 'text', label: 'Cadre', hint: 'Où l’agent se trouve et comment tu lui parles.' },
  { key: 'edit', kind: 'text', label: 'Mode « Modifier »', hint: 'Règles de la copie isolée. Contient la ligne « Commit: … » que Studio relit pour proposer le message de commit : garde-la.' },
  { key: 'read', kind: 'text', label: 'Mode « Analyser »', hint: 'Remplace les règles de modification quand l’agent est en lecture seule.' },
  { key: 'context', kind: 'text', label: 'Mémoire du dépôt · lire contexte.md', hint: 'Chaque agent lit contexte.md en premier, à la racine du dépôt, au lieu de réexplorer le code. Vide : il ne le lit plus.' },
  { key: 'contextEdit', kind: 'text', label: 'Mémoire du dépôt · tenir contexte.md à jour', hint: 'Mode « Modifier » seulement : l’agent y ajoute ce qu’il a appris de durable, et le crée s’il manque. Le fichier part avec ses changements, dans la même pull request. Vide : il n’y touche pas.' },
  { key: 'economy', kind: 'text', label: 'Économie de contexte', hint: 'Un agent relit tout son contexte à chaque appel d’outil : ce qu’il y fait entrer se paie à chaque tour suivant. Vide : aucune consigne d’économie.' },
  { key: 'tests', kind: 'text', label: 'Avec les commandes', hint: 'Ajouté seulement quand « Commandes » est coché, suivi de la liste des commandes permises (Réglages → Autorisations).' },
  { key: 'behavior', kind: 'text', label: 'Façon de travailler', hint: 'Quand agir seul, quand discuter, et la forme du compte rendu.' },
  { key: 'extra', kind: 'text', label: 'Tes consignes', hint: 'Ajoutées à la fin, pour tous les agents de tous les projets : conventions, langue, style de code, ce qu’il ne faut jamais toucher.' },
  { key: 'compactWindow', kind: 'num', label: 'Résumer le contexte à partir de', hint: 'Au-delà, Claude Code résume la conversation au lieu de tout relire à chaque appel d’outil, même avec un modèle qui accepte un million de tokens. 0 : laisser Claude Code décider.', min: 0, max: 2000000, step: 50000, unit: 'tokens' },
  { key: 'lean', kind: 'bool', label: 'Pas d’appels accessoires au modèle', hint: 'Coupe les appels de confort de Claude Code (textes d’attente, suggestions).' },
];
const AGENT_PROMPT = ['intro', 'edit', 'context', 'contextEdit', 'economy', 'behavior', 'extra'];
const agentText = (k: string): string => { const v = agent?.values[k]; return typeof v === 'string' ? v : ''; };

async function agentCall(body: Record<string, unknown> = {}): Promise<boolean> {
  const r = await native.call('agent', 'tuning', body, 10000);
  if (r.ok && r.values && r.defaults) { agent = { values: r.values as Record<string, unknown>, defaults: r.defaults as Record<string, unknown>, changed: Array.isArray(r.changed) ? r.changed as string[] : [] }; agentErr = ''; return true; }
  agentErr = r.message === 'Action inconnue.' ? 'Mets à jour l’app Studio pour Mac pour régler ici les consignes des agents Claude Code.' : r.message ?? 'Réglages des agents illisibles.';
  return false;
}

function agentHTML(): string {
  if (!ai.cc.onMac()) return '<p class="modal-hint">Les consignes des agents Claude Code se règlent depuis l’app Studio pour Mac, là où ils sont lancés. Elles valent aussi pour les consignes envoyées depuis cet appareil.</p>';
  if (!agent) return agentErr ? `<p class="modal-hint">${esc(agentErr)}</p>` : '<p class="cc-wait"><span class="spin"></span>Lecture des réglages sur le Mac…</p>';
  const a = agent;
  return AGENT_ITEMS.map(it => fieldHTML('tna', { ...it, value: a.values[it.key], changed: a.changed.includes(it.key) })).join('');
}

// ---------- Champs ----------
const metaHTML = (text: string, changed: boolean): string => `${text.trim() ? `≈ ${tuning.tokens(text).toLocaleString('fr-FR')} tokens` : 'vide'}${changed ? ' · <b>modifié</b>' : ''}`;

function fieldHTML(attr: Attr, f: Field): string {
  const key = esc(f.key), hint = `<p class="modal-hint tn-hint">${esc(f.hint)}</p>`;
  if (f.kind === 'text') {
    const v = typeof f.value === 'string' ? f.value : '';
    return `<details class="tn-text"><summary><span>${esc(f.label)}</span><em data-${attr}-meta="${key}">${metaHTML(v, f.changed)}</em></summary>${hint}
      <textarea class="field area" rows="${Math.min(14, Math.max(3, Math.ceil(v.length / 90) + v.split('\n').length))}" data-${attr}="${key}" spellcheck="false" aria-label="${esc(f.label)}">${esc(v)}</textarea>
      <button type="button" class="link-btn tn-reset" data-${attr}-reset="${key}">Rétablir le texte d’origine</button></details>`;
  }
  if (f.kind === 'bool') return `<label class="cx-check tn-check"><input type="checkbox" data-${attr}="${key}"${f.value === true ? ' checked' : ''}> ${esc(f.label)}</label>${hint}`;
  const input = f.kind === 'choice' ? `<select class="field" data-${attr}="${key}">${(f.options ?? []).map(([v, l]) => `<option value="${esc(v)}"${v === f.value ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`
    : f.kind === 'num' ? `<input class="field" type="number" data-${attr}="${key}" value="${esc(String(f.value ?? ''))}"${f.min != null ? ` min="${f.min}"` : ''}${f.max != null ? ` max="${f.max}"` : ''}${f.step != null ? ` step="${f.step}"` : ''}><span>${esc(f.unit ?? '')}</span>`
    : `<input class="field" data-${attr}="${key}" value="${esc(String(f.value ?? ''))}" spellcheck="false" autocomplete="off">`;
  return `<label class="cx-row tn-row tn-${f.kind}"><span>${esc(f.label)}</span>${input}</label>${hint}`;
}

// ---------- Vue ----------
/** Taille des consignes que Studio ajoute à chaque demande, par type d'exécution. */
function sumHTML(): string {
  const tile = (n: number | null, label: string, sub: string) => `<div><strong>${n == null ? '—' : `≈ ${n.toLocaleString('fr-FR')}`}</strong><span>${label}</span><em>${sub}</em></div>`;
  const sys = (k: ai.SystemKind) => tuning.tokens(ai.systemFor(k));
  return tile(agent ? tuning.tokens(AGENT_PROMPT.map(agentText).filter(Boolean).join(' ')) : null, 'tokens · agent Claude Code', 'ajoutés à sa consigne, mode Modifier')
    + tile(sys('auto'), 'tokens · automatisation', 'consigne système, hors outils')
    + tile(sys('sub'), 'tokens · sous-agent', 'consigne système, hors outils')
    + tile(sys('plain'), 'tokens · sans outil', 'revue de code, question simple');
}

export function html(): string {
  const groups = tuning.GROUPS.map(([g, ic, label, lead]) => `<section class="cx-sec tn"><h4>${icon(ic)}${esc(label)}</h4><p>${esc(lead)}</p>
    ${tuning.KEYS.filter(k => tuning.ITEMS[k].group === g).map(k => fieldHTML('tn', { ...tuning.ITEMS[k], key: k, value: tuning.get(k), changed: tuning.changed(k) })).join('')}</section>`).join('');
  return `<div class="us-sum tn-sum" data-tn-sum>${sumHTML()}</div>
    <section class="cx-sec tn"><h4>${icon('terminal')}Agents Claude Code des projets</h4><p>Ajouté à la consigne de Claude Code pour chaque agent lancé depuis un projet, sur le Mac comme sur un serveur. Une modification vaut dès le prochain tour ; elle fait relire une fois la conversation hors cache.</p>
      <div data-tn-agent>${agentHTML()}</div></section>
    ${groups}
    <section class="cx-sec"><p class="modal-hint tn-saved">${icon('check')}Chaque valeur est enregistrée dès que tu quittes son champ. Les estimations de tokens sont approximatives (environ 3,5 caractères par token).</p>
      <button class="btn btn-danger" data-tn-all>Tout rétablir…</button></section>`;
}

function refreshMeta(): void {
  document.querySelectorAll<HTMLElement>('.settings [data-tn-meta]').forEach(x => { const k = x.dataset.tnMeta as tuning.Key; if (k in tuning.ITEMS) x.innerHTML = metaHTML(tuning.text(k), tuning.changed(k)); });
  document.querySelectorAll<HTMLElement>('.settings [data-tna-meta]').forEach(x => { const k = x.dataset.tnaMeta ?? ''; x.innerHTML = metaHTML(agentText(k), !!agent?.changed.includes(k)); });
  const s = $('.settings [data-tn-sum]'); if (s) s.innerHTML = sumHTML();
}

/** À l'affichage de l'onglet : lit les réglages des agents sur le Mac. */
export function mount(): void {
  if (!ai.cc.onMac()) return;
  void agentCall().then(() => { const x = $('.settings [data-tn-agent]'); if (x) x.innerHTML = agentHTML(); refreshMeta(); });
}

/** Un champ de l'onglet a changé : la valeur est enregistrée. Renvoie false si le champ n'est pas le sien. */
export function onChange(t: HTMLInputElement): boolean {
  const k = t.dataset.tn, a = t.dataset.tna;
  if (k && k in tuning.ITEMS) {
    const key = k as tuning.Key, it = tuning.ITEMS[key];
    tuning.set(key, it.kind === 'bool' ? t.checked : it.kind === 'num' ? Number(t.value) : t.value);
    if (it.kind === 'num') t.value = String(tuning.num(key));
    refreshMeta();
    return true;
  }
  if (a) {
    const it = AGENT_ITEMS.find(x => x.key === a); if (!it) return true;
    const value = it.kind === 'bool' ? t.checked : it.kind === 'num' ? Math.round(Number(t.value) || 0) : t.value;
    void agentCall({ set: { [a]: value } }).then(ok => {
      if (!ok) { toast(agentErr); return; }
      // Le Mac borne la valeur : le champ montre ce qui a été retenu.
      if (it.kind === 'num') t.value = String(agent?.values[a] ?? '');
      refreshMeta();
    });
    return true;
  }
  return false;
}

/** Clic dans l'onglet (rétablir une consigne, tout rétablir). `redraw` redessine l'onglet entier. */
export async function onClick(t: HTMLElement, redraw: () => void): Promise<boolean> {
  const one = t.closest<HTMLElement>('[data-tn-reset]'), oneA = t.closest<HTMLElement>('[data-tna-reset]');
  if (one) {
    const k = one.dataset.tnReset ?? ''; if (!(k in tuning.ITEMS)) return true;
    tuning.reset(k as tuning.Key);
    const f = $<HTMLTextAreaElement>(`.settings [data-tn="${k}"]`); if (f) f.value = tuning.text(k as tuning.Key);
    refreshMeta(); toast('Texte d’origine rétabli');
    return true;
  }
  if (oneA) {
    const k = oneA.dataset.tnaReset ?? '';
    if (!await agentCall({ reset: k })) { toast(agentErr); return true; }
    const f = $<HTMLTextAreaElement>(`.settings [data-tna="${k}"]`); if (f) f.value = agentText(k);
    refreshMeta(); toast('Texte d’origine rétabli');
    return true;
  }
  if (t.closest('[data-tn-all]')) {
    if (!await confirmBox({ title: 'Tout rétablir ?', text: 'Toutes les consignes et limites reprennent leur valeur d’origine, y compris celles des agents Claude Code sur ce Mac. Tes modifications sont perdues.', ok: 'Tout rétablir', danger: true })) return true;
    tuning.reset();
    if (ai.cc.onMac() && !await agentCall({ reset: 'all' })) toast(agentErr);
    redraw(); toast('Valeurs d’origine rétablies');
    return true;
  }
  return false;
}
