// Premiers pas : six étapes qui se cochent d'elles-mêmes, pour qu'une personne qui découvre ce genre
// d'outil sache toujours quoi faire ensuite. La carte disparaît quand tout est fait, ou sur demande.
import * as vault from '../core/vault.ts';
import * as todo from './tasks.ts';
import * as hub from './hub.ts';

const KEY = 'carnet.onboard';
type Flag = 'note' | 'link' | 'palette' | 'dismissed';
const read = (): Partial<Record<Flag, number>> => { try { return JSON.parse(localStorage.getItem(KEY) || '{}') as Partial<Record<Flag, number>>; } catch { return {}; } };

/** Retient une action faite par la personne (première note, premier lien, palette ouverte…). */
export function mark(flag: Flag): void {
  const f = read(); if (f[flag]) return;
  f[flag] = Date.now();
  try { localStorage.setItem(KEY, JSON.stringify(f)); } catch { /* stockage indisponible */ }
}
export const dismiss = (): void => mark('dismissed');

export interface Step { key: string; label: string; hint: string; done: boolean; action: string }
export function steps(): Step[] {
  const f = read();
  return [
    { key: 'note', label: 'Écrire une première note', hint: 'Du texte simple suffit.', done: !!f.note, action: 'data-act="new"' },
    { key: 'palette', label: 'Ouvrir la palette', hint: 'Elle trouve tout : notes et actions.', done: !!f.palette, action: 'data-act="palette"' },
    { key: 'link', label: 'Relier deux notes', hint: 'Écris [[ puis le titre d’une note.', done: !!f.link, action: 'data-view="help"' },
    { key: 'task', label: 'Ajouter une tâche', hint: 'Ex. « Appeler Paul demain ».', done: !!todo.list(), action: 'data-view="tasks"' },
    { key: 'secure', label: 'Protéger tes notes', hint: 'Chiffrement et Touch ID.', done: vault.enabled(), action: 'data-open-conn="coffre"' },
    { key: 'auto', label: 'Lancer une automatisation', hint: 'Un modèle prêt à l’emploi suffit.', done: hub.runLog().length > 0, action: 'data-view="agents"' },
  ];
}
/** Visible tant qu'il reste quelque chose à découvrir et que la personne ne l'a pas masquée. */
export const visible = (): boolean => !read().dismissed && steps().some(s => !s.done);
