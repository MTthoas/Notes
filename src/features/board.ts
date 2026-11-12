// Kanban générique : colonnes de cartes, glisser-déposer à la souris, et boutons « ‹ › »
// pour déplacer une carte au clavier ou au doigt (le glisser-déposer HTML ne marche pas partout sur iPhone).
import { esc } from '../lib/markdown.ts';
import { $$, target } from '../ui/kit.ts';

export interface Column {
  key: string;
  label: string;
  /** Teinte de la pastille de colonne (nom de la palette : gray, amber, green…). */
  tone: string;
  cards: string[];
}

export function boardHTML(cols: Column[]): string {
  return `<div class="kb" role="list">${cols.map((c, i) => `<section class="kb-col" data-col="${esc(c.key)}" data-i="${i}" aria-label="${esc(c.label)}">
    <header class="kb-head"><i class="kb-dot" style="--c:var(--c-${esc(c.tone)})"></i><span>${esc(c.label)}</span><em class="kb-count">${c.cards.length}</em></header>
    <div class="kb-cards">${c.cards.join('') || '<p class="kb-empty">Dépose une carte ici</p>'}</div></section>`).join('')}</div>`;
}

/** Boutons de déplacement d'une carte (insérés dans chaque carte). */
export const moveButtons = (first: boolean, last: boolean): string =>
  `<span class="kb-move">${first ? '' : '<button class="icon-btn" data-kb-move="-1" title="Colonne précédente" aria-label="Colonne précédente">‹</button>'}${last ? '' : '<button class="icon-btn" data-kb-move="1" title="Colonne suivante" aria-label="Colonne suivante">›</button>'}</span>`;

/**
 * Branche le glisser-déposer et les boutons sur une racine stable (le contenu peut être redessiné).
 * `onMove` reçoit la carte et la clé de la colonne d'arrivée ; il fait le changement réel.
 */
export function bind(root: HTMLElement, onMove: (card: HTMLElement, col: string) => void | Promise<void>): void {
  let dragging: HTMLElement | null = null;
  const colOf = (el: Element | null) => el?.closest<HTMLElement>('.kb-col') ?? null;
  const clear = () => $$('.kb-col.over', root).forEach(c => c.classList.remove('over'));
  const move = (card: HTMLElement, col: HTMLElement | null) => {
    const from = colOf(card), key = col?.dataset.col;
    if (!col || !key || col === from) return;
    void onMove(card, key);
  };

  root.addEventListener('dragstart', e => {
    const card = target(e).closest<HTMLElement>('.kb-card'); if (!card) return;
    dragging = card; card.classList.add('dragging');
    e.dataTransfer?.setData('text/plain', card.dataset.key ?? '');
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  });
  root.addEventListener('dragover', e => {
    const col = colOf(target(e)); if (!dragging || !col) return;
    e.preventDefault();
    if (!col.classList.contains('over')) { clear(); col.classList.add('over'); }
  });
  root.addEventListener('dragleave', e => { const col = colOf(target(e)); if (col && !col.contains(e.relatedTarget as Node | null)) col.classList.remove('over'); });
  root.addEventListener('drop', e => {
    const col = colOf(target(e)), card = dragging; if (!card || !col) return;
    e.preventDefault(); clear(); move(card, col);
  });
  root.addEventListener('dragend', () => { dragging?.classList.remove('dragging'); dragging = null; clear(); });

  root.addEventListener('click', e => {
    const b = target(e).closest<HTMLElement>('[data-kb-move]'); if (!b) return;
    e.stopPropagation();
    const card = b.closest<HTMLElement>('.kb-card'), from = colOf(card); if (!card || !from) return;
    const cols = $$('.kb-col', root), next = cols[cols.indexOf(from) + Number(b.dataset.kbMove)] ?? null;
    move(card, next);
  });
}

/** Déplacement optimiste d'une carte (avant la réponse du serveur, pour Linear). */
export function place(card: HTMLElement, root: HTMLElement, col: string): void {
  const dest = $$('.kb-col', root).find(c => c.dataset.col === col);
  const box = dest?.querySelector('.kb-cards'); if (!dest || !box) return;
  box.querySelector('.kb-empty')?.remove();
  box.prepend(card);
  for (const c of $$('.kb-col', root)) { const n = c.querySelectorAll('.kb-card').length, em = c.querySelector('.kb-count'); if (em) em.textContent = String(n); }
}
