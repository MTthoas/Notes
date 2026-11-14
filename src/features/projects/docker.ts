// Docker sur ce Mac, en lecture seule : conteneurs (en cours, arrêtés) et images, rattachés aux projets.
// L'app Mac lit le moteur Docker par sa socket et reconnaît les conteneurs d'un projet à leur dossier (Compose,
// devcontainer, dossiers montés), y compris ceux lancés dans la copie isolée d'un agent : voir native/Shared/Docker.swift.
// Affiché dans l'onglet Docker d'un projet, sa vue d'ensemble, et l'accueil. Rien ne se lance ni ne s'arrête d'ici.
import * as native from '../../core/native.ts';
import * as model from './model.ts';
import { esc } from '../../lib/markdown.ts';
import { $, icon, rel } from '../../ui/kit.ts';
import type { Project } from './model.ts';

export interface Port { public: number; private: number; type: string }
export interface Container {
  id: string; name: string; image: string; state: string; status: string; created: number; ports: Port[];
  /** Projet et service Compose, s'il y en a. */ compose: string; service: string;
  /** Dossier de travail (Compose ou devcontainer), « ~ » pour le dossier personnel. */ folder: string;
  /** Copie isolée d'un agent (.claude/worktrees/<nom>) d'où il a été lancé. */ worktree: string;
  /** Projets Studio auxquels il appartient. */ projects: string[];
}
export interface Image { id: string; tags: string[]; size: number; created: number; containers: number; compose: string; service: string; projects: string[] }
export interface Status { available: boolean; reason?: string; engine?: { name: string; version: string }; containers: Container[]; images: Image[] }

/** Seule l'app Mac lit Docker (un appareil lié n'y a pas accès : « docker.status » n'est pas dans REMOTE_ALLOWED). */
export const supported = (): boolean => native.available() && document.documentElement.dataset.native === 'mac';

let cache: { at: number; st: Status } | null = null, pending: Promise<Status | null> | null = null;
/** État de Docker, relu au plus toutes les 3 secondes (plusieurs vues le demandent en même temps). */
export async function status(fresh = false): Promise<Status | null> {
  if (!supported()) return null;
  if (!fresh && cache && Date.now() - cache.at < 3000) return cache.st;
  pending ??= native.call('docker', 'status', { projects: model.projects().map(p => p.id) }, 15000).then(r => {
    if (!r.ok) return null;
    const st: Status = { available: r.available === true, reason: typeof r.reason === 'string' ? r.reason : undefined,
      engine: r.engine as Status['engine'], containers: (r.containers as Container[] | undefined) ?? [], images: (r.images as Image[] | undefined) ?? [] };
    cache = { at: Date.now(), st };
    return st;
  }).finally(() => { pending = null; });
  return pending;
}

const running = (c: Container): boolean => c.state === 'running';
const order = (a: Container, b: Container): number => Number(running(b)) - Number(running(a)) || b.created - a.created;
export const ofProject = (st: Status, p: Project): { containers: Container[]; images: Image[] } =>
  ({ containers: st.containers.filter(c => c.projects.includes(p.id)).sort(order), images: st.images.filter(i => i.projects.includes(p.id)) });

// ---------- Formats ----------
const dec = (n: number): string => n.toFixed(1).replace('.', ',').replace(/,0$/, '');
export const size = (n: number): string => n >= 1e9 ? `${dec(n / 1e9)} Go` : n >= 1e6 ? `${Math.round(n / 1e6)} Mo` : `${Math.max(1, Math.round(n / 1e3))} Ko`;
const UNITS: [RegExp, string][] = [[/^about an? hour$/i, 'environ 1 h'], [/^about a minute$/i, 'environ 1 min'], [/^less than a second$/i, 'moins d’1 s'],
  [/^(\d+) seconds?$/i, '$1 s'], [/^(\d+) minutes?$/i, '$1 min'], [/^(\d+) hours?$/i, '$1 h'], [/^(\d+) days?$/i, '$1 j'], [/^(\d+) weeks?$/i, '$1 sem.'], [/^(\d+) months?$/i, '$1 mois'], [/^(\d+) years?$/i, '$1 an(s)']];
