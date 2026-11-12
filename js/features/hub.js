// Interface des connexions : coffre, IA et agents, Linear, schémas de bases de données,
// appareils liés, et l'accueil en « widgets ». app.js lui fournit quelques fonctions (init).
import * as store from '../core/store.js';
import * as vault from '../core/vault.js';
import * as cr from '../core/crypto.js';
import * as ai from '../integrations/ai.js';
import * as linear from '../integrations/linear/api.js';
import * as notifs from '../integrations/linear/notifications.js';
import * as github from '../integrations/github/api.js';
import * as link from '../integrations/link.js';
import * as schema from '../lib/schema.js';
import * as qr from '../lib/qr.js';
import { renderMarkdown, esc, plain } from '../lib/markdown.js';
import { fold } from '../lib/fuzzy.js';
import { $, $$, el, icon, kbd, rel, modal, confirmBox, toast, download } from '../ui/kit.js';

let app = null;
const read = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* plein */ } };
const titleOf = n => n.title.trim() || 'Sans titre';
const plural = (n, w) => `${n} ${w}${n > 1 ? 's' : ''}`;

export function init(api) {
  app = api;
  link.on(e => {
    if (e.type === 'synced' && (e.got || e.sent)) toast(`Synchronisé avec ${e.name} · ${e.got} reçue(s), ${e.sent} envoyée(s)`);
    if (e.type === 'paired') toast(`Appareil lié : ${e.name}`);
    if (e.type === 'status' || e.type === 'devices') { refreshConnections(); if (app.view() === 'home') app.renderMain(); }
  });
  vault.onChange(refreshConnections);
  document.addEventListener('pointerdown', erDrag);
  setTimeout(tick, 5000); setInterval(tick, 60e3);
  if (vault.isOpen()) startVaultServices();
  const m = location.hash.match(/lier=([0-9A-Za-z-]+)/);
  if (m) { history.replaceState(null, '', location.pathname + location.search); joinDialog(m[1]); }
}

let services = false;
function startVaultServices() { if (services) return; services = true; vault.startAutoLock(); link.startAll(); }

// ---------- Écran de déverrouillage ----------
export function gate() {
  if (!vault.enabled()) return Promise.resolve();
  return new Promise(res => {
    const node = el(`<div class="vault-lock"><form class="lock-card">${icon('shield')}<h3>Studio est verrouillé</h3><p>Tes notes sont chiffrées sur cet appareil.</p><input type="password" placeholder="Mot de passe du coffre" autocomplete="current-password" aria-label="Mot de passe du coffre"><button class="btn btn-primary">Déverrouiller</button>${vault.hasPasskey() ? `<button type="button" class="btn" data-pk>${icon('key')}Face ID / Touch ID</button>` : ''}<p class="lock-err" role="alert"></p></form></div>`);
    document.body.append(node);
    const form = $('form', node), input = $('input', form), err = $('.lock-err', form);
    const done = () => { node.remove(); res(); };
    const fail = msg => { form.classList.remove('busy'); form.classList.add('shake'); setTimeout(() => form.classList.remove('shake'), 400); err.textContent = msg; input.select(); };
    form.addEventListener('submit', async e => {
      e.preventDefault(); if (!input.value) return;
      form.classList.add('busy');
      try { await vault.unlockPassword(input.value); done(); } catch { fail('Mot de passe incorrect.'); }
    });
    $('[data-pk]', form)?.addEventListener('click', async () => {
      try { await vault.unlockPasskey(); done(); } catch (e) { fail(e.name === 'NotAllowedError' ? 'Authentification annulée.' : e.message); }
    });
    input.focus();
  });
}

function askPassword({ title, text, confirm = false, ok = 'Valider' }) {
  return new Promise(res => {
    let done = false;
    const m = modal({ title, cls: 'small', onClose: () => { if (!done) res(null); }, html: `<p class="modal-text">${text}</p><form><input type="password" class="field" placeholder="Mot de passe" autocomplete="${confirm ? 'new-password' : 'current-password'}" required autofocus>${confirm ? '<input type="password" class="field" placeholder="Confirmer" autocomplete="new-password" required>' : ''}<p class="lock-err" role="alert"></p><div class="modal-actions"><button type="button" class="btn" data-x>Annuler</button><button class="btn btn-primary">${esc(ok)}</button></div></form>` });
    $('[data-x]', m.node).onclick = m.close;
    $('form', m.node).onsubmit = e => {
      e.preventDefault();
      const [a, b] = $$('input', m.node);
      if (confirm && a.value !== b.value) { $('.lock-err', m.node).textContent = 'Les deux mots de passe ne correspondent pas.'; return; }
      if (confirm && a.value.length < 10) { $('.lock-err', m.node).textContent = '10 caractères minimum.'; return; }
      done = true; m.close(); res(a.value);
    };
  });
}

// ---------- Sauvegardes ----------
// Coffre actif : la sauvegarde JSON est elle-même chiffrée par un mot de passe choisi à l'export.
export async function sealBackup(json) {
  if (!vault.enabled()) return json;
  const pw = await askPassword({ title: 'Sauvegarde chiffrée', text: 'Le coffre est actif : la sauvegarde sera chiffrée. Choisis le mot de passe qui permettra de la restaurer.', confirm: true, ok: 'Exporter' });
  if (!pw) return null;
  return JSON.stringify({ app: 'carnet', format: 2, exportedAt: new Date().toISOString(), sealed: await cr.sealWithPassword(pw, json) });
}
export async function openBackup(text) {
  const data = JSON.parse(text);
  if (!data.sealed) return text;
  for (;;) {
    const pw = await askPassword({ title: 'Sauvegarde chiffrée', text: 'Saisis le mot de passe choisi lors de l’export.' });
    if (!pw) throw new Error('import annulé');
    try { return await cr.openWithPassword(pw, data.sealed); } catch { toast('Mot de passe incorrect'); }
  }
}
export async function importPacket(text) {
  if (!vault.isOpen()) throw new Error('active le coffre et lie l’appareil d’abord');
  const r = await link.openPacket(text);
  toast(`Paquet de ${r.name} : ${plural(r.count, 'note')} mise(s) à jour`);
}

// ---------- Blocs spéciaux dans les notes ----------
const erModels = new Map(), agentSpecs = new Map(), linHTML = new Map(), linAt = new Map(), running = new Set();
const ER = 'carnet.er';

export function fenceFor(note) {
  erModels.clear(); agentSpecs.clear();
  return (lang, code, idx) => {
    if (lang === 'sql' || lang === 'schema' || lang === 'erd') return erBlock(note, lang, code, idx);
    if (lang === 'agent') return agentBlock(note, code, idx);
    if (lang === 'linear') return linBlock(code);
    return null;
  };
}

