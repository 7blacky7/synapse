/**
 * MODUL: intern waits_tot (P15-T31, 11.10.2026)
 * ZWECK: Tote Co-Edit-Waits sichtbar machen und — nur auf ausdruecklichen Auftrag — verlustfrei
 *        schliessen. Grundlage P15-T27 (thought c327013d): ein Wait ohne Ziel, dessen Primaeragent auf
 *        keiner der geteilten Dateien mehr eine lebende Reservierung haelt (abgelaufen, freigegeben,
 *        abgemeldet), loest sich nie mehr (totWaitSql in file-batch.ts). Live lagen 27 davon herum.
 *
 * USER-VORGABE: "so beheben, dass es perfekt wird, ohne dass wir etwas verlieren." Deshalb:
 *   - NICHTS wird automatisch geloescht oder geschlossen; kein Worker ruft das hier auf.
 *   - waits_tot ohne ausfuehren:true = Vorschau: jeder tote Wait vollstaendig (Besitzer, Ziel-Datei(en),
 *     Alter, Ops mit vollem Inhalt, Basis-Hash je Datei, aktueller Hash, warum tot). Aendert nichts.
 *   - ausfuehren:true je Wait in EINER Transaktion, in dieser Reihenfolge:
 *       1. erneut pruefen, dass der Wait noch tot ist (FOR UPDATE; sonst unberuehrt lassen),
 *       2. Sicherung als thought (tags ['wait-sicherung', <besitzer>]) mit vollem Op-Inhalt, Basis-Hash
 *          und Anleitung zum Wiedereinspielen (files(action:"plan", ops:<OPS_JSON>)),
 *       3. Event ANNOUNCEMENT an den Besitzer (scope agent:<besitzer>, mit thought-ID),
 *       4. ERST DANACH Wait auf closed und den dadurch leeren Traeger auf cancelled (nur wenn er keine
 *          Op und keinen anderen offenen Wait mehr hat).
 *     Scheitert ein Schritt, rollt die Transaktion zurueck: kein Schliessen ohne Sicherung.
 *   - Der thought wird direkt in PG geschrieben (embedded_at NULL); das Embedding holt der Nachzug bzw.
 *     embeddeThoughtNach nebenlaeufig nach. So haengt die Sicherung nicht an Qdrant.
 *
 * WIEDER EINSPIELEN: der Block zwischen "<<<OPS_JSON" und "OPS_JSON>>>" im thought ist ein JSON-Array
 * von Ops ohne Co-Edit-Metadaten (opZumNeuPlanen) — direkt als ops an files(action:"plan") geben.
 * Die entfernten Metadaten stehen darunter (META_JSON), damit auch sie nicht verloren sind.
 */

import { randomUUID } from 'node:crypto';
import { getPool } from '../db/client.js';
import { emitEventOnce } from './events.js';
import { embeddeThoughtNach } from './thoughts.js';
import { opZumNeuPlanen, totWaitSql, type FileBatchOp } from './file-batch.js';

export const WAITS_ACTIONS = ['waits_tot'] as const;
export type WaitsAction = (typeof WAITS_ACTIONS)[number];

export function istWaitsAction(action: string): action is WaitsAction {
  return (WAITS_ACTIONS as readonly string[]).includes(action);
}

/** Satz fuer die Tool-Beschreibung (intern-tool.ts haengt ihn an). */
export const WAITS_BESCHREIBUNG =
  'WAITS: waits_tot (project, besitzer, wait_token, ausfuehren): tote Co-Edit-Waits (kein Ziel, Primaeragent ohne lebende ' +
  'Reservierung) vollstaendig zeigen — Besitzer, Ziel-Datei(en), Alter, Ops mit vollem Inhalt, Basis-Hash; ohne ausfuehren:true ' +
  'nur Vorschau. ausfuehren:true sichert JEDEN Wait zuerst als thought (tags wait-sicherung + Besitzer, Ops + Anleitung ' +
  'files(action:"plan", ops:<OPS_JSON>)), informiert den Besitzer per Event und schliesst erst danach Wait und leeren Traeger. ' +
  'Nichts wird geloescht. ';

/** Nur NEUE Parameter (project und ausfuehren nutzt die Action mit). */
export const WAITS_PARAMETER: Record<string, unknown> = {
  besitzer: { type: 'string', description: 'waits_tot: nur Waits dieses wartenden Agenten (Besitzer der Ops)' },
  wait_token: {
    type: ['string', 'array'], items: { type: 'string' },
    description: 'waits_tot: nur diese Wait-Token (aus der Vorschau) — gezielt sichern und schliessen',
  },
};

