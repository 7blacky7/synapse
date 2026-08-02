/**
 * MODUL: Werkzeug-gebundene Regeln ("bei:"-Marken)
 * ZWECK: Liefert die Projekt-Regeln, die zu einem konkreten Werkzeug-Aufruf gehoeren,
 *        damit sie MIT dem Ergebnis dieses Aufrufs ausgeliefert werden koennen.
 *
 * INPUT:
 *   - project: string   - Projekt-Name aus den Aufruf-Argumenten
 *   - toolName: string  - z.B. "specialist"
 *   - action: string|null - z.B. "purge"
 *
 * OUTPUT:
 *   - WerkzeugRegel[]: { name, content } je passender Regel, leer wenn keine passt
 *
 * NEBENEFFEKTE: eine Lese-Abfrage auf memories. Keine Schreibvorgaenge.
 *
 * WARUM DIESE DATEI EXISTIERT
 * ---------------------------
 * Projekt-Regeln wurden bisher AUSSCHLIESSLICH beim Onboarding ausgeliefert, gefiltert
 * ueber die Rolle des Agenten. Beides ist fuer einen Teil der Regeln die falsche Achse,
 * und das ist gemessen, nicht vermutet (Sitzung 2026-08-02):
 *
 *   specialist(purge) wurde zwischen dem 25.05. und dem 02.08. 23 mal aufgerufen.
 *   18 dieser Aufrufe hatten KEINE agent_id, 5 kamen von Web-KIs, und NULL vom Koordinator.
 *   Die zugehoerige Warnregel (koordinator-lesson-purge-vs-stop, sie beschreibt einen bereits
 *   eingetretenen Datenverlust) traegt den Tag "coordinator-only". Sie wurde also seit dem
 *   03.05.2026 ausschliesslich dem einzigen Agenten gezeigt, der die Handlung nie ausfuehrt.
 *
 * Eine Regel, die vor einer HANDLUNG warnt, gehoert an die Handlung — nicht an eine Vermutung
 * darueber, wer sie ausfuehren wird. Der Aufruf selbst ist die Adresse: Werkzeugname und Aktion
 * existieren in 100 Prozent der Faelle, eine Identitaet nur in etwa drei Vierteln.
 *
 * ⚠️ WAS DIESES MODUL NICHT LEISTET — bitte nicht mehr hineinlesen:
 * Es ist KEINE PRAEVENTION. Es gibt in diesem System keinen Haken VOR der Ausfuehrung; beide
 * Oberflaechen dekorieren das fertige Ergebnis (rest-api/routes/mcp.ts, der Aufrufblock um
 * handleToolCall, und mcp-server/server.ts:attachResponseHooks). Die Warnung erscheint deshalb
 * MIT dem Ergebnis, nicht davor — sie wirkt beim NAECHSTEN Mal, nicht beim ersten.
 * Dass das reicht, ist der Regeltext selbst: der dokumentierte Schaden entstand, weil zweimal
 * hintereinander gepurged wurde. Wer hier spaeter echten Schutz vor dem Erstfehler braucht,
 * muss eine Bestaetigungs-Vorstufe bauen — das ist eine andere Aenderung, nicht diese.
 *
 * BEWUSSTE ENTSCHEIDUNGEN
 * -----------------------
 * 1. KEINE BEDINGUNG AUF agent_id. Bei 18 von 23 purge-Aufrufen gibt es keine; ein
 *    "if (!agentId) return" haette 78 Prozent der Faelle still verloren — genau das Muster,
 *    das diese Regeln ueberhaupt erst noetig macht.
 * 2. KEINE ENTPRELLUNG. Ohne Identitaet gibt es keinen Schluessel, ueber den man entprellen
 *    koennte. Die Warnung wiederholt sich also. Das ist der Preis dafuer, dass sie ankommt;
 *    wer die Wahl hat zwischen "wiederholt sich" und "erreicht niemanden", nimmt die
 *    Wiederholung.
 * 3. ADDITIV. Ohne "bei:"-Tag findet die Abfrage nichts und es wird kein Feld gesetzt.
 *    Ruecknahme einer Zuordnung = Tag entfernen, kein Code-Weg noetig.
 * 4. EINE FALSCHE MARKE IST ZAEHLBAR. "bei:specialist.purgee" trifft nie einen Aufruf, und
 *    "welche Regel wurde in 30 Tagen nie ausgespielt" ist eine Datenbankfrage. Genau das ist
 *    beim Rollen-Tag nicht moeglich, weshalb drei Monate lang niemand bemerkt hat, dass die
 *    Bindung ins Leere ging.
 *
 * BEKANNTE GRENZEN, hier benannt statt spaeter entdeckt:
 *   (a) OHNE project KEINE REGELN. Regeln sind projektbezogen. Ein Werkzeug ohne
 *       project-Argument kann keine Marke treffen. Bei specialist ist project Pflicht.
 *   (b) ARRAY-ANTWORTEN werden nicht angereichert (siehe die Aufrufer). Betroffen sind nur
 *       lesende Such-Aktionen, keine zerstoerende.
 */

