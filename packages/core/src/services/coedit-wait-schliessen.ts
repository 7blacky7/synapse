/**
 * P27-T10: EIN Schliessweg fuer Co-Edit-Waits ausserhalb des Co-Edit-Ablaufs. Herausgeloest aus intern waits_tot (P15-T31,
 * intern-waits.ts Schritt 4) und von admin warteschlangen_aufraeumen (warteschlange coedit_waits, warteschlangen-altbestand.ts)
 * mitbenutzt - es gibt keinen zweiten Weg.
 *
 * schliesseWaitUndLeerenTraeger: Wait auf closed (updated_at = NOW()), danach den dadurch leeren Traeger auf cancelled - nur wenn er
 *   offen ist, keine Op mehr hat und keinen anderen offenen Wait ohne Ziel bzw. mit offenem Ziel. reason bekommt den Vermerk angehaengt;
 *   der reason davor kommt fuer den Rueckweg mit zurueck. Laeuft in der Transaktion des Aufrufers, der die Wait-Zeile vorher FOR UPDATE
 *   gesperrt und geprueft hat. NICHTS wird geloescht: deferred_ops, shared_files und alle anderen Spalten bleiben in der Wait-Zeile.
 * oeffneWaitWieder: Rueckweg fuer warteschlangen_aufraeumen wiederherstellen - Wait mit gespeichertem Status und updated_at (nur solange er
 *   closed ist), den Traeger nur, wenn ihn das Schliessen verworfen hatte und er noch cancelled ist, mit seinem reason von vorher.
 */
import type { PoolClient } from 'pg';

type Db = Pick<PoolClient, 'query'>;

export interface WaitSchliessErgebnis {
  geschlossen: boolean;
  traeger_verworfen: boolean;
  /** reason des Traegers vor dem Verwerfen (nur bei traeger_verworfen, sonst null) */
  traeger_reason_vorher: string | null;
}

export async function schliesseWaitUndLeerenTraeger(db: Db, o: { wait_token: string; traeger_plan_id: string; vermerk: string }): Promise<WaitSchliessErgebnis> {
  const w = await db.query(
    `UPDATE file_batch_waits SET status = 'closed', updated_at = NOW() WHERE wait_token = $1::uuid AND status <> 'closed' RETURNING wait_token`,
    [o.wait_token],
  );
  // Der FROM-Teil liest den Stand vor diesem UPDATE: so kommt der alte reason ohne zweite Abfrage zurueck.
  const t = await db.query<{ reason_vorher: string | null }>(
    `UPDATE file_batch_plans c
        SET status = 'cancelled', reason = CONCAT_WS(' ', c.reason, $2::text)
       FROM (SELECT id, reason FROM file_batch_plans WHERE id = $1::bigint) v
      WHERE c.id = v.id AND c.status = 'open' AND jsonb_array_length(c.ops) = 0
        AND NOT EXISTS (
          SELECT 1 FROM file_batch_waits w LEFT JOIN file_batch_plans t ON t.id = w.primary_plan_id
           WHERE w.source_plan_id = c.id AND w.status <> 'closed'
             AND (w.primary_plan_id IS NULL OR t.status = 'open'))
      RETURNING v.reason AS reason_vorher`,
    [o.traeger_plan_id, o.vermerk],
  );
  const verworfen = (t.rowCount ?? 0) > 0;
  return { geschlossen: (w.rowCount ?? 0) > 0, traeger_verworfen: verworfen, traeger_reason_vorher: verworfen ? t.rows[0]?.reason_vorher ?? null : null };
}

export interface WaitOeffnenErgebnis {
  wieder_offen: boolean;
  /** Wait-Zeile existiert nicht mehr (dann bleibt nur die Historie) */
  wait_fehlt: boolean;
  traeger_wieder_offen: boolean;
}

export async function oeffneWaitWieder(db: Db, o: { wait_token: string; status: string; updated_at: string | null; traeger_plan_id: string | null;
  traeger_verworfen: boolean; traeger_reason_vorher: string | null }): Promise<WaitOeffnenErgebnis> {
  const w = await db.query(
    `UPDATE file_batch_waits SET status = $2, updated_at = COALESCE($3::timestamptz, updated_at)
      WHERE wait_token = $1::uuid AND status = 'closed' RETURNING wait_token`,
    [o.wait_token, o.status, o.updated_at],
  );
  if (!w.rowCount) {
    const da = (await db.query('SELECT 1 FROM file_batch_waits WHERE wait_token = $1::uuid', [o.wait_token])).rowCount;
    return { wieder_offen: false, wait_fehlt: !da, traeger_wieder_offen: false };
  }
  let traeger = 0;
  if (o.traeger_verworfen && o.traeger_plan_id) {
    traeger = (await db.query(
      `UPDATE file_batch_plans SET status = 'open', reason = $2 WHERE id = $1::bigint AND status = 'cancelled' RETURNING id`,
      [o.traeger_plan_id, o.traeger_reason_vorher],
    )).rowCount ?? 0;
  }
  return { wieder_offen: true, wait_fehlt: false, traeger_wieder_offen: traeger > 0 };
}