function erBlock(note, lang, code, idx) {
  const m = schema.parse(lang === 'sql' ? 'sql' : 'dsl', code);
  if (!m.tables.length) return lang === 'sql' ? null : `<div class="er"><div class="er-bar"><span class="er-stat">${icon('db')}Schéma vide</span></div><p class="er-hint">Une table par ligne, ses colonnes en retrait : <code>id uuid pk</code>, <code>email text unique</code>, <code>bio text?</code>, <code>team_id int &gt; teams.id</code></p></div>`;
  const key = `${note.id}:${idx}`;
  erModels.set(idx, { m, key });
  const pos = schema.layout(m, read(ER, {})[key]);
  return `<div class="er" data-er="${idx}"><div class="er-bar"><span class="er-stat">${icon('db')}${plural(m.tables.length, 'table')} · ${plural(m.rels.length, 'relation')}</span><span class="er-tools">${[['sql', 'Copier SQL'], ['dsl', 'Copier texte'], ['mermaid', 'Copier Mermaid'], ['svg', 'SVG'], ['reset', 'Réorganiser']].map(([a, l]) => `<button data-er-act="${a}">${l}</button>`).join('')}</span></div><div class="er-scroll">${schema.renderSVG(m, pos)}</div>${m.warnings.length ? `<ul class="er-warn">${m.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}<details class="er-src"><summary>Source</summary><pre><code>${esc(code)}</code></pre></details></div>`;
}

function erDrag(e) {
  const g = e.target.closest?.('.er .er-table'); if (!g || e.button > 0) return;
  const box = g.closest('.er'), info = erModels.get(+box.dataset.er); if (!info) return;
  e.preventDefault();
  const scroll = $('.er-scroll', box), pos = schema.layout(info.m, read(ER, {})[info.key]), name = g.dataset.t;
  const s = { x: e.clientX, y: e.clientY, px: pos[name].x, py: pos[name].y };
  scroll.setPointerCapture(e.pointerId); scroll.classList.add('dragging');
  const move = ev => { pos[name].x = Math.max(0, s.px + ev.clientX - s.x); pos[name].y = Math.max(0, s.py + ev.clientY - s.y); scroll.innerHTML = schema.renderSVG(info.m, pos); };
  const up = () => {
    scroll.removeEventListener('pointermove', move); scroll.removeEventListener('pointerup', up); scroll.removeEventListener('pointercancel', up);
    scroll.classList.remove('dragging');
    const all = read(ER, {}); all[info.key] = Object.fromEntries(Object.entries(pos).map(([k, p]) => [k, { x: Math.round(p.x), y: Math.round(p.y) }])); write(ER, all);
  };
  scroll.addEventListener('pointermove', move); scroll.addEventListener('pointerup', up); scroll.addEventListener('pointercancel', up);
}

async function erAction(box, act) {
  const info = erModels.get(+box.dataset.er); if (!info) return;
  const copy = (t, what) => navigator.clipboard?.writeText(t).then(() => toast(`${what} copié`));
  if (act === 'sql') return copy(schema.toSQL(info.m), 'SQL (PostgreSQL)');
  if (act === 'dsl') return copy(schema.toDSL(info.m), 'Schéma texte');
  if (act === 'mermaid') return copy(schema.toMermaid(info.m), 'Diagramme Mermaid');
  if (act === 'svg') { const pos = schema.layout(info.m, read(ER, {})[info.key]); return download('schema.svg', new Blob([schema.standaloneSVG(info.m, pos, document.documentElement.dataset.theme === 'dark')], { type: 'image/svg+xml' })); }
  if (act === 'reset') { const all = read(ER, {}); delete all[info.key]; write(ER, all); app.refreshPreview(); }
}

function linDesc(o) {
  const FR = { unstarted: 'à faire', started: 'en cours', backlog: 'backlog', completed: 'terminées', canceled: 'annulées', triage: 'triage' };
  return [o.assignee === 'me' ? 'assignées à moi' : o.assignee && `assignées à ${o.assignee}`, o.states?.map(x => FR[x] || x).join(', '), o.team && `équipe ${o.team}`, o.project && `projet ${o.project}`, o.search && `« ${o.search} »`].filter(Boolean).join(' · ') || 'issues récentes';
}
function linBlock(code) {
  const o = linear.parseBlock(code), k = JSON.stringify(o);
  return `<div class="lin" data-lin="${esc(k)}"><div class="lin-head">${icon('linear')}<span>Linear · ${esc(linDesc(o))}</span><button class="icon-btn" data-lin-refresh title="Actualiser" aria-label="Actualiser">${icon('refresh')}</button></div><div class="lin-list">${linHTML.get(k) || '<div class="lin-empty">Chargement…</div>'}</div></div>`;
}
const PRIO = ['', '🔴', '🟠', '🟡', '🔵'];
const issueRow = i => `<a class="lin-issue" href="${esc(i.url)}" target="_blank" rel="noopener noreferrer"><i class="lin-dot" style="--c:${esc(i.state?.color || '#999')}" title="${esc(i.state?.name || '')}"></i><span class="lin-id">${esc(i.identifier)}</span><span class="lin-title">${esc(i.title)}</span><span class="lin-meta">${PRIO[i.priority] || ''}${i.dueDate ? ` ${esc(new Date(i.dueDate).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }))}` : ''}${i.assignee ? ` · ${esc(i.assignee.name)}` : ''}</span></a>`;

export async function hydrate(root, fresh = false) {
  for (const box of $$('.lin', root)) {
    const k = box.dataset.lin, list = $('.lin-list', box);
    if (!linear.connected()) { list.innerHTML = `<div class="lin-empty">Linear n’est pas connecté. <button class="link-btn" data-open-conn="linear">Connecter Linear</button></div>`; continue; }
    if (!fresh && linHTML.has(k) && Date.now() - linAt.get(k) < 60e3) continue;
    linAt.set(k, Date.now());
    try {
      const items = await linear.issues(JSON.parse(k), { fresh });
      linHTML.set(k, items.length ? items.map(issueRow).join('') : '<div class="lin-empty">Aucune issue.</div>');
    } catch (e) { linHTML.set(k, `<div class="lin-empty err">${esc(e.message)}</div>`); }
    for (const b of $$(`.lin[data-lin="${CSS.escape(k)}"] .lin-list`)) b.innerHTML = linHTML.get(k);
  }
}

// ---------- Agents ----------
const RUNS = 'carnet.agents';
const setRun = (key, patch) => { const all = read(RUNS, {}); all[key] = { ...all[key], ...patch }; write(RUNS, all); };

function agentBlock(note, code, idx) {
  const s = ai.parseAgent(code), key = `${note.id}:${s.nom}`, st = read(RUNS, {})[key] || {};
  agentSpecs.set(idx, s);
  const prov = ai.PROVIDERS[s.modele || ai.config().provider];
  const last = running.has(key) ? '<span class="ag-live"><span class="spin"></span>En cours…</span>'
    : st.last ? `<span class="${st.ok ? 'ag-ok' : 'ag-err'}">${st.ok ? '✓' : '⚠'} ${esc(rel(st.last))}</span>${st.error ? ` <span class="ag-errmsg">${esc(st.error)}</span>` : ''}` : 'Jamais lancé';
  return `<div class="agent-card" data-agent="${idx}"><div class="ag-head">${icon('bot')}<strong>${esc(s.nom)}</strong><span class="ag-prov">${esc(prov)}</span></div>
    <p class="ag-prompt">${esc(s.consigne.slice(0, 220) || 'Pas encore de consigne : écris-la sous la ligne ---')}${s.consigne.length > 220 ? '…' : ''}</p>
    <div class="ag-meta">${s.outils.map(t => `<span class="ag-chip">${esc(t)}</span>`).join('')}${s.planning ? `<span class="ag-chip">${icon('history')}${esc(s.planning)}</span>` : ''}<span class="ag-chip">→ ${esc(s.sortie)}</span></div>
    <div class="ag-foot"><span class="ag-last">${last}</span><button class="btn btn-primary" data-agent-run="${idx}" ${running.has(key) ? 'disabled' : ''}>${icon('play')}Lancer</button></div></div>`;
}

function approve(action) {
  return new Promise(res => {
    let done = false;
    const m = modal({ title: 'Autoriser cette action ?', cls: 'approve', onClose: () => { if (!done) res(false); },
      html: `<p class="modal-text"><strong>${esc(action.title)}</strong></p>${action.preview ? `<div class="approve-prev md">${renderMarkdown(String(action.preview).slice(0, 6000))}</div>` : ''}<p class="modal-hint">${icon('bot')}Demandé par un agent IA. Relis avant d’accepter : une note piégée pourrait tenter de le manipuler.</p><div class="modal-actions"><button class="btn" data-no autofocus>Refuser</button><button class="btn btn-primary" data-ok>Autoriser</button></div>` });
    $('[data-no]', m.node).onclick = () => m.close();
    $('[data-ok]', m.node).onclick = () => { done = true; m.close(); res(true); };
  });
}

const STEP = { chercher_notes: i => `Recherche « ${i.requete || '…'} »`, lire_note: i => `Lecture de « ${i.titre} »`, lister_taches: () => 'Liste des tâches', creer_note: i => `Création de « ${i.titre} »`, ajouter_a_note: i => `Ajout à « ${i.titre} »`, ajouter_tache: i => `Tâche « ${i.texte} »`, linear_chercher: () => 'Recherche dans Linear', linear_creer_issue: i => `Issue Linear « ${i.titre} »`, lancer_agent: i => `Délégation à l’agent « ${i.nom} »` };

function runEntry(title) {
  let d = $('#runs'); if (!d) { d = el('<div id="runs" aria-live="polite"></div>'); document.body.append(d); }
  const ctrl = new AbortController();
  const node = el(`<div class="run"><div class="run-head"><span class="spin"></span><strong>${esc(title)}</strong><button class="icon-btn" data-x aria-label="Fermer">✕</button></div><div class="run-steps"></div><div class="run-out md"></div></div>`);
  d.append(node);
  $('[data-x]', node).onclick = () => { ctrl.abort(); node.remove(); };
  const steps = $('.run-steps', node);
  return {
    signal: ctrl.signal,
    step: e => { steps.insertAdjacentHTML('beforeend', `<div>${icon('bolt')}${esc((STEP[e.name] || (() => e.name))(e.input || {}))}</div>`); },
    done(text, target) {
      $('.spin', node).outerHTML = `<span class="run-ok">${icon('check')}</span>`;
      $('.run-out', node).innerHTML = renderMarkdown(text.slice(0, 700) + (text.length > 700 ? '…' : '')) + (target ? `<button class="link-btn" data-open-note="${target.id}">Ouvrir « ${esc(titleOf(target))} »</button>` : '');
      if (target) setTimeout(() => { if (!node.matches(':hover')) node.remove(); }, 15000);
    },
    fail(msg) { $('.spin', node).outerHTML = `<span class="run-err">⚠</span>`; $('.run-out', node).innerHTML = `<p class="err">${esc(msg)}</p>`; },
  };
}

async function writeOutput(spec, note, text) {
  const s = fold(spec.sortie || 'journal');
  if (!text || /^aucun/.test(s)) return null;
  const m = spec.sortie.match(/\[\[([^\]]+)\]\]/);
  const target = m ? (store.findByTitle(m[1]) || await store.createNote({ title: m[1].trim() })) : s === 'ici' ? note : await store.dailyNote();
  if (store.isLocked(target)) throw new Error('La note de sortie est verrouillée.');
  await app.flush(target.id);
  await ai.appendTo(target, `### ${spec.nom} ·${new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}\n\n${text}`);
  app.refreshNote(target);
  return target;
}

