// Plugin n8n : pousse ce qui se passe dans Studio vers un webhook n8n, qui en fait ce que tu veux
// (Slack, Notion, agenda, mail…). Aucun serveur de notre côté : la page appelle directement ton n8n.
// L'adresse du webhook vaut mot de passe : elle est gardée dans le coffre.
import * as events from '../core/events.ts';
import { toast } from '../ui/kit.ts';
import type { Field, Plugin, PluginAPI } from './registry.ts';

const KINDS = Object.keys(events.TRIGGERS) as events.Trigger[];
const ON_BY_DEFAULT = new Set<events.Trigger>(['capture', 'tache']);
let warned = 0;

/** Seuls les domaines ouverts par la politique de sécurité (connect-src, index.html) peuvent être joints. */
function checkURL(v: string): string | null {
  let u: URL;
  try { u = new URL(v); } catch { return 'Adresse invalide : colle l’URL de production du nœud Webhook.'; }
  const local = u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname);
  const cloud = u.protocol === 'https:' && u.hostname.endsWith('.app.n8n.cloud');
  return local || cloud ? null : 'Studio ne joint que n8n Cloud (….app.n8n.cloud) ou un n8n sur cette machine (http://localhost:5678). Pour un autre domaine, ajoute-le à connect-src dans index.html.';
}

async function send(api: PluginAPI, event: string, text: string, extra: Record<string, string> = {}): Promise<void> {
  const url = api.secret('url'); if (!url) throw new Error('Renseigne d’abord l’adresse du webhook n8n (Réglages → Extensions).');
  let r: Response;
  try { r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: 'studio', event, text, at: new Date().toISOString(), ...extra }), credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' }); }
  catch { throw new Error('n8n est injoignable : vérifie que le workflow est actif et que le nœud Webhook accepte les requêtes de Studio (option « Allowed Origins (CORS) »).'); }
  if (!r.ok) throw new Error(`n8n a répondu ${r.status}${r.status === 404 ? ' : le workflow est-il actif, et l’URL est-elle celle de production ?' : ''}`);
}

export const n8n: Plugin = {
  id: 'n8n', name: 'n8n', icon: 'bolt', optional: true,
  description: 'Envoie tes captures, tes tâches terminées et tes notes à un webhook n8n, pour les brancher sur tout le reste.',
  hosts: ['*.app.n8n.cloud', 'localhost'],
  settings: [
    { key: 'url', label: 'Adresse du webhook', secret: true, placeholder: 'https://toi.app.n8n.cloud/webhook/…', check: checkURL },
    ...KINDS.map((k): Field => ({ key: k, kind: 'check', label: `Envoyer ${events.TRIGGERS[k]}`, def: ON_BY_DEFAULT.has(k) ? '1' : '' })),
  ],
  start(api) {
    api.on(e => {
      if (!api.get(e.kind) || !api.secret('url')) return;
      send(api, e.kind, e.text).catch((err: unknown) => {
        // Un envoi de fond qui échoue ne doit pas inonder l'écran : un seul message par quart d'heure.
        if (Date.now() - warned > 900000) { warned = Date.now(); toast(err instanceof Error ? err.message : String(err)); }
      });
    });
  },
  panel: api => `${api.secret('url') ? `<div class="cx-grid"><button class="btn" data-plug="n8n:test">Envoyer un essai</button></div>` : ''}
    <p class="modal-hint">Dans n8n : un nœud <strong>Webhook</strong>, méthode <strong>POST</strong>, workflow actif. Studio lui envoie ce JSON, tant qu’il est ouvert :</p>
    <pre class="cx-code">{ "source": "studio", "event": "capture", "text": "…", "at": "2026-01-01T09:00:00.000Z" }</pre>
    <p class="modal-hint"><code>event</code> vaut <code>capture</code>, <code>tache</code>, <code>linear</code>, <code>github</code>, <code>note</code> (palette → « n8n : envoyer la note ouverte », avec son <code>title</code>) ou <code>test</code>. Les notes chiffrées ou taguées <code>#privé</code> ne partent jamais d’elles-mêmes.</p>`,
  actions: {
    async test(api) { await send(api, 'test', 'Essai envoyé depuis Studio.'); toast('n8n a bien reçu l’essai'); },
  },
  commands: [{
    label: 'n8n : envoyer la note ouverte', icon: 'bolt', kw: 'webhook automatisation workflow',
    async run(api) {
      const n = api.note(); if (!n) throw new Error('Ouvre d’abord une note lisible.');
      await send(api, 'note', n.body, { title: n.title });
      toast('Note envoyée à n8n');
    },
  }],
};
