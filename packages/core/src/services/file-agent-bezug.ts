/** P22-T15: getypte Dateiakteure. IDs kommen vom Principal oder gespeicherten Datensatz. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { aktuelleAgentIdentityId, aktuellerAgentPrincipal } from './agent-bezug.js';
export interface FileAgentBezug { agent_id: string | null; identity_id?: string | null }
const dateiAkteur = new AsyncLocalStorage<FileAgentBezug & {project:string}>();
/** Nur aus gespeicherten Plan/Wait-Metadaten, kein Rollen- oder Authnachweis. */
export function mitFileAgentBezug<T>(project:string, actor:FileAgentBezug, run:()=>T):T {
  return dateiAkteur.run({...actor,project},run);
}
export function dateiAgentIdentityId(project:string,name?:string|null):string|null {
  const a=dateiAkteur.getStore();
  return a?.project===project && (name===undefined || name===a.agent_id) ? a.identity_id??null : aktuelleAgentIdentityId(project,name);
}
export function dateiAgentName(): string|null|undefined { return dateiAkteur.getStore()?.agent_id; }
export function fileAgentBezug(project: string, name: string | null): FileAgentBezug {
  return { agent_id: name, identity_id: name ? dateiAgentIdentityId(project, name) : null };
}
export function fileAgentKey(a: FileAgentBezug): string {
  return a.identity_id ? 'identity:' + a.identity_id : 'legacy:' + JSON.stringify(a.agent_id);
}
export function gleicherFileAgent(a: FileAgentBezug, b: FileAgentBezug): boolean {
  return fileAgentKey(a) === fileAgentKey(b);
}
/** Werte bleiben gebunden; keine aus Requestparametern zusammengesetzten SQL-Bezeichner. */
export function fileAgentFilter(name: string, identity: string, parameter: string): string {
  return `((${parameter}::jsonb->>'identity_id' IS NOT NULL AND ${identity}=${parameter}::jsonb->>'identity_id')
    OR (${parameter}::jsonb->>'identity_id' IS NULL AND ${identity} IS NULL AND ${name}=${parameter}::jsonb->>'agent_id'))`;
}
export function fileAgentWert(a: FileAgentBezug): string { return JSON.stringify(a); }
/** Nur feste Spaltennamen vom Aufrufer; Identitätswerte werden als SQL-Literal escaped. */
export function fileIdentitySql(id?: string | null): string { return id ? "'" + id.replace(/'/g,"''") + "'" : 'NULL'; }
export function fileAgentSql(name: string, identity: string, parameter: string, identityId?: string | null): string {
  return identityId ? `(${identity}='${identityId.replace(/'/g, "''")}' AND ${parameter}::text IS NOT DISTINCT FROM ${parameter}::text)` : `(${identity} IS NULL AND COALESCE(${name}=${parameter},false))`;
}
export function fileCallerSql(name: string, identity: string, parameter: string): string {
  const a=dateiAkteur.getStore();
  if(a) return fileAgentSql(name,identity,parameter,a.identity_id);
  const p = aktuellerAgentPrincipal();
  return fileAgentSql(name,identity,parameter,p ? aktuelleAgentIdentityId(p.project,p.agent_id) : null);
}
export function fileCallerKey(project: string, name: string | null): string { return fileAgentKey(fileAgentBezug(project,name)); }
export const RESERVIERUNGS_SPALTEN = 'id,project,agent_id,file_path,reserved_at,expires_at,released_at,plan_id,content_hash_at_reservation,last_extended_at,taken_over_at,taken_over_by';
/** Gemeinsame Lesesicht, ohne Legacy-Zeilen zu adoptieren. Schreibziele explizit wählen. */
export function reservierungsQuelle(): string {
  return `(SELECT ${RESERVIERUNGS_SPALTEN},NULL::text AS identity_id,taken_over_by_identity_id FROM file_reservations
    UNION ALL SELECT ${RESERVIERUNGS_SPALTEN},identity_id,taken_over_by_identity_id FROM agent_identitaet_file_reservations)`;
}
