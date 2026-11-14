// Notifications Linear dans Studio. Aucun serveur : l'app interroge api.linear.app toutes les minutes
// tant qu'elle est ouverte, avec la clé du coffre. Rien n'est écrit sur le disque, sauf l'heure du dernier passage.
import * as linear from './api.ts';
import * as vault from '../../core/vault.ts';
import * as events from '../../core/events.ts';
import { esc } from '../../lib/markdown.ts';
import { $, icon, toast, rel, need, target, errMsg, avatar } from '../../ui/kit.ts';
import type { AppShell } from '../../types.ts';

const EVERY = 60e3, SEEN = 'carnet.linear.seen', PREF = 'carnet.linear.notify';
let app!: AppShell, items: linear.Notification[] = [], error = '', loaded = false, busy = false;
let timer: ReturnType<typeof setInterval> | undefined;

const native = () => window.webkit?.messageHandlers?.carnet;
export const systemOn = (): boolean => localStorage.getItem(PREF) !== '0';
export const setSystem = (on: boolean): void => localStorage.setItem(PREF, on ? '1' : '0');
// Dans un navigateur, il faut l'autorisation du site ; dans l'app native, le système la demande lui-même.
export const systemState = (): NotificationPermission | 'native' | 'absent' => native() ? 'native' : !('Notification' in window) ? 'absent' : Notification.permission;
export const askPermission = async (): Promise<NotificationPermission> => ('Notification' in window ? Notification.requestPermission() : 'denied');

export const unreadCount = (): number => items.filter(n => !n.readAt).length;
/** Projet Linear d'une notification ('' : aucun, elle n'entre dans aucun périmètre de l'IA). */
const projectOf = (n: linear.Notification): string => n.issue?.project?.id ?? n.project?.id ?? '';
export const latest = (n = 4) => items.slice(0, n).map(x => ({ at: x.createdAt, text: headline(x), issue: x.issue?.identifier || '', unread: !x.readAt, project: projectOf(x) }));
export const active = (): boolean => vault.isOpen() && linear.connected();

