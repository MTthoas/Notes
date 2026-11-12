// Petite boîte à outils d'interface : icônes, menus, fenêtres modales, toasts, formats.
import { esc } from '../lib/markdown.js';

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const el = html => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };

const I = {
  today: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M2.5 12h2M19.5 12h2M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
  notes: '<path d="M6 3.5h8.5L19 8v12.5H6z"/><path d="M14 3.5V8.5h5M9.5 13h5.5M9.5 16.5h5.5"/>',
  inbox: '<path d="M3.5 13.5l3-8.5h11l3 8.5v5.5h-17z"/><path d="M3.5 13.5h5l1 2.5h5l1-2.5h5"/>',
  hourglass: '<path d="M7 3.5h10M7 20.5h10M8.5 3.5v3.5L12 12l3.5-5V3.5M8.5 20.5V17L12 12l3.5 5v3.5"/>',
  trash: '<path d="M4.5 7h15M10 11v6M14 11v6M6.5 7l1 13h9l1-13M9.5 7V4.5h5V7"/>',
  graph: '<circle cx="6" cy="7" r="2.3"/><circle cx="18" cy="9" r="2.3"/><circle cx="11" cy="18" r="2.3"/><path d="M8.3 7.4l7.4 1.2M7 9.1l3 6.8M16.5 10.8l-4 5.4"/>',
  hash: '<path d="M5 9h14M5 15h14M10 4.5L8 19.5M16 4.5l-2 15"/>',
  compose: '<path d="M11.5 5H5v14h14v-6.5"/><path d="M18.3 3.7a1.9 1.9 0 012.7 2.7l-9 9-3.6.9.9-3.6z"/>',
  search: '<circle cx="11" cy="11" r="6.3"/><path d="M15.8 15.8l4.7 4.7"/>',
  lock: '<rect x="5" y="11" width="14" height="9.5" rx="2.2"/><path d="M8.2 11V8a3.8 3.8 0 017.6 0v3"/>',
  unlock: '<rect x="5" y="11" width="14" height="9.5" rx="2.2"/><path d="M8.2 11V8a3.8 3.8 0 017.3-1.5"/>',
  history: '<path d="M4 12a8 8 0 102.5-5.8L4 8.5"/><path d="M4 4.5v4h4M12 8v4.3l2.8 1.8"/>',
  pin: '<path d="M9 4h6l-.8 5.5L17 12.5v2H7v-2l2.8-3z"/><path d="M12 14.5v6"/>',
  more: '<circle cx="5.5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.4" fill="currentColor" stroke="none"/>',
  sidebar: '<rect x="3" y="5" width="18" height="14" rx="2.8"/><path d="M9 5v14"/>',
  focus: '<path d="M4.5 9V4.5H9M19.5 9V4.5H15M4.5 15v4.5H9M19.5 15v4.5H15"/>',
  bolt: '<path d="M13 2.5L5.5 13.5h5.5l-1 8 7.5-11H12z"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
  pencil: '<path d="M4.5 19.5l1-4L16.6 4.4a2 2 0 012.9 2.9L8.5 18.5z"/>',
  split: '<rect x="3" y="5" width="18" height="14" rx="2.8"/><path d="M12 5v14"/>',
  download: '<path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19.5h14"/>',
  upload: '<path d="M12 15V4M7.5 8.5L12 4l4.5 4.5M5 19.5h14"/>',
  back: '<path d="M14.5 5.5L8 12l6.5 6.5"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  github: '<path d="M9.5 20.5v-3c-3.5 1-4.5-1.5-5.5-2M14.5 20.5v-3.2c0-1 .1-1.6-.5-2.3 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 00-1.3-3.2 4.2 4.2 0 00-.1-3.2s-1-.3-3.4 1.3a11.8 11.8 0 00-6 0C6.3 2.3 5.3 2.6 5.3 2.6a4.2 4.2 0 00-.1 3.2A4.6 4.6 0 004 9c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2.3"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0013 0M12 18v3"/>',
  bell: '<path d="M6 16.5V11a6 6 0 0112 0v5.5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 004 0"/>',
  moon: '<path d="M20 14.5A8 8 0 019.5 4a8 8 0 1010.5 10.5z"/>',
  link: '<path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  restore: '<path d="M4 12a8 8 0 102.5-5.8L4 8.5"/><path d="M4 4.5v4h4"/>',
  keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2.5"/><path d="M6.5 10h.01M10 10h.01M13.5 10h.01M17 10h.01M7.5 14h9"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6.5a2 2 0 00-2-2h-7a2 2 0 00-2 2v7a2 2 0 002 2h2"/>',
  home: '<path d="M4 10.5L12 4l8 6.5V20h-5.5v-5.5h-5V20H4z"/>',
  bot: '<circle cx="6" cy="6.5" r="2.5"/><circle cx="18" cy="17.5" r="2.5"/><path d="M8.5 6.5H14a4 4 0 014 4V15"/><path d="M15.6 12.6L18 15l2.4-2.4"/>',
  sparkle: '<path d="M4.5 6.5a2 2 0 012-2h11a2 2 0 012 2v8a2 2 0 01-2 2H11l-4.5 3.5V16.5a2 2 0 01-2-2z"/><path d="M9 10.5h.01M12 10.5h.01M15 10.5h.01"/>',
  db: '<ellipse cx="12" cy="6" rx="7" ry="2.8"/><path d="M5 6v12c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8V6M5 12c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8"/>',
  shield: '<path d="M12 3.5l7 2.8v5.4c0 4.4-3 7.6-7 8.8-4-1.2-7-4.4-7-8.8V6.3z"/><path d="M9 12l2.2 2.2L15.5 10"/>',
  key: '<circle cx="8" cy="15" r="3.8"/><path d="M10.7 12.3L19 4M16 7l2.5 2.5M14 9l2 2"/>',
  phone: '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M10.5 18.5h3"/>',
  devices: '<rect x="2.5" y="5" width="13" height="9.5" rx="1.5"/><path d="M1.5 18h15"/><rect x="17" y="8" width="5.5" height="11" rx="1.3"/>',
  play: '<path d="M8 5.5v13l10.5-6.5z"/>',
  refresh: '<path d="M19.5 12a7.5 7.5 0 11-2.2-5.3L19.5 9"/><path d="M19.5 4.5V9H15"/>',
  linear: '<path d="M4.2 13.6l6.2 6.2M3.6 10.2l10.2 10.2M4.8 6.9l12.3 12.3M7.5 4.5l12 12M11 3.6l9.4 9.4"/>',
  plug: '<path d="M9 3.5v4M15 3.5v4M6.5 7.5h11v3.5a5.5 5.5 0 01-11 0zM12 16.5v4"/>',
  share: '<path d="M12 15V3.5M7.5 8L12 3.5 16.5 8M5.5 12v7.5h13V12"/>',
  chevron: '<path d="M8 10l4 4 4-4"/>',
  chevronRight: '<path d="M10 8l4 4-4 4"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7"/>',
  palette: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v17M12 3.5a8.5 8.5 0 010 17"/>',
  database: '<ellipse cx="12" cy="6" rx="7" ry="2.8"/><path d="M5 6v12c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8V6"/>',
};
// Marque : un cercle vermillon, un signet incliné découpé en creux (reprend l'icône de l'application).
export const logo = () => `<svg class="logo" viewBox="0 0 20 20" aria-hidden="true"><circle cx="4.2" cy="10" r="2.7" fill="currentColor"/><rect x="10" y="1" width="2.4" height="18" rx="1.2" fill="#F04A23"/></svg>`;
export const icon = name => `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${I[name] || ''}</svg>`;

