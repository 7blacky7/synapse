/**
 * MODUL: project-status
 * ZWECK: Persistenter Projekt-Status in .synapse/status.json
 *
 * INPUT:
 *   - projectPath: string - Absoluter Pfad zum Projekt
 *   - status: Partial<ProjectStatus> - Status-Daten zum Aktualisieren
 *
 * OUTPUT:
 *   - ProjectStatus | null - Geladener Status oder null wenn nicht vorhanden
 *   - void - Bei Schreiboperationen
 *   - boolean - Bei Statusprüfung
 *
 * NEBENEFFEKTE:
 *   - Dateisystem: Liest/schreibt .synapse/status.json
 *   - Erstellt .synapse Ordner automatisch falls noetig
 *
 * ABHÄNGIGKEITEN:
 *   - fs (extern) - Dateisystem-Operationen
 *   - path (extern) - Pfad-Manipulation
 *   - uuid (extern) - ID-Generierung
 *
 * HINWEISE:
 *   - Status-Datei liegt immer in {projectPath}/.synapse/status.json
 *   - Bei korrupter JSON wird null zurueckgegeben
 */

import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { getPool } from '../db/client.js';

const STATUS_DIR = '.synapse';
const STATUS_FILE = 'status.json';

export interface ProjectStatus {
  id: string;           // UUID v4
  project: string;      // Projektname
  path: string;         // Absoluter Pfad
  initialized: string;  // ISO Timestamp
  lastAccess: string;   // ISO Timestamp
  status: 'active' | 'stopped';
  setupPhase?: 'none' | 'initial-pending' | 'initial-done' | 'post-indexing-pending' | 'complete';
}

/**
 * Gibt den Pfad zur status.json zurueck
 */
function getStatusPath(projectPath: string): string {
  return path.join(projectPath, STATUS_DIR, STATUS_FILE);
}

/**
 * Liest den Projekt-Status aus .synapse/status.json
 * Gibt null zurueck wenn Datei nicht existiert oder korrupt ist
 */
export function getProjectStatus(projectPath: string): ProjectStatus | null {
  const statusPath = getStatusPath(projectPath);

  try {
    if (!fs.existsSync(statusPath)) {
      return null;
    }
    const content = fs.readFileSync(statusPath, 'utf-8');
    return JSON.parse(content) as ProjectStatus;
  } catch {
    // Datei korrupt oder nicht lesbar
    return null;
  }
}

/**
 * Setzt/aktualisiert den Projekt-Status
 * Erstellt .synapse Ordner und generiert ID falls noetig
 */
export function setProjectStatus(
  projectPath: string,
  status: Partial<ProjectStatus>
): void {
  const synapseDir = path.join(projectPath, STATUS_DIR);
  const statusPath = getStatusPath(projectPath);

  // .synapse Ordner erstellen falls noetig
  if (!fs.existsSync(synapseDir)) {
    fs.mkdirSync(synapseDir, { recursive: true });
  }

  // Bestehenden Status laden oder neu erstellen
  const existing = getProjectStatus(projectPath);
  const now = new Date().toISOString();
  const projectName = path.basename(projectPath);

  const merged: ProjectStatus = {
    id: existing?.id || status.id || uuidv4(),
    project: status.project ?? existing?.project ?? projectName,
    path: status.path ?? existing?.path ?? projectPath,
    initialized: existing?.initialized ?? status.initialized ?? now,
    lastAccess: status.lastAccess ?? now,
    status: status.status ?? existing?.status ?? 'active',
    setupPhase: status.setupPhase ?? existing?.setupPhase ?? 'none',
  };

  fs.writeFileSync(statusPath, JSON.stringify(merged, null, 2), 'utf-8');
}

/**
 * Prueft ob Projekt initialisiert ist (status.json existiert UND status === 'active')
 */
export function isProjectInitialized(projectPath: string): boolean {
  const status = getProjectStatus(projectPath);
  return status !== null && status.status === 'active';
}

/**
 * Aktualisiert nur den lastAccess Timestamp
 */
