// Réglages → Autorisations : ce que les agents Claude Code des projets ont le droit de faire sur ce Mac.
// - Commandes : la liste des commandes permises quand la case « Commandes » est cochée au lancement (par défaut
//   `npm test` et `npm run …`), ou toutes ; et si cette case vaut aussi en mode Analyser.
// - Web : recherche et lecture de pages (WebSearch, WebFetch).
// - PATH : dossiers ajoutés en tête du PATH des agents (l'app ouverte depuis le Dock n'a qu'un PATH minimal).
// Gardé sur le Mac, là où les agents sont lancés : voir AgentPermissions dans Agents.swift. Un appareil lié ne peut
// ni lire ni modifier ces réglages (« agent.permissions » n'est pas dans REMOTE_ALLOWED, link.ts).
// Chaque valeur s'enregistre dès qu'on quitte son champ.
import * as ai from '../integrations/ai.ts';
import * as native from '../core/native.ts';
import { esc } from '../lib/markdown.ts';
import { $, icon, toast, confirmBox } from '../ui/kit.ts';

interface Values { web: boolean; anyCommand: boolean; commandsInRead: boolean; commands: string[]; path: string[] }
interface Preview { read: string[]; readCommands: string[]; edit: string[]; editCommands: string[] }
interface State { values: Values; defaults: Values; changed: string[]; preview: Preview }
type Key = keyof Values;

let state: State | null = null, err = '';

/** Exemples proposés sous chaque liste : un clic les ajoute. */
const COMMAND_IDEAS = ['npm ci', 'npm install', 'npx tsc *', 'cargo test *', 'cargo build *', 'git status', 'git diff *', 'swift test *', 'pytest *', 'make test'];
const PATH_IDEAS = ['/opt/homebrew/bin', '/usr/local/bin', '~/.cargo/bin', '~/.local/bin', '~/.bun/bin'];

const strings = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
function parse(r: native.Reply): State | null {
  const v = r.values as Record<string, unknown> | undefined, d = r.defaults as Record<string, unknown> | undefined, p = r.preview as Record<string, unknown> | undefined;
  if (!r.ok || !v || !d || !p) return null;
  const values = (o: Record<string, unknown>): Values => ({ web: o.web === true, anyCommand: o.anyCommand === true, commandsInRead: o.commandsInRead === true, commands: strings(o.commands), path: strings(o.path) });
  return { values: values(v), defaults: values(d), changed: strings(r.changed),
    preview: { read: strings(p.read), readCommands: strings(p.readCommands), edit: strings(p.edit), editCommands: strings(p.editCommands) } };
}

/** Lit (et modifie, si `body` le demande) les autorisations gardées sur le Mac. */
async function call(body: Record<string, unknown> = {}): Promise<boolean> {
  const r = await native.call('agent', 'permissions', body, 10000);
  const s = parse(r);
  if (s) {
    state = s; err = '';
    const refused = strings(r.rejected);
    if (refused.length) toast(`Ignoré${refused.length > 1 ? 's' : ''} : ${refused.slice(0, 4).join(', ')}${refused.length > 4 ? '…' : ''} (une ligne par entrée, sans parenthèses ; dossiers en chemin absolu)`);
    return true;
  }
  err = r.message === 'Action inconnue.' ? 'Mets à jour l’app Studio pour Mac pour régler ici les autorisations des agents.' : r.message ?? 'Autorisations illisibles.';
  return false;
}

/** Pour le formulaire de consigne : la case « Commandes » vaut-elle aussi en mode Analyser ? (dernière valeur lue) */
export const commandsInRead = (): boolean => state?.values.commandsInRead === true;
/** Lit les autorisations une fois, en arrière-plan, pour le formulaire de consigne. */
export function preload(): void { if (!state && ai.cc.onMac()) void call(); }

// ---------- Vue ----------
const tag = (s: string) => `<code>${esc(s)}</code>`;
function previewHTML(p: Preview): string {
  const row = (label: string, tools: string[], cmds: string[]) => `<div><span>${esc(label)}</span><strong class="ap-tools">${tools.map(tag).join(' ')}</strong>
    <em>${cmds.length ? `avec « Commandes » : ${cmds.map(tag).join(' ')}` : 'pas de commande dans ce mode'}</em></div>`;
  return `<div class="ap-preview">${row('Analyser', p.read, p.readCommands)}${row('Modifier', p.edit, p.editCommands)}</div>`;
}

