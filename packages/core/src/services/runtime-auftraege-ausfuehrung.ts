/**
 * P22-T6 (W2c): Ausfuehrerseite der Runtime-Auftraege (Tabelle agent_runtime_auftraege, Schema 116, angelegt von P22-T36).
 * Der Container-Daemon (Principal runtime-daemon, P22-T5) holt hier die offenen Auftraege der Identitaeten SEINER Projekte,
 * fuehrt sie lokal aus (Wrapper stoppen/neu starten wie bei lokalen Spezialisten) und meldet das Ergebnis.
 *
 * ABLAUF: pending -> claimed (claim_revision+1, lease_bis) -> accepted (Ausfuehrung begonnen) -> completed | rejected.
 *   Jede Meldung traegt die claim_revision des eigenen Claims (Fence): ein abgeloester Ausfuehrer kann nichts mehr melden.
 *   claimed mit abgelaufener Lease darf neu geclaimt werden (es ist noch nichts passiert). accepted mit abgelaufener Lease
 *   kommt mit versoehnen:true zurueck: Leaseablauf beweist keinen Exit, der Daemon prueft den Wrapperstand und meldet dann
 *   (nicht blind wiederholen).
 *
 * TATSAECHLICH (5fc2cafa): completed schreibt tatsaechlich {modell, runtime} erst nach erfolgreichem Neustart. Ein completed
 *   modellwechsel uebernimmt das Modell als konfiguriertes Profil-Modell (modell_bestaetigt), damit spaetere Starts es nutzen.
 *
 * ARTEN: neustart, modellwechsel, stop fuehrt der Container-Daemon aus (T6a). runtime_wechsel (claude <-> codex, beide
 *   Daemons beteiligt) fuehrt die API aus (P22-T6c, hauptagent-lauf.ts fuehreRuntimeWechselAus, arten:['runtime_wechsel']).
 *   update (CLI-Update aus P22-T4) bleibt pending, bis sein Ausfuehrer existiert.
 */
import { getPool } from '../db/client.js';
import { AUSWEIS_IM_TEXT } from './agent-ausweis-format.js';
import { istUserWahlAuftrag, leseCliModelleSchalter } from './hauptagent-modelle.js';

export const AUSFUEHRBARE_AUFTRAG_ARTEN = ['neustart', 'modellwechsel', 'stop'] as const;
export type AusfuehrbareAuftragArt = typeof AUSFUEHRBARE_AUFTRAG_ARTEN[number] | 'runtime_wechsel';
/** Standard-Lease eines Claims; die accepted-Meldung verlaengert sie einmal. */
export const AUFTRAG_LEASE_MS = 10 * 60_000;
const MAX_JE_ABRUF = 8;

export interface AuftragFuerDaemon {
  auftrag_id: string;
  identity_id: string;
  project: string;
  agent_id: string;
  art: AusfuehrbareAuftragArt;
  status: 'claimed' | 'accepted';
  gewuenscht: Record<string, unknown>;
  hands_off: Record<string, unknown> | null;
  claim_revision: number;
  lease_bis: string;
  /** Konfiguriertes Profil-Modell (modell_bestaetigt) fuer einen Neustart mit gleichem Rezept. */
  modell_konfiguriert: string | null;
  /** P22-T65: gespeicherte Effort-Stufe dieses Modells (startrezept.effort_je_modell) fuer einen Neustart. */
  effort_konfiguriert: string | null;
  /** true = war schon accepted, Lease abgelaufen: erst Wrapperstand pruefen, dann melden. */
  versoehnen: boolean;
}

export class RuntimeAuftragFehler extends Error {
  constructor(readonly code: string, readonly details?: Record<string, unknown>) { super(code); }
}

