// Curseur d'écriture plus fin pour la zone de saisie des notes.
// Le curseur natif d'un champ de texte prend toute la hauteur de la ligne : avec 1,7 d'interligne,
// c'est une grande barre de près de 30 px. On le masque et on dessine à sa place un curseur
// de la hauteur du texte, placé grâce à un double invisible du champ.
// Si quoi que ce soit échoue, le curseur natif revient.

const NATIVE_OK = () => !matchMedia('(pointer: fine)').matches; // tactile : le système gère son propre curseur

export function attach(ta: HTMLTextAreaElement) {
  if (NATIVE_OK() || !ta?.parentElement) return;
  const host = ta.parentElement, bar = document.createElement('i');
  bar.className = 'caret'; bar.hidden = true; bar.setAttribute('aria-hidden', 'true');
  host.append(bar);

  const mirror = document.createElement('div'), mark = document.createElement('span');
  mark.textContent = '​';
  let composing = false, frame = 0;

  function place() {
    frame = 0;
    try {
      const cs = getComputedStyle(ta);
      if (composing || document.activeElement !== ta || ta.selectionStart !== ta.selectionEnd) { bar.hidden = true; return; }
      for (const p of ['fontFamily', 'fontSize', 'fontWeight', 'letterSpacing', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'tabSize', 'lineHeight'] as const) mirror.style[p] = cs[p];
      Object.assign(mirror.style, { position: 'absolute', visibility: 'hidden', pointerEvents: 'none', whiteSpace: 'pre-wrap', overflowWrap: 'break-word', boxSizing: 'border-box', width: ta.clientWidth + 'px', top: 0, left: 0 });
      mirror.textContent = ta.value.slice(0, ta.selectionStart);
      mirror.append(mark);
      host.append(mirror);
      const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5, h = Math.round(parseFloat(cs.fontSize) * 1.25);
      const x = mark.offsetLeft - ta.scrollLeft, y = mark.offsetTop - ta.scrollTop + (lh - h) / 2;
      mirror.remove();
      if (y < -h / 2 || y > ta.clientHeight - h / 2) { bar.hidden = true; return; } // le curseur est hors de la zone visible
      bar.style.cssText = `height:${h}px;transform:translate(${Math.round(ta.offsetLeft + x)}px,${Math.round(ta.offsetTop + y)}px)`;
      bar.hidden = false;
      bar.classList.remove('blink'); void bar.offsetWidth; bar.classList.add('blink'); // plein pendant la frappe, puis il clignote
      ta.classList.add('own-caret');
    } catch { bar.hidden = true; ta.classList.remove('own-caret'); mirror.remove(); }
  }
  const soon = () => { if (!frame) frame = requestAnimationFrame(place); };

  for (const ev of ['input', 'keydown', 'keyup', 'mouseup', 'mousedown', 'focus', 'blur', 'scroll', 'select']) ta.addEventListener(ev, soon);
  ta.addEventListener('compositionstart', () => { composing = true; soon(); });
  ta.addEventListener('compositionend', () => { composing = false; soon(); });
  new ResizeObserver(soon).observe(ta);
  document.addEventListener('selectionchange', function onSel() {
    if (!ta.isConnected) return document.removeEventListener('selectionchange', onSel); // le champ a été remplacé
    if (document.activeElement === ta) soon();
  });
  soon();
}
