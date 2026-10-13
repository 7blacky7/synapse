/**
 * R5.2: durable Aktivitaet fuer Toolcontainer, unabhaengig von tool_calls.
 * Nur serverseitig nach Auth/Projektbindung aufrufen, nie Client-Flags durchreichen.
 * Vor Annahme/Wake awaiten. Bei Jobs denselben PG-Client und dieselbe Transaktion
 * wie beim Job-INSERT verwenden; DB-Fehler werden absichtlich NICHT geschluckt.
 * Offene/geleaste Jobs bleiben ein separater, zwingender Idle-Stop-Schutz (R5.1).
 */
import type {Pool, PoolClient} from 'pg';
import {getPool} from '../db/client.js';

export type ToolAktivitaetDb = Pick<Pool | PoolClient, 'query'>;
export interface ToolAktivitaetDescriptor {
  toolId: string;
  tool: string;
  /** Explizite Positivliste fachlicher Aktionen, auch lesende Aufrufe. */
  aktivitaetsAktionen: readonly string[];
}
export interface ToolAktivitaetKontext {
  descriptor: ToolAktivitaetDescriptor;
  /** Ergebnis der serverseitigen Bindungspruefung, kein Request-Parameter. */
  gebundenesProjekt: string | null;
  berechtigt: boolean;
}
export interface ToolAktivitaetEintrag {
  project: string;
  tool: string;
  aktion: string;
  agentId?: string | null;
  containerId?: string | null;
  jobId?: string | null;
  akzeptiert: boolean;
  /** Fachtool entscheidet explizit; Mutation/ok allein reichen nicht. */
  zaehltAlsAktivitaet: boolean;
}
export interface ToolAktivitaetZeile {
  id: string;
  projekt: string;
  tool: string;
  aktion: string;
  agent_id: string | null;
  tool_id: string;
  container_id: string | null;
  job_id: string | null;
  akzeptiert: boolean;
  berechtigt: boolean;
  projekt_gebunden: boolean;
  zaehlt_als_aktivitaet: boolean;
  zeit: Date;
}
export interface ToolAktivitaetFenster {
  project: string;
  toolId: string;
  tool: string;
  fensterSekunden: number;
  containerId?: string;
}
const KEINE_AKTIVITAET = new Set(['status', 'heartbeat', 'admin', 'poll']);
function pflichtText(wert: string, name: string): void {
  if (typeof wert !== 'string' || !wert.trim()) throw new Error('Toolaktivitaet: '+name+' fehlt');
}
export function toolAktivitaetRetentionTage(): number {
  const roh=process.env.SYNAPSE_TOOL_AKTIVITAET_RETENTION_DAYS;
  const tage=roh === undefined ? 90 : Number(roh);
  if (!Number.isSafeInteger(tage) || tage < 1) throw new Error('Ungueltige Toolaktivitaet-Retention');
  return tage;
}

/** PG-Zeit, strukturierte Werte und Fehlerweitergabe; auch Nichtaktivitaet wird dokumentiert. */
export async function erfasseToolAktivitaet(
  e: ToolAktivitaetEintrag, k: ToolAktivitaetKontext, db: ToolAktivitaetDb = getPool(),
): Promise<ToolAktivitaetZeile> {
  for (const [name,wert] of Object.entries({projekt:e.project,tool:e.tool,aktion:e.aktion,toolId:k.descriptor.toolId})) pflichtText(wert,name);
  const gebunden=k.gebundenesProjekt === e.project;
  const zaehlt=e.akzeptiert === true && k.berechtigt === true && gebunden
    && e.zaehltAlsAktivitaet === true && k.descriptor.tool === e.tool
    && k.descriptor.aktivitaetsAktionen.includes(e.aktion)
    && e.tool !== 'admin' && !KEINE_AKTIVITAET.has(e.aktion.toLowerCase());
  const res=await db.query<ToolAktivitaetZeile>(
    `INSERT INTO tool_aktivitaet
      (projekt,tool,aktion,agent_id,tool_id,container_id,job_id,akzeptiert,berechtigt,projekt_gebunden,zaehlt_als_aktivitaet)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *, id::text AS id`,
    [e.project,e.tool,e.aktion,e.agentId??null,k.descriptor.toolId,e.containerId??null,e.jobId??null,
     e.akzeptiert===true,k.berechtigt===true,gebunden,zaehlt],
  );
  return res.rows[0];
}

/** Letzte passende Aktivitaet je Projekt/Descriptor/Tool; Fenster ausschliesslich nach PG-Zeit. */
export async function letzteToolAktivitaet(
  f: ToolAktivitaetFenster, db: ToolAktivitaetDb = getPool(),
): Promise<ToolAktivitaetZeile[]> {
  pflichtText(f.project,'projekt');pflichtText(f.toolId,'toolId');pflichtText(f.tool,'tool');
  if (!Number.isFinite(f.fensterSekunden) || f.fensterSekunden <= 0
      || f.fensterSekunden > toolAktivitaetRetentionTage()*86400) {
    throw new Error('Aktivitaetsfenster muss positiv und innerhalb der Retention sein');
  }
  const res=await db.query<ToolAktivitaetZeile>(
    `SELECT *, id::text AS id FROM tool_aktivitaet
      WHERE projekt=$1 AND tool_id=$2 AND tool=$3 AND zaehlt_als_aktivitaet
        AND zeit >= NOW() - ($4 * INTERVAL '1 second')
        AND ($5::text IS NULL OR container_id=$5)
      ORDER BY zeit DESC, tool_aktivitaet.id DESC LIMIT 1`,
    [f.project,f.toolId,f.tool,f.fensterSekunden,f.containerId??null],
  );
  return res.rows;
}

/** Konfiguration wird bei jedem Lauf gelesen; Fehler bleiben sichtbar. */
export async function bereinigeToolAktivitaet(db: ToolAktivitaetDb = getPool()): Promise<number> {
  const res=await db.query(
    `DELETE FROM tool_aktivitaet WHERE zeit < NOW() - ($1 * INTERVAL '1 day')`,
    [toolAktivitaetRetentionTage()],
  );
  return res.rowCount??0;
}