/** Ein toter Wait, vollstaendig. */
export interface ToterWait {
  wait_token: string;
  project: string;
  /** Wartender Agent: ihm gehoeren die Ops. */
  besitzer: string | null;
  /** Auf ihn wartet der Wait (Primaeragent ohne lebende Reservierung). */
  wartet_auf: string;
  ziel_dateien: string[];
  traeger_plan_id: string;
  traeger_status: string | null;
  traeger_ops: number | null;
  erstellt: string;
  alter_minuten: number;
  alter_text: string;
  /** Warum tot: letzte Reservierung des Primaeragenten auf den Dateien. */
  warum_tot: string;
  /** Ops mit vollem Inhalt, wie sie im Wait liegen. */
  ops: FileBatchOp[];
  op_indexes: number[];
  /** Hash je Datei beim Entstehen des Waits (letzte file_version davor, sonst expected_hashes des Traegers); null = unbekannt. */
  basis_hashes: Record<string, string | null>;
  /** Hash je Datei jetzt (code_files); null = Datei fehlt. */
  aktuelle_hashes: Record<string, string | null>;
  basis_unveraendert: boolean;
}

interface WaitZeile {
  wait_token: string;
  project: string;
  waiting_agent: string | null;
  primary_agent: string;
  shared_files: string[];
  deferred_ops: FileBatchOp[];
  deferred_op_indexes: number[];
  source_plan_id: string;
  created_at: Date | string;
  alter_s: number;
  traeger_status: string | null;
  traeger_ops: number | null;
  expected_hashes: Record<string, string> | null;
}

const WAIT_SPALTEN = `w.wait_token::text AS wait_token, w.project, w.waiting_agent, w.primary_agent, w.shared_files,
  w.deferred_ops, w.deferred_op_indexes, w.source_plan_id::text AS source_plan_id, w.created_at,
  EXTRACT(EPOCH FROM (NOW() - w.created_at))::int AS alter_s,
  c.status::text AS traeger_status, jsonb_array_length(c.ops)::int AS traeger_ops, c.expected_hashes`;

function alterText(sekunden: number): string {
  const min = Math.floor(sekunden / 60);
  if (min < 60) return `${min} min`;
  const std = Math.floor(min / 60);
  if (std < 48) return `${std} h ${min % 60} min`;
  return `${Math.floor(std / 24)} Tage ${std % 24} h`;
}

const iso = (v: Date | string): string => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());

async function fuelleAus(zeilen: WaitZeile[]): Promise<ToterWait[]> {
  const pool = getPool();
  const ergebnis: ToterWait[] = [];
  for (const z of zeilen) {
    const aktuell = await pool.query<{ file_path: string; content_hash: string }>(
      `SELECT file_path, content_hash FROM code_files WHERE project = $1 AND file_path = ANY($2::text[]) AND deleted_at IS NULL`,
      [z.project, z.shared_files],
    );
    const reservierung = await pool.query<{ expires_at: Date; released_at: Date | null; abgemeldet: boolean }>(
      `SELECT r.expires_at, r.released_at,
              EXISTS (SELECT 1 FROM agent_sessions s WHERE s.id = r.agent_id AND s.status <> 'active') AS abgemeldet
         FROM file_reservations r
        WHERE r.project = $1 AND r.agent_id = $2 AND r.file_path = ANY($3::text[])
        ORDER BY r.reserved_at DESC LIMIT 1`,
      [z.project, z.primary_agent, z.shared_files],
    );
    const r = reservierung.rows[0];
    const warumTot = !r
      ? `${z.primary_agent} haelt keine Reservierung auf diesen Dateien`
      : r.released_at
        ? `Reservierung von ${z.primary_agent} freigegeben ${iso(r.released_at)}`
        : r.abgemeldet
          ? `${z.primary_agent} ist abgemeldet`
          : `Reservierung von ${z.primary_agent} abgelaufen ${iso(r.expires_at)}`;
    // Basis = Stand der Datei, als der Wait entstand: letzte file_version davor. Der leere Traeger
    // hat fuer die Wait-Dateien keine expected_hashes (seine Ops liegen ja im Wait).
    const versionen = await pool.query<{ file_path: string; content_hash: string }>(
      `SELECT DISTINCT ON (file_path) file_path, content_hash
         FROM file_versions
        WHERE project = $1 AND file_path = ANY($2::text[]) AND created_at <= $3::timestamptz
        ORDER BY file_path, created_at DESC, id DESC`,
      [z.project, z.shared_files, iso(z.created_at)],
    );
    const basis: Record<string, string | null> = {};
    const jetzt: Record<string, string | null> = {};
    for (const datei of z.shared_files) {
      basis[datei] = versionen.rows.find((row) => row.file_path === datei)?.content_hash ?? z.expected_hashes?.[datei] ?? null;
      jetzt[datei] = aktuell.rows.find((row) => row.file_path === datei)?.content_hash ?? null;
    }
    ergebnis.push({
      wait_token: z.wait_token,
      project: z.project,
      besitzer: z.waiting_agent,
      wartet_auf: z.primary_agent,
      ziel_dateien: z.shared_files,
      traeger_plan_id: z.source_plan_id,
      traeger_status: z.traeger_status,
      traeger_ops: z.traeger_ops,
      erstellt: iso(z.created_at),
      alter_minuten: Math.floor(Number(z.alter_s) / 60),
      alter_text: alterText(Number(z.alter_s)),
      warum_tot: warumTot,
      ops: Array.isArray(z.deferred_ops) ? z.deferred_ops : [],
      op_indexes: z.deferred_op_indexes ?? [],
      basis_hashes: basis,
      aktuelle_hashes: jetzt,
      basis_unveraendert: z.shared_files.every((datei) => basis[datei] !== null && basis[datei] === jetzt[datei]),
    });
  }
  return ergebnis;
}

