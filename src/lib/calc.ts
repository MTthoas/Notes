// Petit évaluateur d'expressions pour les calculs inline (`= 12 * 4`). Aucun eval.
const FN: Record<string, (...a: number[]) => number> = {
  sqrt: Math.sqrt, abs: Math.abs, round: Math.round, floor: Math.floor, ceil: Math.ceil,
  min: Math.min, max: Math.max, sin: Math.sin, cos: Math.cos, tan: Math.tan,
  log: Math.log10, ln: Math.log, exp: Math.exp,
  racine: Math.sqrt, arrondi: (x: number, n = 0) => Math.round(x * 10 ** n) / 10 ** n,
  somme: (...a: number[]) => a.reduce((s, x) => s + x, 0),
  moyenne: (...a: number[]) => a.reduce((s, x) => s + x, 0) / a.length,
};
const CONST: Record<string, number> = { pi: Math.PI, e: Math.E };

type Token = { t: 'n'; v: number } | { t: 'id'; v: string; call: boolean } | { t: string; v?: undefined };

function tokenize(src: string): Token[] {
  const out: Token[] = [], stack: string[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i] ?? '';
    if (/\s/.test(c) || c === ' ' || c === ' ') { i++; continue; }
    if (/\d/.test(c) || (c === '.' && /\d/.test(src[i + 1] || ''))) {
      let j = i, seenDot = false;
      while (j < src.length) {
        const d = src[j] ?? '';
        if (/\d/.test(d)) j++;
        else if (!seenDot && (d === '.' || (d === ',' && stack[stack.length - 1] !== 'f')) && /\d/.test(src[j + 1] || '')) { seenDot = true; j++; }
        else break;
      }
      out.push({ t: 'n', v: parseFloat(src.slice(i, j).replace(',', '.')) }); i = j; continue;
    }
    if (/[a-zA-Zà-ÿπ]/.test(c)) {
      let j = i; while (j < src.length && /[a-zA-Zà-ÿπ0-9_]/.test(src[j] ?? '')) j++;
      const id = src.slice(i, j).toLowerCase(); let k = j;
      while (src[k] === ' ') k++;
      out.push({ t: 'id', v: id === 'π' ? 'pi' : id, call: src[k] === '(' }); i = j; continue;
    }
    if (c === '(') { const p = out[out.length - 1]; stack.push(p && p.t === 'id' && 'call' in p && p.call ? 'f' : 'p'); out.push({ t: '(' }); i++; continue; }
    if (c === ')') { stack.pop(); out.push({ t: ')' }); i++; continue; }
    const op = ({ '×': '*', '÷': '/', '−': '-', ';': ',' } as Record<string, string>)[c] || c;
    if ('+-*/^%,'.includes(op)) { out.push({ t: op }); i++; continue; }
    throw new Error('caractère inattendu');
  }
  return out;
}

export function evaluate(src: string): number {
  const tk = tokenize(src); let p = 0;
  const peek = (): string | undefined => tk[p]?.t;
  const eat = (t: string): void => { if (peek() !== t) throw new Error('syntaxe'); p++; };
  const expr = (): number => { let v = term(); while (peek() === '+' || peek() === '-') v = tk[p++]?.t === '+' ? v + term() : v - term(); return v; };
  const term = (): number => {
    let v = unary();
    for (;;) {
      if (peek() === '*') { p++; v *= unary(); }
      else if (peek() === '/') { p++; v /= unary(); }
      else if (peek() === '(' || peek() === 'id') v *= unary(); // multiplication implicite
      else return v;
    }
  };
  const unary = (): number => peek() === '-' ? (p++, -unary()) : peek() === '+' ? (p++, unary()) : power();
  const power = (): number => { const b = postfix(); return peek() === '^' ? (p++, b ** unary()) : b; };
  const postfix = (): number => { let v = atom(); while (peek() === '%') { p++; v /= 100; } return v; };
  const atom = (): number => {
    const t = tk[p];
    if (!t) throw new Error('incomplet');
    if (t.t === 'n' && typeof t.v === 'number') { p++; return t.v; }
    if (t.t === '(') { p++; const v = expr(); eat(')'); return v; }
    if (t.t === 'id' && typeof t.v === 'string') {
      p++;
      const fn = FN[t.v];
      if ('call' in t && t.call) {
        if (!fn) throw new Error('fonction inconnue');
        eat('('); const args: number[] = [];
        if (peek() !== ')') { args.push(expr()); while (peek() === ',') { p++; args.push(expr()); } }
        eat(')'); return fn(...args);
      }
      const k = CONST[t.v];
      if (k !== undefined) return k;
      throw new Error('nom inconnu');
    }
    throw new Error('syntaxe');
  };
  const v = expr();
  if (p < tk.length) throw new Error('syntaxe');
  if (typeof v !== 'number' || !isFinite(v)) throw new Error('indéfini');
  return v;
}

const nf = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 4 });
export const format = (v: number): string => nf.format(Math.abs(v) < 1e-12 ? 0 : v);
