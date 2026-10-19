/**
 * P6-T49 (User 19.10.2026 ~23:20: 'Ein Fileplan ist nach 2 Tagen auf jeden Fall abgeschlossen.'): offene files-Plaene
 * laufen nach einer einstellbaren Frist ohne Aktivitaet ab. Seit 28.09.2026 liefen sie gar nicht mehr ab; Altbestand
 * (Plaene 16-19, 3733, ~169 Tage) hing an fast jeder Tool-Antwort als open_plans.
 *
 * FRIST: Einstellung files_plan_stunden (admin ausweis_fristen, Web-UI Agenten-Ausweis; EINE Lesestelle
 *   agent-ausweis-fristen.ts, projekt > global > Standard 48 h). Kein Hartwert, keine Env.
 * AKTIVITAET (wie open_plans in plan-hints.ts): GREATEST(created_at, letzte Bewegung eines an den Plan gebundenen
 *   Waits - als Ziel primary_plan_id oder als Traeger source_plan_id). plan_update erzeugt einen Folgeplan (neues
 *   created_at), coedit_add/ready/no_changes bewegen den Wait.
 * WIRKUNG: derselbe Weg wie files(cancel) (cancelBatch mit ablauf:true): Status expired, NICHTS angewendet, ops und
 *   reason bleiben (Vermerk 'abgelaufen ... Frist'), gebundene Waits und leere Traeger schliessen, Betroffene bekommen
 *   PLAN_CANCELLED mit abgelaufen:true. Betroffen sind status open und conflict.
 * LAUF: REST-API-Worker files_plan_ablauf (server.ts), pausierbar und einzeln ausloesbar ueber intern(worker_*). Der erste
 *   Lauf beim Start raeumt den Altbestand ab.
 * SCHALTER: Produkt-Schalter files_plan_ablauf in PG (files-plan-ablauf-schalter.ts, projekt > global > Standard EIN),
 *   verwaltet ueber admin(ausweis_fristen, files_plan_ablauf_aktiv) / Web-UI. Env SYNAPSE_FILES_PLAN_ABLAUF_DISABLED=1 ist nur
 *   Infrastruktur-Notbremse (Worker startet nicht).
 * DEBUG: Ergebnis je Lauf: geprueft, abgelaufen[] (plan_id, project, owner, ops, letzte_aktivitaet), uebersprungen[] (mit
 *   grund), fristen{project: {stunden, quelle}} - Wert und Quelle der wirksamen Frist je Projekt.
 * KONTEXT: Der Worker hat keinen Agentenaufruf; er laeuft unter mitAgentAufrufKontext mit dem aktuellen Bezugsmodus und
 *   ohne Principal, damit Identitaets-Plaene (owner_identity_id) wie im Agentenweg behandelt werden. Im Modus 'alt' sind
 *   Identitaets-Plaene nicht freigegeben (agent_bezug_nicht_freigegeben) und erscheinen unter uebersprungen.
 */
import { getPool } from '../db/client.js';
import { leseAusweisFristen } from './agent-ausweis-fristen.js';
import { leseAgentBezugModus, mitAgentAufrufKontext } from './agent-bezug.js';
import { cancelBatch } from './file-batch.js';
import { leseFilesPlanAblaufSchalter } from './files-plan-ablauf-schalter.js';

/** Akteur im Vermerk und in den Events des Fristablaufs. */
export const FILES_PLAN_ABLAUF_AKTEUR = 'synapse-plan-ablauf';

/** Hoechstzahl je Projekt und Lauf (der naechste Lauf macht weiter). */
const MAX_JE_LAUF = 200;

export interface FilesPlanAblaufEintrag { plan_id: string; project: string; owner: string | null; ops: number; letzte_aktivitaet: string }
export interface FilesPlanAblaufErgebnis {
  geprueft: number;
  abgelaufen: FilesPlanAblaufEintrag[];
  uebersprungen: Array<{ plan_id: string; project: string; grund: string }>;
  fristen: Record<string, { stunden: number; quelle: string }>;
  /** Nachtrag 28011: Produkt-Schalter files_plan_ablauf je Projekt (Wert + Quelle). */
  schalter: Record<string, { aktiv: boolean; quelle: string; letzter_fehler?: string }>;
  /** Projekte, deren Schalter AUS ist (dort laeuft nichts ab). */
  aus: string[];
}

