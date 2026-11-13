// Onglet « Sessions IA » d'un projet : les sessions Claude Code menées dans son dossier, lues en local
// par l'app Mac et rafraîchies en direct — ce qu'elles font, les fichiers touchés, les tokens consommés,
// et l'état de la limite d'utilisation de Claude Code.
import * as native from '../../core/native.ts';
import * as usage from '../../integrations/usage.ts';
import { esc } from '../../lib/markdown.ts';
import { icon, rel } from '../../ui/kit.ts';
import type { Project } from './model.ts';

interface Tokens { input: number; output: number; cacheRead: number; cacheWrite: number }
interface Session { id: string; title: string; branch: string; started: string; updated: string; live: boolean; models: string[]; prompts: number; lastPrompt: string; tokens: Tokens; tools: Record<string, number>; files: string[] }
interface Quota { status?: string; resetsAt?: number; rateLimitType?: string; overageStatus?: string; isUsingOverage?: boolean }
interface Action { at: string; kind: string; text: string }

let selected: string | null = null, timer: ReturnType<typeof setInterval> | undefined;
const ms = (iso: string) => Date.parse(iso) || 0;
const short = (path: string, root: string | null) => root && path.startsWith(root + '/') ? path.slice(root.length + 1) : path.replace(/^\/Users\/[^/]+/, '~');
const model = (m: string) => m.replace(/^claude-/, '').replace(/-(\d)-(\d)$/, ' $1.$2').replace(/-/g, ' ');

function quotaHTML(q: Quota | null): string {
  if (!q?.status) return '';
  const kind = q.rateLimitType === 'five_hour' ? 'Limite des 5 heures' : q.rateLimitType === 'seven_day' ? 'Limite de la semaine' : q.rateLimitType === 'seven_day_opus' ? 'Limite Opus de la semaine' : 'Limite d’utilisation';
  const at = q.resetsAt ? new Date(q.resetsAt * 1000) : null;
  const when = at ? at.toLocaleString('fr-FR', { weekday: at.getTime() - Date.now() > 864e5 ? 'long' : undefined, hour: '2-digit', minute: '2-digit' }) : '';
  const state = q.status === 'rejected' ? ['err', 'atteinte'] : q.status === 'allowed_warning' ? ['warn', 'bientôt atteinte'] : ['ok', 'disponible'];
  return `<div class="ss-quota ${state[0]}"><i></i><strong>${kind} : ${state[1]}</strong>${at && q.status !== 'allowed' ? `<span>se réinitialise ${esc(when)}</span>` : ''}${q.isUsingOverage ? '<span>· crédit supplémentaire en cours d’utilisation</span>' : ''}</div>`;
}

