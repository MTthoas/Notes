// Mise à jour de l'app Mac depuis les Releases du dépôt (voir native/Shared/Updater.swift).
// La version web, elle, se met à jour seule à chaque chargement (service worker) : rien à faire ici pour elle.
//
// Par défaut tout est automatique : Studio cherche la dernière version, la télécharge et la vérifie en arrière-plan,
// puis l'installe à la relance (proposée par features/news.ts) ou, à défaut, à la fermeture de l'app.
import * as native from './native.ts';

export interface UpdateState { ok: boolean; message?: string; current: string; commit: string; available: boolean; staged?: boolean; tag?: string; notes?: string; page?: string; published?: string }
/** Version en cours d'installation, retenue pour la présenter à la prochaine ouverture. `from` : commit de l'app qu'elle remplace. */
export interface Installed { tag: string; notes: string; page: string; from: string }
type Busy = '' | 'check' | 'download' | 'install';

const AUTO = 'studio.update.auto', INSTALL = 'studio.update.install', PENDING = 'studio.update.pending', EVERY = 6 * 3600e3;
let state: UpdateState | null = null, busy: Busy = '', tooOld = false, failure = '', timer: ReturnType<typeof setInterval> | undefined;
const listeners = new Set<() => void>();
const tell = (): void => { listeners.forEach(f => f()); };
const flag = (key: string): boolean => { try { return localStorage.getItem(key) !== '0'; } catch { return true; } };
const setFlag = (key: string, on: boolean): void => { try { localStorage.setItem(key, on ? '1' : '0'); } catch { /* stockage indisponible */ } };

export const onChange = (f: () => void): void => { listeners.add(f); };
/** Seule l'app Mac se met à jour ainsi (l'app iPhone s'installe depuis Xcode). */
export const supported = (): boolean => native.available() && document.documentElement.dataset.native === 'mac';
export const current = (): UpdateState | null => state;
export const working = (): Busy => busy;
/** L'app installée date d'avant cette fonction : elle ne sait pas se mettre à jour seule. */
export const outdatedShell = (): boolean => tooOld;
export const available = (): boolean => !!state?.available;
/** La nouvelle version est téléchargée et vérifiée : il ne reste qu'à relancer. */
export const ready = (): boolean => !!state?.available && !!state.staged;
/** Pourquoi le dernier téléchargement automatique a échoué (vide sinon). */
export const problem = (): string => failure;

/** Recherche automatique au lancement puis toutes les 6 heures (activée par défaut). */
export const auto = (): boolean => flag(AUTO);
export function setAuto(on: boolean): void { setFlag(AUTO, on); schedule(); }

/** Téléchargement et installation automatiques d'une version trouvée (activés par défaut). */
export const autoInstall = (): boolean => flag(INSTALL);
export function setAutoInstall(on: boolean): void {
  setFlag(INSTALL, on);
  if (on) { if (state?.available && !state.staged) void download(); return; }
  // Désactivé : le paquet déjà prêt ne doit plus s'installer à la fermeture.
  if (state?.staged) { state = { ...state, staged: false }; forget(); void native.call('update', 'discard', {}, 10000); }
  tell();
}

// ---------- Version en attente : ce qui sera présenté après la relance ----------
function pending(): Installed | null {
  try {
    const p = JSON.parse(localStorage.getItem(PENDING) || 'null') as Partial<Installed> | null;
    return p && typeof p.tag === 'string' && typeof p.from === 'string' ? { tag: p.tag, notes: String(p.notes ?? ''), page: String(p.page ?? ''), from: p.from } : null;
  } catch { return null; }
}
function remember(): void {
  if (!state?.available || !state.tag) return;
  const p: Installed = { tag: state.tag, notes: state.notes ?? '', page: state.page ?? '', from: state.commit };
  try { localStorage.setItem(PENDING, JSON.stringify(p)); } catch { /* stockage indisponible */ }
}
function forget(): void { try { localStorage.removeItem(PENDING); } catch { /* stockage indisponible */ } }

/** Si l'app vient d'être mise à jour, rend la version installée — une seule fois. */
export async function justInstalled(): Promise<Installed | null> {
  const p = supported() ? pending() : null;
  if (!p) return null;
  const r = await native.call('update', 'info', {}, 5000);
  // Même commit qu'avant : la version retenue n'est pas encore installée.
  if (!r.ok || String(r.commit ?? '') === p.from) return null;
  forget();
  return p;
}

/** Demande au Mac la dernière version publiée ; si elle est nouvelle, la télécharge en arrière-plan. */
export async function check(): Promise<UpdateState | null> {
  if (!supported() || busy) return state;
  busy = 'check'; tell();
  const r = await native.call('update', 'check', {}, 30000);
  busy = '';
  // Une app trop ancienne ignore la demande : elle ne répond pas.
  if (r.message === 'Pas de réponse de l’app.') tooOld = true;
  else { tooOld = false; state = { current: '', commit: '', available: false, ...(r as Partial<UpdateState>), ok: r.ok }; }
  tell();
  if (state?.ok && state.available && !state.staged && autoInstall()) void download();
  return state;
}

/** Télécharge et vérifie la nouvelle version sans rien remplacer : elle s'installera à la relance, ou à la fermeture de l'app. */
export async function download(): Promise<boolean> {
  if (!supported() || busy || !state?.available) return false;
  if (state.staged) return true;
  const found = state;
  busy = 'download'; tell();
  const r = await native.call('update', 'download', {}, 300000);
  busy = '';
  if (r.ok) { failure = ''; state = { ...found, staged: true }; remember(); }
  else failure = r.message ?? 'Téléchargement de la mise à jour impossible.';
  tell();
  return r.ok;
}

/** Installe la dernière version (déjà téléchargée, ou téléchargée ici) ; l'app se relance seule. */
export async function install(): Promise<{ ok: boolean; message?: string; restarting?: boolean }> {
  if (!supported() || busy) return { ok: false, message: 'Une opération est déjà en cours.' };
  busy = 'install'; tell();
  remember();
  const r = await native.call('update', 'install', {}, 300000);
  busy = '';
  if (!r.ok) { if (state?.staged) state = { ...state, staged: false }; forget(); }
  tell();
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
