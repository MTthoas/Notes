// Plugin Figma : les maquettes s'affichent dans Studio, au plus près des notes et des projets.
// - Un bloc ```figma (une adresse de fichier par ligne) devient des fiches « Afficher / Ouvrir dans Figma ».
//   « Afficher » ouvre la maquette en grand par l'intégration officielle (embed.figma.com) : navigation,
//   zoom, prototypes et commentaires, mais pas d'édition (Figma ne se laisse pas éditer dans un cadre).
// - La page d'un projet liste les fichiers Figma cités dans ses notes ; avec un jeton personnel
//   (lecture seule), elle donne aussi leur vrai nom, leur dernière modification et les commentaires ouverts.
// L'aperçu exige frame-src https://embed.figma.com (index.html) et, dans l'app native, que Shell.swift
// laisse les cadres figma.com naviguer au lieu de les ouvrir dans le navigateur.
import * as store from '../core/store.ts';
import { notesOf } from '../features/projects/model.ts';
import { esc } from '../lib/markdown.ts';
import { icon, modal, rel, errMsg, toast } from '../ui/kit.ts';
import type { Plugin, PluginAPI } from './registry.ts';
import type { Project } from '../features/projects/model.ts';

export interface FigmaLink { kind: string; key: string; name: string; url: string; embed: string }

