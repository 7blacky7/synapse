/**
 * MODUL: Ignore-Regeln je Projekt (IGN-2)
 *
 * ZWECK: Die Regeln, die bestimmen welche Dateien Synapse indexiert und anzeigt,
 *        werden hier gepflegt — anlegen, entfernen, einzeln an- und abschalten,
 *        und pruefen warum ein Pfad nicht sichtbar ist.
 *
 * WARUM IN DER DATENBANK: Frueher stand das in der Datei .synapseignore. Lokaler
 *        Daemon und API lasen sie jeder fuer sich vom Dateisystem, hatten also
 *        jeder seine eigene Wahrheit. Ueber die Tabelle project_ignore_rules
 *        sehen beide dieselben Regeln.
 *
 * SCHUTZ: Regeln mit locked=true (node_modules, .git, dist, .env, .mcp.json)
 *        koennen weder entfernt noch abgeschaltet werden. Ohne diese Sperre
 *        koennte ein versehentliches Freigeben ein Paketverzeichnis in den
 *        Index ziehen.
 *
 * NEBENEFFEKTE:
 *   - PostgreSQL: schreibt in project_ignore_rules (Trigger meldet die Aenderung
 *     per pg_notify an alle Prozesse)
 *   - verwirft den Zwischenspeicher im eigenen Prozess, damit eine Aenderung
 *     dort sofort wirkt
 */

import { getPool } from '../db/client.js';
import {
  verwirfIgnoreRegeln,
  erklaereIgnore,
  aktualisiereIgnoreRegeln,
  loadGitignore,
  shouldIgnore,
} from '../watcher/ignore.js';

export interface IgnoreRegel {
  id: string;
  pattern: string;
  scope: string | null;
  enabled: boolean;
  locked: boolean;
  kommentar: string | null;
  sort_order: number;
}

/** Alle Regeln eines Projekts, in Wirkreihenfolge (spaetere gewinnt). */
export async function listeIgnoreRegeln(project: string): Promise<IgnoreRegel[]> {
  const ergebnis = await getPool().query<IgnoreRegel>(
    `SELECT id::text AS id, pattern, scope, enabled, locked, kommentar, sort_order
       FROM project_ignore_rules
      WHERE project = $1
      ORDER BY sort_order, id`,
    [project],
  );
  return ergebnis.rows;
}

/**
 * Legt eine oder mehrere Regeln an. Bereits vorhandene Muster werden
 * uebersprungen statt zu scheitern — mehrfaches Anlegen soll nichts kaputt machen.
 * Ohne sort_order wird ans Ende gehaengt, damit eine neue Regel spaetere
 * Wirkung hat als die bestehenden (gitignore-Semantik).
 */