const span = (s: string): string => { const t = s.trim(); for (const [re, fr] of UNITS) if (re.test(t)) return t.replace(re, fr); return t; };
/** L'état que donne Docker (« Up 2 hours (healthy) », « Exited (0) 3 days ago »…), en français. */
export function statusText(c: Container): string {
  const s = c.status.trim(), health = /\(healthy\)/i.test(s) ? ' · sain' : /\(unhealthy\)/i.test(s) ? ' · en mauvaise santé' : /\(health: starting\)/i.test(s) ? ' · vérification…' : '';
  let m = s.match(/^Up (.+?)(?: \((?:healthy|unhealthy|health: starting|Paused)\))*$/i);
  if (m) return `${c.state === 'paused' ? 'En pause' : 'En cours'} depuis ${span(m[1] ?? '')}${health}`;
  m = s.match(/^Exited \((-?\d+)\) (.+) ago$/i);
  if (m) return `Arrêté${m[1] === '0' ? '' : ` (code ${m[1]})`} il y a ${span(m[2] ?? '')}`;
  m = s.match(/^Restarting \((-?\d+)\)/i);
  if (m) return `Redémarre en boucle (code ${m[1]})`;
  if (/^Created$/i.test(s)) return 'Créé, jamais lancé';
  if (/^Removal In Progress$/i.test(s)) return 'Suppression…';
  if (/^Dead$/i.test(s)) return 'Hors d’usage';
  return s || c.state;
}
const dot = (c: Container): string => `<i class="dk-dot ${running(c) ? 'up' : c.state === 'paused' || c.state === 'restarting' ? 'warn' : c.state === 'dead' || /^Exited \((?!0\))/i.test(c.status) ? 'down' : ''}"></i>`;
/** Ports publiés : une adresse locale cliquable pour ceux en TCP d'un conteneur en cours. */
function ports(c: Container): string {
  return c.ports.map(p => running(c) && p.type === 'tcp' && p.public > 0 && p.public < 65536
    ? `<a class="dk-port" href="http://localhost:${p.public}/" target="_blank" rel="noopener" title="Port ${p.private} du conteneur">:${p.public}</a>`
    : `<span class="dk-port" title="Port ${p.private} du conteneur">:${p.public}${p.type === 'tcp' ? '' : `/${esc(p.type)}`}</span>`).join('');
}

// ---------- Vues ----------
function unavailable(st: Status | null): string {
  if (!supported()) return '<p class="hm-empty">Les conteneurs Docker se lisent depuis l’app Studio pour Mac, là où ils tournent.</p>';
  if (!st) return '<p class="hm-empty">Docker n’a pas répondu.</p>';
  return st.reason === 'stopped'
    ? `<p class="hm-empty">Docker est installé mais son moteur ne tourne pas : ouvre Docker Desktop (ou OrbStack, Colima…).</p>`
    : `<p class="hm-empty">Docker est introuvable sur ce Mac : aucun moteur ne répond (Docker Desktop, OrbStack, Colima, Rancher Desktop).</p>`;
}

function containerRow(c: Container, { project = false } = {}): string {
  const owner = project ? '' : c.projects.map(id => model.byId(id)).filter(Boolean).map(p => `<button class="dk-proj" data-dk-project="${esc(p!.id)}" style="--c:var(--c-${p!.hue})">${esc(p!.name)}</button>`).join('');
  const agent = c.worktree ? `<em class="pj-badge pending dk-agent" title="Lancé depuis la copie isolée d’un agent : ${esc(c.folder)}">${icon('terminal')}agent</em>` : '';
  return `<div class="dk-row">${dot(c)}<div class="dk-main"><span class="dk-name"><strong title="${esc(c.name)}">${esc(c.service || c.name)}</strong>${agent}${owner}</span>
      <span class="dk-sub"><code>${esc(c.image)}</code> · ${esc(statusText(c))}</span></div><span class="dk-ports">${ports(c)}</span></div>`;
}

function imageRow(i: Image): string {
  const name = i.tags[0] ?? `<sans nom> ${i.id}`;
  const what = [i.tags.length > 1 ? esc(i.tags.slice(1).join(', ')) : '', i.compose ? `construite par Compose${i.service ? ` (service ${esc(i.service)})` : ''}` : '', i.created ? esc(rel(i.created * 1000)) : ''].filter(Boolean).join(' · ');
  return `<div class="dk-row"><i class="dk-ic">${icon('box')}</i><div class="dk-main"><span class="dk-name"><strong>${esc(name)}</strong></span>
      <span class="dk-sub">${what || `<code>${esc(i.id)}</code>`}</span></div><span class="dk-size">${esc(size(i.size))}</span></div>`;
}

