// Consommation de l'IA branchée dans Studio : tokens par mois, par fournisseur et par modèle.
// Les fournisseurs n'exposent pas le crédit restant à une simple clé d'API : « ce qu'il en reste »
// est calculé à partir du budget mensuel que tu fixes dans les réglages.
export interface Counts { input: number; output: number; cacheRead: number; cacheWrite: number; calls: number }
interface Month { month: string; byModel: Record<string, Counts> }

const KEY = 'carnet.ai.usage';
const monthKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
const zero = (): Counts => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 });

function read(): Month[] {
  try { const v = JSON.parse(localStorage.getItem(KEY) || '[]') as Month[]; return Array.isArray(v) ? v : []; } catch { return []; }
}
const listeners = new Set<() => void>();
export const onChange = (f: () => void): void => { listeners.add(f); };

/** Enregistre la consommation d'une réponse. */
export function record(provider: string, model: string, c: Partial<Counts>): void {
  const all = read(), m = monthKey();
  let cur = all.find(x => x.month === m);
  if (!cur) { cur = { month: m, byModel: {} }; all.unshift(cur); }
  const k = `${provider}:${model}`, row = cur.byModel[k] ??= zero();
  row.input += c.input ?? 0; row.output += c.output ?? 0; row.cacheRead += c.cacheRead ?? 0; row.cacheWrite += c.cacheWrite ?? 0; row.calls += 1;
  try { localStorage.setItem(KEY, JSON.stringify(all.slice(0, 12))); } catch { /* stockage plein */ }
  const s = sinceAll(), p = s[provider];
  if (p) { const t = p.counts; t.input += c.input ?? 0; t.output += c.output ?? 0; t.cacheRead += c.cacheRead ?? 0; t.cacheWrite += c.cacheWrite ?? 0; t.calls += 1; saveSince(s); }
  listeners.forEach(f => f());
}

// Consommation d'un fournisseur depuis sa connexion (ChatGPT) : le compteur part de l'enregistrement de la clé.
export interface Since { at: number; counts: Counts }
const SINCE = 'carnet.ai.since';
function sinceAll(): Record<string, Since> {
  try { const v = JSON.parse(localStorage.getItem(SINCE) || '{}') as Record<string, Since>; return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}
const saveSince = (s: Record<string, Since>): void => { try { localStorage.setItem(SINCE, JSON.stringify(s)); } catch { /* stockage plein */ } };
/** Compteur depuis la connexion, ou null s'il n'a pas démarré. */
export const since = (provider: string): Since | null => sinceAll()[provider] ?? null;
/** Démarre (ou redémarre) le compteur au moment présent. */
export function connect(provider: string): Since {
  const s = sinceAll(), v = { at: Date.now(), counts: zero() };
  s[provider] = v; saveSince(s); listeners.forEach(f => f());
  return v;
}
export function disconnect(provider: string): void { const s = sinceAll(); delete s[provider]; saveSince(s); listeners.forEach(f => f()); }

const sum = (rows: [string, Counts][]): Counts => rows.reduce((t, [, c]) => ({ input: t.input + c.input, output: t.output + c.output, cacheRead: t.cacheRead + c.cacheRead, cacheWrite: t.cacheWrite + c.cacheWrite, calls: t.calls + c.calls }), zero());
/** Fournisseurs inclus dans un abonnement (pas de facturation au token) : comptés à part du budget. */
const SUBSCRIPTION = /^claudecode:/;

/** Consommation du mois : par modèle, totale facturée au token (clés API) et via l'abonnement (Claude Code). */
export function month(m = monthKey()): { rows: [string, Counts][]; total: Counts; subscription: Counts } {
  const cur = read().find(x => x.month === m), rows = Object.entries(cur?.byModel ?? {}).sort((a, b) => (b[1].input + b[1].output) - (a[1].input + a[1].output));
  return { rows, total: sum(rows.filter(([k]) => !SUBSCRIPTION.test(k))), subscription: sum(rows.filter(([k]) => SUBSCRIPTION.test(k))) };
}
/** Tous les tokens du mois, abonnement compris. */
export const all = (): number => { const { total, subscription } = month(); return billable(total) + billable(subscription); };
/** Tokens comptés dans le budget : entrée, sortie et écriture en cache (les relectures du cache sont comptées à part). */
export const billable = (c: Counts): number => c.input + c.output + c.cacheWrite;

/** Formate un nombre de tokens : 12,3 k, 4,5 M. */
export function fmt(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} M`;
  if (n >= 1e3) return `${(n / 1e3).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} k`;
  return String(n);
}