function listHTML(key: 'commands' | 'path', label: string, hint: string, ideas: string[]): string {
  const s = state; if (!s) return '';
  const lines = s.values[key], have = new Set(lines);
  const changed = s.changed.includes(key);
  return `<label class="ap-list"><span>${esc(label)}${changed ? ' <b>· modifié</b>' : ''}</span>
      <textarea class="field area" rows="${Math.min(12, Math.max(3, lines.length + 1))}" data-ap="${key}" spellcheck="false" autocomplete="off" aria-label="${esc(label)}">${esc(lines.join('\n'))}</textarea></label>
    <p class="modal-hint tn-hint">${hint}</p>
    <div class="ap-ideas">${ideas.filter(x => !have.has(x)).map(x => `<button type="button" class="chip ap-idea" data-ap-add="${key}" data-value="${esc(x)}">${icon('plus')}${esc(x)}</button>`).join('')}</div>
    ${changed ? `<button type="button" class="link-btn tn-reset" data-ap-reset="${key}">Rétablir la valeur d’origine</button>` : ''}`;
}

const check = (key: Key, label: string, hint: string): string => `<label class="cx-check tn-check"><input type="checkbox" data-ap="${key}"${state?.values[key] === true ? ' checked' : ''}> ${esc(label)}</label><p class="modal-hint tn-hint">${hint}</p>`;

function bodyHTML(): string {
  if (!ai.cc.onMac()) return '<p class="modal-hint">Les autorisations des agents Claude Code se règlent depuis l’app Studio pour Mac, là où ils sont lancés. Un appareil lié ne peut jamais autoriser les commandes.</p>';
  if (!state) return err ? `<p class="modal-hint">${esc(err)}</p>` : '<p class="cc-wait"><span class="spin"></span>Lecture des autorisations sur le Mac…</p>';
  const v = state.values;
  return `<section class="cx-sec tn"><h4>${icon('shield')}Ce que reçoit Claude Code</h4>
      <p>Les outils donnés à chaque agent selon son mode. Tout ce qui n’est pas listé est refusé sans question, et les fichiers restent confinés à son dossier de travail (<code>--restricted</code>).</p>
      ${previewHTML(state.preview)}</section>
    <section class="cx-sec tn"><h4>${icon('terminal')}Commandes</h4>
      <p>Permises seulement quand tu coches <strong>Commandes</strong> en lançant un agent, jamais sur un serveur ni depuis un appareil lié. L’agent reçoit la liste dans sa consigne ; une commande hors liste lui est refusée et s’affiche sous son fil. Claude Code laisse toujours passer de lui-même quelques commandes en lecture seule (<code>ls</code>, <code>whoami</code>…).</p>
      ${v.anyCommand ? `<p class="modal-hint ap-warn">${icon('shield')}Toutes les commandes sont permises : la liste ci-dessous ne s’applique pas.</p>` : listHTML('commands', 'Commandes permises', 'Une par ligne, au format des règles de Claude Code : <code>npm run *</code> permet tout ce qui commence par <code>npm run </code>. Sans parenthèses. Liste vide : aucune commande.', COMMAND_IDEAS)}
      ${check('anyCommand', 'Toutes les commandes (terminal sans restriction)', 'L’agent peut lancer n’importe quelle commande sur ce Mac, y compris supprimer des fichiers hors de sa copie ou envoyer des données en ligne. À réserver aux dépôts dont tu relis chaque consigne.')}
      ${check('commandsInRead', 'Aussi en mode Analyser', 'En mode Analyser, l’agent travaille directement dans le dossier du projet, pas dans une copie isolée : ses commandes y laissent leurs traces (fichiers de build, dépendances installées).')}</section>
    <section class="cx-sec tn"><h4>${icon('search')}Web</h4>
      ${check('web', 'Rechercher et lire des pages web (WebSearch, WebFetch)', 'Dans les deux modes. Utile pour consulter une documentation ; l’agent peut alors aussi envoyer des requêtes vers n’importe quelle adresse.')}</section>
    <section class="cx-sec tn"><h4>${icon('folder')}Dossiers des outils</h4>
      ${listHTML('path', 'Ajoutés en tête du PATH', 'Ouvert depuis le Dock, Studio n’a qu’un PATH minimal : un agent ne trouve ni <code>cargo</code>, ni les outils de Homebrew. Un dossier absolu par ligne, <code>~</code> accepté. Vide : le PATH de l’app.', PATH_IDEAS)}</section>`;
}

