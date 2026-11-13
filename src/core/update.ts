// Mise à jour de l'app Mac depuis les Releases du dépôt (voir native/Shared/Updater.swift).
// La version web, elle, se met à jour seule à chaque chargement (service worker) : rien à faire ici pour elle.
import * as native from './native.ts';

export interface UpdateState { ok: boolean; message?: string; current: string; commit: string; available: boolean; tag?: string; notes?: string; page?: string; published?: string }

const AUTO = 'studio.update.auto', EVERY = 6 * 3600e3;
let state: UpdateState | null = null, busy: '' | 'check' | 'install' = '', tooOld = false, timer: ReturnType<typeof setInterval> | undefined;
const listeners = new Set<() => void>();
const tell = (): void => { listeners.forEach(f => f()); };

export const onChange = (f: () => void): void => { listeners.add(f); };
/** Seule l'app Mac se met à jour ainsi (l'app iPhone s'installe depuis Xcode). */
export const supported = (): boolean => native.available() && document.documentElement.dataset.native === 'mac';
export const current = (): UpdateState | null => state;
export const working = (): '' | 'check' | 'install' => busy;
/** L'app installée date d'avant cette fonction : elle ne sait pas se mettre à jour seule. */
export const outdatedShell = (): boolean => tooOld;
export const available = (): boolean => !!state?.available;

/** Recherche automatique au lancement puis toutes les 6 heures (activée par défaut). */
export const auto = (): boolean => { try { return localStorage.getItem(AUTO) !== '0'; } catch { return true; } };
export function setAuto(on: boolean): void {
  try { localStorage.setItem(AUTO, on ? '1' : '0'); } catch { /* stockage indisponible */ }
  schedule();
}

/** Demande au Mac la dernière version publiée. */
export async function check(): Promise<UpdateState | null> {
  if (!supported() || busy) return state;
  busy = 'check'; tell();
  const r = await native.call('update', 'check', {}, 30000);
  busy = '';
  // Une app trop ancienne ignore la demande : elle ne répond pas.
  if (r.message === 'Pas de réponse de l’app.') tooOld = true;
  else { tooOld = false; state = { current: '', commit: '', available: false, ...(r as Partial<UpdateState>), ok: r.ok }; }
  tell();
  return state;
}

/** Télécharge et installe la dernière version ; l'app se relance seule. */
export async function install(): Promise<{ ok: boolean; message?: string; restarting?: boolean }> {
  if (!supported() || busy) return { ok: false, message: 'Une opération est déjà en cours.' };
  busy = 'install'; tell();
  const r = await native.call('update', 'install', {}, 300000);
  busy = ''; tell();
  return { ok: r.ok, ...(r.message ? { message: r.message } : {}), restarting: r.restarting === true };
}

function schedule(): void {
  clearInterval(timer);
  if (supported() && auto()) timer = setInterval(() => { if (!document.hidden) void check(); }, EVERY);
}
/** À appeler une fois au démarrage. */
export function start(): void {
  if (!supported()) return;
  schedule();
  if (auto()) setTimeout(() => void check(), 5000);
}
