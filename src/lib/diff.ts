// Diff ligne à ligne (LCS), avec repli quand les textes sont très longs.
function lcs(a: string[], b: string[]) {
  const n = a.length, m = b.length;
  const w = m + 1, t = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      t[i * w + j] = a[i] === b[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
  const ops = []; let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ t: '=', s: a[i] }); i++; j++; }
    else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) ops.push({ t: '-', s: a[i++] });
    else ops.push({ t: '+', s: b[j++] });
  }
  while (i < n) ops.push({ t: '-', s: a[i++] });
  while (j < m) ops.push({ t: '+', s: b[j++] });
  return ops;
}

export function diff(a: string[], b: string[]) {
  // Préfixe et suffixe communs retirés d'abord : garde la table LCS petite.
  let s = 0; while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let e = 0; while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
  const ma = a.slice(s, a.length - e), mb = b.slice(s, b.length - e);
  const mid = ma.length * mb.length > 4e6
    ? [...ma.map((x: string) => ({ t: '-', s: x })), ...mb.map((x: string) => ({ t: '+', s: x }))]
    : lcs(ma, mb);
  return [...a.slice(0, s).map((x: string) => ({ t: '=', s: x })), ...mid, ...a.slice(a.length - e).map((x: string) => ({ t: '=', s: x }))];
}

export const diffLines = (a: string, b: string) => diff(a.split('\n'), b.split('\n'));
export const diffWords = (a: string, b: string) => diff(a.split(/(\s+)/), b.split(/(\s+)/));