export function updateLastAccess(projectPath: string): void {
  const existing = getProjectStatus(projectPath);
  if (!existing) {
    return;
  }
  setProjectStatus(projectPath, { lastAccess: new Date().toISOString() });
}

/**
 * Loescht die status.json Datei
 */
export function clearProjectStatus(projectPath: string): void {
  const statusPath = getStatusPath(projectPath);

  try {
    if (fs.existsSync(statusPath)) {
      fs.unlinkSync(statusPath);
    }
  } catch {
    // Fehler beim Loeschen ignorieren
  }
}

/** In-Memory-Schnellpfad: (instance, agent, project)-Keys die dieser Prozess schon
 *  ongeboardet hat — spart den PG-Roundtrip bei JEDEM weiteren Tool-Call. */
const onboardedKeys = new Set<string>();

/**
 * ON-2 (15.08.2026): Der Bezugspunkt des Ruhefensters liegt in der DATENBANK, nicht mehr
 * im Prozess. Vorher stand hier ein PROZESS_START = Date.now(), und genau daran ist es
 * gescheitert: fuer den Container ist der Prozessstart der Deploy, fuer den lokalen
 * stdio-Server aber JEDE Session und JEDER Reconnect. Der lokale Server hat das Onboarding
 * deshalb nicht einmalig unterdrueckt, sondern dauerhaft.
 * Gesetzt wird der Zeitpunkt nur von der REST-API beim Start (setzeOnboardingRuhe),
 * gelesen wird er von jedem — beide Strecken bekommen damit dieselbe Antwort.
 */

/**
 * Ruhefenster nach dem Prozessstart in Minuten (Env SYNAPSE_ONBOARDING_RUHE_MIN, Default 60).
 * 0 oder ein unlesbarer Wert schaltet es ab — dann gilt wieder das alte Verhalten, und das
 * ist die sichere Richtung: im Zweifel kommt das Onboarding, statt still zu verschwinden.
 * Bewusst bei JEDEM Aufruf gelesen und nicht in einer Konstanten eingefroren, damit ein Test
 * (und ein Betreiber per docker exec) den Wert umstellen kann, ohne den Prozess neu zu starten.
 */
function ruhefensterMinuten(): number {
  const roh = Number(process.env.SYNAPSE_ONBOARDING_RUHE_MIN ?? 60);
  return Number.isFinite(roh) && roh > 0 ? roh : 0;
}

/**
 * Startet das Ruhefenster. AUSSCHLIESSLICH vom Start der REST-API aufzurufen — sie ist das,
 * was deployt wird, und ihr Neustart ist das Ereignis, das alle Server-Kennungen entwertet.
 * Der lokale stdio-Server ruft das NICHT auf, sonst begaenne das Fenster bei jeder Session neu.
 *
 * Minuten <= 0 (SYNAPSE_ONBOARDING_RUHE_MIN=0) loescht die Zeile und schaltet die Ruhe ab.
 */
export async function setzeOnboardingRuhe(quelle: string, minuten = ruhefensterMinuten()): Promise<void> {
  try {
    const pool = getPool();
    if (minuten <= 0) {
      await pool.query('DELETE FROM onboarding_ruhe WHERE id = 1');
      console.info('[Onboarding] Ruhefenster abgeschaltet (SYNAPSE_ONBOARDING_RUHE_MIN=0).');
      return;
    }
    await pool.query(
      `INSERT INTO onboarding_ruhe (id, ruhe_bis, gesetzt_von, gesetzt_am)
       VALUES (1, NOW() + ($1 || ' minutes')::interval, $2, NOW())
       ON CONFLICT (id) DO UPDATE
          SET ruhe_bis = EXCLUDED.ruhe_bis, gesetzt_von = EXCLUDED.gesetzt_von, gesetzt_am = NOW()`,
      [String(minuten), quelle]
    );
    console.info(`[Onboarding] Ruhefenster laeuft ${minuten} Minuten (gesetzt von "${quelle}").`);
  } catch (err) {
    // Kein Abbruch: ohne Ruhefenster kommt das Onboarding oefter — laestig, aber harmlos.
    console.warn('[Onboarding] Ruhefenster konnte nicht gesetzt werden:', err);
  }
}

