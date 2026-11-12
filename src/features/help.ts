// Page d'aide : pensée pour quelqu'un qui n'a jamais utilisé ce genre d'outil.
// Des cartes courtes (« bento »), chacune répond à une question : comment écrire, relier, ranger, automatiser.
// Les exemples sont rendus en direct à côté de ce qu'on tape, mais restent inertes (aucune note n'est modifiée).
import { renderMarkdown, esc } from '../lib/markdown.ts';
import { icon, kbd } from '../ui/kit.ts';
import type { AppShell } from '../types.ts';

export interface HelpApi extends AppShell { shortcuts(): [string, string][] }
let app!: HelpApi;
export const init = (api: HelpApi): void => { app = api; };

/** Exemple : à gauche ce qu'on tape, à droite le résultat. */
const demo = (src: string): string => `<div class="hp-demo"><pre class="hp-src">${esc(src)}</pre><div class="hp-out md">${renderMarkdown(src, { exists: () => true }).replace(/<input /g, '<input disabled ')}</div></div>`;
const card = (cls: string, hue: string, ic: string, title: string, body: string): string =>
  `<section class="hp-card ${cls}" style="--c:var(--c-${hue})"><h2><span class="hp-ic">${icon(ic)}</span>${title}</h2>${body}</section>`;

function key(label: string, combo: string): string { return `<div class="hp-key">${kbd(combo)}<span>${esc(label)}</span></div>`; }

