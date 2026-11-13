// Revue IA des changements d'un projet : le diff est lu en local (app Mac), montré avant envoi,
// puis relu par l'IA branchée dans Studio. Rien ne part sans un clic explicite.
import * as store from '../../core/store.ts';
import * as native from '../../core/native.ts';
import * as ai from '../../integrations/ai.ts';
import * as usage from '../../integrations/usage.ts';
import { esc, renderMarkdown } from '../../lib/markdown.ts';
import { icon, modal, need, toast, errMsg } from '../../ui/kit.ts';
import type { Project } from './model.ts';

const PROMPT = `Fais la revue de code de ces changements, comme un relecteur senior exigeant.
Classe tes remarques par gravité : **Bloquant**, **Important**, **Mineur**. Pour chacune : le fichier (et la ligne si possible), le problème, la correction proposée, en une ou deux phrases.
Regarde en priorité : bugs et régressions probables, sécurité (secrets, injections, données non validées), cas limites, cohérence avec le reste du code. Puis lisibilité.
Pas de compliments ni de résumé du diff. S'il n'y a rien de grave, dis-le en une ligne.
Termine par les corrections à faire, en cases - [ ].`;

export async function review(p: Project, scope: 'working' | 'branch'): Promise<void> {
  if (!native.available()) { toast('La revue lit les changements du dossier : disponible dans l’app Studio pour Mac.'); return; }
  if (!ai.ready()) { toast('Connecte d’abord une IA (Réglages → Intelligence artificielle).'); return; }
  const d = await native.call('project', 'diff', { project: p.id, scope }, 30000);
  if (!d.ok) { toast(d.message ?? 'Impossible de lire les changements.'); return; }
  const patch = String(d.patch ?? ''), stat = String(d.stat ?? '').trim(), untracked = String(d.untracked ?? '').trim();
  if (!patch.trim()) { toast(scope === 'working' ? 'Aucun changement non commité à relire.' : `Aucune différence avec ${String(d.base)}.`); return; }
  const lines = patch.split('\n').length, provider = ai.PROVIDERS[ai.config().provider];
  const m = modal({ cls: 'rv', title: scope === 'working' ? 'Revue des changements non commités' : `Revue de la branche (par rapport à ${String(d.base)})`, html: `
    <pre class="rv-stat">${esc(stat || '(aucune statistique)')}</pre>
    ${untracked ? `<p class="modal-hint">Fichiers nouveaux non suivis (non relus) : ${esc(untracked.split('\n').slice(0, 8).join(', '))}${untracked.split('\n').length > 8 ? '…' : ''}</p>` : ''}
    <p class="modal-hint">${icon('shield')}Le diff (${lines.toLocaleString('fr-FR')} lignes${d.truncated ? ', tronqué' : ''}) sera envoyé à <strong>${esc(provider)}</strong> pour relecture. Vérifie qu’il ne contient pas de secret.</p>
    <div class="rv-out md" hidden></div><p class="rv-status"></p>
    <div class="modal-actions"><button class="btn" data-x>Fermer</button><button class="btn" data-save hidden>${icon('notes')}Enregistrer dans le projet</button><button class="btn btn-primary" data-go>${icon('sparkle')}Lancer la revue</button></div>` });
  need('[data-x]', m.node).onclick = m.close;
  let text = '';
  need('[data-go]', m.node).onclick = async () => {
    const go = need<HTMLButtonElement>('[data-go]', m.node), status = need('.rv-status', m.node), out = need('.rv-out', m.node);
    go.disabled = true; status.innerHTML = '<span class="spin"></span> Relecture en cours…';
    const before = usage.all();
    try {
      const r = await ai.run({ prompt: PROMPT, tools: [], context: `Projet : ${p.name}\nChangements (${scope === 'working' ? 'non commités' : 'de la branche'}) :\n\n${stat}\n\n\`\`\`diff\n${patch}\n\`\`\`` });
      text = r.text;
      out.innerHTML = renderMarkdown(text || '*(réponse vide)*'); out.hidden = false;
      status.textContent = `Relu par ${ai.PROVIDERS[r.provider]} · ${usage.fmt(usage.all() - before)} tokens`;
      need('[data-save]', m.node).hidden = false; go.hidden = true;
    } catch (e) { status.innerHTML = `<span class="err">${esc(errMsg(e))}</span>`; go.disabled = false; }
  };
  need('[data-save]', m.node).onclick = async () => {
    const title = `Revue ${scope === 'working' ? 'des changements' : 'de la branche'} · ${new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })}`;
    await store.createNote({ title, body: `${text}\n\n\`\`\`\n${stat}\n\`\`\`\n\n#${p.tag}` });
    m.close(); toast('Revue enregistrée dans le projet');
  };
}
