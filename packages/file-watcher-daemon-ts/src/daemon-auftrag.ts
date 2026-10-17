/** Zielbindung aus einem von der API geclaimten Auftrag; verleiht keine Agentenrolle. */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { SpecialistJobRow } from '@synapse/core';
const auftraege = new AsyncLocalStorage<SpecialistJobRow>();
export function mitDaemonAuftrag<T>(job: SpecialistJobRow, arbeit: () => T): T { return auftraege.run(job, arbeit); }
export function daemonAuftragBindung(): Record<string,string> {
  const j = auftraege.getStore();
  return j?.target_identity_id ? { auftrag_id: j.id, identity_id: j.target_identity_id } : {};
}