export function mount(main: HTMLElement): void {
  const sc = Object.fromEntries(app.shortcuts().map(([l, k]) => [l, k]));
  const k = (label: string) => sc[label] ?? '';
  main.innerHTML = `<header class="toolbar">${app.tbLeft()}${app.crumb('Aide')}<div class="tb-side tb-right"></div></header>
  <div class="todo hp"><div class="todo-in hp-in">
    <div class="td-head"><h1>Prendre Studio en main</h1><p class="td-sub">Tout ce qu’il faut savoir, en cinq minutes. Rien n’est obligatoire : commence par écrire, le reste viendra.</p></div>
    <div class="hp-grid">
      ${card('hp-hero', 'gray', 'home', 'Studio en trois idées', `<div class="hp-pillars">
        <div style="--c:var(--c-blue)"><span class="hp-ic">${icon('compose')}</span><strong>Écrire</strong><p>Des notes en texte simple, reliées entre elles comme un wiki personnel.</p></div>
        <div style="--c:var(--c-green)"><span class="hp-ic">${icon('check')}</span><strong>Centraliser</strong><p>Tâches, tickets Linear et activité GitHub au même endroit que tes notes.</p></div>
        <div style="--c:var(--c-violet)"><span class="hp-ic">${icon('bot')}</span><strong>Automatiser</strong><p>Décris une routine une fois : Studio l’exécute à ta place, à heure fixe ou à chaque événement.</p></div></div>
        <div class="hp-actions"><button class="btn btn-primary" data-act="new">${icon('compose')}Écrire ma première note</button><button class="btn" data-view="agents">${icon('bot')}Voir les automatisations</button></div>`)}

      ${card('hp-w3', 'amber', 'keyboard', 'Les 5 raccourcis à retenir', `<p class="hp-lead">Avec ces cinq-là, tu n’as presque plus besoin de la souris.</p><div class="hp-keys">
        ${key('Tout trouver, tout lancer', k('Palette de commandes'))}${key('Noter une idée en 2 secondes', k('Capture rapide'))}${key('Nouvelle note', k('Nouvelle note'))}${key('Mes tâches', k('Tâches'))}${key('Réglages', k('Réglages'))}</div>
        <p class="hp-tip">${icon('search')}La palette (${kbd(k('Palette de commandes'))}) connaît toutes les actions : tape ce que tu veux faire, « tâche », « linear », « exporter »…</p>`)}

      ${card('hp-w3', 'blue', 'compose', 'Écrire une note', `<p class="hp-lead">Du texte normal, avec quelques signes pour la mise en forme. Tu peux les ignorer au début.</p>
        ${demo('# Un titre\nDu texte en **gras**, en *italique*.\n- une liste\n- à puces\n> une citation')}`)}

      ${card('hp-w2', 'teal', 'link', 'Relier tes idées', `<p class="hp-lead">Entre doubles crochets, le titre d’une autre note : un lien se crée, même si la note n’existe pas encore.</p>
        ${demo('Voir [[Projet Studio]] pour le détail.')}
        <p class="hp-tip">${icon('graph')}Chaque note montre en bas qui la cite. Le <button class="link-btn" data-view="graph">graphe</button> dessine l’ensemble.</p>`)}

      ${card('hp-w2', 'pink', 'hash', 'Ranger sans y penser', `<p class="hp-lead">Un mot précédé de # range la note. Pas de dossier à choisir.</p>
        ${demo('Idée pour la rentrée #idée #projet/studio')}
        <p class="hp-tip">${icon('inbox')}Une capture sans # va dans la <button class="link-btn" data-view="inbox">boîte de réception</button>, à ranger plus tard (ou automatiquement).</p>`)}

      ${card('hp-w2', 'green', 'check', 'Gérer tes tâches', `<p class="hp-lead">Une case dans n’importe quelle note devient une tâche, retrouvée dans la page Tâches.</p>
        ${demo('- [ ] À faire\n- [/] En cours\n- [x] Terminée')}
        <p class="hp-tip">${icon('today')}Dans la page <button class="link-btn" data-view="tasks">Tâches</button>, écris « Appeler Paul demain » : l’échéance est comprise. Passe en Kanban pour glisser les cartes.</p>`)}

      ${card('hp-w3', 'orange', 'bolt', 'Les blocs intelligents', `<p class="hp-lead">Quelques écritures spéciales donnent vie à une note.</p>
        ${demo('Budget : `= 1200 * 12`\n\n| Ville | Habitants |\n|---|---|\n| Lyon | 520 000 |\n| Nantes | 320 000 |')}
        <ul class="hp-list"><li><code>[timer 25m]</code> un minuteur dans la note</li><li><code>\`\`\`linear</code> une liste de tickets à jour</li><li><code>\`\`\`schema</code> un schéma de base de données dessiné</li></ul>`)}

      ${card('hp-w3', 'violet', 'bot', 'Automatiser avec l’IA', `<p class="hp-lead">Une automatisation est une consigne écrite comme à un assistant. Elle peut lire et agir sur tes notes, tâches, Linear et GitHub.</p>
        <pre class="hp-src">\`\`\`agent
nom: Tri des captures
outils: notes
déclencheur: capture
---
Range la capture sous les bons tags
et ajoute les actions à mes tâches.
\`\`\`</pre>
        <ul class="hp-list"><li><strong>planning:</strong> « jours ouvrés 9h », « vendredi 17h », « toutes les 2h »</li><li><strong>déclencheur:</strong> capture, linear, github ou tâche</li><li>Toute modification te sera <strong>demandée avant</strong> d’être faite.</li></ul>
        <div class="hp-actions"><button class="btn" data-view="agents">Choisir un modèle prêt à l’emploi</button></div>`)}

      ${card('hp-w3', 'red', 'shield', 'Tes données restent à toi', `<ul class="hp-list">
        <li>Tout est enregistré <strong>sur tes appareils</strong>, sans compte ni serveur.</li>
        <li>Active le <button class="link-btn" data-open-conn="coffre">coffre</button> : tout est chiffré, et Touch ID ouvre l’app.</li>
        <li>Une note marquée <code>#privé</code> n’est <strong>jamais</strong> envoyée à une IA.</li>
        <li>Une note peut être <strong>éphémère</strong> : elle s’efface seule à la date choisie.</li></ul>`)}

      ${card('hp-w3', 'indigo', 'devices', 'Sur tous tes appareils', `<ul class="hp-list">
        <li>Relie ton iPhone et ton Mac dans <button class="link-btn" data-open-conn="appareils">Réglages → Appareils</button> : un code à copier, et c’est tout.</li>
        <li>Les notes passent directement d’un appareil à l’autre, chiffrées.</li>
        <li>Sur iPhone, le bouton micro transforme ta voix en note.</li></ul>`)}

      ${card('hp-w6', 'gray', 'keyboard', 'Tous les raccourcis', `<div class="hp-allkeys">${app.shortcuts().map(([l, c]) => key(l, c)).join('')}</div>`)}
    </div>
  </div></div>`;
}
