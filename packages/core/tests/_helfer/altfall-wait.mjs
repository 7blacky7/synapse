/**
 * P25-T15 (Inventur 2f2f6776 Gruppe H): Altfall-Wait ohne Zielplan synthetisch anlegen, wie in
 * file-reservation-planless-p6-t48.test.mjs ("Alt-Wait synthetisch nachstellen").
 *
 * Seit P6-T48 (Koordinator-Entscheidung 13.10.2026) erzeugt files(plan) auf eine Datei, die ein anderer nur RESERVIERT
 * (ohne offenen Plan), keinen Wait mehr: der Plan schreibt sofort und traegt reservation_hint. Die Code-Pfade fuer schon
 * bestehende zielose Waits gibt es weiter (Bindung an einen spaeter entstehenden Plan, Ablauf, intern waits_tot,
 * replanUnblockedReservationWaits, nothing_written am leeren Traeger). Tests dieser Pfade legen den Altfall deshalb direkt an,
 * statt ihn ueber planBatch zu erzeugen.
 *
 * pool: pg-Pool gegen synapse_test. ops: die zurueckgehaltenen Ops des Wartenden (deferred_ops).
 * Rueckgabe in der Form der alten planBatch-Antwort: { plan_id, total_ops: 0, coedit_waits: [{ wait_token, primary_agent, shared_files }] }.
 */
export async function legeAltfallWaitAn(pool, { project, waitingAgent, primaryAgent, ops, expiresSek = 60 }) {
  const dateien = [...new Set(ops.map((o) => o.file_path))];
  const plan_id = (await pool.query(
    "INSERT INTO file_batch_plans(project,owner_agent_id,ops,expected_hashes,previews) VALUES($1,$2,'[]','{}','[]') RETURNING id::text",
    [project, waitingAgent],
  )).rows[0].id;
  const wait_token = (await pool.query(
    `INSERT INTO file_batch_waits(source_plan_id,project,waiting_agent,primary_agent,shared_files,deferred_ops,deferred_op_indexes,expires_at)
     VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,NOW()+($8*INTERVAL '1 second')) RETURNING wait_token::text`,
    [plan_id, project, waitingAgent, primaryAgent, dateien, JSON.stringify(ops), ops.map((_, i) => i), expiresSek],
  )).rows[0].wait_token;
  return { plan_id, total_ops: 0, coedit_waits: [{ wait_token, primary_agent: primaryAgent, shared_files: dateien }] };
}