interface Zeile {
  id: string; identity_id: string; project: string; agent_id: string; art: AusfuehrbareAuftragArt; status: 'claimed' | 'accepted';
  gewuenscht: Record<string, unknown>; hands_off: Record<string, unknown> | null; claim_revision: number; lease_bis: Date;
  war_accepted: boolean; modell_bestaetigt: string | null; effort_konfiguriert: string | null;
}

/**
 * Claimt offene Auftraege der aktiven Identitaeten in `projekte` (von der Route auf die Projekte dieser Runtime geprueft).
 * Atomar je Zeile (FOR UPDATE SKIP LOCKED): zwei Ausfuehrer bekommen nie denselben Auftrag mit derselben Revision.
 */
export async function claimeRuntimeAuftraege(o: {
  projekte: string[]; max?: number; leaseMs?: number;
  /** Standard: die Arten des Container-Daemons. Die API claimt mit ['runtime_wechsel'] (P22-T6c). */
  arten?: readonly AusfuehrbareAuftragArt[];
}): Promise<AuftragFuerDaemon[]> {
  if (o.projekte.length === 0) return [];
  const max = Math.max(1, Math.min(MAX_JE_ABRUF, o.max ?? MAX_JE_ABRUF));
  const lease = Math.max(10_000, Math.min(60 * 60_000, o.leaseMs ?? AUFTRAG_LEASE_MS));
  const r = await getPool().query<Zeile>(
    `WITH kandidaten AS (
       SELECT a.id, a.status = 'accepted' AS war_accepted FROM agent_runtime_auftraege a
         JOIN agent_identitaeten i ON i.id = a.identity_id
        WHERE i.project = ANY($1::text[]) AND i.status = 'aktiv' AND a.art = ANY($2::text[])
          AND (a.status = 'pending' OR (a.status IN ('claimed','accepted') AND a.lease_bis < NOW()))
        ORDER BY a.erstellt_am
        LIMIT $3
        FOR UPDATE OF a SKIP LOCKED)
     UPDATE agent_runtime_auftraege a
        SET status = CASE WHEN k.war_accepted THEN 'accepted' ELSE 'claimed' END,
            claim_revision = a.claim_revision + 1, lease_bis = NOW() + ($4::integer * interval '1 millisecond'),
            aktualisiert_am = NOW()
       FROM kandidaten k, agent_identitaeten i
      WHERE a.id = k.id AND i.id = a.identity_id
      RETURNING a.id, a.identity_id, i.project, i.agent_id, a.art, a.status, a.gewuenscht, a.hands_off, a.claim_revision,
                a.lease_bis, k.war_accepted, i.modell_bestaetigt,
                i.startrezept->'effort_je_modell'->>i.modell_bestaetigt AS effort_konfiguriert`,
    [o.projekte, [...(o.arten ?? AUSFUEHRBARE_AUFTRAG_ARTEN)], max, lease]);
  return r.rows.map(z => ({
    auftrag_id: z.id, identity_id: z.identity_id, project: z.project, agent_id: z.agent_id, art: z.art, status: z.status,
    gewuenscht: z.gewuenscht ?? {}, hands_off: z.hands_off, claim_revision: z.claim_revision,
    lease_bis: z.lease_bis.toISOString(), modell_konfiguriert: z.modell_bestaetigt,
    effort_konfiguriert: z.effort_konfiguriert ?? null, versoehnen: z.war_accepted,
  }));
}

export type AuftragMeldung =
  | { schritt: 'accepted' }
  | { schritt: 'completed'; tatsaechlich: { modell?: string | null; runtime?: string | null } }
  | { schritt: 'rejected'; fehler: string };

function textOderNull(v: unknown, max = 128): string | null {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
}

/**
 * P22-T71: Zwischenschritt eines laufenden Auftrags (Fortschritt im Chip der Web-UI, z. B. stoppt_alt -> startet -> laeuft).
 * Fence auftrag_id + claim_revision, nur solange er offen ist. false = abgeloest/abgeschlossen; wirft nur bei DB-Fehlern.
 */
