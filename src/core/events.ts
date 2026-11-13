// Bus d'événements de l'application : les sources (capture, Linear, GitHub, tâches) annoncent ce qui
// se passe, les automatisations s'y abonnent. Aucune dépendance : n'importe quel module peut émettre.

/** Événements qui peuvent déclencher une automatisation. Le texte est une DONNÉE décrivant l'événement. */
export type Trigger = 'capture' | 'linear' | 'github' | 'tache';
export interface AppEvent { kind: Trigger; text: string; at: number }

const listeners = new Set<(e: AppEvent) => void>();
export const on = (f: (e: AppEvent) => void): (() => void) => { listeners.add(f); return () => listeners.delete(f); };
export function emit(kind: Trigger, text: string): void {
  const e: AppEvent = { kind, text: text.slice(0, 4000), at: Date.now() };
  for (const f of listeners) { try { f(e); } catch (err) { console.error('événement', kind, err); } }
}

export const TRIGGERS: Record<Trigger, string> = {
  capture: 'à chaque capture rapide',
  linear: 'à chaque notification Linear',
  github: 'à chaque nouveauté GitHub',
  tache: 'à chaque tâche terminée',
};
/** Lit la valeur écrite dans un bloc ```agent (« déclencheur: capture », « linear », …). */
export function parseTrigger(v: string): Trigger | null {
  const s = v.toLowerCase();
  if (/captur|bo[iî]te|inbox|note/.test(s)) return 'capture';
  if (/linear|notif|ticket/.test(s)) return 'linear';
  if (/github|git|d[eé]p[oô]t|commit|pr\b/.test(s)) return 'github';
  if (/t[aâ]che|todo|termin/.test(s)) return 'tache';
  return null;
}