/** Alle toten Waits (optional gefiltert). Liest nur. */
export async function toteWaitsListe(filter: {
  project?: string;
  besitzer?: string;
  wait_tokens?: string[];
} = {}): Promise<ToterWait[]> {
  const res = await getPool().query<WaitZeile>(
    `SELECT ${WAIT_SPALTEN}
       FROM file_batch_waits w LEFT JOIN file_batch_plans c ON c.id = w.source_plan_id
      WHERE ${totWaitSql('w')}
        AND ($1::text IS NULL OR w.project = $1)
        AND ($2::text IS NULL OR w.waiting_agent = $2)
        AND ($3::text[] IS NULL OR w.wait_token::text = ANY($3::text[]))
      ORDER BY w.created_at, w.wait_token`,
    [filter.project ?? null, filter.besitzer ?? null, filter.wait_tokens && filter.wait_tokens.length > 0 ? filter.wait_tokens : null],
  );
  return fuelleAus(res.rows);
}

/** Text des Sicherungs-thoughts. Der OPS_JSON-Block ist maschinenlesbar und einspielbar. */
export function sicherungsText(wait: ToterWait): string {
  const opsSauber = wait.ops.map(opZumNeuPlanen);
  const meta = wait.ops.map((op, index) => {
    const entfernt: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(op as unknown as Record<string, unknown>)) {
      if (k === 'agent_id' || k.startsWith('coedit_')) entfernt[k] = v;
    }
    return { index, ...entfernt };
  });
  const hashes = wait.ziel_dateien.map((datei) => {
    const b = wait.basis_hashes[datei];
    const a = wait.aktuelle_hashes[datei];
    return `  ${datei}: Basis ${b ?? 'unbekannt'} | jetzt ${a ?? 'Datei fehlt'} (${b !== null && b === a ? 'unveraendert' : 'GEAENDERT oder unbekannt'})`;
  }).join('\n');
  return [
    'WAIT-SICHERUNG (P15-T31, intern waits_tot): toter Co-Edit-Wait vor dem Schliessen verlustfrei gesichert.',
    `Besitzer: ${wait.besitzer ?? 'unbekannt'} | Projekt: ${wait.project} | Wait: ${wait.wait_token}`,
    `Traegerplan: ${wait.traeger_plan_id} (${wait.traeger_status ?? 'fehlt'}) | wartete auf: ${wait.wartet_auf}`,
    `Ziel-Datei(en): ${wait.ziel_dateien.join(', ')}`,
    `Erstellt: ${wait.erstellt} (Alter ${wait.alter_text}) | Warum tot: ${wait.warum_tot}`,
    'Basis-Hash je Datei (Stand beim Planen):',
    hashes,
    '',
    'WIEDER EINSPIELEN:',
    `  files(action:"plan", project:"${wait.project}", agent_id:"${wait.besitzer ?? '<besitzer>'}", ops:<OPS_JSON unten>, reason:"Wait-Sicherung ${wait.wait_token} eingespielt")`,
    '  danach files(action:"commit", plan_id) — oder gleich auto_commit:true.',
    '  Ist eine Datei seit dem Basis-Hash GEAENDERT, zuerst Anker/Suchtexte pruefen: der Trockenlauf meldet nicht mehr passende Ops als failed_ops,',
    '  dann mit files(action:"plan_update", plan_id, op_index, ops) korrigieren. Nichts davon wurde geschrieben.',
    '',
    `OPS_JSON (${opsSauber.length} Op(s), vollstaendig, ohne Co-Edit-Metadaten):`,
    '<<<OPS_JSON',
    JSON.stringify(opsSauber, null, 2),
    'OPS_JSON>>>',
    '',
    `META_JSON (entfernte Co-Edit-Metadaten je Op, op_indexes im Traeger ${JSON.stringify(wait.op_indexes)}):`,
    JSON.stringify(meta),
  ].join('\n');
}

