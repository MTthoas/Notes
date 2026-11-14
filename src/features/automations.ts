// Page Automatisations : le cœur de Studio. Une automatisation est une consigne en langage naturel
// que l'IA exécute avec des outils (notes, tâches, Linear, GitHub), à la main, à heure fixe ou à chaque événement.
// Elle vit dans une note (bloc ```agent) : on peut la lire, la modifier, la synchroniser comme le reste.
import * as store from '../core/store.ts';
import * as ai from '../integrations/ai.ts';
import * as hub from './hub.ts';
import * as projects from './projects/model.ts';
import { TRIGGERS } from '../core/events.ts';
import { esc } from '../lib/markdown.ts';
import { $, icon, rel, toast, need, target, num } from '../ui/kit.ts';
import type { AppShell } from '../types.ts';

let app!: AppShell;
export const init = (shell: AppShell): void => { app = shell; hub.onRunsChange(refresh); };

/** Modèles prêts à l'emploi : un clic crée la note qui contient l'automatisation. */
interface Template { name: string; hue: string; ic: string; pitch: string; block: string }
const TEMPLATES: Template[] = [
  { name: 'Revue du matin', hue: 'amber', ic: 'today', pitch: 'Chaque matin de semaine, pour un projet : tâches en retard et du jour, tickets en cours, activité GitHub de la veille, et tes trois priorités.',
    block: 'nom: Revue du matin\noutils: notes, linear, github\nprojet: {projet}\nplanning: jours ouvrés 8h30\nsortie: journal\n---\nPrépare ma revue du matin sur ce projet. Liste les tâches en retard et celles du jour, les tickets Linear en cours qui me sont assignés, et ce qui a bougé sur ses dépôts GitHub depuis hier. Termine par mes trois priorités du jour, en cases à cocher.' },
  { name: 'Tri des captures', hue: 'blue', ic: 'inbox', pitch: 'À chaque capture rapide : la range sous les bons tags et en extrait les tâches.',
    block: 'nom: Tri des captures\noutils: notes\ndéclencheur: capture\nsortie: aucune\n---\nRange la nouvelle capture : choisis un ou deux tags pertinents parmi ceux que j’utilise déjà (chercher_notes), puis range-la. S’il y a des actions à faire dedans, ajoute-les à mes tâches avec leur échéance.' },
  { name: 'Linear → tâches', hue: 'indigo', ic: 'linear', pitch: 'À chaque notification Linear du projet : crée une tâche quand on te demande d’agir, avec l’identifiant du ticket.',
    block: 'nom: Linear vers tâches\noutils: notes, linear\nprojet: {projet}\ndéclencheur: linear\nsortie: aucune\n---\nPour chaque notification qui me demande d’agir (assignation, mention, question), ajoute une tâche courte qui commence par un verbe et contient l’identifiant du ticket (ex. ENG-42). Ignore les notifications purement informatives.' },
  { name: 'Veille GitHub', hue: 'gray', ic: 'github', pitch: 'À chaque nouveauté sur tes dépôts : résume ce qui demande ton attention dans une note de suivi.',
    block: 'nom: Veille GitHub\noutils: notes, github\ndéclencheur: github\nsortie: [[Veille GitHub]]\n---\nRésume en quelques lignes ce qui vient de se passer sur mes dépôts et ce qui demande mon attention (revue de PR, issue qui me concerne, version publiée). Ajoute une tâche pour chaque revue qui m’attend.' },
  { name: 'Bilan de la semaine', hue: 'green', ic: 'check', pitch: 'Le vendredi à 17 h, pour un projet : ce qui a été fait, ce qui reste, et ce qu’il faut préparer pour lundi.',
    block: 'nom: Bilan de la semaine\noutils: notes, linear, github\nprojet: {projet}\nplanning: vendredi 17h\nsortie: journal\n---\nFais le bilan de ma semaine sur ce projet : tâches terminées, tickets Linear fermés, pull requests fusionnées, notes importantes modifiées. Puis liste ce qui reste en cours et ce que je dois préparer pour lundi.' },
  { name: 'Clôture de tâche', hue: 'teal', ic: 'link', pitch: 'À chaque tâche terminée : si elle cite un ticket Linear, propose de le passer à « Terminé ».',
    block: 'nom: Clôture de tâche\noutils: notes, linear\nprojet: {projet}\ndéclencheur: tâche\nsortie: aucune\n---\nSi la tâche terminée mentionne un ticket Linear (ex. ENG-42), vérifie son état avec linear_chercher et indique s’il reste ouvert. Ne fais rien d’autre si aucun ticket n’est cité.' },
];

const when = (s: ai.AgentSpec): string => s.declencheur ? `${icon('bolt')}${esc(TRIGGERS[s.declencheur])}` : s.planning ? `${icon('history')}${esc(s.planning)}` : `${icon('play')}À la demande`;