export async function runAgent(spec, note, auto = false) {
  const key = `${note.id}:${spec.nom}`;
  if (running.has(key)) return;
  running.add(key); app.refreshPreview();
  const r = runEntry(spec.nom + (auto ? ' · planifié' : ''));
  try {
    const out = await ai.runAgent(spec, { approve, onStep: r.step, onWrite: app.refreshNote, signal: r.signal });
    const target = await writeOutput(spec, note, out.text);
    setRun(key, { last: Date.now(), ok: true, error: null });
    r.done(out.text || '(réponse vide)', target);
  } catch (e) {
    setRun(key, { last: Date.now(), ok: false, error: e.name === 'AbortError' ? 'Interrompu' : e.message.slice(0, 160) });
    r.fail(e.name === 'AbortError' ? 'Interrompu.' : e.message);
  } finally { running.delete(key); app.refreshPreview(); if (app.view() === 'home') app.renderMain(); }
}

// Planification : un agent planifié se lance quand son créneau est passé, si l'app est ouverte
// (rattrapage unique si elle était fermée à l'heure prévue).
function tick() {
  if (vault.enabled() && !vault.isOpen()) return;
  const all = read(RUNS, {}); let dirty = false;
  for (const { note, spec } of ai.findAgents()) {
    if (!spec.planning) continue;
    const key = `${note.id}:${spec.nom}`, st = all[key] ||= {};
    if (!st.seen) { st.seen = Date.now(); dirty = true; continue; }
    const slot = ai.lastSlot(spec.planning);
    if (slot && +slot > Math.max(st.last || 0, st.seen) && !running.has(key) && ai.ready(spec.modele || ai.config().provider)) runAgent(spec, note, true);
  }
  if (dirty) write(RUNS, all);
}

