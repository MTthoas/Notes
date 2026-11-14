// Site vitrine de Studio : deux effets discrets, aucun traceur, aucune requête.
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

  // Apparition au défilement.
  const items = [...document.querySelectorAll('[data-reveal]')];
  if (calm || !('IntersectionObserver' in window)) items.forEach(el => el.classList.add('in'));
  else {
    const io = new IntersectionObserver(entries => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add('in');
        io.unobserve(e.target);
      }
    }, { rootMargin: '0px 0px -6% 0px', threshold: 0.08 });
    items.forEach(el => io.observe(el));
  }
})();