function card(a: ReturnType<typeof hub.agentList>[number]): string {
  const paused = hub.isPaused(a.spec, a.note), st = a.live ? 'live' : paused ? 'paused' : 'on';
  const label = a.live ? 'En cours' : paused ? 'En pause' : a.spec.declencheur || a.spec.planning ? 'Active' : 'Manuelle';
  return `<article class="au-card" data-i="${a.index}">
    <header><strong>${esc(a.spec.nom)}</strong><span class="au-state ${st}"><i></i>${label}</span></header>
    <p class="au-when">${when(a.spec)}</p>
    <p class="au-prompt">${esc(a.spec.consigne.slice(0, 180) || 'Pas encore de consigne.')}${a.spec.consigne.length > 180 ? '…' : ''}</p>
    <div class="au-tools"><span class="ag-chip" title="Périmètre : elle ne voit que ces données">${icon('lock')}${esc(a.spec.projet || 'Général')}</span>${a.spec.outils.map(t => `<span class="ag-chip">${esc(t)}</span>`).join('')}<span class="ag-chip">→ ${esc(a.spec.sortie)}</span></div>
    <footer><span class="au-last">${a.last ? `<span class="${a.ok ? 'ok' : 'err'}">${a.ok ? '✓' : '⚠'}</span> ${esc(rel(a.last))}` : 'Jamais lancée'}</span>
      <button class="btn" data-au="edit">Modifier</button>
      ${a.spec.declencheur || a.spec.planning ? `<button class="btn" data-au="pause">${paused ? 'Reprendre' : 'Pause'}</button>` : ''}
      <button class="btn btn-primary" data-au="run"${a.live ? ' disabled' : ''}>${icon('play')}Lancer</button></footer></article>`;
}

function body(): string {
  const list = hub.agentList(), log = hub.runLog().slice(0, 12), ready = ai.ready();
  return `${ready ? '' : `<div class="au-banner">${icon('sparkle')}<div><strong>Connecte une IA pour lancer tes automatisations</strong><span>Le plus simple sur Mac : ton abonnement Claude via Claude Code, sans clé. Sinon une clé Claude ou OpenAI, gardée chiffrée dans le coffre.</span></div><button class="btn btn-primary" data-open-conn="ia">Connecter</button></div>`}
    <section class="td-sec"><h2>Tes automatisations<span>${list.length}</span></h2>
      ${list.length ? `<div class="au-grid">${list.map(card).join('')}</div>` : '<p class="nf-empty">Aucune pour l’instant. Choisis un modèle ci-dessous : il se crée en un clic, et tu peux ensuite le modifier comme une note.</p>'}</section>
    <section class="td-sec"><h2>Modèles prêts à l’emploi</h2><div class="au-tpl">${TEMPLATES.map((t, i) => `<button class="au-t" data-tpl="${i}" style="--c:var(--c-${t.hue})"><span class="au-ic">${icon(t.ic)}</span><strong>${esc(t.name)}</strong><span>${esc(t.pitch)}</span></button>`).join('')}
      <button class="au-t au-blank" data-tpl="blank"><span class="au-ic">${icon('plus')}</span><strong>Partir de zéro</strong><span>Une note avec un bloc d’automatisation vide, à compléter en langage naturel.</span></button></div></section>
    ${log.length ? `<section class="td-sec"><h2>Journal<span>${log.length}</span></h2>${log.map(l => `<div class="au-log"><span class="${l.ok ? 'ok' : 'err'}">${l.ok ? '✓' : '⚠'}</span><strong>${esc(l.name)}</strong><em>${esc(l.how)}</em>${l.error ? `<span class="au-err">${esc(l.error)}</span>` : ''}<time>${esc(rel(l.ts))}</time></div>`).join('')}</section>` : ''}`;
}

export function refresh(): void {
  const box = $('#main .au-body'); if (box) box.innerHTML = body();
}

// Un modèle qui touche Linear ou un projet porte « projet: {projet} » : le seul projet relié à Linear s'il n'y en a
// qu'un, sinon la note s'ouvre pour qu'on le choisisse (un nom inconnu bloque l'automatisation, elle ne déborde pas).
async function useTemplate(i: string): Promise<void> {
  const t = i === 'blank' ? null : TEMPLATES[Number(i)];
  const linked = projects.projects().filter(p => p.linear), only = linked.length === 1 ? linked[0] : null;
  const ask = !!t?.block.includes('{projet}') && !only;
  const block = t?.block.replace('{projet}', only ? only.name : 'à choisir parmi tes projets');
  const n = await store.createNote({
    title: t?.name ?? 'Nouvelle automatisation',
    body: t ? `${t.pitch}\n\n\`\`\`agent\n${block}\n\`\`\`\n\n#automatisation` : `${hub.AGENT_TEMPLATE}\n#automatisation`,
  });
  if (ask) { app.openNote(n.id); toast('Indique son projet à la ligne « projet: » : elle ne verra que ses données.'); }
  else if (t) { toast(`Automatisation « ${t.name} » créée${only ? ` pour ${only.name}` : ''}`, { label: 'Modifier', run: () => app.openNote(n.id) }); refresh(); }
  else app.openNote(n.id);
}

export function mount(main: HTMLElement): void {
  main.innerHTML = `<header class="toolbar">${app.tbLeft()}${app.crumb('Automatisations')}<div class="tb-side tb-right"></div></header>
    <div class="todo au"><div class="todo-in au-in">
      <div class="td-head"><h1>Automatisations</h1><p class="td-sub">Décris une fois ce que tu veux, Studio le fait pour toi : à la demande, à heure fixe, ou dès qu’il se passe quelque chose.</p></div>
      <div class="au-body"></div>
    </div></div>`;
  need('.au', main).addEventListener('click', e => {
    const t = target(e), tpl = t.closest('[data-tpl]');
    if (tpl) { void useTemplate(tpl.dataset.tpl ?? 'blank'); return; }
    const b = t.closest('[data-au]'), c = t.closest('.au-card'); if (!b || !c) return;
    const a = hub.agentList()[num(c, 'i')]; if (!a) return;
    if (b.dataset.au === 'run') void hub.runAgent(a.spec, a.note);
    if (b.dataset.au === 'edit') app.openNote(a.note.id);
    if (b.dataset.au === 'pause') { const p = !hub.isPaused(a.spec, a.note); hub.setPaused(a.spec, a.note, p); toast(p ? `« ${a.spec.nom} » en pause` : `« ${a.spec.nom} » reprend`); refresh(); }
  });
  refresh();
}
