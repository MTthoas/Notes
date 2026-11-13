// Registre d'extensions. Les fonctions de Studio s'y branchent comme le feront les futurs plugins :
// si cette porte suffit pour nos propres intégrations (GitHub, Linear, Claude Code), elle suffira pour les autres.
// Un plugin ne reçoit que ce que l'API lui donne : jamais le coffre ni les clés directement.
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

export interface Plugin {
  id: string;
  name: string;
  projectPanels?: ProjectPanel[];
  taskActions?: TaskAction[];
}

const plugins = new Map<string, Plugin>();

export function register(p: Plugin): void {
  if (plugins.has(p.id)) throw new Error(`Plugin déjà enregistré : ${p.id}`);
  plugins.set(p.id, p);
}
export const list = (): Plugin[] => [...plugins.values()];
export const projectPanels = (p: Project, tab = 'overview'): ProjectPanel[] =>
  list().flatMap(x => x.projectPanels ?? []).filter(x => (x.tab ?? 'overview') === tab && (!x.when || x.when(p))).sort((a, b) => a.order - b.order);
export const taskActions = (t: Task, p: Project | null): TaskAction[] =>
  list().flatMap(x => x.taskActions ?? []).filter(x => !x.when || x.when(t, p));