export async function fuegeIgnoreRegelnHinzu(
  project: string,
  regeln: Array<{ pattern: string; scope?: string; kommentar?: string; sort_order?: number }>,
  agentId?: string | null,
): Promise<{ hinzugefuegt: string[]; uebersprungen: string[] } & Auswirkung> {
  const pool = getPool();
  const hoechste = await pool.query<{ max: number | null }>(
    'SELECT MAX(sort_order) AS max FROM project_ignore_rules WHERE project = $1',
    [project],
  );
  let naechste = (hoechste.rows[0]?.max ?? 0) + 10;

  const hinzugefuegt: string[] = [];
  const uebersprungen: string[] = [];

  for (const regel of regeln) {
    const muster = regel.pattern.trim();
    if (!muster) continue;
    const eingefuegt = await pool.query(
      `INSERT INTO project_ignore_rules (project, pattern, scope, kommentar, sort_order, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [project, muster, regel.scope ?? null, regel.kommentar ?? null, regel.sort_order ?? naechste, agentId ?? null],
    );
    if (eingefuegt.rowCount) {
      hinzugefuegt.push(muster);
      naechste += 10;
    } else {
      uebersprungen.push(muster);
    }
  }

  const auswirkung = hinzugefuegt.length
    ? await nachRegelAenderung(project)
    : { neuAusgeblendet: [], neuSichtbar: [] };
  return { hinzugefuegt, uebersprungen, ...auswirkung };
}

/**
 * Entfernt eine Regel. Gesperrte Regeln bleiben bestehen und werden mit einer
 * klaren Meldung abgewiesen — sie sind die Untergrenze, die verhindert dass
 * Paketverzeichnisse in den Index geraten.
 */
export async function entferneIgnoreRegel(
  project: string,
  muster: string,
): Promise<{ entfernt: boolean; grund?: string } & Partial<Auswirkung>> {
  const pool = getPool();
  const vorhanden = await pool.query<{ locked: boolean }>(
    'SELECT locked FROM project_ignore_rules WHERE project = $1 AND pattern = $2',
    [project, muster],
  );
  if (!vorhanden.rowCount) {
    return { entfernt: false, grund: `Regel "${muster}" gibt es in diesem Projekt nicht.` };
  }
  if (vorhanden.rows[0].locked) {
    return {
      entfernt: false,
      grund: `Regel "${muster}" ist gesperrt und kann nicht entfernt werden. ` +
        `Gesperrte Regeln schuetzen den Index vor Paket- und Build-Verzeichnissen.`,
    };
  }
  await pool.query('DELETE FROM project_ignore_rules WHERE project = $1 AND pattern = $2', [project, muster]);
  return { entfernt: true, ...(await nachRegelAenderung(project)) };
}

/**
 * Schaltet eine Regel an oder ab, ohne sie zu verlieren — der eigentliche Zweck
 * der Tabelle. Gesperrte Regeln lassen sich nicht abschalten (einschalten schon,
 * das ist immer unbedenklich).
 */
export async function schalteIgnoreRegel(
  project: string,
  muster: string,
  aktiv: boolean,
): Promise<{ geschaltet: boolean; grund?: string } & Partial<Auswirkung>> {
  const pool = getPool();
  const vorhanden = await pool.query<{ locked: boolean; enabled: boolean }>(
    'SELECT locked, enabled FROM project_ignore_rules WHERE project = $1 AND pattern = $2',
    [project, muster],
  );
  if (!vorhanden.rowCount) {
    return { geschaltet: false, grund: `Regel "${muster}" gibt es in diesem Projekt nicht.` };
  }
  if (vorhanden.rows[0].locked && !aktiv) {
    return {
      geschaltet: false,
      grund: `Regel "${muster}" ist gesperrt und kann nicht abgeschaltet werden. ` +
        `Sonst wuerde der naechste Durchlauf Paket- oder Build-Verzeichnisse einlesen.`,
    };
  }
  if (vorhanden.rows[0].enabled === aktiv) {
    return { geschaltet: true };
  }
  await pool.query(
    'UPDATE project_ignore_rules SET enabled = $3, updated_at = NOW() WHERE project = $1 AND pattern = $2',
    [project, muster, aktiv],
  );
  return { geschaltet: true, ...(await nachRegelAenderung(project)) };
}

/**
 * Beantwortet: wird dieser Pfad ignoriert, und durch WELCHE Regel?
 *
 * Ohne diese Auskunft muss man Ignore-Dateien von Hand durchsuchen — genau daran
 * ist am 2026-07-25 Zeit verloren gegangen, weil beim Lesen der Datei die
 * entscheidende Zeile abgeschnitten war und der Fehler deshalb im Code gesucht
 * wurde statt in den Regeln.
 */
export async function pruefeIgnorePfad(
  project: string,
  pfad: string,
  projectPath?: string,
): Promise<{ pfad: string; ignoriert: boolean; regel: string | null; herkunft: string | null; hinweis: string }> {
  const wurzel = projectPath ?? await ermittleProjektWurzel(project);
  await aktualisiereIgnoreRegeln(project);
  const ergebnis = erklaereIgnore(wurzel, pfad, project);
  return {
    pfad,
    ignoriert: ergebnis.ignoriert,
    regel: ergebnis.regel,
    herkunft: ergebnis.herkunft,
    hinweis: ergebnis.ignoriert
      ? `Wird durch die Regel "${ergebnis.regel}" (${ergebnis.herkunft}) ignoriert. ` +
        `Zum Freigeben die Regel abschalten statt sie zu loeschen.`
      : 'Wird nicht ignoriert.',
  };
}

/**
 * Nach jeder Aenderung: den Zwischenspeicher im eigenen Prozess verwerfen und
 * neu laden. Andere Prozesse ziehen ueber die Gueltigkeitsdauer des
 * Zwischenspeichers nach; der Trigger auf der Tabelle meldet die Aenderung
 * zusaetzlich per pg_notify.
 */
async function nachRegelAenderung(project: string): Promise<Auswirkung> {
  verwirfIgnoreRegeln(project);
  await aktualisiereIgnoreRegeln(project);
  const markiert = await markiereIgnorierteDateien(project);
  return { neuAusgeblendet: markiert.neuAusgeblendet, neuSichtbar: markiert.neuSichtbar };
}

/**
 * Was eine Regel-Aenderung bewirkt hat. Wird bis zur Tool-Antwort durchgereicht,
 * damit sichtbar ist was passiert ist ("3 Dateien ausgeblendet, 1 wieder sichtbar").
 *
 * Wichtiger noch: IGN-8 haengt daran. neuAusgeblendet sind die Dateien, deren
 * Vektoren aus den Suchergebnissen fallen muessen; neuSichtbar die, bei denen vor
 * dem Wiedereinblenden der Hash zu pruefen ist — hat sich der Inhalt waehrend der
 * Ausblendung geaendert, sind die vorhandenen Vektoren veraltet.
 */
export interface Auswirkung {
  neuAusgeblendet: string[];
  neuSichtbar: string[];
}

/**
 * Berechnet code_files.ignored fuer das ganze Projekt neu (IGN-4).
 *
 * Die Markierung ist materialisiert, damit die Lesepfade mit einem simplen
 * "NOT ignored" filtern koennen, statt bei jeder Abfrage saemtliche Muster gegen
 * jeden Pfad zu pruefen.
 *
 * Die Rueckgabe nennt die Pfade, die neu ausgeblendet bzw. neu sichtbar wurden.
 * Darauf setzen zwei weitere Schritte auf:
 *   - neu ausgeblendet: im Qdrant-Payload als ignoriert markieren (IGN-8, Fall A).
 *     Die Vektoren bleiben liegen, sie werden nur nicht mehr geliefert.
 *   - neu sichtbar: HASH PRUEFEN. Ist der Inhalt auf der Platte inzwischen ein
 *     anderer, sind die vorhandenen Vektoren veraltet und muessen ersetzt werden;
 *     nur bei gleichem Hash genuegt es, die Markierung zurueckzunehmen. Wer das
 *     zusammenfasst, baut stille Falschtreffer ein (IGN-8, Fall A mit Drift).
 */
export async function markiereIgnorierteDateien(project: string): Promise<{
  geprueft: number;
  ignoriert: number;
  neuAusgeblendet: string[];
  neuSichtbar: string[];
}> {
  const wurzel = await ermittleProjektWurzel(project);
  // Regeln zuerst laden: bei kaltem Zwischenspeicher wuerde loadGitignore sonst
  // auf den Notnagel (.synapseignore vom Dateisystem) zurueckfallen und damit
  // einen anderen Regelstand verwenden als den, der gerade gesetzt wurde.
  await aktualisiereIgnoreRegeln(project);
  const regeln = loadGitignore(wurzel, project);
  const pool = getPool();

  const dateien = await pool.query<{ file_path: string; ignored: boolean }>(
    'SELECT file_path, ignored FROM code_files WHERE project = $1 AND deleted_at IS NULL',
    [project],
  );

  const neuAusgeblendet: string[] = [];
  const neuSichtbar: string[] = [];
  let ignoriert = 0;

  for (const zeile of dateien.rows) {
    const soll = shouldIgnore(regeln, zeile.file_path);
    if (soll) ignoriert++;
    if (soll === zeile.ignored) continue;
    (soll ? neuAusgeblendet : neuSichtbar).push(zeile.file_path);
  }

  if (neuAusgeblendet.length) {
    await pool.query(
      'UPDATE code_files SET ignored = TRUE WHERE project = $1 AND file_path = ANY($2)',
      [project, neuAusgeblendet],
    );
  }
  if (neuSichtbar.length) {
    await pool.query(
      'UPDATE code_files SET ignored = FALSE WHERE project = $1 AND file_path = ANY($2)',
      [project, neuSichtbar],
    );
  }

  return { geprueft: dateien.rowCount ?? 0, ignoriert, neuAusgeblendet, neuSichtbar };
}

/**
 * Projektwurzel aus der Tabelle projects. Wird gebraucht, weil die .gitignore
 * weiterhin vom Dateisystem gelesen wird — die Regeln aus der Datenbank allein
 * ergaeben ein unvollstaendiges Bild.
 */
async function ermittleProjektWurzel(project: string): Promise<string> {
  const ergebnis = await getPool().query<{ path: string }>(
    'SELECT path FROM projects WHERE name = $1',
    [project],
  );
  const pfad = ergebnis.rows[0]?.path;
  if (!pfad) {
    throw new Error(
      `Projekt "${project}" hat keinen Pfad in der Tabelle projects — ohne ihn ist die .gitignore nicht lesbar.`,
    );
  }
  return pfad;
}