/**
 * Laeuft das Ruhefenster gerade? Die Frage geht an die DB, damit lokaler Server und API
 * dieselbe Antwort bekommen. Bei jedem Fehler und bei fehlender Zeile: false — dann kommt
 * das Onboarding, und das ist die sichere Richtung.
 */
/** Ein Channel-Block fuer das Onboarding: wer ist noch da, was war zuletzt los. */
export interface ChannelUebersichtEintrag {
  channel: string;
  /** ALLE Mitglieder des Channels — auch laengst inaktive. Genau die sind die Kandidaten,
   *  wenn es um "kann der weg" geht. */
  agenten: string[];
  /** Teilmenge davon, deren Session noch auf 'active' steht (der Reaper raeumt nach 4 h). */
  noch_aktiv: string[];
  /** Zeitpunkt der letzten Nachricht — Sortierkriterium und Alters-Anzeige.
   *  BEWUSST OHNE INHALT: den holt sich der Koordinator mit channel(action:"feed"),
   *  wenn er ihn braucht. Ein Auszug im Onboarding waere Ballast bei jedem Start. */
  wann?: string;
}

export interface ChannelUebersicht {
  channels: ChannelUebersichtEintrag[];
  weitere: number;
  hinweis?: string;
}

/** Wie viele Channels der Block hoechstens zeigt. Der Rest wird nur gezaehlt. */
const CHANNEL_BLOCK_MAX = 5;

/**
 * CH-1 (15.08.2026): Die fuenf aktuellsten Channels eines Projekts fuers Onboarding.
 *
 * ANLASS: "momentan ertrinken wir in Channels" (User). Channels werden angelegt und nie
 * geschlossen; niemand sieht beim Start, was ueberhaupt noch laeuft, und niemand raeumt auf.
 * TOP heisst deshalb AKTUALITAET, nicht Groesse: sortiert wird nach der letzten Nachricht.
 * Ein Channel ohne jede Nachricht steht hinten, nicht vorn.
 *
 * "Aktive Agenten" sind Mitglieder, deren Session noch auf 'active' steht. Das ist bewusst
 * eine WEICHE Auskunft: 'active' heisst "angemeldet", nicht "arbeitet gerade", und der
 * Session-Reaper setzt erst nach vier Stunden ohne Lebenszeichen auf 'inactive'. Die Liste
 * sagt also "koennte noch jemand drinhaengen", nicht "hier arbeitet jemand".
 *
 * Faellt die Abfrage aus, gibt es KEINEN Block statt eines halben — ein Aufraeum-Hinweis darf
 * das Onboarding nicht gefaehrden.
 */
export async function baueChannelUebersicht(
  project: string,
  istKoordinator: boolean,
): Promise<ChannelUebersicht | undefined> {
  try {
    const { rows } = await getPool().query<{
      name: string;
      agenten: string[] | null;
      aktive: string[] | null;
      created_at: Date | null;
    }>(
      `SELECT c.name,
              letzte.created_at,
              (SELECT array_agg(DISTINCT mem.agent_name)
                 FROM specialist_channel_members mem
                WHERE mem.channel_id = c.id) AS agenten,
              (SELECT array_agg(DISTINCT mem.agent_name)
                 FROM specialist_channel_members mem
                 JOIN agent_sessions s
                   ON s.id = mem.agent_name AND s.project = c.project AND s.status = 'active'
                WHERE mem.channel_id = c.id) AS aktive
         FROM specialist_channels c
         LEFT JOIN LATERAL (
              SELECT created_at
                FROM specialist_channel_messages m
               WHERE m.channel_id = c.id
               ORDER BY m.id DESC
               LIMIT 1
         ) letzte ON TRUE
        WHERE c.project = $1
        ORDER BY letzte.created_at DESC NULLS LAST, c.id DESC`,
      [project],
    );

    if (rows.length === 0) return undefined;

    const channels = rows.slice(0, CHANNEL_BLOCK_MAX).map((r) => ({
      channel: r.name,
      agenten: r.agenten ?? [],
      noch_aktiv: r.aktive ?? [],
      ...(r.created_at ? { wann: new Date(r.created_at).toISOString() } : {}),
    }));
    const weitere = Math.max(0, rows.length - channels.length);

    return { channels, weitere, hinweis: channelHinweis(weitere, istKoordinator) };
  } catch (err) {
    console.warn('[Onboarding] Channel-Uebersicht nicht ermittelbar:', err);
    return undefined;
  }
}

