// Plugin Spotify : le titre en cours et les commandes de lecture, en bas de la barre latérale.
// Aucun serveur : la connexion suit le parcours OAuth « PKCE », prévu pour les apps sans secret. Chacun crée
// sa propre app Spotify (gratuite) et n'en donne que le Client ID ; les jetons restent dans le coffre.
//   - dans un navigateur, Spotify renvoie sur l'adresse de Studio avec ?code=… ;
//   - dans l'app Mac ou iPhone, la page s'ouvre dans le navigateur du système, qui ne sait pas revenir dans
//     l'app : Spotify renvoie sur une adresse locale (page introuvable, c'est attendu) qu'on colle dans Studio.
import { esc } from '../lib/markdown.ts';
import { icon, toast } from '../ui/kit.ts';
import type { Plugin, PluginAPI } from './registry.ts';

const AUTH = 'https://accounts.spotify.com', API = 'https://api.spotify.com/v1';
// user-read-playback-state donne l'appareil actif, donc son volume ; les connexions antérieures ne l'ont pas.
const SCOPE = 'user-read-currently-playing user-read-playback-state user-modify-playback-state';
const PKCE = 'studio.spotify.pkce';
const LOCAL = 'http://127.0.0.1:8888/callback';

interface Pkce { verifier: string; state: string; challenge: string }
interface Tok { access: string; refresh: string; exp: number; scope?: string }
/** `volume` : null quand l'appareil ne le règle pas à distance (souvent un téléphone) ou que l'autorisation manque. */
interface Now { title: string; by: string; url: string; playing: boolean; volume: number | null }
interface Playing { is_playing?: boolean; device?: { volume_percent?: number | null; supports_volume?: boolean } | null; item?: { name?: string; artists?: { name?: string }[]; show?: { name?: string }; external_urls?: { spotify?: string } } | null }

let pkce: Pkce | null = null, now: Now | null = null, renewing: Promise<Tok> | null = null;
/** Volume d'avant la coupure du son, rendu au clic suivant sur le haut-parleur. */
let unmute = 50;

const inApp = (): boolean => document.documentElement.dataset.native !== undefined;
const redirect = (): string => inApp() ? LOCAL : location.origin + location.pathname;
const b64 = (b: Uint8Array): string => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const rand = (n: number): string => b64(crypto.getRandomValues(new Uint8Array(n)));

/** Prépare la paire PKCE à l'avance : le bouton de connexion est alors un vrai lien, sans attente au clic. */
async function prepare(): Promise<void> {
  if (!pkce) { try { pkce = JSON.parse(sessionStorage.getItem(PKCE) || 'null') as Pkce | null; } catch { pkce = null; } }
  if (pkce) return;
  const verifier = rand(48), hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  pkce = { verifier, state: rand(12), challenge: b64(hash) };
  try { sessionStorage.setItem(PKCE, JSON.stringify(pkce)); } catch { /* gardée en mémoire */ }
}
function forget(): void { pkce = null; try { sessionStorage.removeItem(PKCE); } catch { /* ignoré */ } }

const authorizeURL = (api: PluginAPI): string => pkce ? `${AUTH}/authorize?${new URLSearchParams({ client_id: api.get('client'), response_type: 'code', redirect_uri: redirect(), code_challenge_method: 'S256', code_challenge: pkce.challenge, scope: SCOPE, state: pkce.state })}` : '';

function token(api: PluginAPI): Tok | null {
  try { return JSON.parse(api.secret('tok') || 'null') as Tok | null; } catch { return null; }
}
const connected = (api: PluginAPI): boolean => !!token(api);
const canVolume = (api: PluginAPI): boolean => !!token(api)?.scope?.split(' ').includes('user-read-playback-state');

