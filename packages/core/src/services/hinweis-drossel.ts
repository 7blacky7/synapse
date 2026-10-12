/** P10-T40: gemeinsame Drossel fuer optionale Tool-Hinweise (nicht fuer Events/Fehler). */
import { getPool } from '../db/client.js';
import { darfKoordinatorOderUser } from './rollen-pruefung.js';

export async function projektHinweisOption(project: string, agent: string, aktiv?: boolean): Promise<{success: true; project: string; hinweise: boolean}> {
  if (!project) throw new Error('Projekt erforderlich');
  if (aktiv !== undefined) {
    if (!darfKoordinatorOderUser(agent)) throw new Error('Hinweise einstellen darf nur Koordinator/User');
    await getPool().query(
      'INSERT INTO hinweis_optionen(project,aktiv,gesetzt_von) VALUES($1,$2,$3) ON CONFLICT(project) DO UPDATE SET aktiv=EXCLUDED.aktiv,gesetzt_von=EXCLUDED.gesetzt_von,gesetzt_am=NOW()',
      [project,aktiv,agent]);
  }
  const r = await getPool().query<{aktiv:boolean}>('SELECT aktiv FROM hinweis_optionen WHERE project=$1',[project]);
  return {success:true,project,hinweise:r.rows[0]?.aktiv !== false};
}

/** Atomarer Claim: parallele Prozesse liefern denselben Hinweis nicht doppelt aus.
 * intervallMs=null: nur erste Auslieferung/Sitzungs- oder Inhaltsaenderung.
 * wiederholen=false: Intervall abgelaufen reicht nicht (z.B. files gerade nicht benutzt).
 */
export async function claimHinweis(o: {
  project:string; agentId:string; art:string; fingerprint:string;
  intervallMs?:number|null; wiederholen?:boolean; jetzt?:number;
}): Promise<boolean> {
  if (!o.project || !o.agentId) return false;
  const r=await getPool().query(
    `INSERT INTO hinweis_gesehen(project,agent_id,art,sitzung,fingerprint,gezeigt_am)
     SELECT $1,$2,$3,
       COALESCE((SELECT COALESCE(sitzung_seit,registered_at)::text FROM agent_sessions WHERE id=$2),'unregistriert'),
       $4,to_timestamp($5::double precision/1000)
     WHERE COALESCE((SELECT aktiv FROM hinweis_optionen WHERE project=$1),true)
     ON CONFLICT(project,agent_id,art) DO UPDATE SET
       sitzung=EXCLUDED.sitzung,fingerprint=EXCLUDED.fingerprint,gezeigt_am=EXCLUDED.gezeigt_am
     WHERE hinweis_gesehen.sitzung IS DISTINCT FROM EXCLUDED.sitzung
        OR hinweis_gesehen.fingerprint IS DISTINCT FROM EXCLUDED.fingerprint
        OR ($6::double precision IS NOT NULL AND $7::boolean AND
            hinweis_gesehen.gezeigt_am <= EXCLUDED.gezeigt_am - ($6 * interval '1 millisecond'))
     RETURNING art`,
    [o.project,o.agentId,o.art,o.fingerprint,o.jetzt??Date.now(),o.intervallMs??null,o.wiederholen===true]);
  return r.rowCount === 1;
}