const RE = /https:\/\/(?:www\.)?figma\.com\/(design|file|proto|board|slides)\/([A-Za-z0-9]{10,})(?:\/([^\s?#)\]<>"'`]*))?(?:\?([^\s#)\]<>"'`]*))?/g;
const KIND: Record<string, string> = { design: 'Maquette', proto: 'Prototype', board: 'FigJam', slides: 'Présentation' };

function nameOf(slug: string): string {
  try { return decodeURIComponent(slug).replace(/-+/g, ' ').trim(); } catch { return slug; }
}

/** Fichiers Figma cités dans un texte, sans doublon (même fichier, même cadre). */
export function links(text: string): FigmaLink[] {
  const seen = new Map<string, FigmaLink>();
  for (const m of text.matchAll(RE)) {
    const [url, k = 'design', key = '', slug = '', q = ''] = m;
    const kind = k === 'file' ? 'design' : k, params = new URLSearchParams(q);
    params.set('embed-host', 'studio');
    const id = `${kind}:${key}:${params.get('node-id') ?? ''}`;
    if (!seen.has(id)) seen.set(id, { kind, key, url, name: nameOf(slug) || 'Fichier Figma', embed: `https://embed.figma.com/${kind}/${key}${slug ? '/' + slug : ''}?${params}` });
  }
  return [...seen.values()];
}

let API: PluginAPI | null = null;
const token = (): string => API?.secret('token') ?? '';

async function call<T>(path: string): Promise<T> {
  const t = token(); if (!t) throw new Error('Ajoute d’abord ton jeton Figma (Réglages → Extensions).');
  let r: Response;
  try { r = await fetch('https://api.figma.com/v1/' + path, { headers: { 'X-Figma-Token': t }, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' }); }
  catch { throw new Error('Figma est injoignable'); }
  if (r.status === 401 || r.status === 403) throw new Error('jeton refusé, ou fichier auquel ce compte n’a pas accès');
  if (r.status === 404) throw new Error('fichier introuvable');
  if (r.status === 429) throw new Error('trop de requêtes, réessaie dans une minute');
  if (!r.ok) throw new Error(`Figma a répondu ${r.status}`);
  return await r.json() as T;
}

interface Info { name: string; modified: number; open: number }
const cache = new Map<string, { at: number; v: Promise<Info> }>();
/** Nom, dernière modification et commentaires ouverts d'un fichier (gardés 5 min : l'API limite le débit). */
function info(key: string): Promise<Info> {
  const c = cache.get(key); if (c && Date.now() - c.at < 300000) return c.v;
  const v = Promise.all([
    call<{ name: string; lastModified: string }>(`files/${key}?depth=1`),
    call<{ comments: { resolved_at?: string | null; parent_id?: string }[] }>(`files/${key}/comments`),
  ]).then(([f, cm]) => ({ name: f.name, modified: Date.parse(f.lastModified), open: (cm.comments ?? []).filter(x => !x.resolved_at && !x.parent_id).length }));
  v.catch(() => cache.delete(key));
  cache.set(key, { at: Date.now(), v });
  return v;
}

function card(l: FigmaLink, detail = ''): string {
  return `<div class="fg-card">${icon('figma')}<span class="fg-name"><strong>${esc(l.name)}</strong><em>${esc(KIND[l.kind] ?? 'Figma')}${detail ? ' · ' + esc(detail) : ''}</em></span>
    <button class="btn" data-plug="figma:show" data-embed="${esc(l.embed)}" data-name="${esc(l.name)}" data-url="${esc(l.url)}">${icon('eye')}Afficher</button>
    <a class="icon-btn" href="${esc(l.url)}" target="_blank" rel="noopener noreferrer" title="Ouvrir dans Figma" aria-label="Ouvrir dans Figma">${icon('share')}</a></div>`;
}

function show(l: Pick<FigmaLink, 'embed' | 'name' | 'url'>): void {
  if (!l.embed.startsWith('https://embed.figma.com/')) return;
  modal({ title: l.name, cls: 'fg-modal', html: `<iframe class="fg-frame" src="${esc(l.embed)}" allowfullscreen sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-forms" title="${esc(l.name)}"></iframe>
    <div class="modal-actions"><span class="fg-hint">Fichier privé ? Il faut être connecté à Figma, ou que le lien soit partagé.</span><a class="btn" href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${icon('share')}Ouvrir dans Figma</a></div>` });
}

const filesOf = (p: Project): FigmaLink[] => links(notesOf(p).map(n => store.getBody(n) ?? '').join('\n'));

export const figma: Plugin = {
  id: 'figma', name: 'Figma', icon: 'figma', optional: true,
  description: 'Affiche tes maquettes Figma dans les notes et les projets : colle un lien dans un bloc ```figma.',
  hosts: ['api.figma.com', 'embed.figma.com'],
  settings: [
    { key: 'token', label: 'Jeton personnel (facultatif)', secret: true, placeholder: 'figd_…', hint: 'Figma → Réglages → Sécurité → Jetons d’accès personnels, en lecture seule (fichiers et commentaires). Sans jeton, l’aperçu marche quand même.' },
  ],
  start(api) { API = api; },
  panel: api => `${api.secret('token') ? '<div class="cx-grid"><button class="btn" data-plug="figma:test">Vérifier le jeton</button></div>' : ''}
    <p class="modal-hint">Dans une note : <code>\`\`\`figma</code>, une adresse par ligne (Partager → Copier le lien), puis <code>\`\`\`</code>. Un lien vers un cadre (<code>node-id</code>) ouvre ce cadre. Les fichiers cités dans les notes d’un projet apparaissent sur sa page.</p>`,
  fences: {
    figma(code) {
      const ls = links(code);
      return `<div class="fg">${ls.length ? ls.map(l => card(l)).join('') : '<p class="fg-empty">Colle l’adresse d’un fichier Figma par ligne (Partager → Copier le lien).</p>'}</div>`;
    },
  },
  projectPanels: [{
    id: 'figma.files', title: 'Maquettes Figma', icon: 'figma', order: 15,
    when: p => filesOf(p).length > 0,
    async render(p) {
      const ls = filesOf(p);
      if (!token()) return `<div class="fg">${ls.map(l => card(l)).join('')}</div><p class="nf-empty">Ajoute un jeton Figma pour voir les noms, les dates et les commentaires ouverts. <button class="link-btn" data-open-conn="extensions">Réglages</button></p>`;
      const rows = await Promise.all(ls.map(async l => {
        try {
          const i = await info(l.key);
          return card({ ...l, name: i.name || l.name }, `modifié ${rel(i.modified)}${i.open ? ` · ${i.open} commentaire${i.open > 1 ? 's' : ''} ouvert${i.open > 1 ? 's' : ''}` : ''}`);
        } catch (e) { return card(l, errMsg(e)); }
      }));
      return `<div class="fg">${rows.join('')}</div>`;
    },
  }],
  actions: {
    show(_api, el) { const d = el.dataset; show({ embed: d.embed ?? '', name: d.name ?? 'Figma', url: d.url ?? '' }); },
    async test() { const me = await call<{ handle: string }>('me'); toast(`Jeton valide : connecté en tant que ${me.handle}`); },
  },
  commands: [{
    label: 'Figma : afficher la maquette de la note', icon: 'figma', kw: 'design maquette prototype figjam',
    run(api) {
      const n = api.note(); if (!n) throw new Error('Ouvre d’abord une note lisible.');
      const l = links(n.body)[0]; if (!l) throw new Error('Cette note ne contient aucun lien Figma.');
      show(l);
    },
  }],
};