// ---------- Demander à l'IA ----------
export function askAI(prefill = '') {
  const n = app.current(), cfg = ai.config();
  const canCtx = !!n && !n.deletedAt && !store.isLocked(n) && ai.shareable(n);
  const m = modal({ cls: 'ask', html: `<div class="cap-head">${icon('sparkle')}<span>Demander à l’IA</span><select class="ask-prov" aria-label="Fournisseur">${Object.entries(ai.PROVIDERS).map(([k, l]) => `<option value="${k}"${k === cfg.provider ? ' selected' : ''}>${l}${ai.ready(k) ? '' : ' — à configurer'}</option>`).join('')}</select></div>
    <textarea rows="3" placeholder="Résume cette note, propose un plan d’action, crée les issues Linear correspondantes…" aria-label="Demande" autofocus>${esc(prefill)}</textarea>
    <div class="ask-opts"><label><input type="checkbox" data-o="ctx"${canCtx ? ' checked' : ' disabled'}> Note ouverte${n && !canCtx ? ' (chiffrée ou #privé : jamais envoyée)' : ''}</label><label><input type="checkbox" data-o="notes" checked> Mes notes</label><label><input type="checkbox" data-o="linear"${linear.connected() ? '' : ' disabled'}> Linear</label><label><input type="checkbox" data-o="agents"> Mes agents</label></div>
    <div class="ask-steps"></div><div class="ask-out md" hidden></div>
    <div class="cap-foot"><span class="ask-status"></span><span class="ask-actions"><button class="btn" data-ins hidden>Ajouter à la note</button><button class="btn" data-new hidden>Nouvelle note</button><button class="btn btn-primary" data-go>Envoyer ${kbd('mod+enter')}</button></span></div>` });
  const ta = $('textarea', m.node), out = $('.ask-out', m.node), status = $('.ask-status', m.node), steps = $('.ask-steps', m.node);
  let text = '', busy = false;
  const go = async () => {
    if (busy || !ta.value.trim()) return;
    const p = $('.ask-prov', m.node).value;
    if (!ai.ready(p)) { m.close(); return openConnections('ia'); }
    busy = true; status.innerHTML = '<span class="spin"></span> Réflexion…'; steps.innerHTML = ''; out.hidden = true;
    const opt = k => $(`[data-o="${k}"]`, m.node).checked;
    try {
      const ctx = opt('ctx') ? `Note ouverte : « ${titleOf(n)} »\n\n${store.getBody(n)}` : '';
      const r = await ai.run({ prompt: ta.value, provider: p, context: ctx, tools: ['notes', 'linear', 'agents'].filter(opt) },
        { approve, onWrite: app.refreshNote, onStep: e => steps.insertAdjacentHTML('beforeend', `<div>${icon('bolt')}${esc((STEP[e.name] || (() => e.name))(e.input || {}))}</div>`) });
      text = r.text; out.innerHTML = renderMarkdown(text || '*(réponse vide)*'); out.hidden = false;
      status.textContent = `Réponse de ${ai.PROVIDERS[p]}`;
      $('[data-ins]', m.node).hidden = !canCtx; $('[data-new]', m.node).hidden = false;
    } catch (e) { status.innerHTML = `<span class="err">${esc(e.message)}</span>`; }
    busy = false;
  };
  $('[data-go]', m.node).onclick = go;
  ta.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); go(); } });
  $('[data-ins]', m.node).onclick = async () => { await app.flush(n.id); await ai.appendTo(n, text); app.refreshNote(n); m.close(); toast('Ajouté à la note'); };
  $('[data-new]', m.node).onclick = async () => { const t = plain(text.split('\n').find(l => l.trim()) || 'Réponse IA').slice(0, 80); const nn = await store.createNote({ title: t, body: text }); m.close(); app.openNote(nn.id); };
}

// ---------- Linear depuis une note ----------
export async function issueFromSelection() {
  if (!linear.connected()) return openConnections('linear');
  const sel = app.selection(); if (!sel) return toast('Ouvre une note et sélectionne du texte (ou place le curseur sur une tâche).');
  const lines = sel.text.split('\n').map(l => plain(l)).filter(Boolean);
  let teams = []; try { teams = await linear.teams(); } catch (e) { return toast('Linear : ' + e.message); }
  const m = modal({ title: 'Nouvelle issue Linear', html: `<form><input class="field" name="t" value="${esc(lines[0] || '')}" placeholder="Titre" required autofocus><textarea class="field area" name="d" rows="4" placeholder="Description (Markdown)">${esc(lines.slice(1).join('\n'))}</textarea><select class="field" name="team">${teams.map(t => `<option value="${t.id}">${esc(t.key)} · ${esc(t.name)}</option>`).join('')}</select><p class="modal-hint">Le lien vers l’issue sera ajouté au bout de la ligne.</p><div class="modal-actions"><button type="button" class="btn" data-x>Annuler</button><button class="btn btn-primary">Créer l’issue</button></div></form>` });
  $('[data-x]', m.node).onclick = m.close;
  $('form', m.node).onsubmit = async e => {
    e.preventDefault(); const f = e.target;
    try {
      const i = await linear.createIssue({ teamId: f.team.value, title: f.t.value, description: f.d.value || undefined });
      m.close(); app.insertAtLineEnd(sel.end, ` [${i.identifier}](${i.url})`); toast(`Issue ${i.identifier} créée`);
    } catch (err) { toast('Linear : ' + err.message); }
  };
}

// ---------- Accueil ----------
// Peu de cartes, chacune utile : ce qu'il y a à faire, les agents, les notes récentes, les appareils.
// État des agents pour l'accueil et la page Agents.
export function agentList() {
  const runs = read(RUNS, {});
  return ai.findAgents().map(({ note, spec }, index) => { const key = `${note.id}:${spec.nom}`, st = runs[key] || {}; return { note, spec, index, live: running.has(key), last: st.last, ok: st.ok }; });
}

