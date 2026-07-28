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
import { getFileContentFromPg, contentHash } from './code-write.js';
import { planBatch } from './file-batch.js';
import type { FileBatchOp, PlanBatchResult } from './file-batch.js';

/**
 * Was eine Regel bewirkt. Zwei verschiedene Dinge, die bis zum 28.07.2026
 * faelschlich eines waren:
 *
 *   'ausgeblendet'  Nur die Sichtbarkeit in code_intel — lexikalisch UND
 *                   semantisch. Zweck: Rauschen aus dem KI-Kontext halten.
 *                   Die Datei laeuft voellig normal zwischen Platte und
 *                   Datenbank hin und her.
 *   'gesperrt'      Der Inhalt darf gar nicht erst in die Datenbank. Der
 *                   lokale Daemon fragt vor dem Senden und schickt nichts los.
 *                   Fuer Secrets und fuer alles, was ein kuenftiges Framework
 *                   mitbringt und wofuer es noch keine Code-Regel gibt.
 */
export type IgnoreModus = 'ausgeblendet' | 'gesperrt';

export interface IgnoreRegel {
  id: string;
  pattern: string;
  scope: string | null;
  enabled: boolean;
  locked: boolean;
  modus: IgnoreModus;
  kommentar: string | null;
  sort_order: number;
}

