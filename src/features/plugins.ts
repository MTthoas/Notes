// Réglages → Extensions : la liste des plugins optionnels, à activer un par un, avec leurs réglages.
// La page se construit sur ce que chaque plugin déclare dans le registre (champs, domaines, panneau).
import * as registry from '../plugins/registry.ts';
import * as vault from '../core/vault.ts';
import { esc } from '../lib/markdown.ts';
import { icon, toast, confirmBox } from '../ui/kit.ts';
import type { Field, Plugin } from '../plugins/registry.ts';

const optional = (): Plugin[] => registry.list().filter(p => p.optional);
const needsVault = (p: Plugin): boolean => !!p.vault || !!p.settings?.some(f => f.secret);

function field(p: Plugin, f: Field): string {
  const a = registry.api(p), ref = `${p.id}:${f.key}`, name = `px-${p.id}-${f.key}`;
  const hint = f.hint ? `<p class="modal-hint">${f.hint}</p>` : '';
  if (f.kind === 'check') return `<label class="cx-check"><input type="checkbox" data-px-check="${ref}"${a.get(f.key) ? ' checked' : ''}> ${esc(f.label)}</label>${hint}`;
  if (f.secret && a.secret(f.key)) return `<div class="cx-key">${icon('key')}<span>${esc(f.label)} enregistrée <code>••••${esc(a.secret(f.key).slice(-4))}</code></span><button class="btn btn-danger" data-px-del="${ref}">Supprimer</button></div>${hint}`;
  return `<label class="px-label" for="${name}">${esc(f.label)}</label><form class="cx-row" data-px-form="${ref}"><input ${f.secret ? 'type="password" ' : ''}class="field" id="${name}" name="${name}" value="${f.secret ? '' : esc(a.get(f.key))}" placeholder="${esc(f.placeholder ?? '')}" autocomplete="off" spellcheck="false"${f.secret ? ' required' : ''}><button class="btn btn-primary">Enregistrer</button></form>${hint}`;
}

function card(p: Plugin): string {
  const on = registry.active(p);
  const locked = needsVault(p) && !vault.isOpen();
  const body = !on ? '' : locked
    ? `<p class="modal-hint">${icon('shield')} Les jetons et adresses secrètes de ${esc(p.name)} sont gardés chiffrés dans le coffre. <button class="link-btn" data-tab="coffre">Active-le d’abord</button>.</p>`
    : `${(p.settings ?? []).map(f => field(p, f)).join('')}${p.panel?.(registry.api(p)) ?? ''}`;
  return `<section class="cx-sec px${on ? ' on' : ''}"><div class="px-head">${icon(p.icon ?? 'plug')}<div><h4>${esc(p.name)}</h4><p>${esc(p.description ?? '')}</p></div>
    <label class="cx-check"><input type="checkbox" data-px-on="${esc(p.id)}"${on ? ' checked' : ''}> Activer</label></div>
    ${p.hosts?.length ? `<p class="px-hosts">Ne contacte que ${p.hosts.map(h => `<code>${esc(h)}</code>`).join(', ')}.</p>` : ''}${body}</section>`;
}

export const html = (): string => optional().map(card).join('')
  + `<p class="modal-hint">Une extension ne tourne que lorsqu’elle est activée, et seulement tant que Studio est ouvert : sans serveur, rien ne se passe quand l’app est fermée. Elle ne peut joindre que les domaines affichés, les seuls ouverts par la politique de sécurité de Studio.</p>`;

const parts = (ref: string | undefined): { p: Plugin; f: Field } | null => {
  const [id = '', key = ''] = (ref ?? '').split(':'), p = registry.get(id), f = p?.settings?.find(x => x.key === key);
  return p && f ? { p, f } : null;
};

export function onChange(t: HTMLInputElement, refresh: () => void): boolean {
  if (t.dataset.pxOn) { registry.enable(t.dataset.pxOn, t.checked); refresh(); return true; }
  const x = parts(t.dataset.pxCheck);
  if (x) { registry.api(x.p).set(x.f.key, t.checked ? '1' : ''); return true; }
  return false;
}

export async function onSubmit(form: HTMLFormElement, refresh: () => void): Promise<boolean> {
  if (form.dataset.plugForm) { await registry.run(form.dataset.plugForm, form); return true; }
  const x = parts(form.dataset.pxForm); if (!x) return false;
  const value = form.querySelector('input')?.value.trim() ?? '', bad = value ? x.f.check?.(value) : null;
  if (bad) { toast(bad); return true; }
  const a = registry.api(x.p);
  if (x.f.secret) await a.setSecret(x.f.key, value); else a.set(x.f.key, value);
  toast(`${x.p.name} : enregistré`);
  registry.refresh(); refresh();
  return true;
}

export async function onClick(t: HTMLElement, refresh: () => void): Promise<boolean> {
  const x = parts(t.closest<HTMLElement>('[data-px-del]')?.dataset.pxDel); if (!x) return false;
  if (await confirmBox({ title: 'Supprimer ?', text: `« ${x.f.label} » sera effacée du coffre de cet appareil.`, ok: 'Supprimer', danger: true })) { await registry.api(x.p).setSecret(x.f.key, null); refresh(); }
  return true;
}
