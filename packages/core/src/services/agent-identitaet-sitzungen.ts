/** P22-T15: Token-Sitzungen, getrennt von agent_sessions; kein Name-Fallback. */
import { getPool } from '../db/client.js';
import type { AgentTokenAnmeldung } from './agent-identitaet.js';
import type { PoolClient } from 'pg';
export interface AgentIdentitaetSitzung {
 identity_id: string; project: string; agent_id: string; model: string | null;
 cutoff_date: string | Date | null; status: 'active' | 'inactive';
 registered_at: Date; sitzung_seit: Date; aktiv_seit: Date; zuletzt_aktiv: Date;
 context_epoch: number; lauf_id: string | null;
}
type SitzungsDb = Pick<PoolClient, 'query'>;
/** In der Token-Login-Transaktion ausfuehren. Rotation behaelt registered/aktiv_seit. */
export async function beginneIdentitaetsSitzung(p: AgentTokenAnmeldung, db: SitzungsDb = getPool()): Promise<AgentIdentitaetSitzung> {
 const r = await db.query<AgentIdentitaetSitzung>(`INSERT INTO agent_identitaet_sitzungen
 (identity_id,project,agent_id,model,status,context_epoch,lauf_id)
 VALUES($1,$2,$3,$4,'active',$5,$6)
 ON CONFLICT(identity_id) DO UPDATE SET status='active',agent_id=EXCLUDED.agent_id,
 model=COALESCE(EXCLUDED.model,agent_identitaet_sitzungen.model),
 sitzung_seit=clock_timestamp(),zuletzt_aktiv=clock_timestamp(),
 context_epoch=EXCLUDED.context_epoch,lauf_id=EXCLUDED.lauf_id
 WHERE agent_identitaet_sitzungen.project=EXCLUDED.project
 RETURNING *`,[p.identitaet.id,p.project,p.agent_id,p.modell,p.context_epoch,p.lauf_id]);
 if (!r.rows[0]) throw new Error('identitaet_sitzung_projektkonflikt');
 return r.rows[0];
}
export async function holeIdentitaetsSitzung(project: string, identityId: string, db: SitzungsDb = getPool()): Promise<AgentIdentitaetSitzung | null> {
 return (await db.query<AgentIdentitaetSitzung>('SELECT * FROM agent_identitaet_sitzungen WHERE identity_id=$1 AND project=$2',[identityId,project])).rows[0] ?? null;
}
export async function listeIdentitaetsSitzungen(project: string, nurAktive = true): Promise<AgentIdentitaetSitzung[]> {
 return (await getPool().query<AgentIdentitaetSitzung>("SELECT * FROM agent_identitaet_sitzungen WHERE project=$1 AND (NOT $2::boolean OR status='active') ORDER BY sitzung_seit DESC",[project,nurAktive])).rows;
}
export async function beruehreIdentitaetsSitzung(project: string, identityId: string): Promise<void> {
 await getPool().query('UPDATE agent_identitaet_sitzungen SET zuletzt_aktiv=clock_timestamp() WHERE identity_id=$1 AND project=$2',[identityId,project]);
}
export async function beendeIdentitaetsSitzung(project: string, identityId: string): Promise<void> {
 await getPool().query("UPDATE agent_identitaet_sitzungen SET status='inactive' WHERE identity_id=$1 AND project=$2",[identityId,project]);
}
