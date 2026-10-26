import { getPool } from '../db/client.js'
import { kommunikationsAgent, aufgeloestesKommunikationsZiel, aufgeloestesSendeZiel, bezugsWert, agentBezugAktiv } from './kommunikation-agent.js'
import type { AgentZiel } from './agent-bezug.js'
import type { InboxMessage } from '../types/index.js'
import { wakeAntwortIdentitaetAktiv, rueckadresseFuer, projektfreiesLesenErlaubt } from './wake-rueckadresse.js'
import { aktuellerAgentPrincipal } from './agent-bezug.js'

function mapRow(row: Record<string, unknown>): InboxMessage {
  return {
    id: row.id as number,
    fromAgent: row.from_agent as string,
    toAgent: row.to_agent as string,
    ...(agentBezugAktiv() ? {fromIdentityId:row.from_identity_id as string|null,toIdentityId:row.to_identity_id as string|null} : {}),
    content: row.content as string,
    processed: row.processed as boolean,
    createdAt: row.created_at as Date,
  }
}

/**
 * P22-T120: lesende Identitaets-Abfragen projektuebergreifend (Schalter wake_antwort_identitaet im Leseprojekt), R1: NUR fuer
 * die eigene Identitaet des verifizierten Principals; fremde explizite Identitaetsziele bleiben beim Projektfilter (Bestand).
 */
async function identitaetProjektfrei(z: AgentZiel, project: string): Promise<boolean> {
  if (z.art !== 'identity') return false
  if (!projektfreiesLesenErlaubt(z.identity_id, aktuellerAgentPrincipal() as { art?: string; identity_id?: string } | null)) {
    if (await wakeAntwortIdentitaetAktiv(project)) console.debug('[wake-antwort-identitaet] projektfrei abgewiesen: fremde Identitaet', { project, ziel: z.identity_id })
    return false
  }
  return wakeAntwortIdentitaetAktiv(project)
}

/** opts.fromIdentityId: P22-T120 R2 - serverseitig bestimmte Rueckadresse (wakeRueckadresseVorab), atomar im INSERT. Nie aus Toolargs. */
export async function postToInbox(fromAgent: string | AgentZiel, toAgent: string | AgentZiel, content: string, project: string, opts?: { fromIdentityId?: string | null; transaktion?: Pick<import('pg').PoolClient,'query'>; nachCommit?: Array<()=>void> }): Promise<{ id: number; createdAt: Date }> {
  // P22-T195: derselbe Inbox-Weg, optional atomar mit Quellenanmerkungen; Wake erst nach COMMIT.
  const db = opts?.transaktion ?? getPool()
  const melden = (ziel: unknown) => { const f = () => apiLaufZustellung(project,ziel,content,sender.agent_id); if(opts?.nachCommit)opts.nachCommit.push(f);else f() }
  const sender = kommunikationsAgent(project, fromAgent)
  let ziel = await aufgeloestesSendeZiel(project, toAgent)
  // P22-T120 (Schalter wake_antwort_identitaet): Antwort an den Wecker aus anderem Projekt -> dessen Identitaet (Rueckadresse).
  if (agentBezugAktiv() && ziel.art === 'legacy' && typeof toAgent === 'string' && await wakeAntwortIdentitaetAktiv(project)) {
    const r = await rueckadresseFuer(project, toAgent, sender.agent_id)
    console.debug('[wake-antwort-identitaet] Antwortziel', { project, ziel: toAgent, antwortender: sender.agent_id, rueckadresse: r })
    if (r) ziel = { art: 'identity', project, identity_id: r.identity_id, agent_id: r.agent_id } as AgentZiel
  }
  if (agentBezugAktiv()) {
    const { rows } = await db.query(
      `INSERT INTO specialist_inbox(from_agent,to_agent,content,project,from_identity_id,to_identity_id)
       VALUES($1,$2,$3,$4,$5,$6) RETURNING id,created_at`,
      [sender.agent_id,ziel.agent_id,content,project,sender.art === 'identity' ? sender.identity_id : (opts?.fromIdentityId ?? null),ziel.art === 'identity' ? ziel.identity_id : null])
    melden(ziel)
    return { id: rows[0].id, createdAt: rows[0].created_at }
  }
  toAgent = ziel.agent_id
  const result = await db.query(
    opts?.fromIdentityId
      ? `INSERT INTO specialist_inbox (from_agent, to_agent, content, project, from_identity_id) VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at`
      : `INSERT INTO specialist_inbox (from_agent, to_agent, content, project) VALUES ($1, $2, $3, $4) RETURNING id, created_at`,
    opts?.fromIdentityId ? [sender.agent_id, toAgent, content, project, opts.fromIdentityId] : [sender.agent_id, toAgent, content, project],
  )
  const row = result.rows[0]
  melden(toAgent)
  return { id: row.id as number, createdAt: row.created_at as Date }
}