/**
 * Der Satz unter dem Block. Fuer den Koordinator ist es ein AUFTRAG, fuer alle anderen nur
 * eine Zahl — aufraeumen darf nicht jeder, und wer es darf, soll wissen WIE.
 * Die Reihenfolge im Auftrag ist die wichtige Stelle: erst lesen, dann PRUEFEN, dann sichern,
 * erst danach loeschen. Ein Channel, der ungelesen verschwindet, nimmt sein Wissen mit.
 */
function channelHinweis(weitere: number, istKoordinator: boolean): string | undefined {
  if (!istKoordinator) {
    return weitere > 0 ? `Es gibt noch ${weitere} weitere Channel(s).` : undefined;
  }
  const kopf = weitere > 0
    ? `Es gibt noch ${weitere} weitere Channel(s) — schau sie dir an.`
    : 'Sieh die Channels durch.';
  return `${kopf} Hol dir je Channel den letzten Kontext (channel(action:"feed")) und entscheide, `
    + 'ob er geschlossen werden kann. REIHENFOLGE, nicht abkuerzen: (1) lesen, (2) die wichtigsten '
    + 'Annahmen mit code_intel gegen den heutigen Code pruefen — erst dann weisst du, ob sie '
    + 'veraltet sind, (3) was noch wertvoll ist als memory sichern, (4) danach den Channel loeschen. '
    + 'Ohne Schritt 2 loeschst du entweder Gueltiges weg oder schleppst Ueberholtes mit.';
}

async function ruheLaeuftNoch(): Promise<boolean> {
  try {
    const { rows } = await getPool().query<{ aktiv: boolean }>(
      'SELECT ruhe_bis > NOW() AS aktiv FROM onboarding_ruhe WHERE id = 1'
    );
    return rows[0]?.aktiv === true;
  } catch {
    return false;
  }
}

/** Einmal pro Prozess: tote Instance-Rows aus agent_onboardings raeumen */
let onboardingCleanupDone = false;

/**
 * Prueft ob ein Agent in dieser Server-Instanz bereits ongeboardet wurde.
 * Nutzt die Tabelle agent_onboardings mit PK(agent_id, project, server_instance_id):
 *   - INSERT ON CONFLICT DO NOTHING → rowCount 1 = neu (Onboarding), 0 = bekannt
 *   - Einmal pro (Agent, Projekt, Server-Prozess) — kein Ping-Pong zwischen Prozessen,
 *     kein Project-Mismatch (frueher: server_instance_id-Vergleich auf agent_sessions
 *     mit UNIQUE(id) → Onboarding-Spam bei jedem Tool-Call, siehe schema.ts)
 *   - Zusaetzlich In-Memory-Set als Schnellpfad (einmal pro Prozess reicht dem Modell)
 *
 * @param rolle - Optional: die beim Onboarding verwendete Rolle. PROTOKOLL, keine Wahrheit.
 * @param rolleQuelle - Optional: woher sie stammt. Werte siehe RollenQuelle in agent-rollen.ts:
 *   'angegeben' | 'namensmuster' | 'standard'.
 *   Erst mit der QUELLE wird der Eintrag auswertbar: 'standard' heisst, dass gar nichts
 *   gegriffen hat. Ohne sie sieht eine geratene Rolle aus wie eine erklaerte.
 * @returns true wenn Agent NEU ist (Onboarding zeigen), false wenn bereits bekannt
 */
