// Recherche floue, insensible aux accents et à la casse.
export const fold = s => s.normalize('NFC').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function fuzzy(query, text) {
  const q = fold(query).replace(/\s+/g, ' ').trim();
  if (!q) return { score: 0, pos: [] };
  const t = fold(text);
  const at = t.indexOf(q);
  if (at >= 0) {
    const pos = Array.from({ length: q.length }, (_, i) => at + i);
    const start = at === 0 ? 200 : /[\s\-_/.#]/.test(t[at - 1]) ? 100 : 0;
    return { score: 1000 + start - at * 2 - (t.length - q.length) * 0.5, pos };
  }
  let ti = 0, score = 0, prev = -2; const pos = [];
  for (const c of q) {
    if (c === ' ') continue;
    const i = t.indexOf(c, ti);
    if (i < 0) return null;
    score += 10;
    if (i === prev + 1) score += 15;
    if (i === 0 || /[\s\-_/.#]/.test(t[i - 1])) score += 12;
    score -= (i - ti);
    pos.push(i); prev = i; ti = i + 1;
  }
  return { score: score - t.length * 0.2, pos };
}
