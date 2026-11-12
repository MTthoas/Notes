// Rendu Markdown maison (aucune dépendance) avec les blocs intelligents :
// cases à cocher, calculs `= 12 * 4`, minuteurs [timer 25m], tableaux triables, [[liens]] et #tags.
import { evaluate, format } from './calc.ts';
import type { NoteMeta, TaskLine } from '../types.ts';

/** Ce que l'appelant peut brancher sur le rendu : existence des notes liées, blocs de code spéciaux. */
export interface RenderContext {
  exists?: (title: string) => boolean;
  fence?: (lang: string, code: string, index: number) => string | null | undefined;
}
interface RenderState { timer: number; fence: number; ctx: RenderContext }
interface ListItem { indent: number; ordered: boolean; num: number; text: string; line: number }

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const UNESC: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" };

/** Échappe le HTML. Accepte tout type (nombres, identifiants…) pour l'insertion dans les gabarits. */
export const esc = (s: unknown): string => String(s).replace(/[&<>"']/g, c => ESC[c] ?? c);
const unesc = (s: string): string => s.replace(/&(amp|lt|gt|quot|#39);/g, (_, e: string) => UNESC[e] ?? '');

export const TAG_RE = /(^|[\s(>])#([\p{L}\d][\p{L}\d_/-]*)/gu;
export const LINK_RE = /\[\[([^\[\]|\n]+?)(?:\|([^\[\]\n]+))?\]\]/g;
export const TASK_RE = /^(\s*(?:[-*+]|\d{1,9}[.)])\s+)\[([ xX])\]\s+(.*)$/;
const LI_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const HR_RE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const FENCE_RE = /^\s*(```|~~~)\s*([\w-]*)\s*$/;
const HEAD_RE = /^(#{1,6})\s+(.*)$/;
const CALC_RE = /^=\s*(\S.*)$/;
const SEP_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

export function parseDuration(s: string) {
  s = s.trim().toLowerCase();
  let m;
  if ((m = s.match(/^(\d+):(\d{2})(?::(\d{2}))?$/))) return m[3] ? +m[1] * 3600 + +m[2] * 60 + +m[3] : +m[1] * 60 + +m[2];
  if (/^\d+$/.test(s)) return +s * 60;
  let total = 0, rest = s.replace(/(\d+(?:[.,]\d+)?)\s*(h|min|m|s)/g, (_, n, u: string) => {
    total += parseFloat(n.replace(',', '.')) * (u === 'h' ? 3600 : u === 's' ? 1 : 60); return '';
  });
  return rest.trim() || !total ? null : Math.round(total);
}

export function calcHtml(expr: string) {
  try {
    const r = format(evaluate(expr));
    return `<span class="calc" data-copy="${esc(r)}" title="Cliquer pour copier le résultat"><span class="calc-expr">${esc(expr.trim())}</span><span class="calc-res">= ${esc(r)}</span></span>`;
  } catch {
    return `<span class="calc calc-err" title="Expression non reconnue"><span class="calc-expr">${esc(expr.trim())}</span><span class="calc-res">= ?</span></span>`;
  }
}

const safeUrl = (u: string) => /^(https?:|mailto:|#|\/|\.\/)/i.test(u) ? u : null;

function inline(text: string, st: RenderState): string {
  const held: string[] = [];
  const hold = (html: string) => `\u0000${held.push(html) - 1}\u0000`;
  let s = text.replace(/`([^`\n]+)`/g, (_, c) => hold(/^=\s*\S/.test(c) ? calcHtml(c.replace(/^=\s*/, '')) : `<code>${esc(c)}</code>`));
  s = esc(s);
  // Images distantes : jamais chargées automatiquement (une image peut servir de mouchard
  // ou de canal de fuite) — la politique de sécurité de la page les bloquerait de toute façon.
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt, url) => safeUrl(unesc(url)) ? hold(`<a class="ext-img" href="${url}" target="_blank" rel="noopener noreferrer" title="Image distante non chargée">🖼 ${alt || 'image'}</a>`) : m);
  s = s.replace(/\[([^\]\[]+)\]\(([^)\s]+)\)/g, (m, label, url) => safeUrl(unesc(url)) ? hold(`<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`) : m);
  s = s.replace(LINK_RE, (_, title, alias) => {
    const t = unesc(title).trim();
    const missing = st.ctx.exists && !st.ctx.exists(t);
    return hold(`<a class="wikilink${missing ? ' missing' : ''}" data-link="${esc(t)}"${missing ? ' title="Note à créer"' : ''}>${(alias || title).trim()}</a>`);
  });
  s = s.replace(/\[timer\s+([^\]]+)\]/gi, (m, d) => {
    const sec = parseDuration(unesc(d));
    return sec ? hold(`<span class="timer" data-timer="${st.timer++}" data-dur="${sec}"><button class="timer-toggle" aria-label="Démarrer ou mettre en pause"></button><span class="timer-time"></span><button class="timer-reset" aria-label="Réinitialiser" title="Réinitialiser">↺</button></span>`) : m;
  });
  s = s.replace(/https?:\/\/[^\s<\u0000]+[^\s<\u0000.,;:!?)]/g, (u: string) => hold(`<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`));
  s = s.replace(TAG_RE, (m, pre, tag) => /^\d+$/.test(tag) ? m : pre + hold(`<a class="tag" data-tag="${tag.toLowerCase()}">#${tag}</a>`));
  s = s.replace(/\*\*(?!\s)(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(?!\s)([^*]+?)\*/g, '<em>$1</em>')
    .replace(/(^|[\s(])_(?!\s)([^_]+?)_(?=$|[\s).,;:!?])/g, '$1<em>$2</em>')
    .replace(/~~(.+?)~~/g, '<del>$1</del>')
    .replace(/==(.+?)==/g, '<mark>$1</mark>');
  for (let i = 0; i < 4 && s.includes('\u0000'); i++) s = s.replace(/\u0000(\d+)\u0000/g, (_, n) => held[+n]);
  return s;
}

const splitRow = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|'));

function listHtml(items: ListItem[], st: RenderState): string {
  let pos = 0;
  const level = (indent: number): string => {
    const first = items[pos], tag = first.ordered ? 'ol' : 'ul';
    let html = `<${tag}${first.ordered && first.num !== 1 ? ` start="${first.num}"` : ''}>`;
    while (pos < items.length && items[pos].indent >= indent && !(items[pos].indent === indent && items[pos].ordered !== first.ordered)) {
      const it = items[pos++];
      const task = it.text.match(/^\[([ xX])\]\s+(.*)$/);
      let inner = task
        ? `<label class="task-row"><input type="checkbox" data-line="${it.line}"${task[1] !== ' ' ? ' checked' : ''}><span>${inline(task[2], st)}</span></label>`
        : inline(it.text, st);
      while (pos < items.length && items[pos].indent > it.indent) inner += level(items[pos].indent);
      html += `<li${task ? ` class="task${task[1] !== ' ' ? ' done' : ''}"` : ''}>${inner}</li>`;
    }
    return html + `</${tag}>`;
  };
  let html = '';
  while (pos < items.length) html += level(items[pos].indent);
  return html;
}

function blocks(lines: string[], base: number, st: RenderState): string {
  const out: string[] = [];
  const startsBlock = (l: string) => HEAD_RE.test(l) || FENCE_RE.test(l) || /^\s*>/.test(l) || LI_RE.test(l) || HR_RE.test(l) || CALC_RE.test(l);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    let m;
    if (!line.trim()) { i++; continue; }
    if ((m = line.match(FENCE_RE))) {
      const buf = []; i++;
      while (i < lines.length && !new RegExp('^\\s*' + m[1] + '\\s*$').test(lines[i])) buf.push(lines[i++]);
      i++;
      // Blocs spéciaux (```sql, ```schema, ```agent, ```linear…) : rendus par l'application.
      const custom = st.ctx.fence?.(m[2].toLowerCase(), buf.join('\n'), st.fence++);
      out.push(custom ?? `<pre><code>${esc(buf.join('\n'))}</code></pre>`); continue;
    }
    if ((m = line.match(HEAD_RE))) { out.push(`<h${m[1].length}>${inline(m[2], st)}</h${m[1].length}>`); i++; continue; }
    if (HR_RE.test(line)) { out.push('<hr>'); i++; continue; }
    if (/^\s*>/.test(line)) {
      const start = i, buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${blocks(buf, base + start, st)}</blockquote>`); continue;
    }
    if (line.includes('|') && i + 1 < lines.length && lines[i + 1].includes('-') && SEP_RE.test(lines[i + 1]) && (lines[i + 1].includes('|') || !line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').includes('|'))) {
      const head = splitRow(line);
      const align = splitRow(lines[i + 1]).map(c => c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : '');
      i += 2; const rows = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) rows.push(splitRow(lines[i++]));
      const al = (k: number) => align[k] ? ` style="text-align:${align[k]}"` : '';
      out.push(`<div class="table-wrap"><table class="sortable"><thead><tr>${head.map((c, k: number) => `<th${al(k)} title="Cliquer pour trier">${inline(c, st)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${head.map((_, k: number) => `<td${al(k)}>${inline(r[k] || '', st)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if ((m = line.match(CALC_RE))) { out.push(`<p>${calcHtml(m[1])}</p>`); i++; continue; }
    if (LI_RE.test(line)) {
      const items = [];
      while (i < lines.length && lines[i].trim()) {
        const l = lines[i].replace(/\t/g, '    ');
        if ((m = l.match(LI_RE))) items.push({ indent: m[1].length, ordered: /\d/.test(m[2]), num: parseInt(m[2]) || 1, text: m[3], line: base + i });
        else if (/^\s+\S/.test(l) && !FENCE_RE.test(l)) items[items.length - 1].text += ' ' + l.trim();
        else break;
        i++;
      }
      out.push(listHtml(items, st)); continue;
    }
    const buf = [line]; i++;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i])) buf.push(lines[i++]);
    out.push(`<p>${buf.map(l => inline(l, st)).join('<br>')}</p>`);
  }
  return out.join('\n');
}

export function renderMarkdown(src: string, ctx: RenderContext = {}): string {
  return blocks(src.split('\n'), 0, { timer: 0, fence: 0, ctx });
}

// Analyse légère du texte brut : tags, liens, tâches et extrait (hors blocs de code).
export function analyze(body: string): Omit<NoteMeta, "body"> {
  const tags = new Set<string>(), links: string[] = [], tasks: TaskLine[] = [];
  let snippet = '', fence: string | null = null;
  body.split('\n').forEach((raw: string, line: number) => {
    const f = raw.match(FENCE_RE);
    if (f) { fence = fence ? (f[1] === fence ? null : fence) : f[1]; return; }
    if (fence) return;
    const l = raw.replace(/`[^`\n]+`/g, ' ');
    for (const m of l.matchAll(LINK_RE)) links.push(m[1].trim());
    for (const m of l.replace(LINK_RE, ' ').replace(/https?:\/\/\S+/g, ' ').matchAll(TAG_RE)) if (!/^\d+$/.test(m[2])) tags.add(m[2].toLowerCase());
    const t = raw.match(TASK_RE);
    if (t) tasks.push({ line, text: t[3].trim(), done: t[2] !== ' ' });
    if (!snippet && l.trim()) snippet = plain(l).slice(0, 160);
  });
  return { tags: [...tags], links, tasks, snippet };
}

export const plain = (l: string) => l.replace(/^\s*(#{1,6}\s+|>\s?|(?:[-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?)/, '')
  .replace(LINK_RE, (_, t, a) => a || t).replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
  .replace(/(\*\*|~~|==|\*|`)/g, '').trim();