/** Alle Regeln eines Projekts, in Wirkreihenfolge (spaetere gewinnt). */
export async function listeIgnoreRegeln(project: string): Promise<IgnoreRegel[]> {
  const ergebnis = await getPool().query<IgnoreRegel>(
    `SELECT id::text AS id, pattern, scope, enabled, locked, modus, kommentar, sort_order
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
  regeln: Array<{
    pattern: string;
    scope?: string;
    kommentar?: string;
    sort_order?: number;
    modus?: IgnoreModus;
  }>,
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
      `INSERT INTO project_ignore_rules (project, pattern, scope, kommentar, sort_order, created_by, modus)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        project,
        muster,
        regel.scope ?? null,
        regel.kommentar ?? null,
        regel.sort_order ?? naechste,
        agentId ?? null,
        // Standard ist ausblenden: die haeufigere und die harmlosere Wahl.
        // Sperren ist der Eingriff, der ausdruecklich verlangt werden muss.
        regel.modus === 'gesperrt' ? 'gesperrt' : 'ausgeblendet',
      ],
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
  if (hinzugefuegt.length) {
    await protokolliereIgnoreEreignis({
      project,
      pattern: hinzugefuegt.join(', '),
      editAction: 'ignore_add',
      agentId,
      auswirkung,
    });
  }
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
  agentId?: string | null,
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
  const auswirkung = await nachRegelAenderung(project);
  await protokolliereIgnoreEreignis({ project, pattern: muster, editAction: 'ignore_remove', agentId, auswirkung });
  return { entfernt: true, ...auswirkung };
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
  agentId?: string | null,
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
  const auswirkung = await nachRegelAenderung(project);
  await protokolliereIgnoreEreignis({
    project,
    pattern: muster,
    editAction: aktiv ? 'ignore_enable' : 'ignore_disable',
    agentId,
    auswirkung,
  });
  return { geschaltet: true, ...auswirkung };
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
 * Traegt eine Regel-Aenderung als sichtbares Ereignis in file_versions ein.
 *
 * WARUM file_versions UND NICHT watcher_events: der aktuell genutzte Go-Tray
 * (tray.go, ReloadEvents) zeigt im Events-Tab ausschliesslich file_versions —
 * ueber die API primaer, mit direktem PG-Zugriff als Fallback. watcher_events
 * ist ein aelterer Pfad, den nur die abgeloeste bash/zenity- und moo-Anzeige
 * lesen. Ohne diesen Eintrag bliebe ein Ent-/Ignorieren im tatsaechlich
 * genutzten Tray unsichtbar, obwohl es das Sichtbarkeitsmodell des ganzen
 * Projekts aendert.
 *
 * Rein informativ, kein echter Dateiinhalt (content bleibt leer, size_bytes
 * bleibt 0) — pattern steht im file_path-Feld, damit es in der Tray-Spalte
 * "Datei" lesbar auftaucht. Best-effort: ein Fehler hier darf die eigentliche
 * Regel-Aenderung nicht zu Fall bringen.
 */
async function protokolliereIgnoreEreignis(args: {
  project: string;
  pattern: string;
  editAction: 'ignore_add' | 'ignore_remove' | 'ignore_enable' | 'ignore_disable';
  agentId?: string | null;
  auswirkung: Auswirkung;
}): Promise<void> {
  const { project, pattern, editAction, agentId, auswirkung } = args;
  const teile: string[] = [];
  if (auswirkung.neuAusgeblendet.length) teile.push(`${auswirkung.neuAusgeblendet.length} Datei(en) ausgeblendet`);
  if (auswirkung.neuSichtbar.length) teile.push(`${auswirkung.neuSichtbar.length} Datei(en) wieder sichtbar`);
  const reason = teile.length ? teile.join(', ') : 'keine bereits indexierte Datei betroffen';
  try {
    await getPool().query(
      `INSERT INTO file_versions (project, file_path, content, content_hash, edit_action, agent_id, reason, size_bytes)
       VALUES ($1, $2, '', $3, $4, $5, $6, 0)`,
      [project, pattern, contentHash(''), editAction, agentId ?? null, reason],
    );
  } catch (fehler) {
    console.error('[Synapse] Ignore-Ereignis nicht protokolliert (best-effort):', (fehler as Error).message);
  }
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
 * Markiert eine EINZELNE, gerade erst geschriebene Datei als ignoriert.
 *
 * LUECKE, LIVE GEFUNDEN 2026-07-26: Fall B (pruefeUndBereiteSchreibenVor,
 * modus='direkt_mit_hinweis') legt eine brandneue Datei unter einer aktiven
 * Regel an und verspricht im Hinweistext "wird in ca. einer Minute aus Suche/
 * Baum ausgeblendet" -- aber createFileInPg setzt code_files.ignored NIE,
 * die Spalte bleibt beim INSERT-Default (false) stehen. Reproduziert: eine so
 * angelegte Datei blieb im Baum sichtbar, bis eine VOELLIG UNABHAENGIGE
 * Regel-Aenderung zufaellig einen vollstaendigen Neudurchlauf ausloeste.
 *
 * Diese Funktion wird von den Tool-Handlern (rest-api/mcp-server) direkt NACH
 * createFileInPg/updateFileInPg aufgerufen, wenn pruefeUndBereiteSchreibenVor
 * modus='direkt_mit_hinweis' zurueckgegeben hat -- die Datei existiert dann
 * bereits in code_files und braucht nur noch die Markierung.
 *
 * Best-effort: ein Fehler hier darf das eigentliche Schreiben nicht zu Fall
 * bringen, deshalb try/catch statt throw.
 */
export async function markiereEinzelneDateiIgnoriert(project: string, filePath: string): Promise<void> {
  try {
    await getPool().query(
      'UPDATE code_files SET ignored = TRUE WHERE project = $1 AND file_path = $2',
      [project, filePath],
    );
  } catch (fehler) {
    console.error(
      `[Synapse] Konnte "${filePath}" nicht als ignoriert markieren (best-effort):`,
      (fehler as Error).message,
    );
  }
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


/** Was pruefeUndBereiteSchreibenVor ueber die Lage eines Pfades herausgefunden hat. */
export interface IgnorierterSchreibHinweis {
  ignoriert: boolean;
  regel: string | null;
  herkunft: string | null;
  bestandExistiertBereits: boolean;
}

export type SchreibVorbereitung =
  | { modus: 'direkt' }
  | { modus: 'direkt_mit_hinweis'; hinweis: IgnorierterSchreibHinweis }
  | { modus: 'plan'; hinweis: IgnorierterSchreibHinweis; plan: PlanBatchResult; aktueller_inhalt: string };

/**
 * Bereitet ein create/update vor, BEVOR geschrieben wird. Zwei unabhaengige
 * Gruende koennen in den Planmodus fuehren:
 *
 * GRUND 1 — create auf einen bereits existierenden Pfad, UNABHAENGIG vom
 *   Ignore-Zustand. createFileInPg ueberschreibt sonst ohne jede Pruefung
 *   (ON CONFLICT DO UPDATE) — GEMESSEN am 2026-07-26: eine bestehende Funktion
 *   ging so ersatzlos verloren, ohne Fehlermeldung. Kein Upsert-Bypass: alles
 *   ist ohnehin versioniert (file_versions), ein Rollback ist jederzeit
 *   moeglich — das Sicherheitsnetz ist der Plan selbst.
 * GRUND 2 (Fall C) — die Datei ist ignoriert UND existiert bereits, betrifft
 *   create UND update. Eine ignorierte Datei ist fuer die KI unsichtbar, sie
 *   kann also nicht wissen was schon drinsteht.
 *
 * WEITERE FAELLE:
 * - Nicht ignoriert, existiert noch nicht: normal schreiben (modus 'direkt').
 * - Ignoriert, existiert noch nicht (Fall B, brandneu unter einer Regel
 *   angelegt): direkt schreiben ist unbedenklich, nichts zu verlieren — nur
 *   ein Hinweis, damit die KI weiss dass die Datei gleich aus Suche/Baum
 *   verschwindet (modus 'direkt_mit_hinweis').
 * - update auf einen bestehenden, NICHT ignorierten Pfad: normal schreiben —
 *   'update' impliziert per Definition, dass der Aufrufer die Datei kennt.
 *
 * Im Planmodus: ein Plan (planBatch) mit der gewuenschten Aenderung als
 * einzelner Op wird angelegt, aber NICHT committed. Die Antwort enthaelt den
 * AKTUELLEN Inhalt und die plan_id, damit die KI die Aenderung gegen das
 * Bestehende abgleichen und bei Bedarf anpassen kann, bevor sie committed.
 * Der Anker fuer den Op wird aus der ersten nicht-leeren Zeile des BESTEHENDEN
 * Inhalts abgeleitet (nicht von der KI angegeben) — das reicht, weil Plan und
 * Pruefung im selben Aufruf entstehen, es also keine Zeit fuer Drift gibt.
 */
export async function pruefeUndBereiteSchreibenVor(args: {
  project: string;
  filePath: string;
  content: string;
  aktion: 'create' | 'update';
  agentId?: string;
  reason?: string;
}): Promise<SchreibVorbereitung> {
  const { project, filePath, content, aktion, agentId, reason } = args;

  const bestehenderInhalt = await getFileContentFromPg(project, filePath);
  const bestandExistiertBereits = bestehenderInhalt !== null;
  const pruefung = await pruefeIgnorePfad(project, filePath);
  const hinweis: IgnorierterSchreibHinweis = {
    ignoriert: pruefung.ignoriert,
    regel: pruefung.regel,
    herkunft: pruefung.herkunft,
    bestandExistiertBereits,
  };

  const wegenExistenz = aktion === 'create' && bestandExistiertBereits;
  const wegenIgnore = pruefung.ignoriert && bestandExistiertBereits;

  if (!wegenExistenz && !wegenIgnore) {
    if (pruefung.ignoriert && !bestandExistiertBereits) {
      return { modus: 'direkt_mit_hinweis', hinweis }; // Fall B
    }
    return { modus: 'direkt' };
  }

  const ankerZeile =
    bestehenderInhalt!
      .split('\n')
      .map((zeile) => zeile.trim())
      .find((zeile) => zeile.length > 0) ?? bestehenderInhalt!.slice(0, 40);

  const op: FileBatchOp = {
    file_path: filePath,
    action: 'update',
    content,
    anchor_contains: ankerZeile,
  };

  const grundText = wegenIgnore
    ? `Ignorierter, bereits vorhandener Pfad "${filePath}" — Plan statt Direktschreiben`
    : `Pfad "${filePath}" existiert bereits — create wuerde sonst ungeprueft ueberschreiben, Plan statt Direktschreiben`;

  const plan = await planBatch({
    project,
    agent_id: agentId,
    ops: [op],
    reason: reason ?? grundText,
  });

  return { modus: 'plan', hinweis, plan, aktueller_inhalt: bestehenderInhalt };
}