/** P22-T183 B7c: Inbox an einen API-Agenten mit Lauf in der synapse-api -> Eingang (Schalter api_agenten_lauf_intern); wirft nie, wartet nicht. */
function apiLaufZustellung(project: string, ziel: unknown, content: string, absender: string): void {
  void import('./api-agent-einstieg.js').then(m => m.stelleApiLaufZu(project, ziel, content, 'inbox', absender)).catch(() => undefined)
}

export async function checkInbox(agentName: string | AgentZiel, project: string): Promise<InboxMessage[]> {

  const z = await aufgeloestesKommunikationsZiel(project, agentName, true)
  if (agentBezugAktiv()) {
    const frei = await identitaetProjektfrei(z, project)
    const result = await getPool().query(`UPDATE specialist_inbox SET processed=true WHERE ($3::boolean OR project=$2) AND ${z.art === 'identity' ? 'to_identity_id=$1' : 'to_agent=$1 AND to_identity_id IS NULL'} AND processed=false RETURNING *`, [bezugsWert(z), project, frei])
    return result.rows.map(mapRow)
  }
  agentName = z.agent_id
  const result = await getPool().query(
    `UPDATE specialist_inbox SET processed = true WHERE to_agent = $1 AND to_identity_id IS NULL AND project = $2 AND processed = false RETURNING id, from_agent, to_agent, content, processed, created_at`,
    [agentName, project],
  )
  return result.rows.map(mapRow)
}

export async function getNewInboxMessages(agentName: string | AgentZiel, sinceId: number, project: string): Promise<InboxMessage[]> {

  const z = await aufgeloestesKommunikationsZiel(project, agentName, true)
  if (agentBezugAktiv()) {
    const frei = await identitaetProjektfrei(z, project)
    const result = await getPool().query(`SELECT * FROM specialist_inbox WHERE ($4::boolean OR project=$3) AND ${z.art === 'identity' ? 'to_identity_id=$1' : 'to_agent=$1 AND to_identity_id IS NULL'} AND processed=false AND id>$2 ORDER BY id ASC`, [bezugsWert(z), sinceId, project, frei])
    return result.rows.map(mapRow)
  }
  agentName = z.agent_id
  const result = await getPool().query(
    `SELECT id, from_agent, to_agent, content, processed, created_at FROM specialist_inbox WHERE to_agent = $1 AND to_identity_id IS NULL AND project = $3 AND processed = false AND id > $2 ORDER BY id ASC`,
    [agentName, sinceId, project],
  )
  return result.rows.map(mapRow)
}

export async function getInboxHistory(agentName: string | AgentZiel, project: string, limit = 50): Promise<InboxMessage[]> {

  const z = await aufgeloestesKommunikationsZiel(project, agentName, true)
  if (agentBezugAktiv()) {
    const frei = await identitaetProjektfrei(z, project)
    const result = await getPool().query(`SELECT * FROM specialist_inbox WHERE ($4::boolean OR project=$2) AND ${z.art === 'identity' ? 'to_identity_id=$1' : 'to_agent=$1 AND to_identity_id IS NULL'} ORDER BY id DESC LIMIT $3`, [bezugsWert(z), project, limit, frei])
    return result.rows.map(mapRow)
  }
  agentName = z.agent_id
  const result = await getPool().query(
    `SELECT id, from_agent, to_agent, content, processed, created_at FROM specialist_inbox WHERE to_agent = $1 AND to_identity_id IS NULL AND project = $2 ORDER BY id DESC LIMIT $3`,
    [agentName, project, limit],
  )
  return result.rows.map(mapRow)
}

export async function removeInboxForAgent(agentName: string | AgentZiel, project: string): Promise<number> {

  const z = await aufgeloestesKommunikationsZiel(project, agentName, true)
  if (agentBezugAktiv()) {
    const result = await getPool().query(`DELETE FROM specialist_inbox WHERE project=$2 AND ${z.art === 'identity' ? 'to_identity_id=$1' : 'to_agent=$1 AND to_identity_id IS NULL'} RETURNING id`, [bezugsWert(z), project])
    return result.rowCount ?? result.rows.length
  }
  agentName = z.agent_id
  const result = await getPool().query(
    `DELETE FROM specialist_inbox WHERE to_agent = $1 AND to_identity_id IS NULL AND project = $2 RETURNING id`,
    [agentName, project],
  )
  return result.rowCount ?? result.rows.length
}
