// Site vitrine de Studio : quelques effets, aucun traceur, aucune requête.
// Sans ce script, la page reste entièrement lisible (les apparitions ne s'activent qu'avec la classe « js »).
(() => {
  'use strict';
  const root = document.documentElement;
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  root.classList.add('js');

  // Barre de navigation : fond dépoli dès qu'on quitte le haut de page.
  const nav = document.querySelector('[data-nav]');
  const onScroll = () => nav && nav.classList.toggle('scrolled', scrollY > 12);
  addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // Apparition au défilement, décalée entre voisins d'une même grille.
  const items = [...document.querySelectorAll('[data-reveal]')];
  if (calm || !('IntersectionObserver' in window)) items.forEach(el => el.classList.add('in'));
  else {
    const io = new IntersectionObserver(entries => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const el = e.target, brothers = [...el.parentElement.children].filter(x => x.hasAttribute('data-reveal'));
        el.style.setProperty('--d', `${Math.min(brothers.indexOf(el), 5) * 70}ms`);
        el.classList.add('in');
        io.unobserve(el);
        el.querySelectorAll('[data-count]').forEach(count);
      }
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.12 });
    items.forEach(el => io.observe(el));
  }

  // Compteurs : seuls les grands nombres s'animent.
  const fr = new Intl.NumberFormat('fr-FR');
  function count(el) {
    const to = Number(el.dataset.count);
    if (!Number.isFinite(to) || to < 100) return;
    const t0 = performance.now(), ms = 1400;
    const step = now => {
      const k = Math.min(1, (now - t0) / ms), eased = 1 - Math.pow(1 - k, 4);
      el.textContent = fr.format(Math.round(to * eased));
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // Halo qui suit le pointeur sur les cartes.
  for (const card of document.querySelectorAll('[data-spot]')) {
    card.addEventListener('pointermove', e => {
      const r = card.getBoundingClientRect();
      card.style.setProperty('--mx', `${e.clientX - r.left}px`);
      card.style.setProperty('--my', `${e.clientY - r.top}px`);
    });
  }

  // Maquette : elle se redresse au défilement et suit légèrement le pointeur.
  const mock = document.querySelector('[data-tilt]');
  if (mock && !calm) {
    let ry = 0, ticking = false;
    const draw = () => {
      ticking = false;
      const r = mock.getBoundingClientRect();
      const seen = Math.max(0, Math.min(1, (innerHeight - r.top) / (innerHeight * 0.9)));
      mock.style.setProperty('--rx', `${(7 * (1 - seen)).toFixed(2)}deg`);
      mock.style.setProperty('--ry', `${ry.toFixed(2)}deg`);
    };
    const ask = () => { if (!ticking) { ticking = true; requestAnimationFrame(draw); } };
    addEventListener('scroll', ask, { passive: true });
    if (matchMedia('(hover: hover)').matches) {
      mock.addEventListener('pointermove', e => { const r = mock.getBoundingClientRect(); ry = ((e.clientX - r.left) / r.width - 0.5) * 3; ask(); });
      mock.addEventListener('pointerleave', () => { ry = 0; ask(); });
    }
    draw();
  }
})();