// Raccourcis : 'mod+shift+k' -> ⇧⌘K sur Mac, Ctrl+Shift+K ailleurs.
export function keys(combo) {
  if (!combo) return '';
  const p = combo.split('+'), key = p.pop();
  const k = key === 'enter' ? (isMac ? '↵' : 'Entrée') : key === 'esc' ? (isMac ? 'esc' : 'Échap') : key.toUpperCase();
  if (isMac) return ['ctrl', 'alt', 'shift', 'mod'].filter(m => p.includes(m)).map(m => ({ ctrl: '⌃', alt: '⌥', shift: '⇧', mod: '⌘' }[m])).join('') + k;
  return [...['mod', 'ctrl', 'alt', 'shift'].filter(m => p.includes(m)).map(m => ({ mod: 'Ctrl', ctrl: 'Ctrl', alt: 'Alt', shift: 'Maj' }[m])), k].join('+');
}
export const kbd = combo => combo ? `<kbd>${esc(keys(combo))}</kbd>` : '';

export function matches(e, combo) {
  const p = combo.split('+'), key = p.pop();
  const mod = isMac ? e.metaKey : e.ctrlKey, ctrl = isMac ? e.ctrlKey : false;
  if (p.includes('mod') !== mod || p.includes('shift') !== e.shiftKey || p.includes('alt') !== e.altKey || (isMac && p.includes('ctrl') !== ctrl)) return false;
  const code = e.code || '';
  const k = e.altKey && code.startsWith('Key') ? code.slice(3).toLowerCase() : (e.key || '').toLowerCase();
  return k === key;
}

// ---------- Dates ----------
const sameDay = (a, b) => a.toDateString() === b.toDateString();
export function rel(ts) {
  const d = new Date(ts), now = new Date(), diff = now - d;
  if (diff < 60e3) return 'à l’instant';
  if (diff < 3600e3) return `il y a ${Math.floor(diff / 60e3)} min`;
  if (sameDay(d, now)) return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  if (sameDay(d, new Date(now - 864e5))) return 'hier';
  return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
}
export function until(ts) {
  const s = (ts - Date.now()) / 1000;
  if (s <= 0) return 'expirée';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min`;
  if (s < 86400) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} j`;
}
export const full = ts => new Date(ts).toLocaleString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });

