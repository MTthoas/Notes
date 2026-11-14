// Registre d'extensions. Les fonctions de Studio s'y branchent comme les plugins optionnels (Spotify, n8n…) :
// si cette porte suffit pour nos propres intégrations (GitHub, Linear, Claude Code), elle suffira pour les autres.
// Un plugin ne reçoit que ce que l'API lui donne : jamais le coffre entier ni les clés des autres.
// Tout tourne dans la page : aucun serveur. Un plugin ne peut joindre que les domaines ouverts par la
// politique de sécurité de index.html (connect-src) ; il les déclare dans `hosts`, affichés dans les réglages.
import * as vault from '../core/vault.ts';
import * as events from '../core/events.ts';
import { toast, errMsg } from '../ui/kit.ts';
import type { AppEvent } from '../core/events.ts';
import type { Project } from '../features/projects/model.ts';
import type { Task } from '../features/tasks.ts';

/** Panneau affiché dans la page d'un projet (PR et CI, tickets, déploiements…). */
export interface ProjectPanel {
  id: string;
  title: string;
  icon: string;
  /** Ordre d'affichage : plus petit = plus haut. */
  order: number;
  /** Onglet du projet où le panneau s'affiche (par défaut : vue d'ensemble). */
  tab?: 'overview' | 'code' | 'flux' | 'sessions' | 'tasks' | 'notes' | 'site';
  /** Visible pour ce projet ? (ex. seulement s'il a un dépôt GitHub). */
  when?(p: Project): boolean;
  /** HTML du panneau ; peut être asynchrone (données distantes). */
  render(p: Project): string | Promise<string>;
}

/** Action proposée sur une tâche (« Confier à Claude Code », …). */
export interface TaskAction {
  id: string;
  label: string;
  icon: string;
  when?(t: Task, p: Project | null): boolean;
  run(t: Task, p: Project | null): void | Promise<void>;
}

/** Réglage d'un plugin : le formulaire de Réglages → Extensions se construit dessus. */
export interface Field {
  key: string;
  label: string;
  /** `text` (par défaut) : une ligne à enregistrer ; `check` : une case à cocher (valeur '1' ou ''). */
  kind?: 'text' | 'check';
  placeholder?: string;
  hint?: string;
  /** Gardé chiffré dans le coffre (jeton, adresse secrète) plutôt qu'en clair. */
  secret?: boolean;
  /** Valeur tant que rien n'a été choisi. */
  def?: string;
  /** Refuse une valeur : renvoie le message à afficher, ou null si elle convient. */
  check?(value: string): string | null;
}

/** Commande ajoutée à la palette. */
export interface Command { label: string; icon: string; kw?: string; run(api: PluginAPI): unknown }

export interface OpenNote { title: string; body: string }

/** Tout ce qu'un plugin peut faire dans Studio. */
export interface PluginAPI {
  /** Réglage en clair du plugin (ou la valeur par défaut du champ). */
  get(key: string): string;
  set(key: string, value: string): void;
  /** Secret du plugin, dans le coffre ; '' si absent ou coffre fermé. */
  secret(key: string): string;
  setSecret(key: string, value: string | null): Promise<void>;
  /** S'abonne aux événements de Studio (capture, tâche terminée, Linear, GitHub) ; résilié à la désactivation. */
  on(f: (e: AppEvent) => void): void;
  /** Minuterie arrêtée à la désactivation. */
  every(ms: number, f: () => void): void;
  /** Redessine le bloc du plugin dans la barre latérale. */
  refresh(): void;
  /** Redessine la page Réglages → Extensions, si elle est affichée (efface une saisie en cours : pas en tâche de fond). */
  refreshSettings(): void;
  /** La note ouverte, si elle est lisible (ni verrouillée ni supprimée). */
  note(): OpenNote | null;
}

export interface Plugin {
  id: string;
  name: string;
  icon?: string;
  description?: string;
  /** À activer dans Réglages → Extensions. Sans ce drapeau, le plugin fait partie de Studio et tourne toujours. */
  optional?: boolean;
  /** Domaines contactés, affichés tels quels dans les réglages. Ils doivent figurer dans connect-src (index.html). */
  hosts?: string[];
  /** A besoin du coffre même sans champ secret (jetons obtenus par connexion). */
  vault?: boolean;
  settings?: Field[];
  projectPanels?: ProjectPanel[];
  taskActions?: TaskAction[];
  commands?: Command[];
  /** Rendu des blocs de code ```<langage> d'une note (HTML synchrone, ou null pour le bloc brut). */
  fences?: Record<string, (code: string, api: PluginAPI) => string | null>;
  /** Appelé à l'activation (et au démarrage si le plugin est actif). */
  start?(api: PluginAPI): void;
  /** HTML ajouté sous les champs, dans les réglages (état de connexion, bouton d'essai…). */
  panel?(api: PluginAPI): string;
  /** HTML du bloc en bas de la barre latérale ; '' pour ne rien afficher. */
  sidebar?(api: PluginAPI): string;
  /** Réponses aux clics sur `data-plug="<id>:<action>"`, aux formulaires `data-plug-form="<id>:<action>"` et aux champs `data-plug-change="<id>:<action>"`. */
  actions?: Record<string, (api: PluginAPI, el: HTMLElement) => unknown>;
}

/** Ce que le registre attend de l'application. */
export interface Hooks { settings(): void; note(): OpenNote | null }