export function html(): string {
  return `<div data-ap-body>${bodyHTML()}</div>
    <section class="cx-sec"><p class="modal-hint tn-saved">${icon('check')}Chaque valeur est enregistrée sur ce Mac dès que tu quittes son champ, et vaut dès le prochain agent lancé.</p>
      <button class="btn btn-danger" data-ap-all>Tout rétablir…</button></section>`;
}

const redrawBody = (): void => { const x = $('.settings [data-ap-body]'); if (x) x.innerHTML = bodyHTML(); };

/** À l'affichage de l'onglet : lit les autorisations sur le Mac. */
export function mount(): void {
  if (!ai.cc.onMac()) return;
  void call().then(redrawBody);
}

async function save(set: Partial<Values>): Promise<void> {
  if (!await call({ set })) toast(err);
  redrawBody();
}

/** Un champ de l'onglet a changé : la valeur est enregistrée. Renvoie false si le champ n'est pas le sien. */
export function onChange(t: HTMLInputElement): boolean {
  const k = t.dataset.ap as Key | undefined; if (!k) return false;
  if (k === 'commands' || k === 'path') { void save({ [k]: t.value.split('\n') }); return true; }
  if (k === 'anyCommand' && t.checked) {
    void confirmBox({ title: 'Permettre toutes les commandes ?', text: 'Quand tu coches « Commandes », l’agent pourra lancer n’importe quelle commande sur ce Mac, sans liste ni question : supprimer des fichiers hors de sa copie, installer des programmes, envoyer des données en ligne. Les garde-fous de fichiers ne s’appliquent pas au terminal.', ok: 'Tout permettre', danger: true })
      .then(ok => { if (ok) void save({ anyCommand: true }); else t.checked = false; });
    return true;
  }
  void save({ [k]: t.checked });
  return true;
}

/** Clic dans l'onglet (ajouter un exemple, rétablir, tout rétablir). `redraw` redessine l'onglet entier. */
export async function onClick(t: HTMLElement, redraw: () => void): Promise<boolean> {
  const add = t.closest<HTMLElement>('[data-ap-add]'), one = t.closest<HTMLElement>('[data-ap-reset]');
  if (add && state) {
    const k = add.dataset.apAdd as 'commands' | 'path', value = add.dataset.value ?? '';
    if (k !== 'commands' && k !== 'path') return true;
    // Le texte du champ, même pas encore enregistré, plus l'exemple.
    const field = $<HTMLTextAreaElement>(`.settings [data-ap="${k}"]`);
    const lines = (field?.value ?? state.values[k].join('\n')).split('\n').map(x => x.trim()).filter(Boolean);
    if (!lines.includes(value)) lines.push(value);
    await save({ [k]: lines });
    return true;
  }
  if (one) {
    if (!await call({ reset: one.dataset.apReset ?? '' })) toast(err);
    redrawBody(); toast('Valeur d’origine rétablie');
    return true;
  }
  if (t.closest('[data-ap-all]')) {
    if (!await confirmBox({ title: 'Tout rétablir ?', text: 'Les agents reprennent les autorisations d’origine : lecture (et écriture en mode Modifier) dans leur dossier, et avec « Commandes » seulement npm test et npm run … ; pas de web, et le PATH de l’app.', ok: 'Tout rétablir', danger: true })) return true;
    if (ai.cc.onMac() && !await call({ reset: 'all' })) toast(err);
    redraw(); toast('Autorisations d’origine rétablies');
    return true;
  }
  return false;
}
