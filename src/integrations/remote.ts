// Pont vers les agents Claude Code : directement sur le Mac, ou à distance via un Mac lié (iPhone, autre ordinateur).
// À distance, seules les demandes de suivi et de pilotage passent (voir REMOTE_ALLOWED dans link.ts).
import * as native from '../core/native.ts';
import * as link from './link.ts';

/** Ce Mac exécute lui-même les agents. */
export const local = (): boolean => native.available() && document.documentElement.dataset.native === 'mac';
/** Où tournent les agents vus d'ici : sur ce Mac, sur un Mac lié, ou nulle part. */
export function where(): { kind: 'mac' } | { kind: 'remote'; name: string } | null {
  if (local()) return { kind: 'mac' };
  const h = link.remoteHost();
  return h ? { kind: 'remote', name: h.name } : null;
}
export const call = (type: string, action: string, extra: Record<string, unknown> = {}, timeout = 60000): Promise<native.Reply> =>
  local() ? native.call(type, action, extra, timeout) : link.remoteCall(type, action, extra, timeout);