function listHTML(list: Session[], quota: Quota | null): string {
  const tot = list.reduce((t, s) => ({ input: t.input + s.tokens.input + s.tokens.cacheWrite, output: t.output + s.tokens.output, cacheRead: t.cacheRead + s.tokens.cacheRead }), { input: 0, output: 0, cacheRead: 0 });
  return `${quotaHTML(quota)}
    <div class="ss-totals"><div><strong>${list.length}</strong><span>session${list.length > 1 ? 's' : ''}</span></div><div><strong>${usage.fmt(tot.output)}</strong><span>tokens écrits par l’IA</span></div><div><strong>${usage.fmt(tot.input)}</strong><span>tokens lus</span></div><div><strong>${usage.fmt(tot.cacheRead)}</strong><span>relus depuis le cache</span></div></div>
    <div class="ss-list">${list.map(s => {
      const top = Object.entries(s.tools).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${esc(k)} ${v}`).join(' · ');
      return `<button class="ss-row${s.id === selected ? ' sel' : ''}" data-ss="${esc(s.id)}"><i class="ss-live${s.live ? ' on' : ''}" title="${s.live ? 'En cours' : 'Inactive'}"></i>
        <span class="ss-main"><strong>${esc(s.title)}</strong><em>${s.branch ? `${icon('pr')}${esc(s.branch)} · ` : ''}${esc(s.models.map(model).join(', '))} · ${s.prompts} demande${s.prompts > 1 ? 's' : ''}${top ? ` · ${top}` : ''}</em></span>
        <span class="ss-tok">${usage.fmt(s.tokens.output)}<small>écrits</small></span><time>${esc(rel(ms(s.updated)))}</time></button>`;
    }).join('') || '<p class="hm-empty">Aucune session Claude Code dans ce dossier pour l’instant.</p>'}</div>`;
}

function detailHTML(s: Session & { actions: Action[] }, root: string | null): string {
  const dur = ms(s.updated) - ms(s.started), h = Math.floor(dur / 36e5), mn = Math.round(dur % 36e5 / 6e4);
  const kind = (k: string) => k === 'prompt' ? ['user', 'Toi'] : k === 'text' ? ['ai', 'Claude'] : ['tool', k.slice(5)];
  return `<div class="ss-detail"><button class="lv-back" data-ss="">${icon('back')}Toutes les sessions</button>
    <div class="ss-dhead"><i class="ss-live${s.live ? ' on' : ''}"></i><h2>${esc(s.title)}</h2>${s.live ? '<span class="au-state live"><i></i>En cours</span>' : ''}</div>
    <p class="ss-meta">${s.branch ? `${icon('pr')}${esc(s.branch)} · ` : ''}${esc(s.models.map(model).join(', '))} · ${h ? `${h} h ` : ''}${mn} min · ${s.prompts} demande${s.prompts > 1 ? 's' : ''}</p>
    <div class="ss-totals"><div><strong>${usage.fmt(s.tokens.output)}</strong><span>tokens écrits</span></div><div><strong>${usage.fmt(s.tokens.input + s.tokens.cacheWrite)}</strong><span>tokens lus</span></div><div><strong>${usage.fmt(s.tokens.cacheRead)}</strong><span>relus du cache</span></div><div><strong>${Object.values(s.tools).reduce((a, b) => a + b, 0)}</strong><span>actions</span></div></div>
    <div class="ss-actions"><button class="btn" data-pj="review-branch">${icon('sparkle')}Revue IA de la branche</button><button class="btn" data-pj="review-working">${icon('sparkle')}Revue des changements en cours</button><button class="btn" data-pj="vscode">${icon('code')}Ouvrir dans VS Code</button></div>
    ${s.files.length ? `<h3 class="ss-h">Fichiers modifiés <span>${s.files.length}</span></h3><div class="ss-files">${s.files.map(f => `<code>${esc(short(f, root))}</code>`).join('')}</div>` : ''}
    <h3 class="ss-h">Fil de la session <span>les ${s.actions.length} dernières étapes</span></h3>
    <div class="ss-feed">${s.actions.slice().reverse().map(a => { const [c, who] = kind(a.kind); return `<div class="ss-step ${c}"><span class="ss-who">${c === 'tool' ? icon('bolt') : ''}${esc(who ?? '')}</span><p>${esc(c === 'tool' ? short(a.text, root) : a.text)}</p><time>${esc(rel(ms(a.at)))}</time></div>`; }).join('')}</div></div>`;
}

/** Dessine l'onglet et le garde à jour toutes les 3 secondes tant qu'il est affiché. */
export function mount(box: HTMLElement, p: Project, folder: string | null): void {
  clearInterval(timer);
  if (!native.available()) { box.innerHTML = '<p class="hm-empty">Les sessions Claude Code se lisent sur ton Mac : ouvre ce projet dans l’app Studio pour Mac.</p>'; return; }
  if (!folder) { box.innerHTML = `<p class="hm-empty">Choisis d’abord le dossier du projet : ses sessions Claude Code apparaîtront ici.</p><button class="btn btn-primary" data-pj="pick">Choisir le dossier</button>`; return; }
  const paint = async () => {
    if (!box.isConnected) { clearInterval(timer); return; }
    if (selected) {
      const d = await native.call('project', 'session', { project: p.id, session: selected }, 20000);
      if (box.isConnected && d.ok) box.innerHTML = detailHTML(d as unknown as Session & { actions: Action[] }, folder);
      else if (!d.ok) { selected = null; void paint(); }
      return;
    }
    const r = await native.call('project', 'sessions', { project: p.id }, 20000);
    if (!box.isConnected) return;
    if (!r.found) { box.innerHTML = '<p class="hm-empty">Aucune session Claude Code n’a encore été lancée dans ce dossier.</p>'; return; }
    box.innerHTML = listHTML((r.sessions as Session[]) ?? [], (r.quota as Quota | null) ?? null);
  };
  box.onclick = e => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('[data-ss]'); if (!row) return;
    selected = row.dataset.ss || null; box.innerHTML = '<p class="hm-empty">Chargement…</p>'; void paint();
  };
  void paint();
  timer = setInterval(() => { if (!document.hidden) void paint(); }, 3000);
}
export const stop = (): void => { clearInterval(timer); };
export const select = (id: string | null): void => { selected = id; };
