// Vue en graphe : disposition par forces sur un canvas. Pensé pour le trackpad
// (défilement à deux doigts = déplacement, pincement = zoom).
export interface GraphInput { id: string; title: string; ghost?: boolean }
export interface GraphNode extends GraphInput { x: number; y: number; vx: number; vy: number; deg: number; adj: Set<GraphNode> }
export interface Graph { redraw(): void; zoom(f: number): void; reset(): void; destroy(): void }
type Point = { x: number; y: number };

export function createGraph(canvas: HTMLCanvasElement, { nodes: input, edges: links, currentId, onOpen }:
  { nodes: GraphInput[]; edges: { a: string; b: string }[]; currentId: string | null; onOpen: (n: GraphNode) => void }): Graph {
  const c2d = canvas.getContext('2d');
  if (!c2d) throw new Error('Canvas 2D indisponible');
  const ctx = c2d;
  const css = (v: string) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  let W = 0, H = 0, dpr = 1, raf = 0, alpha = 1, alive = true;
  const view = { x: 0, y: 0, k: 1 };
  const nodes = input.map(n => ({ ...n, x: 0, y: 0, vx: 0, vy: 0, deg: 0, adj: new Set<GraphNode>() }));
  const byId = new Map<string, GraphNode>(nodes.map(n => [n.id, n]));
  const R = 60 + Math.sqrt(nodes.length) * 40;
  nodes.forEach((n, i) => {
    const a = i * 2.399963; const r = R * Math.sqrt((i + 0.5) / nodes.length);
    n.x = Math.cos(a) * r; n.y = Math.sin(a) * r;
  });
  const edges = links.flatMap(e => { const a = byId.get(e.a), b = byId.get(e.b); return a && b ? [{ a, b }] : []; });
  for (const e of edges) { e.a.deg++; e.b.deg++; e.a.adj.add(e.b); e.b.adj.add(e.a); }
  const radius = (n: GraphNode) => 4 + Math.min(n.deg, 10) * 0.7;
  let hover: GraphNode | null = null, drag: GraphNode | null = null, pan: Point | null = null, moved = false;

  function resize() {
    const r = canvas.getBoundingClientRect();
    dpr = window.devicePixelRatio || 1; W = r.width; H = r.height;
    canvas.width = W * dpr; canvas.height = H * dpr;
    kick(0.05);
  }

  function step() {
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i]!;
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j]!;
        let dx = a.x - b.x, dy = a.y - b.y, d2 = dx * dx + dy * dy;
        if (d2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1; }
        if (d2 > 250000) continue;
        const f = 2600 / d2 * alpha, d = Math.sqrt(d2);
        a.vx += dx / d * f; a.vy += dy / d * f; b.vx -= dx / d * f; b.vy -= dy / d * f;
      }
      a.vx -= a.x * 0.012 * alpha; a.vy -= a.y * 0.012 * alpha;
    }
    for (const e of edges) {
      const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y, d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = (d - 150) * 0.03 * alpha;
      e.a.vx += dx / d * f; e.a.vy += dy / d * f; e.b.vx -= dx / d * f; e.b.vy -= dy / d * f;
    }
    for (const n of nodes) {
      if (n === drag) { n.vx = n.vy = 0; continue; }
      n.vx *= 0.82; n.vy *= 0.82; n.x += n.vx; n.y += n.vy;
    }
    alpha *= 0.985;
  }

  function draw() {
    const fg = css('--text'), dim = css('--text-3'), sep = css('--graph-edge'), accent = css('--accent'), bg = css('--bg');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.translate(W / 2 + view.x, H / 2 + view.y); ctx.scale(view.k, view.k);
    const lit = (n: GraphNode) => !hover || n === hover || hover.adj.has(n);
    ctx.lineWidth = 1 / view.k;
    for (const e of edges) {
      const on = hover && (e.a === hover || e.b === hover);
      ctx.globalAlpha = hover && !on ? 0.25 : 1;
      ctx.strokeStyle = on ? accent : sep;
      ctx.beginPath(); ctx.moveTo(e.a.x, e.a.y); ctx.lineTo(e.b.x, e.b.y); ctx.stroke();
    }
    const showAll = nodes.length <= 40 || view.k > 1.3;
    ctx.font = `${11 / view.k}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (const n of nodes) {
      const r = radius(n);
      ctx.globalAlpha = lit(n) ? 1 : 0.2;
      ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, 6.2832);
      if (n.ghost) { ctx.fillStyle = bg; ctx.fill(); ctx.strokeStyle = dim; ctx.setLineDash([2 / view.k, 2 / view.k]); ctx.stroke(); ctx.setLineDash([]); }
      else { ctx.fillStyle = n.id === currentId || n === hover ? accent : n.deg ? fg : dim; ctx.fill(); }
      if (n.id === currentId) { ctx.globalAlpha *= 0.25; ctx.beginPath(); ctx.arc(n.x, n.y, r + 4 / view.k, 0, 6.2832); ctx.strokeStyle = accent; ctx.lineWidth = 3 / view.k; ctx.stroke(); ctx.lineWidth = 1 / view.k; ctx.globalAlpha = lit(n) ? 1 : 0.2; }
      if (showAll || (hover && lit(n)) || n.id === currentId) {
        ctx.fillStyle = n === hover ? fg : css('--text-2');
        const label = n.title.length > 28 ? n.title.slice(0, 27) + '…' : n.title;
        ctx.fillText(label, n.x, n.y + r + 4 / view.k);
      }
    }
    ctx.globalAlpha = 1;
  }

  function frame() {
    raf = 0; if (!alive) return;
    if (alpha > 0.02) step();
    draw();
    if (alpha > 0.02 || drag) raf = requestAnimationFrame(frame);
  }
  const kick = (a: number) => { alpha = Math.max(alpha, a); if (!raf) raf = requestAnimationFrame(frame); };

  const toWorld = (e: MouseEvent): Point => { const r = canvas.getBoundingClientRect(); return { x: (e.clientX - r.left - W / 2 - view.x) / view.k, y: (e.clientY - r.top - H / 2 - view.y) / view.k }; };
  const pick = (p: Point): GraphNode | null => { let best: GraphNode | null = null, bd = Infinity; for (const n of nodes) { const d = Math.hypot(n.x - p.x, n.y - p.y); if (d < radius(n) + 8 / view.k && d < bd) { best = n; bd = d; } } return best; };

  const down = (e: PointerEvent) => { const p = toWorld(e); moved = false; drag = pick(p); if (!drag) pan = { x: e.clientX - view.x, y: e.clientY - view.y }; canvas.setPointerCapture(e.pointerId); };
  const move = (e: PointerEvent) => {
    const p = toWorld(e);
    if (drag) { drag.x = p.x; drag.y = p.y; moved = true; kick(0.3); }
    else if (pan) { view.x = e.clientX - pan.x; view.y = e.clientY - pan.y; moved = true; kick(0.03); }
    else { const h = pick(p); if (h !== hover) { hover = h; canvas.style.cursor = h ? 'pointer' : 'grab'; kick(0.03); } }
  };
  const up = () => { const n = drag; drag = pan = null; if (n && !moved) onOpen(n); };
  const wheel = (e: WheelEvent) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const r = canvas.getBoundingClientRect(), mx = e.clientX - r.left - W / 2, my = e.clientY - r.top - H / 2;
      const k = Math.min(4, Math.max(0.25, view.k * Math.exp(-e.deltaY * 0.01)));
      view.x = mx - (mx - view.x) * k / view.k; view.y = my - (my - view.y) * k / view.k; view.k = k;
    } else { view.x -= e.deltaX; view.y -= e.deltaY; }
    kick(0.03);
  };
  canvas.addEventListener('pointerdown', down); canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', up); canvas.addEventListener('wheel', wheel, { passive: false });
  canvas.addEventListener('pointerleave', () => { if (hover) { hover = null; kick(0.03); } });
  const ro = new ResizeObserver(resize); ro.observe(canvas);
  const mq = matchMedia('(prefers-color-scheme: dark)'); const redraw = () => kick(0.03); mq.addEventListener('change', redraw);
  canvas.style.cursor = 'grab';
  resize();
  return { redraw, zoom: (f: number) => { view.k = Math.min(4, Math.max(0.25, view.k * f)); kick(0.03); }, reset: () => { view.x = view.y = 0; view.k = 1; kick(0.03); }, destroy() { alive = false; cancelAnimationFrame(raf); ro.disconnect(); mq.removeEventListener('change', redraw); } };
}