/**
 * Ein Durchlauf: je Projekt mit offenen Plaenen die wirksame Frist lesen und Plaene ohne Aktivitaet seit laenger als
 * die Frist abschliessen. project begrenzt auf ein Projekt (Tests, Einzelausloesung); jetzt verschiebt den Bezugspunkt.
 */
export async function laufeFilesPlaeneAb(opt: { project?: string; jetzt?: Date } = {}): Promise<FilesPlanAblaufErgebnis> {
  const pool = getPool();
  const jetzt = opt.jetzt ?? new Date();
  const ergebnis: FilesPlanAblaufErgebnis = { geprueft: 0, abgelaufen: [], uebersprungen: [], fristen: {}, schalter: {}, aus: [] };
  const projekte = (await pool.query<{ project: string }>(
    `SELECT DISTINCT project FROM file_batch_plans WHERE status IN ('open','conflict')${opt.project ? ' AND project = $1' : ''} ORDER BY project`,
    opt.project ? [opt.project] : [],
  )).rows.map((r) => r.project);
  const bezug = await leseAgentBezugModus();
  for (const project of projekte) {
    const frist = (await leseAusweisFristen(project, { frisch: true })).fristen.files_plan_stunden;
    ergebnis.fristen[project] = { stunden: frist.wert, quelle: frist.quelle };
    // Nachtrag 28011: Produkt-Schalter (projekt > global > Standard EIN); AUS = in diesem Projekt laeuft nichts ab.
    const schalter = await leseFilesPlanAblaufSchalter(project);
    ergebnis.schalter[project] = { aktiv: schalter.aktiv, quelle: schalter.quelle, ...(schalter.letzter_fehler ? { letzter_fehler: schalter.letzter_fehler } : {}) };
    if (!schalter.aktiv) { ergebnis.aus.push(project); continue; }
    const grenze = new Date(jetzt.getTime() - frist.ms);
    const kandidaten = (await pool.query<{ id: string; owner_agent_id: string | null; ops: number; aktivitaet: Date }>(
      `SELECT p.id::text AS id, p.owner_agent_id, jsonb_array_length(p.ops)::int AS ops,
              GREATEST(p.created_at, COALESCE((SELECT MAX(w.updated_at) FROM file_batch_waits w
                                                WHERE w.primary_plan_id = p.id OR w.source_plan_id = p.id), p.created_at)) AS aktivitaet
         FROM file_batch_plans p
        WHERE p.project = $1 AND p.status IN ('open','conflict')
          AND GREATEST(p.created_at, COALESCE((SELECT MAX(w.updated_at) FROM file_batch_waits w
                                                WHERE w.primary_plan_id = p.id OR w.source_plan_id = p.id), p.created_at)) < $2
        ORDER BY p.id
        LIMIT $3`,
      [project, grenze, MAX_JE_LAUF],
    )).rows;
    ergebnis.geprueft += kandidaten.length;
    for (const k of kandidaten) {
      const grund = `Frist abgelaufen: ${frist.wert} h ohne Aktivitaet (files_plan_stunden, Quelle ${frist.quelle}; letzte Aktivitaet ${new Date(k.aktivitaet).toISOString()})`;
      try {
        const r = await mitAgentAufrufKontext({ principal: null, bezug }, () =>
          cancelBatch(k.id, FILES_PLAN_ABLAUF_AKTEUR, grund, { ablauf: true }));
        if (r.ok && r.status === 'expired') {
          ergebnis.abgelaufen.push({ plan_id: k.id, project, owner: k.owner_agent_id, ops: Number(k.ops), letzte_aktivitaet: new Date(k.aktivitaet).toISOString() });
        } else {
          // Inzwischen committed/verworfen (Status nicht mehr open/conflict) - kein Fehler.
          ergebnis.uebersprungen.push({ plan_id: k.id, project, grund: `status_${r.status}` });
        }
      } catch (err) {
        ergebnis.uebersprungen.push({ plan_id: k.id, project, grund: (err as Error).message.slice(0, 200) });
      }
    }
  }
  return ergebnis;
}
