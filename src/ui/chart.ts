// Petits graphiques de Studio, en HTML (pas de bibliothèque) : histogramme d'une série, jauge, bande d'états.
// Règles : une seule couleur par série, barres fines à bout arrondi posées sur une ligne de base discrète,
// étiquettes sélectives (total en titre, maximum), infobulle au survol, et un tableau lisible par les lecteurs d'écran.
import { esc } from '../lib/markdown.ts';

export interface Point { key: string; label: string; value: number }

export const fmt = (n: number): string => n >= 1e6 ? `${(n / 1e6).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} M` : n >= 1e4 ? `${Math.round(n / 1e3)} k` : n >= 1e3 ? `${(n / 1e3).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} k` : String(n);

/** Les `days` derniers jours (du plus ancien à aujourd'hui), au format AAAA-MM-JJ. */
export function lastDays(days: number, values: Record<string, number>): Point[] {
  const out: Point[] = [], d = new Date();
  d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - days + 1);
  for (let i = 0; i < days; i++) {
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    out.push({ key, label: d.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' }), value: values[key] ?? 0 });
    d.setDate(d.getDate() + 1);
  }
  return out;
}

/** Histogramme d'une série : `unit` nomme ce qui est compté (« commit », « token »). */
export function bars(points: Point[], { color, unit, units = unit + 's', summary }: { color: string; unit: string; units?: string; summary: string }): string {
  const max = Math.max(1, ...points.map(p => p.value)), peak = points.reduce((a, b) => (b.value > a.value ? b : a), points[0] ?? { key: '', label: '', value: 0 });
  const word = (n: number) => `${fmt(n)} ${n > 1 ? units : unit}`;
  return `<figure class="ch" style="--c:var(--c-${color})" role="img" aria-label="${esc(summary)}">
    <div class="ch-plot">${peak.value ? `<span class="ch-max">max ${esc(fmt(peak.value))}</span>` : ''}
      ${points.map(p => `<span class="ch-col" data-tip="${esc(`${p.label} · ${word(p.value)}`)}"><i style="height:${p.value ? Math.max(3, p.value / max * 100) : 0}%"></i></span>`).join('')}</div>
    <figcaption class="ch-x"><span>${esc(points[0]?.label ?? '')}</span><span>aujourd’hui</span></figcaption>
    <table class="sr-only"><caption>${esc(summary)}</caption>${points.filter(p => p.value).map(p => `<tr><th>${esc(p.label)}</th><td>${esc(word(p.value))}</td></tr>`).join('')}</table></figure>`;
}

/** Jauge d'avancement (une seule couleur) : `done` sur `total`. */
export function meter(done: number, total: number, color = 'green'): string {
  const pct = total ? Math.round(done / total * 100) : 0;
  return `<div class="ch-meter" style="--c:var(--c-${color})" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="Avancement ${pct} %"><i style="width:${pct}%"></i></div>`;
}

export interface Run { at: string; state: 'success' | 'failure' | 'pending'; label: string; url?: string }
const STATE: Record<Run['state'], [string, string]> = { success: ['green', 'réussie'], failure: ['red', 'en échec'], pending: ['amber', 'en cours'] };
/** Bande des dernières exécutions de CI, de la plus ancienne à la plus récente (couleur + libellé au survol). */
export function strip(runs: Run[]): string {
  return `<div class="ch-strip" role="list">${runs.map(r => `<a role="listitem" class="ch-run" style="--c:var(--c-${STATE[r.state][0]})" ${r.url ? `href="${esc(r.url)}" target="_blank" rel="noopener"` : ''} data-tip="${esc(`${r.label} · ${STATE[r.state][1]}`)}" aria-label="${esc(`${r.label} : ${STATE[r.state][1]}`)}"></a>`).join('')}</div>`;
}

// ---------- Infobulle partagée ----------
let tip: HTMLElement | null = null;
function show(t: HTMLElement): void {
  tip ??= Object.assign(document.createElement('div'), { className: 'ch-tip' });
  if (!tip.isConnected) document.body.append(tip);
  tip.textContent = t.dataset.tip ?? '';
  const r = t.getBoundingClientRect(), w = tip.offsetWidth;
  tip.style.left = `${Math.min(innerWidth - w - 8, Math.max(8, r.left + r.width / 2 - w / 2))}px`;
  tip.style.top = `${r.top - tip.offsetHeight - 8}px`;
  tip.classList.add('on');
}
/** Active les infobulles des graphiques dans `root` (une seule fois par élément). */
let global = false;
export function bindTips(root: HTMLElement): void {
  if (!global) {
    global = true;
    // L'infobulle disparaît dès que le pointeur quitte un graphique, qu'on fait défiler ou qu'on change de vue.
    document.addEventListener('pointerover', e => { if (!(e.target as HTMLElement).closest?.('[data-tip]')) tip?.classList.remove('on'); }, true);
    addEventListener('scroll', () => tip?.classList.remove('on'), true);
    document.addEventListener('pointerdown', () => tip?.classList.remove('on'), true);
  }
  if (root.dataset.tips) return;
  root.dataset.tips = '1';
  root.addEventListener('pointerover', e => { const t = (e.target as HTMLElement).closest<HTMLElement>('[data-tip]'); if (t && root.contains(t)) show(t); });
  root.addEventListener('pointerout', e => { if ((e.target as HTMLElement).closest('[data-tip]')) tip?.classList.remove('on'); });
}