const TYPES: [RegExp, string][] = [
  [/assignedtoyou/i, 't’a assigné'], [/unassigned/i, 't’a retiré de'], [/commentmention|issuemention|mention/i, 't’a mentionné dans'],
  [/commentreaction|emojireaction|reaction/i, 'a réagi dans'], [/newcomment|comment/i, 'a commenté'], [/statuschanged/i, 'a changé l’état de'],
  [/priority/i, 'a passé en urgent'], [/due/i, 'Échéance proche :'], [/blocking|blocked/i, 'Blocage sur'], [/created/i, 'a créé'],
  [/subscribed/i, 't’a abonné à'], [/reminder/i, 'Rappel :'], [/sla/i, 'SLA :'], [/projectupdate/i, 'a publié un point sur'], [/added/i, 't’a ajouté à'],
];
const verb = (t: string) => TYPES.find(([re]) => re.test(t))?.[1] || t.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
const who = (n: linear.Notification) => n.actor?.displayName || n.actor?.name || 'Linear';
const subject = (n: linear.Notification) => n.issue ? `${n.issue.identifier} ${n.issue.title}` : n.project?.name || '';
const link = (n: linear.Notification) => n.issue?.url || n.project?.url || '';
const safe = (u: string) => /^https:\/\/linear\.app\//.test(u) ? u : '';
const excerpt = (n: linear.Notification) => (n.comment?.body || '').replace(/[#*_`>\[\]()!]/g, '').replace(/\s+/g, ' ').trim().slice(0, 160);
const headline = (n: linear.Notification) => { const v = verb(n.type); return /:$/.test(v) ? `${v} ${subject(n)}` : `${who(n)} ${v} ${subject(n)}`; };

function badge(): void {
  const c = unreadCount();
  native()?.postMessage({ type: 'badge', count: c });
  try { void (c ? navigator.setAppBadge?.(c) : navigator.clearAppBadge?.()); } catch { /* non pris en charge */ }
}

function announce(fresh: linear.Notification[]): void {
  if (!fresh.length) return;
  const one = fresh.length === 1 ? fresh[0] : null;
  const title = one ? headline(one) : `${fresh.length} nouvelles notifications Linear`;
  const body = one ? excerpt(one) : fresh.slice(0, 3).map(subject).join(' · ');
  const away = document.hidden || !document.hasFocus();
  if (away && systemOn()) {
    const nb = native();
    if (nb) { nb.postMessage({ type: 'notify', title, body, url: one ? safe(link(one)) : '' }); return; }
    if (systemState() === 'granted') {
      const n = new Notification(title, { body, tag: 'carnet-linear', icon: 'icons/icon-192.png' });
      n.onclick = () => { window.focus(); void app.setView({ type: 'linear', tab: 'notifs' }); n.close(); };
      return;
    }
  }
  if (app.view() !== 'linear') toast(title, { label: 'Voir', run: () => app.setView({ type: 'linear', tab: 'notifs' }) });
}

export async function poll({ quiet = true } = {}): Promise<void> {
  if (!active() || busy) return;
  busy = true;
  try {
    const before = unreadCount();
    items = await linear.notifications(); error = '';
    const last = localStorage.getItem(SEEN), newest = items[0]?.createdAt;
    // Premier passage : on prend l'état actuel comme point de départ, sans rien annoncer.
    const fresh = last ? items.filter(n => !n.readAt && n.createdAt > last) : [];
    announce(fresh);
    // Un événement par projet Linear : une automatisation ne reçoit que les notifications de son projet.
    const byProject = new Map<string, linear.Notification[]>();
    for (const n of fresh) { const id = projectOf(n), l = byProject.get(id); if (l) l.push(n); else byProject.set(id, [n]); }
    for (const [id, list] of byProject) events.emit('linear', list.map(n => `- ${headline(n)}${excerpt(n) ? ` : « ${excerpt(n)} »` : ''}${n.issue ? ` (${n.issue.url})` : ''}`).join('\n'), { linearProject: id });
    if (newest && (!last || newest > last)) localStorage.setItem(SEEN, newest);
    loaded = true; badge();
    if (before !== unreadCount()) app.renderSidebar();
  } catch (e) { error = errMsg(e); if (!quiet) toast('Linear : ' + errMsg(e)); }
  busy = false;
  refresh();
}

export function init(shell: AppShell): void {
  app = shell;
  clearInterval(timer);
  timer = setInterval(() => void poll(), EVERY);
  addEventListener('focus', () => { if (active()) void poll(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void poll(); });
  vault.onChange(() => { if (!active()) { items = []; loaded = false; badge(); } else if (!loaded) void poll(); });
  void poll();
}

async function read(ids: string[]): Promise<void> {
  const at = new Date().toISOString();
  for (const n of items) if (ids.includes(n.id)) n.readAt = n.readAt || at;
  badge(); refresh(); app.renderSidebar();
  try { await linear.markRead(ids, at); } catch (e) { toast('Linear : ' + errMsg(e)); void poll(); }
}

const row = (n: linear.Notification) => `<div class="nf-row${n.readAt ? ' read' : ''}" data-id="${esc(n.id)}" data-url="${esc(safe(link(n)))}" data-issue="${esc(n.issue?.identifier || '')}" role="link" tabindex="0">
  <i class="nf-dot"></i>${avatar(who(n))}
  <div class="nf-body"><div class="nf-line"><span class="nf-who">${esc(/:$/.test(verb(n.type)) ? '' : who(n))}</span> ${esc(verb(n.type))} <strong>${esc(n.issue ? n.issue.identifier : subject(n))}</strong> ${esc(n.issue?.title || '')}</div>
  ${excerpt(n) ? `<div class="nf-quote">${esc(excerpt(n))}</div>` : ''}</div>
  <span class="nf-time">${esc(rel(Date.parse(n.createdAt)))}</span>
  ${n.readAt ? '' : `<button class="icon-btn nf-read" data-nf-read title="Marquer comme lue" aria-label="Marquer comme lue">${icon('check')}</button>`}
</div>`;

function body(): string {
  if (!vault.enabled() || !linear.connected()) return `<div class="nf-empty"><p>Connecte Linear pour recevoir ici tes notifications : assignations, mentions, commentaires, changements d’état.</p><button class="btn btn-primary" data-open-conn="linear">Connecter Linear</button></div>`;
  if (error && !items.length) return `<p class="nf-empty">Linear ne répond pas : ${esc(error)}</p>`;
  if (!loaded) return '<p class="nf-empty">Chargement…</p>';
  if (!items.length) return '<p class="nf-empty">Aucune notification. Tu es à jour.</p>';
  const un = items.filter(n => !n.readAt), rd = items.filter(n => n.readAt);
  const sec = (t: string, l: linear.Notification[]) => l.length ? `<section class="td-sec"><h2>${t}<span>${l.length}</span></h2>${l.map(row).join('')}</section>` : '';
  return sec('Non lues', un) + sec('Lues', rd.slice(0, 30));
}

export function refresh(): void {
  const root = $('.notifs'); if (!root) return;
  need('.nf-list', root).innerHTML = body();
  const c = unreadCount();
  need('.nf-sub', root).textContent = !active() ? '' : c ? `${c} non lue${c > 1 ? 's' : ''} · actualisé toutes les minutes` : 'Actualisé toutes les minutes tant que Studio est ouverte';
  need('[data-nf-all]', root).hidden = !c;
  app.onCount?.();
}

// La liste s'insère dans la page Linear (onglet Notifications).
export function mountInto(box: HTMLElement): void {
  box.innerHTML = `<div class="notifs"><div class="nf-bar"><p class="nf-sub"></p><button class="btn" data-nf-all hidden>Tout marquer comme lu</button></div><div class="nf-list"></div></div>`;
  const root = need('.notifs', box);
  const open = (r: HTMLElement) => {
    const { issue, url, id } = r.dataset;
    if (issue) void import('./page.ts').then(m => m.openTicket(issue)); else if (url) window.open(url, '_blank', 'noopener');
    if (!r.classList.contains('read') && id) void read([id]);
  };
  root.addEventListener('click', e => {
    if (target(e).closest('[data-nf-all]')) { void read(items.filter(n => !n.readAt).map(n => n.id)); return; }
    const r = target(e).closest('.nf-row'); if (!r) return;
    if (target(e).closest('[data-nf-read]')) { if (r.dataset.id) void read([r.dataset.id]); return; }
    open(r);
  });
  root.addEventListener('keydown', e => { const r = target(e).closest('.nf-row'); if (r && e.target === r && e.key === 'Enter') open(r); });
  refresh();
  void poll();
}