// ---------- Clics délégués (renvoie true si traité) ----------
export async function click(e) {
  const t = e.target;
  let x;
  if ((x = t.closest('[data-er-act]'))) { erAction(x.closest('.er'), x.dataset.erAct); return true; }
  if ((x = t.closest('[data-agent-run]'))) { const s = agentSpecs.get(+x.dataset.agentRun), n = app.current(); if (s && n) runAgent(s, n); return true; }
  if ((x = t.closest('[data-lin-refresh]'))) { const box = x.closest('.lin'); linHTML.delete(box.dataset.lin); hydrate(box.parentElement, true); return true; }
  if ((x = t.closest('[data-open-conn]'))) { openConnections(x.dataset.openConn); return true; }
  if ((x = t.closest('[data-open-note]'))) { app.openNote(x.dataset.openNote); return true; }
  if ((x = t.closest('[data-home-agent]'))) { const a = ai.findAgents()[+x.dataset.homeAgent]; if (a) runAgent(a.spec, a.note); return true; }
  if ((x = t.closest('[data-home]'))) {
    const a = x.dataset.home;
    if (a === 'today') app.setView({ type: 'today' });
    if (a === 'sync') { link.syncNow(); toast('Recherche des appareils…'); }
    if (a === 'pair') pairDialog();
    if (a === 'new-agent') newAgentNote();
    return true;
  }
  return false;
}

export const AGENT_TEMPLATE = '```agent\nnom: Mon agent\noutils: notes\nsortie: journal\nplanning:\n---\nDécris ici, en langage naturel, ce que l’agent doit faire.\n```\n';
export const SCHEMA_TEMPLATE = '```schema\nusers\n  id uuid pk\n  email text unique\n  name text?\n\nposts\n  id uuid pk\n  author_id uuid > users.id\n  title text\n  published_at timestamptz?\n```\n';
export async function newAgentNote() {
  const n = await store.createNote({ title: 'Nouvel agent', body: `${AGENT_TEMPLATE}\n#agents` });
  app.openNote(n.id, { edit: true });
}

// ---------- Page « Réglages » ----------
const TABS = [
  ['coffre', 'shield', 'Sécurité', 'Chiffrement de tout le carnet, déverrouillage et verrouillage automatique.'],
  ['ia', 'sparkle', 'Intelligence artificielle', 'Claude, OpenAI ou un modèle local, appelés directement depuis ce navigateur avec ta clé.'],
  ['linear', 'linear', 'Linear', 'Tickets, projets et notifications Linear, sans intermédiaire.'],
  ['github', 'github', 'GitHub', 'L’actualité de tes dépôts, en lecture seule.'],
  ['appareils', 'devices', 'Appareils', 'Relie ton téléphone et tes ordinateurs, sans serveur, chiffré de bout en bout.'],
  ['apparence', 'palette', 'Apparence', 'Thème de l’interface.'],
  ['donnees', 'database', 'Données', 'Sauvegardes, import et export.'],
];
let curTab = 'coffre';
const root = () => $('#main .settings');

export function openConnections(tab = 'coffre') { app.setView({ type: 'settings', tab }); }

export function mountSettings(main, tab) {
  curTab = TABS.some(t => t[0] === tab) ? tab : 'coffre';
  main.innerHTML = `<header class="toolbar">${app.tbLeft()}${app.crumb('Réglages')}<div class="tb-side tb-right"></div></header>
    <div class="settings"><nav class="set-nav" aria-label="Sections">${TABS.map(([k, ic, l]) => `<button data-tab="${k}"${k === curTab ? ' aria-current="page"' : ''}>${icon(ic)}<span>${l}</span></button>`).join('')}</nav>
    <div class="set-scroll"><div class="set-body"></div></div></div>`;
  const r = root();
  r.addEventListener('click', onConnClick);
  r.addEventListener('submit', onConnSubmit);
  r.addEventListener('change', onConnChange);
  refreshConnections();
}

function refreshConnections() {
  const r = root(); if (!r) return;
  const body = $('.set-body', r), focus = document.activeElement?.closest?.('.set-body') ? document.activeElement.name : null;
  const [, , label, lead] = TABS.find(t => t[0] === curTab);
  $$('.set-nav [data-tab]', r).forEach(b => b.toggleAttribute('aria-current', b.dataset.tab === curTab));
  body.innerHTML = `<h1>${label}</h1><p class="set-lead">${lead}</p>` + { coffre: tabVault, ia: tabAI, linear: tabLinear, github: tabGithub, appareils: tabDevices, apparence: tabLook, donnees: tabData }[curTab]();
  if (focus) $(`[name="${focus}"]`, body)?.focus();
  if (curTab === 'github' && github.connected()) github.viewer().then(v => { const x = $('[data-gh-who]', body); if (x) x.textContent = `Connecté : ${v.login}`; }).catch(e => { const x = $('[data-gh-who]', body); if (x) x.textContent = 'Erreur : ' + e.message; });
  if (curTab === 'linear' && linear.connected()) linear.viewer().then(v => { const x = $('.cx-who', body); if (x) x.textContent = `Connecté : ${v.viewer.name} · ${v.organization.name}`; }).catch(e => { const x = $('.cx-who', body); if (x) x.textContent = 'Erreur : ' + e.message; });
  if (curTab === 'donnees') navigator.storage?.estimate?.().then(e => { const x = $('.cx-usage', body); if (x) x.textContent = `${(e.usage / 1048576).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} Mo utilisés sur cet appareil.`; });
}

function tabLook() {
  const t = app.theme();
  return `<section class="cx-sec"><h4>Thème</h4><div class="look">${[['auto', 'Système'], ['light', 'Clair'], ['dark', 'Sombre']].map(([k, l]) => `<label class="look-opt"><input type="radio" name="theme" value="${k}"${t === k ? ' checked' : ''}><span class="look-prev look-${k}"><i></i><i></i><i></i></span><span>${l}</span></label>`).join('')}</div></section>`;
}
function tabData() {
  const n = store.index().live.length;
  return `<section class="cx-sec"><h4>Sauvegarde</h4><p>${plural(n, 'note')}. <span class="cx-usage"></span></p>
    <div class="cx-grid"><button class="btn btn-primary" data-v="export-json">${icon('download')}Exporter une sauvegarde${vault.enabled() ? ' chiffrée' : ''}</button><button class="btn" data-v="export-md">${icon('download')}Markdown (.zip)</button><button class="btn" data-v="import">${icon('upload')}Importer…</button></div>
    <p class="modal-hint">L’import accepte les fichiers Markdown, les sauvegardes JSON (chiffrées ou non) et les paquets <code>.carnet</code> d’un appareil lié.</p></section>`;
}