export interface WaitGeschlossen {
  wait_token: string;
  besitzer: string | null;
  thought_id: string;
  event_id: number | null;
  traeger_plan_id: string;
  traeger_verworfen: boolean;
  ops: number;
}

/**
 * Sichert und schliesst die toten Waits (gefiltert). Je Wait eine Transaktion; ein Wait, der
 * inzwischen lebt (Besitzer hat neu geplant, Reservierung erneuert), bleibt unberuehrt.
 */
export async function toteWaitsSichernUndSchliessen(filter: {
  project?: string;
  besitzer?: string;
  wait_tokens?: string[];
  agentId?: string;
}): Promise<{ geschlossen: WaitGeschlossen[]; uebersprungen: Array<{ wait_token: string; grund: string }> }> {
  const kandidaten = await toteWaitsListe(filter);
  const geschlossen: WaitGeschlossen[] = [];
  const uebersprungen: Array<{ wait_token: string; grund: string }> = [];
  const quelle = filter.agentId || 'intern-waits-tot';
  for (const kandidat of kandidaten) {
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      // 1. noch tot? (Sperre auf der Wait-Zeile, frischer Stand)
      const frisch = await client.query<WaitZeile>(
        `SELECT ${WAIT_SPALTEN}
           FROM file_batch_waits w LEFT JOIN file_batch_plans c ON c.id = w.source_plan_id
          WHERE w.wait_token = $1::uuid AND ${totWaitSql('w')}
          FOR UPDATE OF w`,
        [kandidat.wait_token],
      );
      if (frisch.rows.length === 0) {
        await client.query('ROLLBACK');
        uebersprungen.push({ wait_token: kandidat.wait_token, grund: 'nicht mehr tot (neu geplant, Ziel gebunden oder Reservierung erneuert) — unberuehrt' });
        continue;
      }
      const wait = (await fuelleAus(frisch.rows))[0] ?? kandidat;
      // 2. Sicherung
      const thoughtId = randomUUID();
      const tags = ['wait-sicherung', wait.besitzer ?? 'besitzer-unbekannt'];
      await client.query(
        `INSERT INTO thoughts (id, project, source, content, tags, timestamp) VALUES ($1, $2, $3, $4, $5, NOW())`,
        [thoughtId, wait.project, quelle, sicherungsText(wait), tags],
      );
      // 3. Besitzer informieren
      let eventId: number | null = null;
      if (wait.besitzer) {
        const ev = await emitEventOnce({
          project: wait.project,
          eventType: 'ANNOUNCEMENT',
          priority: 'normal',
          scope: `agent:${wait.besitzer}`,
          sourceId: quelle,
          payload: JSON.stringify({
            art: 'WAIT_GESICHERT',
            wait_token: wait.wait_token,
            thought_id: thoughtId,
            traeger_plan_id: wait.traeger_plan_id,
            dateien: wait.ziel_dateien,
            ops: wait.ops.length,
            hinweis: `Dein Co-Edit-Wait ${wait.wait_token} war tot (${wait.warum_tot}) und wurde geschlossen. Deine ${wait.ops.length} Op(s) `
              + `wurden NICHT geschrieben, sind aber vollstaendig gesichert: thought(action:"get", id:"${thoughtId}"). `
              + `Wieder einspielen: files(action:"plan", ops:<OPS_JSON aus dem thought>) und commit.`,
          }),
          requiresAck: true,
          dedupeKey: `wait-sicherung:${wait.wait_token}`,
        }, client);
        eventId = ev?.id ?? null;
      }
      // 4. erst jetzt schliessen
      await client.query(
        `UPDATE file_batch_waits SET status = 'closed', updated_at = NOW() WHERE wait_token = $1::uuid`,
        [wait.wait_token],
      );
      const traeger = await client.query(
        `UPDATE file_batch_plans c
            SET status = 'cancelled', reason = CONCAT_WS(' ', c.reason, $2::text)
          WHERE c.id = $1::bigint AND c.status = 'open' AND jsonb_array_length(c.ops) = 0
            AND NOT EXISTS (
              SELECT 1 FROM file_batch_waits w LEFT JOIN file_batch_plans t ON t.id = w.primary_plan_id
               WHERE w.source_plan_id = c.id AND w.status <> 'closed'
                 AND (w.primary_plan_id IS NULL OR t.status = 'open'))`,
        [wait.traeger_plan_id, `[Traegerplan geschlossen durch intern waits_tot, Wait ${wait.wait_token} gesichert in thought ${thoughtId}]`],
      );
      await client.query('COMMIT');
      void embeddeThoughtNach(wait.project, thoughtId).catch(() => {
        /* Nachzug (embed-backlog) holt es nach: embedded_at bleibt NULL */
      });
      geschlossen.push({
        wait_token: wait.wait_token,
        besitzer: wait.besitzer,
        thought_id: thoughtId,
        event_id: eventId,
        traeger_plan_id: wait.traeger_plan_id,
        traeger_verworfen: (traeger.rowCount ?? 0) > 0,
        ops: wait.ops.length,
      });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      uebersprungen.push({ wait_token: kandidat.wait_token, grund: `Fehler, nichts geaendert: ${(error as Error).message}` });
    } finally {
      client.release();
    }
  }
  return { geschlossen, uebersprungen };
}