import { getPool } from '../db/client.js';

/** Eine Regel, die zu einem Werkzeug-Aufruf gehoert. */
export interface WerkzeugRegel {
  name: string;
  content: string;
}

/** Praefix, der eine Regel an eine Handlung bindet. */
export const WERKZEUG_MARKE_PRAEFIX = 'bei:';

/** Feld, unter dem beide Oberflaechen das Ergebnis anhaengen. Eine Schreibweise, nicht zwei. */
export const WERKZEUG_REGEL_FELD = 'werkzeug_regeln';

/**
 * Baut die Marken, die fuer diesen Aufruf gelten.
 * "bei:specialist.purge" bindet an genau eine Aktion, "bei:specialist" an das ganze Werkzeug.
 * Beides ist erlaubt; die engere Marke ist die uebliche.
 */
export function baueWerkzeugMarken(toolName: string, action?: string | null): string[] {
  const werkzeug = String(toolName ?? '').trim().toLowerCase();
  if (!werkzeug) return [];
  const marken = [`${WERKZEUG_MARKE_PRAEFIX}${werkzeug}`];
  const aktion = String(action ?? '').trim().toLowerCase();
  if (aktion) marken.push(`${WERKZEUG_MARKE_PRAEFIX}${werkzeug}.${aktion}`);
  return marken;
}

/**
 * Liefert die Regeln, die an diesen Aufruf gebunden sind.
 *
 * Der Tag-Vergleich ist bewusst case-insensitiv und trimmend: die Rollen-Tags haben genau
 * daran jahrelang still danebengelegen (deutsche gegen englische Schreibweise), und derselbe
 * Fehler soll sich hier nicht wiederholen.
 *
 * Wirft nicht: eine fehlgeschlagene Abfrage darf einen Tool-Aufruf niemals brechen. Im
 * Fehlerfall kommt eine leere Liste und eine Zeile ins Log.
 */
export async function holeWerkzeugRegeln(
  project: string | undefined | null,
  toolName: string,
  action?: string | null,
): Promise<WerkzeugRegel[]> {
  const projekt = String(project ?? '').trim();
  if (!projekt) return [];
  const marken = baueWerkzeugMarken(toolName, action);
  if (marken.length === 0) return [];

  try {
    const pool = getPool();
    const res = await pool.query<{ name: string; content: string }>(
      `SELECT name, content
         FROM memories
        WHERE project = $1
          AND category = 'rules'
          AND EXISTS (
                SELECT 1 FROM unnest(tags) AS t
                 WHERE lower(btrim(t)) = ANY($2::text[])
              )
        ORDER BY name`,
      [projekt, marken],
    );
    return res.rows.map((r) => ({ name: r.name, content: r.content }));
  } catch (err) {
    console.error('[Werkzeug-Regeln] Abfrage fehlgeschlagen:', err);
    return [];
  }
}