const needVault = what => `<div class="cx-need">${icon('shield')}<p>${what} sont gardées chiffrées dans le coffre. Active-le d’abord : c’est ce qui garantit qu’aucun secret n’est stocké en clair.</p><button class="btn btn-primary" data-tab="coffre">Activer le coffre</button></div>`;
const keyField = (name, label, ph) => vault.secret(name)
  ? `<div class="cx-key">${icon('key')}<span>${label} enregistrée <code>••••${esc(String(vault.secret(name)).slice(-4))}</code></span><button class="btn btn-danger" data-del-key="${name}">Supprimer</button></div>`
  : `<form class="cx-row" data-key="${name}"><input type="password" class="field" name="k-${name}" placeholder="${ph}" autocomplete="off" spellcheck="false" required><button class="btn btn-primary">Enregistrer</button></form>`;

function tabVault() {
  if (!vault.enabled()) return `<section class="cx-sec"><h4>${icon('shield')}Chiffrer tout le carnet</h4>
    <p>Le coffre chiffre <strong>toutes</strong> les notes, l’historique, les clés API et les appareils liés (AES-256-GCM) avec une clé maîtresse que seul ton mot de passe — ou Face ID / Touch ID — peut ouvrir. Sans lui, les données sur le disque sont illisibles.</p>
    <form data-f="create"><input type="password" class="field" name="p1" placeholder="Mot de passe (10 caractères minimum)" autocomplete="new-password" required><input type="password" class="field" name="p2" placeholder="Confirmer" autocomplete="new-password" required><p class="lock-err" role="alert"></p><button class="btn btn-primary">Activer le coffre</button></form>
    <p class="modal-hint">Aucune récupération possible en cas d’oubli : garde une sauvegarde.</p></section>`;
  const s = vault.settings();
  return `<section class="cx-sec"><h4>${icon('shield')}Coffre actif</h4><p>Base de notes, historique, clés et appareils : chiffrés sur le disque. Restent lisibles : les identifiants techniques des notes et tes préférences d’affichage.</p>
    <div class="cx-grid"><button class="btn" data-v="lock">${icon('lock')}Verrouiller maintenant</button><button class="btn" data-v="pw">Changer le mot de passe…</button></div></section>
    <section class="cx-sec"><h4>${icon('key')}Face ID / Touch ID</h4>${vault.hasPasskey() ? `<p>Une passkey de cet appareil peut ouvrir le coffre.</p><button class="btn" data-v="pk-del">Retirer la passkey</button>`
      : vault.passkeyPossible() ? `<p>Ouvre le coffre avec ta biométrie : une passkey dérive une clé (extension PRF) qui emballe la clé maîtresse. Safari 18+, Chrome récents.</p><button class="btn btn-primary" data-v="pk-add">Ajouter Face ID / Touch ID</button>` : '<p>Ce navigateur ne gère pas les passkeys.</p>'}</section>
    <section class="cx-sec"><h4>${icon('history')}Verrouillage automatique</h4><select class="field" data-autolock>${[[5, '5 minutes'], [15, '15 minutes'], [30, '30 minutes'], [60, '1 heure'], [0, 'Jamais']].map(([v, l]) => `<option value="${v}"${s.autolock === v ? ' selected' : ''}>Après ${l} d’inactivité</option>`).join('').replace('Après Jamais d’inactivité', 'Jamais')}</select></section>
    <section class="cx-sec"><button class="btn btn-danger" data-v="off">Désactiver le coffre…</button></section>`;
}

function tabAI() {
  if (!vault.enabled()) return needVault('Les clés des fournisseurs d’IA');
  const c = ai.config();
  return `<section class="cx-sec"><h4>${icon('sparkle')}Fournisseur par défaut</h4><div class="cx-seg">${Object.entries(ai.PROVIDERS).map(([k, l]) => `<label><input type="radio" name="provider" value="${k}"${c.provider === k ? ' checked' : ''}>${l}</label>`).join('')}</div>
    <p class="modal-hint">Les requêtes partent directement de ce navigateur vers le fournisseur, avec ta clé. Les notes chiffrées et celles taguées <code>#privé</code> ne sont jamais envoyées. Les actions qui modifient quelque chose demandent ton accord.</p></section>
    <section class="cx-sec"><h4>Claude</h4>${keyField('anthropic', 'Clé Anthropic', 'sk-ant-…')}
      <div class="cx-grid"><select class="field" data-cfg="anthropicModel">${ai.CLAUDE_MODELS.map(([v, l]) => `<option value="${v}"${c.anthropicModel === v ? ' selected' : ''}>${l}</option>`).join('')}</select><select class="field" data-cfg="effort">${[['low', 'Effort : faible'], ['medium', 'Effort : moyen'], ['high', 'Effort : élevé'], ['xhigh', 'Effort : très élevé']].map(([v, l]) => `<option value="${v}"${c.effort === v ? ' selected' : ''}>${l}</option>`).join('')}</select></div></section>
    <section class="cx-sec"><h4>OpenAI (ChatGPT)</h4>${keyField('openai', 'Clé OpenAI', 'sk-…')}<input class="field" data-cfg="openaiModel" value="${esc(c.openaiModel)}" placeholder="Modèle, ex. gpt-5" aria-label="Modèle OpenAI"></section>
    <section class="cx-sec"><h4>Modèle local — rien ne quitte ta machine</h4><p class="modal-hint">Ollama ou LM Studio (API compatible OpenAI). Pour Ollama, autorise l’origine de Studio : <code>OLLAMA_ORIGINS=${esc(location.origin)}</code></p><div class="cx-grid"><input class="field" data-cfg="localUrl" value="${esc(c.localUrl)}" placeholder="http://localhost:11434/v1" aria-label="Adresse du serveur local"><input class="field" data-cfg="localModel" value="${esc(c.localModel)}" placeholder="Modèle" aria-label="Modèle local"></div></section>
    <section class="cx-sec"><button class="btn" data-v="test">${icon('play')}Tester le fournisseur par défaut</button><span class="cx-test"></span></section>`;
}

function tabGithub() {
  if (!vault.enabled()) return needVault('Le jeton GitHub');
  return `<section class="cx-sec"><h4>${icon('github')}GitHub</h4>${keyField('github', 'Jeton GitHub', 'github_pat_…')}${github.connected() ? '<p class="cx-who" data-gh-who>Vérification…</p>' : ''}
    <p class="modal-hint">GitHub → Settings → Developer settings → Personal access tokens → <strong>Fine-grained tokens</strong>. Choisis les dépôts à suivre et donne uniquement des droits en <strong>lecture</strong> : Metadata, Contents, Issues, Pull requests. Studio n’écrit jamais sur GitHub, et le jeton ne part que vers <code>api.github.com</code>.</p></section>
    <section class="cx-sec"><h4>Ce que tu verras</h4><p class="modal-hint">La page <button class="link-btn" data-view="github">GitHub</button> réunit l’activité de tes ${12} dépôts les plus récemment actifs : commits poussés, pull requests, issues, commentaires, versions. Elle se met à jour toutes les 5 minutes tant que Studio est ouverte.</p></section>`;
}