/** Contenu de l'onglet Docker d'un projet. */
export function projectHTML(p: Project, st: Status | null, folder: string | null): string {
  if (!st?.available) return unavailable(st);
  const { containers, images } = ofProject(st, p), up = containers.filter(running).length;
  const engine = st.engine ? `<p class="dk-engine">${icon('box')}${esc(st.engine.name || 'Docker')}${st.engine.version ? ` · moteur ${esc(st.engine.version)}` : ''}<button class="link-btn" data-dk="refresh">${icon('refresh')}Actualiser</button></p>` : '';
  const how = folder
    ? `Studio reconnaît les conteneurs de ce projet quand ils sont lancés par Docker Compose ou un devcontainer depuis son dossier (ou la copie d’un agent), ou qu’ils en montent un dossier.`
    : `Choisis d’abord le dossier du projet sur ce Mac (onglet Vue d’ensemble) : c’est à lui que Studio reconnaît ses conteneurs.`;
  return `${engine}
    <section class="pj-sec"><h2>${icon('box')}Conteneurs <span class="dk-count">${containers.length ? `${up} en cours sur ${containers.length}` : ''}</span></h2><div class="pj-sec-body">
      ${containers.length ? containers.map(c => containerRow(c, { project: true })).join('') : `<p class="hm-empty">Aucun conteneur pour ce projet. ${how}</p>`}</div></section>
    <section class="pj-sec"><h2>${icon('download')}Images <span class="dk-count">${images.length ? `${images.length} · ${esc(size(images.reduce((s, i) => s + i.size, 0)))}` : ''}</span></h2><div class="pj-sec-body">
      ${images.length ? images.map(imageRow).join('') : '<p class="hm-empty">Aucune image construite ou utilisée par ce projet.</p>'}</div></section>`;
}

/** Résumé pour la carte Docker de la vue d'ensemble d'un projet. */
export function overviewText(p: Project, st: Status | null): string {
  if (!st?.available) return st?.reason === 'stopped' ? 'Docker ne tourne pas' : 'Docker introuvable sur ce Mac';
  const { containers, images } = ofProject(st, p), up = containers.filter(running).length;
  if (!containers.length) return images.length ? `${images.length} image${images.length > 1 ? 's' : ''} · aucun conteneur` : 'Aucun conteneur pour ce projet';
  return `${up ? `<span class="ok">${up} en cours</span>` : 'Aucun en cours'}${containers.length > up ? ` · ${containers.length - up} arrêté${containers.length - up > 1 ? 's' : ''}` : ''} · ${images.length} image${images.length > 1 ? 's' : ''}`;
}

/** Bloc de l'accueil : les conteneurs en cours sur ce Mac, avec leur projet. Vide si Docker n'est pas là. */
export function homeHTML(st: Status | null): { body: string; meta: string } | null {
  if (!st?.available) return null;
  const up = st.containers.filter(running).sort((a, b) => Number(b.projects.length > 0) - Number(a.projects.length > 0) || order(a, b));
  const meta = `${up.length} en cours · ${st.images.length} image${st.images.length > 1 ? 's' : ''}`;
  if (!up.length) return { body: '<p class="hm-empty">Aucun conteneur en cours.</p>', meta };
  return { body: up.slice(0, 6).map(c => containerRow(c)).join('') + (up.length > 6 ? `<p class="dk-more">${up.length - 6} de plus</p>` : ''), meta };
}

/** Onglet Docker affiché : dessine, puis relit toutes les 5 secondes tant que l'onglet est à l'écran. */
export function mount(box: HTMLElement, p: Project, folder: string | null): void {
  let last = '';
  const paint = async (fresh: boolean): Promise<void> => {
    const html = projectHTML(p, await status(fresh), folder);
    if (box.isConnected && html !== last) { last = html; box.innerHTML = html; }
  };
  box.addEventListener('click', e => { if ((e.target as HTMLElement).closest('[data-dk="refresh"]')) void paint(true); });
  void paint(false);
  if (!supported()) return;
  const t = setInterval(() => { if (!box.isConnected) clearInterval(t); else void paint(true); }, 5000);
}

/** Pour la vue d'ensemble : remplit la carte Docker. */
export async function fillCard(root: HTMLElement, p: Project): Promise<void> {
  const b = $('[data-ov="docker"]', root); if (!b) return;
  b.innerHTML = overviewText(p, await status());
}