function textListe(v: unknown): string[] | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (Array.isArray(v)) return v.map(String).filter(Boolean);
  const s = String(v).trim();
  if (s.startsWith('[')) {
    try {
      const geparst = JSON.parse(s);
      if (Array.isArray(geparst)) return geparst.map(String).filter(Boolean);
    } catch { /* als Einzelwert behandeln */ }
  }
  return s.split(',').map((t) => t.trim()).filter(Boolean);
}

/** Dispatcher. Wirft nie. */
export async function fuehreWaitsAus(
  action: WaitsAction,
  a: Record<string, unknown>,
  agentId?: string,
): Promise<Record<string, unknown>> {
  try {
    const filter = {
      project: typeof a.project === 'string' && a.project ? a.project : undefined,
      besitzer: typeof a.besitzer === 'string' && a.besitzer ? a.besitzer : undefined,
      wait_tokens: textListe(a.wait_token),
    };
    const ausfuehren = a.ausfuehren === true || a.ausfuehren === 'true';
    if (!ausfuehren) {
      const waits = await toteWaitsListe(filter);
      return {
        success: true,
        action,
        vorschau: true,
        anzahl: waits.length,
        ops_gesamt: waits.reduce((s, w) => s + w.ops.length, 0),
        waits,
        hinweis: waits.length === 0
          ? 'Keine toten Waits.'
          : 'Vorschau, nichts geaendert. ausfuehren:true sichert jeden Wait als thought (tags wait-sicherung + Besitzer), '
            + 'informiert den Besitzer per Event und schliesst erst danach Wait und leeren Traeger. Gezielt: wait_token:[...].',
      };
    }
    const ergebnis = await toteWaitsSichernUndSchliessen({ ...filter, agentId });
    return {
      success: true,
      action,
      vorschau: false,
      geschlossen: ergebnis.geschlossen,
      uebersprungen: ergebnis.uebersprungen,
      message: `${ergebnis.geschlossen.length} toter Wait/tote Waits gesichert und geschlossen`
        + (ergebnis.uebersprungen.length > 0 ? `, ${ergebnis.uebersprungen.length} uebersprungen` : '')
        + '. Je Wait: thought(action:"get", id:<thought_id>) enthaelt die Ops und die Anleitung zum Wiedereinspielen.',
    };
  } catch (error) {
    return { success: false, action, error: 'waits_fehler', message: (error as Error).message };
  }
}