function tabLinear() {
  if (!vault.enabled()) return needVault('Les clés Linear');
  return `<section class="cx-sec"><h4>${icon('linear')}Linear</h4>${keyField('linear', 'Clé Linear', 'lin_api_…')}${linear.connected() ? '<p class="cx-who">Vérification…</p>' : ''}
    <p class="modal-hint">Linear → Settings → Security &amp; access → Personal API keys. Donne à la clé <strong>le minimum de droits</strong> (lecture seule suffit pour voir issues et notifications ; l’écriture sert à créer des issues et à marquer les notifications comme lues) et limite-la aux équipes utiles. La clé ne part que vers <code>api.linear.app</code> : la politique de sécurité de la page bloque tout autre domaine.</p></section>
    ${linear.connected() ? `<section class="cx-sec"><h4>${icon('bell')}Notifications</h4>
      <p class="modal-hint">Tes notifications Linear (assignations, mentions, commentaires, changements d’état) arrivent dans la page <button class="link-btn" data-view="linear">Linear</button>, onglet Notifications, avec le nombre de non lues dans la barre latérale. Studio interroge Linear toutes les minutes <strong>tant qu’il est ouvert</strong> : sans serveur, rien ne peut arriver quand l’app est fermée.</p>
      <label class="cx-check"><input type="checkbox" data-nf-sys${notifs.systemOn() ? ' checked' : ''}> Afficher aussi une notification système quand Studio est en arrière-plan</label>
      ${notifs.systemOn() && notifs.systemState() === 'denied' ? '<p class="modal-hint">Les notifications sont bloquées pour ce site : autorise-les dans les réglages du navigateur.</p>' : ''}
      ${notifs.systemState() === 'absent' ? '<p class="modal-hint">Ce navigateur n’affiche pas de notifications système : elles restent visibles dans Studio.</p>' : ''}</section>` : ''}
    <section class="cx-sec"><h4>Dans une note</h4><pre class="cx-code">\`\`\`linear\nassigné: moi\nétat: en cours, à faire\néquipe: ENG\nlimite: 10\n\`\`\`</pre><p class="modal-hint">Palette → « Linear : créer une issue depuis la sélection ». Les agents avec <code>outils: linear</code> peuvent chercher et proposer des issues (création soumise à ton accord).</p></section>`;
}

function tabDevices() {
  if (!vault.enabled()) return needVault('Les clés de liaison des appareils');
  const devs = link.devices(), mine = link.me();
  return `<section class="cx-sec"><h4>${icon('devices')}Cet appareil</h4><form class="cx-row" data-f="rename"><input class="field" name="devname" value="${esc(mine.name)}" aria-label="Nom de cet appareil"><button class="btn">Renommer</button></form></section>
    <section class="cx-sec"><h4>Appareils liés</h4>${devs.length ? devs.map(d => `<div class="cx-dev"><span class="dot ${link.status(d.secret) === 'connecté' ? 'on' : ''}"></span><div><strong>${esc(d.name)}</strong><span>${esc(link.status(d.secret))}${d.lastSync ? ` · synchro ${esc(rel(d.lastSync))}` : ''}</span></div><button class="icon-btn" data-dev-packet="${d.secret}" title="Envoyer un paquet chiffré (AirDrop…)" aria-label="Paquet chiffré">${icon('share')}</button><button class="icon-btn" data-dev-forget="${d.secret}" title="Oublier" aria-label="Oublier">${icon('trash')}</button></div>`).join('') : '<p>Aucun pour l’instant.</p>'}
      <div class="cx-grid"><button class="btn btn-primary" data-v="pair">${icon('phone')}Lier un appareil</button><button class="btn" data-v="join">J’ai un code</button>${devs.length ? `<button class="btn" data-v="sync">${icon('refresh')}Synchroniser</button>` : ''}<button class="btn" data-v="packet-in">Importer un paquet</button></div></section>
    <section class="cx-sec"><label class="cx-check"><input type="checkbox" data-lan${link.lanOnly() ? ' checked' : ''}> Même réseau Wi-Fi uniquement (aucun serveur STUN)</label>
    <p class="modal-hint">Comment ça marche : le code de liaison (128 bits) ne transite par aucun réseau. Il sert à chiffrer une courte poignée de main relayée par <code>ntfy.sh</code> — qui ne voit que du chiffré — puis les notes passent en direct d’appareil à appareil (WebRTC), et en temps réel tant que les deux sont ouverts. Sans réseau : « Paquet chiffré » via AirDrop.</p></section>`;
}

async function onConnClick(e) {
  const t = e.target;
  const tab = t.closest('[data-tab]'); if (tab) return openConnections(tab.dataset.tab);
  const del = t.closest('[data-del-key]'); if (del) { if (await confirmBox({ title: 'Supprimer la clé ?', text: 'Elle sera effacée du coffre de cet appareil.', ok: 'Supprimer', danger: true })) await vault.setSecret(del.dataset.delKey, null); return; }
  const fg = t.closest('[data-dev-forget]'); if (fg) { if (await confirmBox({ title: 'Oublier cet appareil ?', text: 'La liaison sera supprimée ici. Fais de même sur l’autre appareil.', ok: 'Oublier', danger: true })) await link.forget(fg.dataset.devForget); return; }
  const pk = t.closest('[data-dev-packet]'); if (pk) return sendPacket(link.devices().find(d => d.secret === pk.dataset.devPacket));
  const v = t.closest('[data-v]')?.dataset.v; if (!v) return;
  if (v === 'lock') { await app.flushAll(); vault.lock(); }
  if (v === 'pw') {
    const old = await askPassword({ title: 'Mot de passe actuel', text: 'Saisis le mot de passe actuel du coffre.' }); if (!old) return;
    const nw = await askPassword({ title: 'Nouveau mot de passe', text: 'Choisis le nouveau mot de passe.', confirm: true }); if (!nw) return;
    try { await vault.changePassword(old, nw); toast('Mot de passe changé'); } catch { toast('Mot de passe actuel incorrect'); }
  }
  if (v === 'pk-add') { try { await vault.addPasskey(); toast('Face ID / Touch ID activé'); } catch (err) { toast(err.name === 'NotAllowedError' ? 'Opération annulée' : err.message); } }
  if (v === 'pk-del') vault.removePasskey();
  if (v === 'off') {
    const pw = await askPassword({ title: 'Désactiver le coffre', text: 'Les notes seront réécrites <strong>en clair</strong> sur le disque, et les clés API comme les appareils liés seront effacés.', ok: 'Désactiver' }); if (!pw) return;
    try { await app.flushAll(); await vault.disable(pw); toast('Coffre désactivé'); } catch { toast('Mot de passe incorrect'); }
  }
  if (v === 'test') {
    const out = $('.cx-test', root()); out.innerHTML = ' <span class="spin"></span>';
    try { const r = await ai.run({ prompt: 'Réponds uniquement : « Connexion OK ».', tools: [] }); out.textContent = ' ' + r.text.slice(0, 80); } catch (err) { out.innerHTML = ` <span class="err">${esc(err.message)}</span>`; }
  }
  if (v === 'export-json') app.exportJSON();
  if (v === 'export-md') app.exportZip();
  if (v === 'import') app.pickFiles();
  if (v === 'pair') pairDialog();
  if (v === 'join') joinDialog();
  if (v === 'sync') { link.syncNow(); toast('Recherche des appareils…'); }
  if (v === 'packet-in') { const i = el('<input type="file" accept=".carnet" hidden>'); i.onchange = async () => { try { await importPacket(await i.files[0].text()); } catch (err) { toast(err.message); } }; i.click(); }
}

