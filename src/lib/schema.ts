// Schémas de bases de données : lit du SQL (CREATE TABLE / ALTER TABLE … FOREIGN KEY)
// ou un mini-langage indenté, puis dessine un diagramme entité-association en SVG.
// Exports : SQL (PostgreSQL), mini-langage, Mermaid. Aucune dépendance.
import { esc } from './markdown.ts';

export interface Column { name: string; type: string; pk: boolean; nn: boolean; uq: boolean; def: string | null; fk?: { table: string; col: string } }
export interface Table { name: string; cols: Column[]; pend?: ['pk' | 'uq', string][] }
export interface Relation { from: string; fromCol: string; to: string; toCol: string; one: boolean; optional: boolean }
interface ForeignKey { table: string; col: string; refTable: string; refCol: string | null; one?: boolean }
interface Draft { tables: Table[]; fks: ForeignKey[]; warnings: string[] }
/** Modèle prêt à dessiner ou à exporter. */
export interface Model { tables: Table[]; rels: Relation[]; warnings: string[] }
export interface Box { x: number; y: number; w: number; h: number }
export type Layout = Record<string, Box>;

const ID = String.raw`(?:"[^"]+"|\x60[^\x60]+\x60|\[[^\]]+\]|[\w$.]+)`;
const unq = (s: string): string => s.trim().replace(/^["`\[]|["`\]]$/g, '').split('.').pop() ?? '';
const listOf = (s: string): string[] => s.split(',').map(unq).filter(Boolean);

function splitTop(s: string, sep: string): string[] { // découpe au niveau 0 (hors parenthèses et guillemets)
  const out: string[] = []; let depth = 0, q: string | null = null, cur = '';
  for (const ch of s) {
    if (q) { if (ch === q) q = null; cur += ch; continue; }
    if (ch === "'" || ch === '"' || ch === '`') q = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === sep && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map(x => x.trim()).filter(Boolean);
}

const model = (): Draft => ({ tables: [], fks: [], warnings: [] });
const table = (m: Draft, name: string): Table => { let t = m.tables.find(x => x.name.toLowerCase() === name.toLowerCase()); if (!t) m.tables.push(t = { name, cols: [] }); return t; };
const col = (t: Table, name: string): Column | undefined => t.cols.find(c => c.name.toLowerCase() === name.toLowerCase());

// ---------- SQL ----------
export function parseSQL(src: string): Model {
  const m = model();
  const clean = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
  for (const stmt of splitTop(clean, ';')) {
    let x: RegExpMatchArray | null;
    if ((x = stmt.match(new RegExp(String.raw`^create\s+(?:(?:temporary|temp|unlogged)\s+)?table\s+(?:if\s+not\s+exists\s+)?(${ID})\s*\(([\s\S]*)\)[^)]*$`, 'i')))) {
      const t = table(m, unq(x[1]));
      for (const item of splitTop(x[2], ',')) {
        let y: RegExpMatchArray | null;
        if ((y = item.match(/^(?:constraint\s+\S+\s+)?primary\s+key\s*\(([^)]+)\)/i))) { for (const c of listOf(y[1])) { t.pend ||= []; t.pend.push(['pk', c]); } continue; }
        if ((y = item.match(new RegExp(String.raw`^(?:constraint\s+\S+\s+)?foreign\s+key\s*\(([^)]+)\)\s*references\s+(${ID})\s*(?:\(([^)]+)\))?`, 'i')))) {
          const from = listOf(y[1]), to = y[3] ? listOf(y[3]) : [];
          const ref = unq(y[2] ?? '');
          from.forEach((c, i) => m.fks.push({ table: t.name, col: c, refTable: ref, refCol: to[i] || null }));
          continue;
        }
        if ((y = item.match(/^(?:constraint\s+\S+\s+)?unique\s*(?:key\s*)?\(([^)]+)\)/i))) { const cs = listOf(y[1] ?? ''); if (cs.length === 1 && cs[0]) { t.pend ||= []; t.pend.push(['uq', cs[0]]); } continue; }
        if (/^(constraint|check|key|index|exclude|fulltext|spatial)\b/i.test(item)) continue;
        if (!(y = item.match(new RegExp(String.raw`^(${ID})\s*([\s\S]*)$`)))) continue;
        const rest = y[2], cut = rest.search(/\b(primary|not\s+null|null|unique|references|default|check|constraint|generated|auto_increment|autoincrement|collate|identity|comment)\b/i);
        const c: Column = { name: unq(y[1] ?? ''), type: (cut < 0 ? rest : rest.slice(0, cut)).trim().replace(/\s+/g, ' ') || '—',
          pk: /primary\s+key/i.test(rest), nn: /not\s+null/i.test(rest) || /primary\s+key/i.test(rest), uq: /\bunique\b/i.test(rest),
          def: (rest.match(/\bdefault\s+('[^']*'|\S+)/i) || [])[1] || null };
        t.cols.push(c);
        const r = rest.match(new RegExp(String.raw`references\s+(${ID})\s*(?:\(\s*(${ID})\s*\))?`, 'i'));
        if (r) m.fks.push({ table: t.name, col: c.name, refTable: unq(r[1]), refCol: r[2] ? unq(r[2]) : null });
      }
      for (const [k, cn] of t.pend || []) { const c = col(t, cn); if (c) { c[k] = true; if (k === 'pk') c.nn = true; } }
      delete t.pend;
    } else if ((x = stmt.match(new RegExp(String.raw`^alter\s+table\s+(?:only\s+)?(?:if\s+exists\s+)?(${ID})\s+add\s+(?:constraint\s+\S+\s+)?foreign\s+key\s*\(([^)]+)\)\s*references\s+(${ID})\s*(?:\(([^)]+)\))?`, 'i')))) {
      const from = listOf(x[2] ?? ''), to = x[4] ? listOf(x[4]) : [], tn = unq(x[1] ?? ''), rn = unq(x[3] ?? '');
      from.forEach((c, i) => m.fks.push({ table: tn, col: c, refTable: rn, refCol: to[i] || null }));
    }
  }
  return finish(m);
}

// ---------- Mini-langage ----------
// users
//   id uuid pk
//   email text unique
//   bio text?            (? = facultatif)
//   team_id uuid > teams.id   (> plusieurs-vers-un, - un-vers-un)
export function parseDSL(src: string): Model {
  const m = model(); let t: Table | null = null;
  src.split('\n').forEach((raw, i) => {
    const line = raw.replace(/\s(\/\/|--).*$/, '').replace(/^(\/\/|--).*$/, '');
    if (!line.trim()) return;
    if (!/^\s/.test(line)) { t = table(m, line.trim().replace(/[:{]\s*$/, '').trim()); return; }
    if (/^\s*}\s*$/.test(line)) return;
    if (!t) { m.warnings.push(`Ligne ${i + 1} : colonne hors d’une table.`); return; }
    const tok = line.trim().split(/\s+/);
    const name = tok.shift() ?? ''; let opt = name.endsWith('?');
    const c: Column = { name: name.replace(/\?$/, ''), type: '—', pk: false, nn: true, uq: false, def: null };
    for (let k = 0; k < tok.length; k++) {
      const w = tok[k] ?? '', lw = w.toLowerCase();
      if (lw === 'pk') c.pk = true;
      else if (lw === 'unique' || lw === 'uq') c.uq = true;
      else if (lw === 'null' || w === '?') opt = true;
      else if (w === '>' || w === '-' || /^[>-]\w/.test(w)) {
        const target = w.length > 1 ? w.slice(1) : tok[++k] || '';
        const [rt, rc] = target.split('.');
        if (rt && t) m.fks.push({ table: t.name, col: c.name, refTable: rt, refCol: rc || null, one: w[0] === '-' });
      } else if (/^default=|^=/.test(lw)) c.def = w.replace(/^default=|^=/i, '');
      else if (c.type === '—') { c.type = w.replace(/\?$/, ''); if (w.endsWith('?')) opt = true; }
    }
    c.nn = c.pk || !opt;
    t.cols.push(c);
  });
  return finish(m);
}

function finish(m: Draft): Model {
  const rels: Relation[] = [];
  for (const fk of m.fks) {
    const t = m.tables.find(x => x.name.toLowerCase() === fk.table.toLowerCase());
    const rt = m.tables.find(x => x.name.toLowerCase() === fk.refTable.toLowerCase());
    if (!t) { m.warnings.push(`Table inconnue : ${fk.table}`); continue; }
    if (!rt) { m.warnings.push(`${fk.table}.${fk.col} référence une table absente : ${fk.refTable}`); continue; }
    const c = col(t, fk.col);
    const rc = fk.refCol ? col(rt, fk.refCol) : rt.cols.find(x => x.pk);
    if (!c) { m.warnings.push(`Colonne inconnue : ${fk.table}.${fk.col}`); continue; }
    if (!rc) { m.warnings.push(`${fk.table}.${fk.col} → ${rt.name}.${fk.refCol || '(clé primaire)'} introuvable`); continue; }
    c.fk = { table: rt.name, col: rc.name };
    rels.push({ from: t.name, fromCol: c.name, to: rt.name, toCol: rc.name, one: !!fk.one || c.uq || (c.pk && t.cols.filter(x => x.pk).length === 1), optional: !c.nn });
  }
  return { tables: m.tables, rels, warnings: m.warnings };
}

export const parse = (lang: string, src: string): Model => lang === 'sql' ? parseSQL(src) : parseDSL(src);

// Ordre des tables : parents (tables référencées) d'abord.
function ordered(m: Model): { depth: Map<string, number>; list: Table[] } {
  const depth = new Map<string, number>(), seen = new Set<string>();
  const d = (name: string): number => {
    const known = depth.get(name); if (known !== undefined) return known;
    if (seen.has(name)) return 0; seen.add(name);
    const parents = m.rels.filter(r => r.from === name && r.to !== name).map(r => d(r.to) + 1);
    const v = Math.max(0, ...parents); depth.set(name, v); return v;
  };
  m.tables.forEach(t => d(t.name));
  return { depth, list: [...m.tables].sort((a, b) => (depth.get(a.name) ?? 0) - (depth.get(b.name) ?? 0)) };
}

// ---------- Exports ----------
export function toSQL(m: Model): string {
  const qi = (s: string) => /^[a-z_][a-z0-9_]*$/.test(s) ? s : `"${s.replace(/"/g, '""')}"`;
  return ordered(m).list.map(t => {
    const pks = t.cols.filter(c => c.pk);
    const lines = t.cols.map(c => {
      let l = `  ${qi(c.name)} ${c.type === '—' ? 'text' : c.type}`;
      if (c.pk && pks.length === 1) l += ' PRIMARY KEY'; else if (c.nn) l += ' NOT NULL';
      if (c.uq && !c.pk) l += ' UNIQUE';
      if (c.def) l += ` DEFAULT ${c.def}`;
      if (c.fk) l += ` REFERENCES ${qi(c.fk.table)}(${qi(c.fk.col)})`;
      return l;
    });
    if (pks.length > 1) lines.push(`  PRIMARY KEY (${pks.map(c => qi(c.name)).join(', ')})`);
    return `CREATE TABLE ${qi(t.name)} (\n${lines.join(',\n')}\n);`;
  }).join('\n\n');
}

export function toDSL(m: Model): string {
  return m.tables.map(t => `${t.name}\n${t.cols.map(c => {
    const rel = m.rels.find(r => r.from === t.name && r.fromCol === c.name);
    return `  ${c.name} ${c.type === '—' ? 'text' : c.type.replace(/\s+/g, '')}${c.nn ? '' : '?'}${c.pk ? ' pk' : ''}${c.uq && !c.pk ? ' unique' : ''}${c.def ? ` default=${c.def}` : ''}${rel ? ` ${rel.one ? '-' : '>'} ${rel.to}.${rel.toCol}` : ''}`;
  }).join('\n')}`).join('\n\n');
}

export function toMermaid(m: Model): string {
  const w = (s: string) => s.replace(/[^\w-]/g, '_');
  return `erDiagram\n${m.tables.map(t => `  ${w(t.name)} {\n${t.cols.map(c => `    ${w(c.type === '—' ? 'text' : c.type)} ${w(c.name)}${[c.pk && 'PK', c.fk && 'FK', c.uq && !c.pk && 'UK'].filter(Boolean).join(',') ? ' ' + [c.pk && 'PK', c.fk && 'FK', c.uq && !c.pk && 'UK'].filter(Boolean).join(',') : ''}`).join('\n')}\n  }`).join('\n')}\n${m.rels.map(r => `  ${w(r.to)} ||--${r.optional ? 'o' : '|'}${r.one ? '|' : '{'} ${w(r.from)} : "${r.fromCol}"`).join('\n')}`;
}

// ---------- Mise en page et rendu ----------
const CH = 7.3, ROW = 22, HEAD = 32, GAPX = 90, GAPY = 30, PAD = 24;

export function layout(m: Model, saved: Record<string, { x: number; y: number }> = {}): Layout {
  const { depth, list } = ordered(m), pos: Layout = {}, colY: Record<number, number> = {};
  const widthOf = (t: Table) => Math.max(150, t.name.length * 8.4 + 40, ...t.cols.map(c => (c.name.length + c.type.length) * CH + 74));
  const colX: number[] = []; // largeur maximale par niveau
  for (const t of list) { const d = depth.get(t.name) ?? 0; colX[d] = Math.max(colX[d] || 0, widthOf(t)); }
  for (const t of list) {
    const d = depth.get(t.name) ?? 0, x = PAD + colX.slice(0, d).reduce((s, w) => s + w + GAPX, 0);
    const y = colY[d] ?? PAD, h = HEAD + t.cols.length * ROW + 6;
    pos[t.name] = { x, y, w: widthOf(t), h };
    colY[d] = y + h + GAPY;
  }
  for (const [name, p] of Object.entries(saved)) { const b = pos[name]; if (b && Number.isFinite(p?.x) && Number.isFinite(p?.y)) Object.assign(b, { x: p.x, y: p.y }); }
  return pos;
}

function edge(r: Relation, pos: Layout, m: Model): string {
  const a = pos[r.from], b = pos[r.to];
  if (!a || !b) return '';
  const ia = m.tables.find(t => t.name === r.from)?.cols.findIndex(c => c.name === r.fromCol) ?? 0;
  const ib = m.tables.find(t => t.name === r.to)?.cols.findIndex(c => c.name === r.toCol) ?? 0;
  const ya = a.y + HEAD + ia * ROW + ROW / 2, yb = b.y + HEAD + ib * ROW + ROW / 2;
  let xa: number, xb: number, da: number, db: number;
  if (b.x + b.w + 20 < a.x) { xa = a.x; da = -1; xb = b.x + b.w; db = 1; }
  else if (a.x + a.w + 20 < b.x) { xa = a.x + a.w; da = 1; xb = b.x; db = -1; }
  else { xa = a.x + a.w; da = 1; xb = b.x + b.w; db = 1; } // même colonne : la liaison contourne par la droite
  const bend = Math.max(40, Math.abs(xa - xb) / 2);
  const path = `M${xa},${ya} C${xa + da * bend},${ya} ${xb + db * bend},${yb} ${xb},${yb}`;
  // Côté enfant : patte d'oie (plusieurs) ou barre (un) ; côté parent : barre (un), cercle si facultatif.
  const many = r.one ? `M${xa + da * 10},${ya - 6}v12` : `M${xa},${ya - 6}L${xa + da * 12},${ya}L${xa},${ya + 6}M${xa + da * 12},${ya - 6}v12`;
  const one = `M${xb + db * 8},${yb - 6}v12M${xb + db * 13},${yb - 6}v12`;
  const opt = r.optional ? `<circle cx="${xb + db * 21}" cy="${yb}" r="3.5" class="er-opt"/>` : '';
  return `<g class="er-rel" data-from="${esc(r.from)}" data-to="${esc(r.to)}"><path d="${path}" class="er-line"/><path d="${many} ${one}" class="er-mark"/>${opt}<title>${esc(`${r.from}.${r.fromCol} → ${r.to}.${r.toCol}`)}</title></g>`;
}

export function renderSVG(m: Model, pos: Layout): string {
  const W = Math.max(...Object.values(pos).map(p => p.x + p.w), 200) + PAD;
  const H = Math.max(...Object.values(pos).map(p => p.y + p.h), 80) + PAD;
  const tables = m.tables.map(t => {
    const p = pos[t.name];
    if (!p) return '';
    const rows = t.cols.map((c, i) => {
      const y = HEAD + i * ROW + ROW / 2 + 4;
      const badge = c.pk ? '<tspan class="er-pk">PK</tspan>' : c.fk ? '<tspan class="er-fk">FK</tspan>' : c.uq ? '<tspan class="er-uq">UQ</tspan>' : '';
      return `<text x="12" y="${y}" class="er-badge">${badge}</text><text x="38" y="${y}" class="er-col${c.pk ? ' pk' : ''}">${esc(c.name)}${c.nn ? '' : '<tspan class="er-null">?</tspan>'}</text><text x="${p.w - 12}" y="${y}" class="er-type" text-anchor="end">${esc(c.type)}</text>`;
    }).join('');
    return `<g class="er-table" data-t="${esc(t.name)}" transform="translate(${p.x},${p.y})"><rect width="${p.w}" height="${p.h}" rx="9" class="er-box"/><path d="M0,9a9,9 0 0 1 9,-9h${p.w - 18}a9,9 0 0 1 9,9v${HEAD - 9}h-${p.w}z" class="er-head"/><text x="12" y="21" class="er-name">${esc(t.name)}</text>${rows}</g>`;
  }).join('');
  return `<svg class="er-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Schéma de base de données">${m.rels.map(r => edge(r, pos, m)).join('')}${tables}</svg>`;
}

// SVG autonome (couleurs figées) pour l'export.
export function standaloneSVG(m: Model, pos: Layout, dark = false): string {
  const c = dark ? { bg: '#1c1c1e', box: '#2c2c2e', head: '#3a3a3d', text: '#f5f5f7', mute: '#a1a1a6', line: '#6c6c72', acc: '#0a84ff' }
    : { bg: '#ffffff', box: '#ffffff', head: '#f1f1f4', text: '#1d1d1f', mute: '#6e6e73', line: '#a3a3a8', acc: '#007aff' };
  const css = `<style>text{font:12px ui-monospace,Menlo,monospace;fill:${c.text}}.er-name{font:600 13px -apple-system,sans-serif}.er-type,.er-null{fill:${c.mute}}.er-badge{font-size:9.5px;font-weight:700}.er-pk{fill:#c98a00}.er-fk{fill:${c.acc}}.er-uq{fill:${c.mute}}.er-box{fill:${c.box};stroke:${c.line}}.er-head{fill:${c.head}}.er-line,.er-mark{fill:none;stroke:${c.line};stroke-width:1.3}.er-opt{fill:${c.bg};stroke:${c.line}}</style><rect width="100%" height="100%" fill="${c.bg}"/>`;
  return renderSVG(m, pos).replace(/(<svg[^>]*>)/, `$1${css}`);
}
