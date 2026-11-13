// Nouveautés : ce qui change dans Studio, présenté une nouveauté après l'autre.
//   - après une mise à jour (ou à la première ouverture d'une version qui en apporte), un carrousel
//     montre la version installée puis chaque nouveauté pas encore vue ;
//   - sur Mac, quand une nouvelle version est téléchargée et vérifiée, une fenêtre propose de relancer.
//
// Ajouter une nouveauté : une entrée en tête de NEWS (identifiant stable, jamais réutilisé). Elle sera
// montrée une fois à chaque personne, puis reste consultable depuis le menu Studio → Nouveautés.
import * as update from '../core/update.ts';
import { esc } from '../lib/markdown.ts';
import { icon, modal, need, toast, topLayer, target } from '../ui/kit.ts';
import type { Installed } from '../core/update.ts';
import type { ViewState } from '../types.ts';

/** Ce que les nouveautés attendent de l'application. */
export interface NewsApi {
  setView(v: ViewState): Promise<void>;
  flushAll(): Promise<void>;
  /** Toute première ouverture de Studio sur cet appareil : rien n'est « nouveau » pour cette personne. */
  firstRun: boolean;
}

interface Item {
  id: string;
  /** Date de sortie, AAAA-MM-JJ. */
  date: string;
  title: string;
  text: string;
  icon: string;
  /** Teinte de l'illustration (une des couleurs --c-… de la feuille de style). */
  hue: string;
  /** Trois mots-clés au plus, affichés en pastilles dans l'illustration. */
  points?: string[];
  /** Ne concerne que l'app Mac. */
  mac?: boolean;
  /** Raccourci vers la fonction présentée. */
  go?: { label: string; view: ViewState };
}

// Les plus récentes d'abord.
const NEWS: Item[] = [
  { id: 'auto-update', date: '2026-11-14', mac: true, icon: 'download', hue: 'blue',
    title: 'Studio se met à jour tout seul',
    text: 'Une nouvelle version est téléchargée et vérifiée en arrière-plan. Elle s’installe quand tu relances Studio, ou toute seule quand tu le quittes : tu n’as plus rien à faire.',
    points: ['Téléchargée', 'Vérifiée', 'Installée'],
    go: { label: 'Réglages des mises à jour', view: { type: 'settings', tab: 'maj' } } },
  { id: 'whats-new', date: '2026-11-14', icon: 'bolt', hue: 'orange',
    title: 'Les nouveautés, une à une',
    text: 'À chaque version, Studio te montre ce qui change, ici même. Pour les revoir plus tard : menu Studio, en haut de la barre latérale, puis Nouveautés.',
    points: ['À chaque version', 'En images', 'Toujours consultables'] },
  { id: 'subagent-threads', date: '2026-11-13', mac: true, icon: 'bot', hue: 'violet',
    title: 'Les sous-agents ont leur fil',
    text: 'Les tâches que Claude délègue pendant une conversation apparaissent dans son en-tête. Un clic ouvre le fil du sous-agent, et Épingler le garde dans la barre latérale, sous sa conversation.',
    points: ['Fil du sous-agent', 'Fil d’Ariane', 'Épingler'],
    go: { label: 'Ouvrir les projets', view: { type: 'projets' } } },
  { id: 'queued-messages', date: '2026-11-12', mac: true, icon: 'list', hue: 'teal',
    title: 'Écris pendant que l’agent travaille',
    text: 'Tes messages s’affichent « en attente » dans le fil et lui sont remis ensemble dès qu’il a fini son tour. Studio ne coupe jamais l’agent en plein travail.',
    points: ['En attente', 'Remis ensemble', 'Dans l’ordre'] },
  { id: 'reuse-worktrees', date: '2026-11-12', mac: true, icon: 'pr', hue: 'green',
    title: 'Une discussion, plusieurs branches',
    text: 'Une copie déjà fusionnée n’est plus reproposée à la publication : elle repart d’elle-même de la dernière version de la branche principale, sur une nouvelle branche.',
    points: ['Fusion reconnue', 'Nouvelle branche', 'Même discussion'] },
];

const SEEN = 'studio.news.seen', MAX_AUTO = 5;
let api!: NewsApi;

const applicable = (): Item[] => NEWS.filter(n => !n.mac || update.supported());
function seen(): string[] | null {
  try { const v = JSON.parse(localStorage.getItem(SEEN) || 'null') as unknown; return Array.isArray(v) ? v.map(String) : null; } catch { return null; }
}
function markSeen(items: Item[]): void {
  const ids = new Set([...(seen() ?? []), ...items.map(n => n.id)]);
  try { localStorage.setItem(SEEN, JSON.stringify([...ids])); } catch { /* stockage indisponible */ }
}
/** Nouveautés pas encore montrées sur cet appareil. */
function unseen(): Item[] { const s = new Set(seen() ?? []); return applicable().filter(n => !s.has(n.id)); }

