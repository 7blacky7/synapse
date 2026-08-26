/**
 * Artefakt-Service (ART-1): HTML-Bloecke des Hauptagenten fuer die Web-UI.
 *
 * DIE PG-ZEILE IST DIE WAHRHEIT. Die Datei im Runtime-Container (heute unter
 * /attachments/artefakte, spaeter /mnt/user/synapse-artefakte sobald der Share
 * existiert — Nutzer-Entscheid 26.08.2026) ist nur das Abbild fuers Rendern.
 * Laufen beide auseinander, gewinnt PG.
 */
import { randomUUID } from 'node:crypto';
import { getPool } from '../db/client.js';

export interface ArtefaktEingabe {
  sessionId: string;
  html: string;
  titel?: string | null;
  artefaktId?: string | null;
  column?: number | null;
  columnSpan?: number | null;
  row?: number | null;
  rowSpan?: number | null;
  minHeight?: number | null;
  createdBy?: string | null;
}

export interface ArtefaktZeile {
  id: string;
  sessionId: string;
  title: string | null;
  html: string;
  column: number | null;
  columnSpan: number | null;
  row: number | null;
  rowSpan: number | null;
  minHeight: number | null;
  revision: number;
  htmlPath: string | null;
  imagePath: string | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// 2 MB reichen fuer einen Block und verhindern, dass ein Amok-HTML die DB flutet.
export const ARTEFAKT_HTML_MAX = 2_000_000;

/** Liefert null wenn die Eingabe gueltig ist, sonst die Klartext-Begruendung. */
export function pruefeArtefaktEingabe(input: ArtefaktEingabe): string | null {
  if (!input.sessionId || typeof input.sessionId !== 'string') {
    return 'session_id fehlt — das Artefakt-Tool laeuft nur im Kontext einer Hauptagenten-Session';
  }
  if (typeof input.html !== 'string' || !input.html.trim()) {
    return 'html ist Pflicht und darf nicht leer sein';
  }
  if (input.html.length > ARTEFAKT_HTML_MAX) {
    return 'html ist zu gross (' + String(input.html.length) + ' Zeichen, Limit ' + String(ARTEFAKT_HTML_MAX) + ')';
  }
  const ganzzahlen: Array<[string, number | null | undefined]> = [
    ['column', input.column],
    ['columnSpan', input.columnSpan],
    ['row', input.row],
    ['rowSpan', input.rowSpan],
    ['minHeight', input.minHeight],
  ];
  for (const [name, wert] of ganzzahlen) {
    if (wert === undefined || wert === null) continue;
    if (!Number.isInteger(wert) || wert < 0 || wert > 10000) {
      return name + ' muss eine Ganzzahl zwischen 0 und 10000 sein';
    }
  }
  return null;
}

function zeile(row: Record<string, unknown>): ArtefaktZeile {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    title: (row.title as string | null) ?? null,
    html: String(row.html),
    column: (row.column_pos as number | null) ?? null,
    columnSpan: (row.column_span as number | null) ?? null,
    row: (row.row_pos as number | null) ?? null,
    rowSpan: (row.row_span as number | null) ?? null,
    minHeight: (row.min_height as number | null) ?? null,
    revision: Number(row.revision),
    htmlPath: (row.html_path as string | null) ?? null,
    imagePath: (row.image_path as string | null) ?? null,
    createdBy: (row.created_by as string | null) ?? null,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

/**
 * Legt einen Block an — oder ersetzt mit artefaktId einen bestehenden Block
 * DERSELBEN Session (revision + 1). Session-Bindung beim Update ist Pflicht,
 * sonst koennte eine fremde Session fremde Artefakte ueberschreiben.
 */
export async function speichereArtefakt(input: ArtefaktEingabe): Promise<ArtefaktZeile> {
  const fehler = pruefeArtefaktEingabe(input);
  if (fehler) throw new Error(fehler);
  const pool = getPool();
  if (input.artefaktId) {
    const result = await pool.query(
      `UPDATE agent_artifacts
          SET html = $2,
              title = COALESCE($3, title),
              column_pos = COALESCE($4, column_pos),
              column_span = COALESCE($5, column_span),
              row_pos = COALESCE($6, row_pos),
              row_span = COALESCE($7, row_span),
              min_height = COALESCE($8, min_height),
              revision = revision + 1,
              updated_at = NOW()
        WHERE id = $1 AND session_id = $9
        RETURNING *`,
      [
        input.artefaktId,
        input.html,
        input.titel ?? null,
        input.column ?? null,
        input.columnSpan ?? null,
        input.row ?? null,
        input.rowSpan ?? null,
        input.minHeight ?? null,
        input.sessionId,
      ],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) {
      throw new Error('artefakt_id ' + input.artefaktId + ' existiert nicht oder gehoert zu einer anderen Session — fuer einen neuen Block artefakt_id weglassen');
    }
    return zeile(row);
  }
  const id = randomUUID();
  const result = await pool.query(
    `INSERT INTO agent_artifacts
            (id, session_id, title, html, column_pos, column_span, row_pos, row_span, min_height, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [
      id,
      input.sessionId,
      input.titel ?? null,
      input.html,
      input.column ?? null,
      input.columnSpan ?? null,
      input.row ?? null,
      input.rowSpan ?? null,
      input.minHeight ?? null,
      input.createdBy ?? null,
    ],
  );
  return zeile(result.rows[0] as Record<string, unknown>);
}

/** Traegt die Abbild-Pfade nach — die Zeile selbst bleibt davon unberuehrt die Wahrheit. */
export async function aktualisiereArtefaktPfade(id: string, htmlPath: string | null, imagePath: string | null): Promise<void> {
  await getPool().query(
    'UPDATE agent_artifacts SET html_path = $2, image_path = $3, updated_at = NOW() WHERE id = $1',
    [id, htmlPath, imagePath],
  );
}
