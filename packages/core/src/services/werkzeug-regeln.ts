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
 * P22-T48 (User 19.10.2026) - MIT AUSWEIS (Identitaets-Principal mit lauf_id, Ausweis-Kern EIN):
 *   - project kommt aus dem Principal, wenn der Aufruf keins traegt (Aufrufe mit Ausweis lassen project meist weg).
 *   - ENTPRELLUNG JE LAUF: jede Regel kommt im Lauf (lauf_id = aktueller Kontext, NIE die Identitaet) nur EINMAL;
 *     eine geaenderte Regel (anderer Inhalt) erneut. Ein neuer Lauf (chat anmelden, index_stats fortsetzung, spaeter
 *     ein vom Wrapper erkannter Kontextwechsel) liefert alles wieder. Zustellmarke: agent_identitaet_hinweis_zustellungen
 *     mit sitzung 'lauf:<lauf_id>', quelle_id 'werkzeug_regeln', hinweis_id '<name>#<sha256(content)[0..16]>'
 *     (INSERT ... ON CONFLICT DO NOTHING RETURNING = atomar auch ueber mehrere Prozesse). Debug: diese Zeilen.
 *   - Im Onboarding voll zugestellte Regeln (Typ-/Pflichtregeln) markiert agent-onboarding.ts im selben Lauf mit,
 *     damit eine Regel nicht doppelt kommt.
 *   - Fehler beim Markieren -> Regeln werden geliefert (lieber doppelt als gar nicht).
 *   OHNE Ausweis (Legacy, fremdes Projekt, Kern AUS): unveraendert, Entscheidungen 1 und 2 unten gelten weiter.
 *
 * BEKANNTE GRENZEN, hier benannt statt spaeter entdeckt:
 *   (a) OHNE project KEINE REGELN (ohne Ausweis). Regeln sind projektbezogen. Ein Werkzeug ohne
 *       project-Argument kann keine Marke treffen. Bei specialist ist project Pflicht.
 *   (b) ARRAY-ANTWORTEN werden nicht angereichert (siehe die Aufrufer). Betroffen sind nur
 *       lesende Such-Aktionen, keine zerstoerende.
 */

import { createHash } from 'node:crypto';
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
  const bezug = await laufBezug();
  const projekt = String(project ?? '').trim() || bezug?.project || '';
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
    const regeln = res.rows.map((r) => ({ name: r.name, content: r.content }));
    if (!bezug || bezug.project !== projekt || regeln.length === 0) return regeln;
    return await nurNeueImLauf(bezug, regeln);
  } catch (err) {
    console.error('[Werkzeug-Regeln] Abfrage fehlgeschlagen:', err);
    return [];
  }
}

// ---------------------------------------------------------------------------------------------
// P22-T48: Zustellung je Lauf (nur mit Ausweis)
// ---------------------------------------------------------------------------------------------
/** quelle_id der Lauf-Zustellmarke in agent_identitaet_hinweis_zustellungen. */
export const WERKZEUG_REGEL_QUELLE = 'werkzeug_regeln';

/** Lauf-Bezug eines Ausweis-Aufrufs (Identitaets-Principal mit lauf_id). */
export interface WerkzeugRegelLauf { identity_id: string; project: string; agent_id: string; lauf_id: string }

const laufSitzung = (laufId: string): string => 'lauf:' + laufId;
/** Marke = Name + Inhaltsstempel: eine geaenderte Regel hat eine neue Marke und kommt im Lauf erneut. */
const regelMarke = (r: WerkzeugRegel): string => r.name + '#' + createHash('sha256').update(r.content ?? '').digest('hex').slice(0, 16);

async function laufBezug(): Promise<WerkzeugRegelLauf | null> {
  try {
    // Dynamisch: agent-bezug haengt (indirekt) an vielen Diensten; diese Datei bleibt ohne festen Import-Zyklus.
    const { aktuellerAgentAufruf } = await import('./agent-bezug.js');
    const p = aktuellerAgentAufruf()?.principal;
    if (!p || p.art !== 'identity' || !p.lauf_id) return null;
    return { identity_id: p.identity_id, project: p.project, agent_id: p.agent_id, lauf_id: p.lauf_id };
  } catch {
    return null;
  }
}

/**
 * Markiert Regeln im Lauf als zugestellt und liefert die Marken, die NEU waren (atomar, mehrprozessfest).
 * Wirft bei DB-Fehlern; Aufrufer entscheiden (holeWerkzeugRegeln liefert dann alles).
 */
export async function markiereWerkzeugRegelnZugestellt(b: WerkzeugRegelLauf, regeln: WerkzeugRegel[]): Promise<string[]> {
  if (regeln.length === 0) return [];
  const r = await getPool().query<{ hinweis_id: string }>(
    `INSERT INTO agent_identitaet_hinweis_zustellungen (project, agent_id, sitzung, quelle_id, hinweis_id, aufruf, voll, identity_id)
     SELECT $1, $2, $3, $4, m, 0, true, $5 FROM unnest($6::text[]) AS m
     ON CONFLICT (project, identity_id, sitzung, quelle_id, hinweis_id) DO NOTHING
     RETURNING hinweis_id`,
    [b.project, b.agent_id, laufSitzung(b.lauf_id), WERKZEUG_REGEL_QUELLE, b.identity_id, [...new Set(regeln.map(regelMarke))]]);
  return r.rows.map((z) => z.hinweis_id);
}

/** Nur die im Lauf noch nicht (bzw. geaendert) zugestellten Regeln; Kern AUS oder Fehler -> alle (Bestand). */
async function nurNeueImLauf(b: WerkzeugRegelLauf, regeln: WerkzeugRegel[]): Promise<WerkzeugRegel[]> {
  try {
    const { leseAusweisKern } = await import('./agent-profil-schalter.js');
    if (!(await leseAusweisKern(b.project)).aktiv) return regeln;
    const neu = new Set(await markiereWerkzeugRegelnZugestellt(b, regeln));
    return regeln.filter((r) => neu.has(regelMarke(r)));
  } catch (err) {
    console.error('[Werkzeug-Regeln] Lauf-Zustellmarke fehlgeschlagen:', (err as { message?: string } | null)?.message?.slice(0, 80) ?? 'fehler');
    return regeln;
  }
}
