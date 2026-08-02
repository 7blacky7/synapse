/**
 * MODUL: Vertrag der Wissensschicht eines Spezialisten
 * ZWECK: Alles, was heute als Datei unter .synapse/agents/<name>/ liegt, steht
 *        hier als EINE Schnittstelle. Zwei Umsetzungen erfuellen sie:
 *          'datei' — genau das bisherige Verhalten. Sie ruft die Funktionen aus
 *                    skills.ts AUF, sie baut sie NICHT nach. Damit kann der
 *                    Vorgabe-Weg nicht anders werden als er heute ist.
 *          'api'   — dieselben Faehigkeiten ueber HTTP gegen die synapse-api.
 *        Umgeschaltet wird ueber SYNAPSE_WISSEN_QUELLE, Vorgabe 'datei'.
 *        Ohne gesetzte Variable aendert sich nichts.
 *
 * WARUM ES DIESE SCHICHT GIBT:
 *   Der Wrapper eines Spezialisten liest seinen System-Prompt heute von der
 *   Platte, auf der der Daemon laeuft. Deshalb ist ein Spezialist an seine
 *   Maschine gebunden — ein Wrapper im Container haette das Verzeichnis nicht
 *   und kaeme gar nicht hoch.
 *
 * ⚠️ DIE GEFAEHRLICHE FEHLERFORM HIER IST NICHT DER FEHLER, SONDERN DIE LEERE.
 *   Ein Agent ohne Regeln startet fehlerfrei und ist nur dumm. Ein leerer
 *   System-Prompt wirft keine Ausnahme, er erzeugt einen Agenten, der nicht
 *   weiss, wer er ist. Beides faellt im Log nicht auf. Darum tragen die
 *   Antworten dieser Schicht ZAHLEN (Laenge, Anzahl) und nicht nur Erfolg, und
 *   darum gibt es fuer 'unbekannter Agent' und 'bekannter Agent ohne Inhalt'
 *   zwei verschiedene Rueckgaben — an dieser Unterscheidung haengt, ob der
 *   Spawner das Wissen neu anlegt und dabei Gelerntes ueberschreibt.
 */

import type { AgentMeta, SkillFile } from '../skills.js'

export type WissensQuelle = 'datei' | 'api'

export interface WissensUmgebung {
  /** Projektname. Leer heisst: der api-Weg ist nicht benutzbar. */
  projekt: string
  /** Projekt-Wurzel im Dateisystem. Nur der datei-Weg braucht sie. */
  projektPfad: string
  /**
   * Pfad der System-Prompt-Datei, wie ihn der Spawner in
   * SYNAPSE_SYSTEM_PROMPT_FILE uebergibt. Nur der datei-Weg benutzt ihn; fehlt
   * er, faellt der datei-Weg auf <agentverzeichnis>/system-prompt.txt zurueck.
   */
  promptPfad?: string
  log: (msg: string, ...args: unknown[]) => void
}

/**
 * Das gesamte Wissen eines Agenten in der Form, in der es in den System-Prompt
 * geht.
 *
 * ⚠️ `text` ist WOERTLICH der Text, den readAllSkillFiles heute erzeugt
 * (Kopfzeile, '## Regeln', '## Fehler → Loesung', '## Patterns', '## Kontext',
 * '(Keine)' fuer leere Abschnitte). Der api-Weg baut ihn NICHT selbst nach,
 * sondern uebernimmt das Feld der API — sonst koennen die beiden Wege still
 * auseinanderlaufen, und der Unterschied stuende danach im Kopf jedes Agenten.
 */
export interface AgentWissen {
  meta: AgentMeta | null
  text: string
  /** true = der Agent ist bekannt, hat aber keinerlei Inhalt. KEIN Defekt: ein
   *  frisch angelegter Agent ist genau so (vier leere Dateien). */
  leer: boolean
}

export interface AnlegeErgebnis {
  /** false = es gab den Agenten schon, es wurde NICHTS angefasst. */
  angelegt: boolean
  grund: string
}

export interface WissensZugriff {
  readonly art: WissensQuelle

  /**
   * Das ganze Wissen in EINEM Zug.
   * @returns null wenn der Agent UNBEKANNT ist (heute: readSkill() === null).
   *          Ein bekannter Agent ohne Inhalt liefert ein Objekt mit leer=true.
   *          ⚠️ Diese Unterscheidung ist kein Schoenheitsfehler: der Spawner
   *          legt bei null neu an, und Anlegen ueberschreibt.
   */
  liesAlles(agent: string): Promise<AgentWissen | null>

  /**
   * Legt meta + vier leere Arten an — aber NUR wenn es den Agenten noch nicht
   * gibt. Idempotent: ein zweiter Aufruf meldet angelegt:false und ruehrt nichts
   * an. Die Entscheidung liegt bewusst in der Umsetzung (beim api-Weg auf dem
   * Server), nicht beim Aufrufer — sonst waere sie ein Wettlauf ueber zwei
   * Aufrufe, den zwei gleichzeitige Spawns desselben Namens verlieren koennen.
   */
  legeAn(agent: string, model: string, expertise: string): Promise<AnlegeErgebnis>

  /** Eine Art ganz lesen (Rohtext). null = nicht vorhanden. */
  liesArt(agent: string, art: SkillFile): Promise<string | null>

  /** Eine Art ganz ueberschreiben (= writeSkillFile). */
  schreibeArt(agent: string, art: SkillFile, inhalt: string): Promise<void>

  /**
   * Einen Eintrag anhaengen (= appendToSkillFile), samt Datums-Kopfzeile.
   * ⚠️ Die Datums-Logik gehoert in die Umsetzung, nicht in den Aufrufer: waere
   * es 'lesen, zusammensetzen, ganz zurueckschreiben', verloeren zwei
   * gleichzeitige Eintraege einander.
   */
  haengeAn(agent: string, art: SkillFile, eintrag: string): Promise<void>

  /**
   * Zeilen entfernen, die den Text enthalten (= update_skill remove).
   * @returns Anzahl entfernter Zeilen. 0 heisst "nichts passte" — der Aufrufer
   *          meldet das wie bisher als Misserfolg.
   */
  entferneEintraege(agent: string, art: SkillFile, enthaelt: string): Promise<number>

  /**
   * Alles zu diesem Agenten loeschen. Idempotent.
   * @returns Anzahl entfernter Einheiten. ⚠️ DIE EINHEIT HAENGT AM WEG: im
   *          api-Weg sind es TABELLENZEILEN, im datei-Weg DATEIEN. 0 heisst in
   *          beiden Faellen "es war nichts da".
   *          Warum ueberhaupt eine Zahl: ohne sie sieht ein purge, der ins Leere
   *          greift, genauso aus wie einer, der wirklich aufgeraeumt hat — und
   *          das ist der Fall, in dem still ein Bestand zu Agenten waechst, die
   *          es nicht mehr gibt.
   */
  loescheAlles(agent: string): Promise<number>

  /** Den fertigen System-Prompt ablegen (Spawner). */
  legeSystemPromptAb(agent: string, inhalt: string): Promise<void>

  /**
   * Den System-Prompt holen (Wrapper, beim Start und nach jeder Rotation).
   * WIRFT, wenn nichts oder etwas Unbrauchbares zurueckkommt — ein leerer
   * Prompt darf nicht als gueltiger Start durchgehen.
   */
  holeSystemPrompt(agent: string): Promise<string>
}