async function onConnSubmit(e) {
  e.preventDefault();
  const f = e.target;
  if (f.dataset.f === 'create') {
    const a = f.p1.value, b = f.p2.value, err = $('.lock-err', f);
    if (a.length < 10) return void (err.textContent = '10 caractères minimum.');
    if (a !== b) return void (err.textContent = 'Les deux mots de passe ne correspondent pas.');
    f.classList.add('busy'); $('button', f).disabled = true; $('button', f).textContent = 'Chiffrement de la base…';
    try { await app.flushAll(); await vault.create(a); startVaultServices(); toast('Coffre activé : tout est chiffré'); const p = sessionStorage.getItem('carnet.pending-link'); if (p) { sessionStorage.removeItem('carnet.pending-link'); joinDialog(p); } }
    catch (x) { err.textContent = x.message; f.classList.remove('busy'); }
    return;
  }
  if (f.dataset.f === 'rename') { link.rename(f.devname.value); toast('Appareil renommé'); return refreshConnections(); }
  if (f.dataset.key) {
    const name = f.dataset.key, val = $('input', f).value.trim(); if (!val) return;
    if (name === 'linear') { try { const v = await linear.viewer(val); toast(`Linear connecté : ${v.viewer.name}`); } catch (x) { return toast('Clé refusée par Linear : ' + x.message); } }
    if (name === 'github') { try { const v = await github.viewer(val); toast(`GitHub connecté : ${v.login}`); } catch (x) { return toast('Jeton refusé par GitHub : ' + x.message); } }
    await vault.setSecret(name, val);
    if (name === 'linear') notifs.poll();
    if (name === 'github') github.poll();
    app.renderSidebar?.();
  }
}

function onConnChange(e) {
  const t = e.target;
  if (t.name === 'provider') ai.setConfig({ provider: t.value });
  else if (t.name === 'theme') app.setTheme(t.value);
  else if (t.dataset.cfg) ai.setConfig({ [t.dataset.cfg]: t.value.trim() });
  else if (t.matches('[data-autolock]')) vault.setSetting('autolock', +t.value);
  else if (t.matches('[data-lan]')) link.setLanOnly(t.checked);
  else if (t.matches('[data-nf-sys]')) { notifs.setSystem(t.checked); if (t.checked && notifs.systemState() === 'default') notifs.askPermission().then(refreshConnections); }
}

// ---------- Liaison ----------
async function pairDialog() {
  if (!vault.isOpen()) return openConnections('coffre');
  const inv = await link.invite();
  const m = modal({ title: 'Lier un appareil', cls: 'pair', html: `<div class="pair-qr">${qr.svg(inv.url)}</div>
    <ol class="pair-steps"><li>Sur l’autre appareil : Réglages → Appareils → <strong>J’ai un code</strong>.</li><li>Colle le lien copié ici (presse-papiers universel entre Mac et iPhone), ou scanne le QR code.</li></ol>
    <div class="pair-code"><code>${inv.pretty}</code><button class="btn" data-copy>${icon('copy')}Copier</button></div>
    <p class="pair-wait"><span class="spin"></span>En attente de l’autre appareil…</p>
    <p class="modal-hint">Ce code est une clé secrète : ne le donne qu’à toi-même. Sur iPhone, si Studio est installé sur l’écran d’accueil, préfère copier-coller : un QR code scanné s’ouvre dans Safari, qui a un stockage séparé.</p>
    <div class="modal-actions"><button class="btn btn-primary" data-x>Fermer</button></div>` });
  $('[data-x]', m.node).onclick = m.close;
  $('[data-copy]', m.node).onclick = () => navigator.clipboard?.writeText(inv.url).then(() => toast('Lien de liaison copié'));
  link.on(e => { if (e.type === 'paired' && m.node.isConnected) $('.pair-wait', m.node).innerHTML = `${icon('check')}Lié à <strong>${esc(e.name)}</strong> — synchronisation en cours.`; });
}

export function joinDialog(prefill = '') {
  if (!vault.isOpen()) {
    if (prefill) sessionStorage.setItem('carnet.pending-link', prefill);
    toast('Active d’abord le coffre : la clé de liaison y sera gardée.');
    return openConnections('coffre');
  }
  const m = modal({ title: 'Rejoindre un appareil', cls: 'small', html: `<p class="modal-text">Colle le lien ou saisis le code affiché sur l’autre appareil.</p><form><input class="field" placeholder="XXXX-XXXX-…" value="${esc(prefill)}" autocomplete="off" spellcheck="false" required autofocus><p class="lock-err" role="alert"></p><div class="modal-actions"><button type="button" class="btn" data-x>Annuler</button><button class="btn btn-primary">Lier</button></div></form>` });
  $('[data-x]', m.node).onclick = m.close;
  $('form', m.node).onsubmit = async e => {
    e.preventDefault();
    try { await link.join($('input', m.node).value); m.close(); toast('Connexion à l’autre appareil…'); }
    catch (x) { $('.lock-err', m.node).textContent = x.message; }
  };
}

async function sendPacket(dev) {
  await app.flushAll();
  const file = await link.packet(dev);
  if (navigator.canShare?.({ files: [file] })) { try { await navigator.share({ files: [file], title: 'Paquet Studio' }); return; } catch (e) { if (e.name === 'AbortError') return; } }
  download(file.name, file);
  toast('Paquet chiffré téléchargé : envoie-le sur l’autre appareil');
}