// ---------- Notes de version (Releases GitHub) ----------
export interface Change { kind: 'new' | 'fix' | 'better'; text: string }
const KIND_LABEL: Record<Change['kind'], string> = { new: 'Nouveau', fix: 'Corrigé', better: 'Amélioré' };
const INTERNAL = new Set(['chore', 'ci', 'build', 'test', 'docs', 'style']);

/** Lit les notes d'une Release (liste « * feat(agents): … by @x in … ») et n'en garde que ce qui parle à l'utilisateur. */
export function changes(notes: string): Change[] {
  const out: Change[] = [];
  for (const raw of notes.split('\n')) {
    const line = (/^\s*[*-]\s+(.+)$/.exec(raw)?.[1] ?? '')
      .replace(/\s+by\s+@\S+\s+in\s+https?:\/\/\S+\s*$/i, '').replace(/\s*\(#\d+\)\s*$/, '').trim();
    if (!line || /^bump\b/i.test(line) || /made their first contribution/i.test(line)) continue;
    const c = /^(feat|fix|perf|refactor|revert|chore|ci|build|test|docs|style)(?:\([^)]*\))?!?:\s*(.+)$/i.exec(line);
    const type = (c?.[1] ?? '').toLowerCase();
    if (INTERNAL.has(type)) continue;
    const text = (c?.[2] ?? line).trim();
    out.push({ kind: type === 'feat' ? 'new' : type === 'fix' ? 'fix' : 'better', text: text.charAt(0).toUpperCase() + text.slice(1) });
  }
  return out;
}
/** Liste lisible des changements d'une version ; vide si les notes n'en contiennent pas. */
export function changeList(notes: string, max = 6): string {
  const all = changes(notes);
  if (!all.length) return '';
  return `<ul class="wn-list">${all.slice(0, max).map(c => `<li><span class="wn-kind ${c.kind}">${KIND_LABEL[c.kind]}</span><span>${esc(c.text)}</span></li>`).join('')}${all.length > max ? `<li class="wn-more">et ${all.length - max} autre${all.length - max > 1 ? 's' : ''}</li>` : ''}</ul>`;
}

// ---------- Fenêtres ----------
/** Ouvre une fenêtre dès que rien d'autre n'est ouvert et que Studio est à l'écran. */
function whenFree(run: () => void, delay: number): void {
  const attempt = (): void => { if (topLayer() || document.hidden) setTimeout(attempt, 3000); else run(); };
  setTimeout(attempt, delay);
}

const day = (iso: string): string => { const d = new Date(`${iso}T12:00:00`); return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' }); };
/** Illustration d'une diapositive : une icône sur un fond teinté, entourée de ses mots-clés. */
const hero = (ic: string, hue: string, points: string[] = []): string =>
  `<div class="wn-hero" style="--c:var(--c-${esc(hue)})" aria-hidden="true"><i class="wn-orb"></i><i class="wn-orb b"></i><span class="wn-badge">${icon(ic)}</span>${points.length ? `<div class="wn-chips">${points.slice(0, 3).map((p, i) => `<span style="--i:${i}">${esc(p)}</span>`).join('')}</div>` : ''}</div>`;

interface Slide { hero: string; kicker: string; title: string; body: string; go?: Item['go'] }
const itemSlide = (n: Item): Slide => ({ hero: hero(n.icon, n.hue, n.points), kicker: `Nouveau${day(n.date) ? ` · ${day(n.date)}` : ''}`, title: n.title, body: `<p>${esc(n.text)}</p>`, ...(n.go ? { go: n.go } : {}) });
function installedSlide(v: Installed): Slide {
  const list = changeList(v.notes);
  const page = v.page.startsWith('https://github.com/') ? `<p class="wn-link"><a href="${esc(v.page)}" target="_blank" rel="noopener">Voir le détail sur GitHub</a></p>` : '';
  return { hero: hero('check', 'green', ['Installée', 'Vérifiée', 'À jour']), kicker: 'Mise à jour installée', title: `Studio ${v.tag}`,
    body: (list ? `<p>Studio vient de se mettre à jour. Voici ce qui change :</p>${list}` : '<p>Studio vient de se mettre à jour. Tes notes et tes réglages n’ont pas bougé.</p>') + page };
}

/** Carrousel : une diapositive à la fois, points de progression, flèches du clavier. */
function carousel(slides: Slide[]): void {
  if (!slides.length) return;
  let at = 0;
  const m = modal({ cls: 'wn', html: '<div class="wn-stage"></div><footer class="wn-foot"><div class="wn-dots"></div><button class="btn btn-ghost" data-wn="prev">Précédent</button><button class="btn btn-primary" data-wn="next" autofocus></button></footer>' });
  const stage = need('.wn-stage', m.body), dots = need('.wn-dots', m.body), prev = need<HTMLButtonElement>('[data-wn="prev"]', m.body), next = need<HTMLButtonElement>('[data-wn="next"]', m.body);
  const show = (i: number, dir: 1 | -1 | 0): void => {
    const s = slides[i]; if (!s) return;
    at = i;
    stage.innerHTML = `<section class="wn-slide${dir > 0 ? ' fwd' : dir < 0 ? ' back' : ''}" aria-live="polite">${s.hero}<div class="wn-text"><p class="wn-kicker">${esc(s.kicker)}</p><h3>${esc(s.title)}</h3>${s.body}${s.go ? `<p class="wn-link"><button class="link-btn" data-wn="go">${esc(s.go.label)}</button></p>` : ''}</div></section>`;
    dots.innerHTML = slides.length > 1 ? slides.map((_, k) => `<button class="wn-dot${k === i ? ' on' : ''}" data-wn-at="${k}" aria-label="Nouveauté ${k + 1} sur ${slides.length}"${k === i ? ' aria-current="true"' : ''}></button>`).join('') : '';
    prev.hidden = i === 0;
    next.textContent = i === slides.length - 1 ? (slides.length > 1 ? 'C’est parti' : 'Compris') : 'Suivant';
  };
  const step = (d: 1 | -1): void => {
    if (d > 0 && at === slides.length - 1) { m.close(); return; }
    if (at + d >= 0) show(at + d, d);
  };
  m.node.addEventListener('click', e => {
    const b = target(e).closest('[data-wn], [data-wn-at]'); if (!b) return;
    if (b.dataset.wnAt !== undefined) { const k = Number(b.dataset.wnAt); if (k !== at) show(k, k > at ? 1 : -1); return; }
    if (b.dataset.wn === 'next') step(1);
    else if (b.dataset.wn === 'prev') step(-1);
    else if (b.dataset.wn === 'go') { const go = slides[at]?.go; m.close(); if (go) void api.setView(go.view); }
  });
  m.node.addEventListener('keydown', e => {
    if (e.key === 'ArrowRight') { e.preventDefault(); if (at < slides.length - 1) step(1); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
  });
  show(0, 0);
}

/** Toutes les nouveautés, à la demande (menu Studio → Nouveautés). */
export function open(): void {
  const all = applicable();
  markSeen(all);
  carousel(all.map(itemSlide));
}

/** Une nouvelle version est prête : relancer maintenant, ou la laisser s'installer à la fermeture. */
function promptReady(): void {
  const s = update.current(); if (!s) return;
  const list = changeList(s.notes ?? '', 5);
  const m = modal({ cls: 'wn', html: `<section class="wn-slide">${hero('download', 'blue', ['Téléchargée', 'Vérifiée', 'Prête'])}<div class="wn-text"><p class="wn-kicker">Mise à jour prête</p><h3>Studio ${esc(s.tag ?? '')}</h3>
      <p>La nouvelle version est déjà téléchargée et vérifiée. Relance Studio pour l’utiliser : tes notes sont enregistrées avant, et l’app se rouvre en quelques secondes.</p>${list}
      <p class="wn-hint">Plus tard, elle s’installera toute seule quand tu quitteras Studio. Si un agent Claude Code travaille en ce moment, laisse-le d’abord finir.</p></div></section>
    <footer class="wn-foot"><span class="wn-dots"></span><button class="btn btn-ghost" data-wn="later">Plus tard</button><button class="btn btn-primary" data-wn="restart" autofocus>${icon('refresh')}Relancer maintenant</button></footer>` });
  const restart = need<HTMLButtonElement>('[data-wn="restart"]', m.body), later = need<HTMLButtonElement>('[data-wn="later"]', m.body);
  later.onclick = () => m.close();
  restart.onclick = async () => {
    restart.disabled = later.disabled = true;
    restart.innerHTML = '<span class="spin"></span>Installation…';
    await api.flushAll();
    const r = await update.install();
    if (r.ok && r.restarting) return; // l'app se ferme et se rouvre
    m.close();
    toast(r.ok ? 'Mise à jour installée : quitte puis rouvre Studio.' : r.message ?? 'Mise à jour impossible.');
  };
}

export function init(a: NewsApi): void {
  api = a;
  // Mise à jour prête : on le propose une fois par version.
  let prompted = '';
  update.onChange(() => {
    const tag = update.current()?.tag ?? '';
    if (!update.ready() || update.working() || !tag || tag === prompted) return;
    prompted = tag;
    whenFree(() => { if (update.ready() && !update.working()) promptReady(); }, 600);
  });
  // Première ouverture de Studio : tout est nouveau, rien n'est à annoncer.
  if (a.firstRun) { markSeen(NEWS); return; }
  if (__TEST__) return; // les tests automatisés démarrent sans fenêtre ouverte
  void update.justInstalled().then(done => {
    const fresh = unseen().slice(0, MAX_AUTO);
    if (!done && !fresh.length) return;
    whenFree(() => {
      markSeen(applicable());
      carousel([...(done ? [installedSlide(done)] : []), ...fresh.map(itemSlide)]);
    }, 900);
  });
}