interface State { on: string[]; cfg: Record<string, Record<string, string>> }
const KEY = 'studio.plugins';
function state(): State {
  try { const s = JSON.parse(localStorage.getItem(KEY) || 'null') as Partial<State> | null; return { on: s?.on ?? [], cfg: s?.cfg ?? {} }; }
  catch { return { on: [], cfg: {} }; }
}
const save = (s: State): void => { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* stockage indisponible */ } };

const plugins = new Map<string, Plugin>();
const apis = new Map<string, PluginAPI>();
const stops = new Map<string, (() => void)[]>();
let hooks: Hooks = { settings: () => {}, note: () => null };

export function register(p: Plugin): void {
  if (plugins.has(p.id)) throw new Error(`Plugin déjà enregistré : ${p.id}`);
  plugins.set(p.id, p);
}
export const list = (): Plugin[] => [...plugins.values()];
export const get = (id: string): Plugin | undefined => plugins.get(id);
export const active = (p: Plugin): boolean => !p.optional || state().on.includes(p.id);
const live = (): Plugin[] => list().filter(active);

export const projectPanels = (p: Project, tab = 'overview'): ProjectPanel[] =>
  live().flatMap(x => x.projectPanels ?? []).filter(x => (x.tab ?? 'overview') === tab && (!x.when || x.when(p))).sort((a, b) => a.order - b.order);
export const taskActions = (t: Task, p: Project | null): TaskAction[] =>
  live().flatMap(x => x.taskActions ?? []).filter(x => !x.when || x.when(t, p));
export const commands = (): { label: string; icon: string; kw: string; run: () => unknown }[] =>
  live().flatMap(p => (p.commands ?? []).map(c => ({ label: c.label, icon: c.icon, kw: c.kw ?? '', run: () => guard(() => c.run(api(p))) })));

/** Bloc ```<lang> rendu par un plugin actif ; null si aucun ne le prend. */
export function fence(lang: string, code: string): string | null {
  for (const p of live()) {
    const f = p.fences?.[lang]; if (!f) continue;
    try { return f(code, api(p)); } catch (e) { console.error('plugin', p.id, e); return null; }
  }
  return null;
}

/** L'API remise à un plugin : ses réglages et ses secrets sont rangés sous son identifiant. */
export function api(p: Plugin): PluginAPI {
  const known = apis.get(p.id); if (known) return known;
  const box = `plug.${p.id}`;
  const made: PluginAPI = {
    get: key => state().cfg[p.id]?.[key] ?? p.settings?.find(f => f.key === key)?.def ?? '',
    set(key, value) { const s = state(); s.cfg[p.id] = { ...s.cfg[p.id], [key]: value }; save(s); },
    secret: key => vault.secret<Record<string, string>>(box)?.[key] ?? '',
    async setSecret(key, value) {
      const all = { ...(vault.secret<Record<string, string>>(box) ?? {}) };
      if (value) all[key] = value; else delete all[key];
      await vault.setSecret(box, Object.keys(all).length ? all : null);
    },
    on(f) { stops.get(p.id)?.push(events.on(f)); },
    every(ms, f) { const t = setInterval(f, ms); stops.get(p.id)?.push(() => clearInterval(t)); },
    refresh,
    refreshSettings: () => hooks.settings(),
    note: () => hooks.note(),
  };
  apis.set(p.id, made);
  return made;
}

async function guard(f: () => unknown): Promise<void> {
  try { await f(); } catch (e) { toast(errMsg(e)); }
}
function startOne(p: Plugin): void {
  if (stops.has(p.id)) return;
  stops.set(p.id, []);
  try { p.start?.(api(p)); } catch (e) { console.error('plugin', p.id, e); }
}
function stopOne(p: Plugin): void {
  for (const f of stops.get(p.id) ?? []) f();
  stops.delete(p.id);
}

/** Démarre les plugins actifs. À appeler une fois, coffre ouvert, avant que l'app ne nettoie l'adresse de la page. */
export function boot(h: Hooks): void {
  hooks = h;
  for (const p of live()) startOne(p);
}

export function enable(id: string, on: boolean): void {
  const p = plugins.get(id); if (!p?.optional) return;
  const s = state();
  s.on = s.on.filter(x => x !== id); if (on) s.on.push(id);
  save(s);
  if (on) startOne(p); else stopOne(p);
  refresh();
}

/** Bloc des plugins dans la barre latérale (lecture en cours…). */
export const sidebarHTML = (): string => live().map(p => { try { return p.sidebar?.(api(p)) ?? ''; } catch { return ''; } }).join('');
export function refresh(): void {
  const x = document.getElementById('plug-side');
  if (x) x.innerHTML = sidebarHTML();
}

/** Lance l'action `<id>:<action>` d'un plugin actif, puis redessine ce qu'il affiche. */
export async function run(ref: string, el: HTMLElement): Promise<void> {
  const [id = '', name = ''] = ref.split(':'), p = plugins.get(id);
  if (!p || !active(p)) return;
  await guard(() => p.actions?.[name]?.(api(p), el));
  refresh(); hooks.settings();
}
/** Clic délégué : renvoie true s'il visait un plugin. */
export async function click(t: HTMLElement): Promise<boolean> {
  const x = t.closest<HTMLElement>('[data-plug]'); if (!x) return false;
  await run(x.dataset.plug ?? '', x);
  return true;
}
/** Changement délégué d'un champ `data-plug-change="<id>:<action>"` (curseur…) : renvoie true s'il visait un plugin. */
export function change(t: HTMLElement): boolean {
  const ref = t.dataset.plugChange; if (!ref) return false;
  void run(ref, t);
  return true;
}