export async function registerAgent(
  project: string,
  agentId: string,
  serverInstanceId: string,
  rolle?: string,
  rolleQuelle?: string
): Promise<boolean> {
  const key = `${serverInstanceId}:${agentId}:${project}`;
  if (onboardedKeys.has(key)) {
    return false;
  }

  try {
    const pool = getPool();

    // Retention: Instance-IDs sind prozess-gebunden — Rows aelter als 7 Tage sind tot.
    // Fire-and-forget, einmal pro Prozess.
    if (!onboardingCleanupDone) {
      onboardingCleanupDone = true;
      pool
        .query(`DELETE FROM agent_onboardings WHERE onboarded_at < NOW() - INTERVAL '7 days'`)
        .catch(() => {});
    }

    const result = await pool.query(
      `INSERT INTO agent_onboardings (agent_id, project, server_instance_id, rolle, rolle_quelle)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (agent_id, project, server_instance_id) DO NOTHING`,
      [agentId, project, serverInstanceId, rolle ?? null, rolleQuelle ?? null]
    );
    onboardedKeys.add(key);

    let isFirstVisit = (result.rowCount ?? 0) > 0;

    // ⚠️ RUHEFENSTER NACH EINEM DEPLOY (ON-1). Die Server-Kennung ist prozessgebunden und bei
    // jedem Containerstart neu — formal ist danach JEDER Agent "zum ersten Mal" da, obwohl sich
    // an den Regeln nichts geaendert hat. In einer Deploy-Nacht kam das volle Onboarding so
    // siebenmal an denselben Agenten, an jedem Tool-Aufruf haengend.
    // Unterdrueckt wird deshalb NUR die Wiederholung: der Agent muss unter einer ANDEREN
    // Server-Kennung schon einen Eintrag haben. Wer noch nie da war — ein frisch gespawnter
    // Subagent — bekommt seine Regeln unveraendert, denn genau dafuer gibt es das Onboarding.
    // Der INSERT oben laeuft in beiden Faellen: dadurch bleibt der Agent auch NACH Ablauf des
    // Fensters ruhig, statt verspaetet doch noch begruesst zu werden.
    if (isFirstVisit) {
      // ON-2: nicht mehr "wie lange laeuft MEIN Prozess", sondern "laeuft das Fenster laut DB".
      if (await ruheLaeuftNoch()) {
        const frueher = await pool.query(
          `SELECT 1 FROM agent_onboardings
            WHERE agent_id = $1 AND project = $2 AND server_instance_id <> $3
            LIMIT 1`,
          [agentId, project, serverInstanceId]
        );
        if (frueher.rows.length > 0) {
          console.info(
            `[Onboarding] Ruhefenster aktiv: "${agentId}" (${project}) war schon vor dem Neustart da `
            + `— kein erneutes Onboarding. Abschalten mit SYNAPSE_ONBOARDING_RUHE_MIN=0.`
          );
          isFirstVisit = false;
        }
      }
    }

    if (isFirstVisit) {
      // Session-Tracking beibehalten (isAgentKnown, events) — ohne Instance-Ueberschreiben.
      // ON CONFLICT DO NOTHING: chat.registerAgent pflegt model/status, hier nur Existenz.
      await pool.query(
        `INSERT INTO agent_sessions (id, project, status, registered_at)
         VALUES ($1, $2, 'active', NOW())
         ON CONFLICT (id) DO NOTHING`,
        [agentId, project]
      );
    }

    return isFirstVisit;
  } catch {
    // Bei PG-Fehler sicherheitshalber Onboarding zeigen
    return true;
  }
}

/**
 * Prueft ob ein Agent dem Projekt bekannt ist (hat jemals einen Record in PG)
 */
export async function isAgentKnown(project: string, agentId: string): Promise<boolean> {
  try {
    const pool = getPool();
    const result = await pool.query(
      `SELECT 1 FROM agent_sessions WHERE id = $1 AND project = $2 LIMIT 1`,
      [agentId, project]
    );
    return result.rows.length > 0;
  } catch {
    return false;
  }
}