export async function meldeAuftragFortschritt(o: {
  auftrag_id: string; claim_revision: number; schritt: string; details?: Record<string, unknown>;
}): Promise<boolean> {
  const r = await getPool().query(
    `UPDATE agent_runtime_auftraege SET fortschritt = $3::jsonb, aktualisiert_am = NOW()
      WHERE id = $1 AND claim_revision = $2 AND status IN ('claimed','accepted')`,
    [o.auftrag_id, o.claim_revision, JSON.stringify({ ...(o.details ?? {}), schritt: o.schritt, seit: new Date().toISOString() })]);
  return (r.rowCount ?? 0) > 0;
}

/**
 * Meldung des Ausfuehrers. Fence: auftrag_id + claim_revision + erwarteter Vorstatus; die Projekte (Route) begrenzen,
 * wessen Auftraege ein Daemon ueberhaupt melden darf. Kein Treffer -> auftrag_nicht_eigen (abgeloest oder fremd).
 */
export async function meldeRuntimeAuftrag(o: {
  projekte: string[]; auftrag_id: unknown; claim_revision: unknown; meldung: AuftragMeldung; wer?: string;
}): Promise<Record<string, unknown>> {
  if (typeof o.auftrag_id !== 'string' || !o.auftrag_id.trim()) throw new RuntimeAuftragFehler('auftrag_id_fehlt');
  if (!Number.isSafeInteger(o.claim_revision) || (o.claim_revision as number) < 1) throw new RuntimeAuftragFehler('claim_revision_fehlt');
  const wer = o.wer ?? 'runtime-daemon';
  const m = o.meldung;
  let tatsaechlich: Record<string, string> | null = null;
  let fehlerText: string | null = null;
  if (m.schritt === 'completed') {
    tatsaechlich = {};
    const modell = textOderNull(m.tatsaechlich?.modell);
    const runtime = textOderNull(m.tatsaechlich?.runtime, 32);
    if (modell) tatsaechlich.modell = modell;
    if (runtime) tatsaechlich.runtime = runtime;
  } else if (m.schritt === 'rejected') {
    fehlerText = textOderNull(m.fehler, 500);
    if (!fehlerText) throw new RuntimeAuftragFehler('fehler_fehlt');
  } else if (m.schritt !== 'accepted') {
    throw new RuntimeAuftragFehler('schritt_ungueltig');
  }
  if (AUSWEIS_IM_TEXT.test(JSON.stringify({ tatsaechlich, fehlerText }))) throw new RuntimeAuftragFehler('inhalt_enthaelt_ausweis');

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const vorher = m.schritt === 'accepted' ? ['claimed'] : ['claimed', 'accepted'];
    const r = await client.query<{ id: string; identity_id: string; art: string; status: string; tatsaechlich: Record<string, unknown> | null; erstellt_von: string | null; gewuenscht: Record<string, unknown> | null }>(
      `UPDATE agent_runtime_auftraege a
          SET status = $4,
              tatsaechlich = CASE WHEN $4 = 'completed' THEN $5::jsonb ELSE a.tatsaechlich END,
              letzter_fehler = CASE WHEN $4 = 'rejected' THEN $6 ELSE a.letzter_fehler END,
              lease_bis = CASE WHEN $4 = 'accepted' THEN NOW() + ($8::integer * interval '1 millisecond') ELSE NULL END,
              aktualisiert_am = NOW(),
              abgeschlossen_am = CASE WHEN $4 IN ('completed','rejected') THEN NOW() ELSE NULL END,
              abgeschlossen_von = CASE WHEN $4 IN ('completed','rejected') THEN $7 ELSE NULL END
        FROM agent_identitaeten i
       WHERE a.id = $1 AND a.claim_revision = $2 AND a.status = ANY($3::text[])
         AND i.id = a.identity_id AND i.project = ANY($9::text[])
       RETURNING a.id, a.identity_id, a.art, a.status, a.tatsaechlich, a.erstellt_von, a.gewuenscht`,
      [o.auftrag_id.trim(), o.claim_revision, vorher, m.schritt, tatsaechlich ? JSON.stringify(tatsaechlich) : null, fehlerText,
        wer, AUFTRAG_LEASE_MS, o.projekte]);
    const z = r.rows[0];
    if (!z) {
      await client.query('ROLLBACK');
      throw new RuntimeAuftragFehler('auftrag_nicht_eigen');
    }
    if (m.schritt === 'completed' && (z.art === 'modellwechsel' || z.art === 'runtime_wechsel') && tatsaechlich?.modell) {
      await client.query(
        'UPDATE agent_identitaeten SET modell_bestaetigt = $2, profil_revision = profil_revision + 1 WHERE id = $1',
        [z.identity_id, tatsaechlich.modell]);
    }
    // P22-T6c: nach erfolgreichem Runtime-Wechsel ist die neue Runtime auch die konfigurierte (startrezept.runtime).
    if (m.schritt === 'completed' && z.art === 'runtime_wechsel' && tatsaechlich?.runtime) {
      await client.query(
        `UPDATE agent_identitaeten SET startrezept = jsonb_set(COALESCE(startrezept, '{}'::jsonb), '{runtime}', to_jsonb($2::text))
          WHERE id = $1`, [z.identity_id, tatsaechlich.runtime]);
    }
    // P22-T62 (Schalter hauptagent_cli_modelle EIN): Wahl von User/Main je Runtime im Startrezept festhalten (ueberlebt
    // Neustart/Deploy). Auftraege der Ueberwachung (Failover/Kontingent/Rueckkehr) schreiben nie.
    if (m.schritt === 'completed' && (z.art === 'modellwechsel' || z.art === 'runtime_wechsel') && tatsaechlich?.modell
      && istUserWahlAuftrag(z.erstellt_von) && (await leseCliModelleSchalter()).aktiv) {
      await client.query(
        `UPDATE agent_identitaeten SET startrezept = jsonb_set(COALESCE(startrezept, '{}'::jsonb), '{modell_je_runtime}',
            COALESCE(startrezept->'modell_je_runtime', '{}'::jsonb) || jsonb_build_object(COALESCE($2::text, startrezept->>'runtime', 'claude'), $3::text))
          WHERE id = $1`, [z.identity_id, tatsaechlich.runtime ?? null, tatsaechlich.modell]);
      // P22-T65: Effort-Wahl je Modell (Synapse-ID) daneben festhalten.
      const effort = typeof z.gewuenscht?.effort === 'string' && z.gewuenscht.effort.trim() ? z.gewuenscht.effort.trim() : null;
      if (effort) {
        await client.query(
          `UPDATE agent_identitaeten SET startrezept = jsonb_set(COALESCE(startrezept, '{}'::jsonb), '{effort_je_modell}',
              COALESCE(startrezept->'effort_je_modell', '{}'::jsonb) || jsonb_build_object($2::text, $3::text))
            WHERE id = $1`, [z.identity_id, tatsaechlich.modell, effort]);
      }
    }
    if (m.schritt !== 'accepted') {
      await client.query(
        `INSERT INTO agent_identitaet_audit (identity_id, wer, aktion, alt, neu, grund, actor_identity_id) VALUES ($1,$2,$3,NULL,$4::jsonb,$5,NULL)`,
        [z.identity_id, wer, m.schritt === 'completed' ? 'runtime_auftrag_ausgefuehrt' : 'runtime_auftrag_abgelehnt',
          JSON.stringify({ auftrag_id: z.id, art: z.art, tatsaechlich, fehler: fehlerText }), 'Runtime-Daemon (P22-T6)']);
    }
    await client.query('COMMIT');
    return { auftrag_id: z.id, status: z.status, tatsaechlich: z.tatsaechlich };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