async function grant(api: PluginAPI, params: Record<string, string>): Promise<Tok> {
  const r = await fetch(`${AUTH}/api/token`, { method: 'POST', body: new URLSearchParams({ client_id: api.get('client'), ...params }), credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' });
  const j = await r.json().catch(() => ({})) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string; error_description?: string };
  if (!r.ok || !j.access_token) {
    if (j.error === 'invalid_grant' && params.refresh_token) { await api.setSecret('tok', null); now = null; }
    throw new Error(`Spotify a refusé la connexion${j.error_description ? ` : ${j.error_description}` : ''}.`);
  }
  const scope = j.scope ?? (params.refresh_token ? token(api)?.scope : undefined);
  const tok: Tok = { access: j.access_token, refresh: j.refresh_token ?? params.refresh_token ?? '', exp: Date.now() + (j.expires_in ?? 3600) * 1000, ...(scope ? { scope } : {}) };
  await api.setSecret('tok', JSON.stringify(tok));
  return tok;
}

/** Jeton d'accès valide, renouvelé au besoin (une seule demande à la fois : le jeton de renouvellement change à chaque usage). */
async function access(api: PluginAPI): Promise<string> {
  const tok = token(api); if (!tok) throw new Error('Spotify n’est pas connecté (Réglages → Extensions).');
  if (tok.exp - 60000 > Date.now()) return tok.access;
  renewing ??= grant(api, { grant_type: 'refresh_token', refresh_token: tok.refresh }).finally(() => { renewing = null; });
  return (await renewing).access;
}

async function call<T>(api: PluginAPI, method: string, path: string): Promise<T | null> {
  const r = await fetch(API + path, { method, headers: { Authorization: `Bearer ${await access(api)}` }, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' });
  if (r.status === 403) throw new Error('Spotify Premium est nécessaire pour piloter la lecture.');
  if (r.status === 404) throw new Error('Aucun appareil Spotify actif : lance la lecture quelque part.');
  if (!r.ok) throw new Error(`Spotify : erreur ${r.status}`);
  if (r.status === 204) return null;
  return await r.json().catch(() => null) as T | null;
}

async function poll(api: PluginAPI): Promise<void> {
  if (!connected(api) || document.visibilityState !== 'visible') return;
  let next: Now | null = null;
  try {
    const p = await call<Playing>(api, 'GET', `/me/player${canVolume(api) ? '' : '/currently-playing'}?additional_types=episode`), it = p?.item, d = p?.device;
    if (it?.name) {
      const url = it.external_urls?.spotify ?? '';
      const volume = d && d.supports_volume !== false && typeof d.volume_percent === 'number' ? d.volume_percent : null;
      next = { title: it.name, by: it.artists?.map(a => a.name ?? '').filter(Boolean).join(', ') || it.show?.name || '', url: url.startsWith('https://open.spotify.com/') ? url : '', playing: !!p?.is_playing, volume };
    }
  } catch { /* hors ligne ou jeton retiré : rien à afficher */ }
  if (JSON.stringify(next) === JSON.stringify(now)) return;
  now = next;
  // Ne pas redessiner sous le doigt : le curseur perdrait la prise en cours de glissement.
  if (!document.activeElement?.matches('#plug-side [data-plug-change]')) api.refresh();
}

/** Fin de la connexion : échange le code reçu contre des jetons. */
async function finish(api: PluginAPI, code: string, state: string): Promise<void> {
  await prepare();
  if (!pkce || state !== pkce.state) throw new Error('Cette connexion Spotify a expiré : relance-la depuis Réglages → Extensions.');
  await grant(api, { grant_type: 'authorization_code', code, redirect_uri: redirect(), code_verifier: pkce.verifier });
  forget();
  toast('Spotify connecté');
  await poll(api);
}

async function control(api: PluginAPI, method: string, path: string): Promise<void> {
  await call(api, method, path);
  setTimeout(() => void poll(api), 700);
}

async function setVolume(api: PluginAPI, v: number): Promise<void> {
  const volume = Math.max(0, Math.min(100, Math.round(v)));
  if (now?.volume) unmute = now.volume;
  await control(api, 'PUT', `/me/player/volume?volume_percent=${volume}`);
  if (now) now.volume = volume;
}

function panel(api: PluginAPI): string {
  const steps = `<p class="modal-hint">Sans serveur, Studio ne peut pas embarquer d’app Spotify : crée la tienne (gratuit) sur <a href="https://developer.spotify.com/dashboard" target="_blank" rel="noopener">developer.spotify.com/dashboard</a>, API « Web API », avec cette adresse de redirection : <code>${esc(redirect())}</code>. Colle ensuite son <strong>Client ID</strong> ci-dessus ; il n’y a aucun secret à fournir.${!inApp() && location.hostname === 'localhost' ? ' Spotify refuse <code>localhost</code> : ouvre Studio par <code>http://127.0.0.1</code>.' : ''}</p>`;
  if (connected(api)) return `<p class="cx-who">Connecté${now ? ` · ${now.playing ? 'en écoute' : 'en pause'} : ${esc(now.title)}` : ''}</p>
    <div class="cx-grid"><button class="btn btn-danger" data-plug="spotify:logout">Déconnecter Spotify</button></div>
    <p class="modal-hint">Le titre en cours s’affiche en bas de la barre latérale, tant que Studio est ouvert. Les boutons lecture, précédent, suivant et le volume demandent Spotify Premium ; certains appareils (souvent les téléphones) ne laissent pas régler leur volume à distance.</p>
    ${canVolume(api) ? '' : '<p class="modal-hint">Pour régler le volume depuis Studio, déconnecte puis reconnecte Spotify : cette connexion date d’avant et n’a pas l’autorisation de lire l’appareil en cours.</p>'}`;
  if (!api.get('client')) return steps;
  const url = authorizeURL(api);
  return `<div class="cx-grid">${url ? `<a class="btn btn-primary" href="${esc(url)}"${inApp() ? ' target="_blank" rel="noopener"' : ''}>${icon('music')}Se connecter à Spotify</a>` : '<button class="btn" disabled>Préparation…</button>'}</div>
    ${inApp() ? `<p class="modal-hint">Spotify s’ouvre dans ton navigateur. Après avoir accepté, il affiche une page introuvable à l’adresse <code>127.0.0.1:8888</code> : c’est attendu. Copie l’adresse complète de cette page et colle-la ici.</p>
    <form class="cx-row" data-plug-form="spotify:paste"><input class="field" name="spotify-back" placeholder="${LOCAL}?code=…" autocomplete="off" spellcheck="false" required><button class="btn">Terminer</button></form>` : ''}
    ${steps}`;
}

function volumeRow(v: number | null): string {
  if (v === null) return '';
  return `<div class="plug-vol">
    <button class="icon-btn" data-plug="spotify:mute" aria-label="${v ? 'Couper le son' : 'Remettre le son'}">${icon(v ? 'volume' : 'mute')}</button>
    <input type="range" min="0" max="100" step="5" value="${v}" data-plug-change="spotify:volume" aria-label="Volume" title="Volume : ${v} %"></div>`;
}

export const spotify: Plugin = {
  id: 'spotify', name: 'Spotify', icon: 'music', optional: true, vault: true,
  description: 'Le titre en cours et les commandes de lecture, en bas de la barre latérale.',
  hosts: ['accounts.spotify.com', 'api.spotify.com'],
  settings: [{ key: 'client', label: 'Client ID de ton app Spotify', placeholder: '32 caractères', check: v => /^[0-9a-f]{32}$/i.test(v) ? null : 'Un Client ID Spotify fait 32 caractères (chiffres et lettres de a à f).' }],
  start(api) {
    // Retour de Spotify dans un navigateur : ?code=…&state=… (ou ?error=…) sur l'adresse de Studio.
    const q = new URLSearchParams(location.search), code = q.get('code'), state = q.get('state');
    if (!inApp() && state && q.has('error')) toast('Connexion à Spotify annulée');
    if (!inApp() && state && code) void finish(api, code, state).catch(e => toast(e instanceof Error ? e.message : String(e))).then(api.refreshSettings);
    else void prepare().then(api.refreshSettings);
    api.every(15000, () => void poll(api));
    void poll(api);
  },
  panel,
  sidebar(api) {
    if (!connected(api) || !now) return '';
    const text = `<span><strong>${esc(now.title)}</strong>${now.by ? `<em>${esc(now.by)}</em>` : ''}</span>`, label = `${now.title}${now.by ? ` — ${now.by}` : ''}`;
    return `<section class="plug-card" aria-label="Spotify"><div class="plug-np" title="${esc(label)}">${now.url ? `<a href="${esc(now.url)}" target="_blank" rel="noopener">${icon('music')}${text}</a>` : `<div>${icon('music')}${text}</div>`}
      <button class="icon-btn" data-plug="spotify:prev" aria-label="Titre précédent">${icon('prev')}</button>
      <button class="icon-btn" data-plug="spotify:toggle" aria-label="${now.playing ? 'Pause' : 'Lecture'}">${icon(now.playing ? 'pause' : 'play')}</button>
      <button class="icon-btn" data-plug="spotify:next" aria-label="Titre suivant">${icon('next')}</button></div>${volumeRow(now.volume)}</section>`;
  },
  actions: {
    async toggle(api) { const playing = !!now?.playing; await control(api, 'PUT', playing ? '/me/player/pause' : '/me/player/play'); if (now) now.playing = !playing; },
    next: api => control(api, 'POST', '/me/player/next'),
    prev: api => control(api, 'POST', '/me/player/previous'),
    volume: (api, el) => el instanceof HTMLInputElement ? setVolume(api, Number(el.value)) : undefined,
    mute: api => setVolume(api, now?.volume ? 0 : unmute),
    async logout(api) { await api.setSecret('tok', null); now = null; forget(); await prepare(); toast('Spotify déconnecté'); },
    async paste(api, el) {
      const raw = el.querySelector('input')?.value.trim() ?? '';
      let q: URLSearchParams;
      try { q = new URL(raw).searchParams; } catch { throw new Error('Colle l’adresse complète de la page d’arrivée (elle commence par http://127.0.0.1:8888).'); }
      if (q.has('error')) throw new Error('Spotify indique que la connexion a été refusée.');
      await finish(api, q.get('code') ?? '', q.get('state') ?? '');
    },
  },
  commands: [
    { label: 'Spotify : lecture ou pause', icon: 'play', kw: 'musique play pause', run: api => spotify.actions?.toggle?.(api, document.body) },
    { label: 'Spotify : titre suivant', icon: 'next', kw: 'musique next passer', run: api => control(api, 'POST', '/me/player/next') },
    { label: 'Spotify : titre précédent', icon: 'prev', kw: 'musique previous retour', run: api => control(api, 'POST', '/me/player/previous') },
    { label: 'Spotify : monter le son', icon: 'volume', kw: 'musique volume plus fort', run: api => setVolume(api, (now?.volume ?? 50) + 10) },
    { label: 'Spotify : baisser le son', icon: 'volume', kw: 'musique volume moins fort', run: api => setVolume(api, (now?.volume ?? 50) - 10) },
    { label: 'Spotify : couper ou remettre le son', icon: 'mute', kw: 'musique volume muet mute', run: api => setVolume(api, now?.volume ? 0 : unmute) },
  ],
};