// ---------- Calques (menus, modales) : Échap ferme toujours celui du dessus ----------
const stack = [];
export const topLayer = () => stack[stack.length - 1];
export function closeTop() { const l = stack.pop(); if (l) l.close(true); return !!l; }
function pushLayer(node, onClose) {
  const prev = document.activeElement;
  const layer = { node, close(fromStack) {
    if (!fromStack) { const i = stack.indexOf(layer); if (i < 0) return; stack.splice(i, 1); }
    node.remove(); onClose?.(); if (prev && prev.isConnected) prev.focus({ preventScroll: true });
  } };
  stack.push(layer); $('#layer').append(node);
  return layer;
}

export function menu(anchor, items) {
  if (topLayer()?.node.classList.contains('menu-backdrop')) closeTop();
  const node = el(`<div class="menu-backdrop"><div class="menu" role="menu">${items.map((it, i) => it === '-' ? '<div class="menu-sep"></div>'
    : it.label && !it.run ? `<div class="menu-label">${esc(it.label)}</div>`
    : `<button role="menuitem" class="menu-item${it.danger ? ' danger' : ''}" data-i="${i}">${it.checked !== undefined ? `<span class="menu-check">${it.checked ? icon('check') : ''}</span>` : it.icon ? icon(it.icon) : ''}<span class="menu-text">${esc(it.label)}</span>${it.hint ? `<span class="menu-hint">${esc(it.hint)}</span>` : ''}${kbd(it.keys)}</button>`).join('')}</div></div>`);
  const layer = pushLayer(node);
  const m = node.firstElementChild;
  const r = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y };
  const w = m.offsetWidth, h = m.offsetHeight;
  let x = anchor.getBoundingClientRect ? r.right - w : r.left; if (x < 8) x = Math.min(r.left, innerWidth - w - 8);
  let y = r.bottom + 6; if (y + h > innerHeight - 8) y = Math.max(8, r.top - h - 6);
  m.style.left = Math.max(8, Math.min(x, innerWidth - w - 8)) + 'px'; m.style.top = y + 'px';
  node.addEventListener('mousedown', e => { if (e.target === node) { e.preventDefault(); layer.close(); } });
  node.addEventListener('contextmenu', e => { e.preventDefault(); if (e.target === node) layer.close(); });
  const btns = $$('.menu-item', m);
  m.addEventListener('click', e => { const b = e.target.closest('.menu-item'); if (!b) return; layer.close(); items[+b.dataset.i].run(); });
  m.addEventListener('mousemove', e => e.target.closest('.menu-item')?.focus({ preventScroll: true }));
  m.addEventListener('keydown', e => {
    const i = btns.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); btns[(i + 1) % btns.length].focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); btns[(i - 1 + btns.length) % btns.length].focus(); }
    if (e.key === 'Tab') e.preventDefault();
  });
  m.tabIndex = -1; m.focus({ preventScroll: true });
  return layer;
}

export function modal({ title, html, cls = '', onClose }) {
  const node = el(`<div class="backdrop"><div class="modal ${cls}" role="dialog" aria-modal="true">${title ? `<h3 class="modal-title">${esc(title)}</h3>` : ''}<div class="modal-body">${html}</div></div></div>`);
  const layer = pushLayer(node, onClose);
  node.addEventListener('mousedown', e => { if (e.target === node) layer.close(); });
  node.addEventListener('keydown', e => { // garde le focus dans la fenêtre
    if (e.key !== 'Tab') return;
    const f = $$('button, input, textarea, select, [tabindex]:not([tabindex="-1"])', node).filter(x => !x.disabled && x.offsetParent);
    if (!f.length) return;
    const i = f.indexOf(document.activeElement);
    if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
    else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
  });
  ($('[autofocus]', node) || $('input, textarea, button', node))?.focus();
  return { node, body: $('.modal-body', node), close: () => layer.close() };
}

export function confirmBox({ title, text, ok = 'OK', danger = false }) {
  return new Promise(res => {
    let done = false;
    const m = modal({ title, cls: 'small', html: `<p class="modal-text">${esc(text)}</p><div class="modal-actions"><button class="btn" data-x>Annuler</button><button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok autofocus>${esc(ok)}</button></div>`, onClose: () => { if (!done) res(false); } });
    $('[data-x]', m.node).onclick = () => m.close();
    $('[data-ok]', m.node).onclick = () => { done = true; m.close(); res(true); };
  });
}

export function toast(text, action) {
  const t = el(`<div class="toast"><span>${esc(text)}</span>${action ? `<button>${esc(action.label)}</button>` : ''}</div>`);
  if (action) $('button', t).onclick = () => { t.remove(); action.run(); };
  $('#toasts').append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 250); }, action ? 6000 : 3200);
}

export function download(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob instanceof Blob ? blob : new Blob([blob], { type: 'text/plain;charset=utf-8' }));
  a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
