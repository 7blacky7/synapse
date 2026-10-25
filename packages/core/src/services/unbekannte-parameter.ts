/**
 * PA-1 (15.08.2026): Ein unbekannter Parameter wird GEMELDET, nicht still verworfen.
 *
 * ANLASS, damit der Grund nicht verlorengeht: der Koordinator rief
 * channel(action:'archivieren', bis_nachricht_id:<id>) auf, um nur die Nachrichten bis zu
 * dieser ID auszublenden. Der lokale MCP-Server lief noch auf dem Stand von vor dem Build und
 * kannte bis_nachricht_id nicht. Er hat den Parameter nicht bemaengelt, sondern ignoriert —
 * und die Aktion in ihrer ALTEN Bedeutung ausgefuehrt: den Standardchannel vollstaendig
 * archiviert, also genau das, was eine Stunde zuvor ausdruecklich verboten worden war. Die
 * Antwort meldete Erfolg. Ein stiller Fehlgriff mit Erfolgsmeldung ist schlimmer als ein
 * Absturz, weil niemand nachsieht.
 *
 * DASSELBE MUSTER hat dieses Projekt schon mehrfach Zeit gekostet: das verworfene file_path
 * bei search (CI-1), die drei von Hand kopierten Felder in agentOnboarding, die Array-Schranke
 * in attachRestOnboarding. Es ist ein Muster, kein Einzelfall.
 *
 * WAS DIE MESSUNG VOR DEM EINBAU ERGAB (22.821 auswertbare Aufrufe der Historie):
 * 17 % tragen einen Parameter, den das Schema nicht kennt. Das ist kein Grund, milder zu
 * pruefen — es ist der Befund selbst:
 *   shell.timeout_ms            2739x, 90 Agenten — mit SH-1 ENTFERNT. Alle diese Aufrufe
 *                               glaubten, ein Timeout zu setzen; es geschah nichts.
 *   code_intel.semantic          560x, 33 Agenten — der lokale Server kennt es nicht (nur die
 *                               REST-Strecke). Die Agenten bekamen Volltext statt Semantik.
 *   code_intel.queries           283x — search_batch fehlt im lokalen Server ganz.
 *   memory.names_only / files.agent_filter — die zwei regressierten Paritaets-Fixes.
 * Jeder dieser Faelle war unsichtbar, solange still verworfen wurde.
 */

/** Levenshtein-Abstand, begrenzt auf kurze Bezeichner — nur fuer den "Meintest du"-Vorschlag. */
function abstand(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 3) return 99;
  const d: number[] = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let vorher = d[0];
    d[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = d[j];
      d[j] = a[i - 1] === b[j - 1] ? vorher : 1 + Math.min(vorher, d[j], d[j - 1]);
      vorher = tmp;
    }
  }
  return d[n];
}

/**
 * Faelle, in denen ein Parameter frueher existierte oder auf der anderen Strecke existiert.
 * Eine blosse Ablehnung wuerde hier ratlos machen — die Meldung sagt deshalb, was gilt.
 */
const BEKANNTE_IRRTUEMER: Record<string, string> = {
  'shell.timeout_ms':
    'timeout_ms wurde mit SH-1 aus dem Schema entfernt und hatte seither keine Wirkung mehr. ' +
    'Lang laufende Kommandos laufen im Hintergrund weiter; das Ergebnis holst du mit ' +
    'shell(action:"history") bzw. shell(action:"get", id).',
  'shell.timeout': 'Siehe timeout_ms: mit SH-1 entfernt, ohne Ersatz-Parameter.',
  'code_intel.semantic':
    'Der lokale MCP-Server kennt semantic nicht — nur die REST-Strecke (synapsen-api). Ueber ' +
    'diesen Weg liefert search ausschliesslich PG-Volltext.',
  'code_intel.queries':
    'search_batch gibt es nur auf der REST-Strecke (synapsen-api), nicht im lokalen ' +
    'MCP-Server. Hier einzeln mit action:"search" abfragen.',
  'code_intel.limit_per_query': 'Gehoert zu search_batch — siehe queries.',
  'memory.names_only':
    'names_only fehlt derzeit im Schema (regressierter Paritaets-Fix vom 14.06.2026), der ' +
    'Handler wertet es noch aus. Bis das behoben ist, ohne den Parameter arbeiten.',
  'files.agent_filter':
    'agent_filter fehlt derzeit im Schema (regressierter Paritaets-Fix vom 14.06.2026).',
  // P15-T38: Signatur-Felder gehoeren in erkennung{} - die Meldung zeigt das Format.
  ...Object.fromEntries(['signatur', 'gegen_signatur', 'flags', 'fenster', 'art'].map((k) => [`code_check.${k}`,
    'gehoert in erkennung, nicht auf die oberste Ebene: erkennung: {art:\'regex\', signatur:[\'A\',\'B\'] (Liste = UND), ' +
    'gegen_signatur:[\'C\'] (einer hebt auf), flags:\'imsu\', fenster:\'zeile\'|\'block\'|\'datei\'}; ODER als \'A|B\' in EINEM String.'])),
};

export interface ParameterBefund {
  tool: string;
  unbekannt: string[];
  meldung: string;
}

/**
 * Prueft die Argumente eines Tool-Aufrufs gegen die im Schema deklarierten Namen.
 *
 * @param toolName   Name des Tools, wie in der definition.
 * @param erlaubt    Die Schluessel aus definition.inputSchema.properties.
 * @param args       Die tatsaechlich uebergebenen Argumente.
 * @returns null wenn alles bekannt ist, sonst der Befund mit fertiger Meldung.
 */
export function pruefeUnbekannteParameter(
  toolName: string,
  erlaubt: Set<string>,
  args: Record<string, unknown> | undefined,
): ParameterBefund | null {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  // Ohne deklarierte Properties gibt es nichts zu pruefen — lieber durchlassen als raten.
  if (erlaubt.size === 0) return null;

  const unbekannt = Object.keys(args).filter((k) => !erlaubt.has(k));
  if (unbekannt.length === 0) return null;

  const teile = unbekannt.map((p) => {
    const hinweis = BEKANNTE_IRRTUEMER[`${toolName}.${p}`];
    if (hinweis) return `"${p}": ${hinweis}`;

    // Tippfehler? Den naechstliegenden erlaubten Namen vorschlagen.
    let bester: string | null = null;
    let besterAbstand = 3; // ab 3 Zeichen Unterschied ist es kein Vertipper mehr
    for (const kandidat of erlaubt) {
      const d = abstand(p.toLowerCase(), kandidat.toLowerCase());
      if (d < besterAbstand) { besterAbstand = d; bester = kandidat; }
    }
    return bester ? `"${p}" — meintest du "${bester}"?` : `"${p}"`;
  });

  const meldung =
    `Das Tool "${toolName}" kennt ${unbekannt.length === 1 ? 'diesen Parameter' : 'diese Parameter'} nicht: ` +
    teile.join(' | ') +
    `. Der Aufruf wurde NICHT ausgefuehrt. Frueher wurden unbekannte Parameter stillschweigend ` +
    `verworfen und die Aktion trotzdem ausgefuehrt — mit der Bedeutung, die sie OHNE den ` +
    `Parameter hat. Genau das soll dir hier nicht mehr passieren. ` +
    `Erlaubt sind: ${[...erlaubt].sort().join(', ')}.`;

  return { tool: toolName, unbekannt, meldung };
}

/**
 * Baut die Nachschlagetabelle aus denselben definition-Objekten, die auch an ListTools gehen.
 * Bewusst KEINE zweite, von Hand gepflegte Liste — die liefe sofort auseinander.
 */
export function baueErlaubteParameter(
  definitionen: Array<{ name: string; inputSchema?: { properties?: Record<string, unknown> } }>,
): Map<string, Set<string>> {
  const tabelle = new Map<string, Set<string>>();
  for (const def of definitionen) {
    const props = def?.inputSchema?.properties;
    if (def?.name && props) tabelle.set(def.name, new Set(Object.keys(props)));
  }
  return tabelle;
}

/**
 * P22-T160 (25.10.2026): Objekt-/Listen-Parameter, die als JSON-TEXT ankommen, laut Server-Schema zurueckwandeln.
 *
 * ANLASS: artefakt(zeigen, vorlage, quellen:[{name:'plaene', vertrag:'plan.list'}]) lieferte quellen_ungueltig. Der
 * MCP-Client (Claude Code) hatte das Tool-Schema vom Sitzungsstart zwischengespeichert, VOR dem Deploy, der quellen
 * einfuehrte. Parameter, die er nicht kennt, reicht er als String weiter - die Liste kam als '[{"name":...}]' an. Das
 * trifft jeden Agenten, der schon vor einem Deploy lief, und jedes Tool mit neuen Objekt-/Listen-Parametern.
 *
 * GLEICHE STELLE WIE PA-1 (beide Strecken, vor dem Handler), GLEICHE QUELLE (die ausgelieferten Definitionen).
 * Bewusst eng:
 *   - nur Parameter mit genau type 'array' bzw. 'object'; oneOf/anyOf/Typlisten mit string bleiben aussen vor (dort ist
 *     ein Text ein gueltiger Wert, z. B. task_id, file_path, to_agent);
 *   - nur Text, der mit '[' bzw. '{' beginnt UND als JSON genau den deklarierten Typ ergibt. Alles andere bleibt
 *     unveraendert - die Handler behalten ihre eigenen Regeln (strArray: einzelner Text -> [Text]; kaputtes JSON meldet
 *     der Fachdienst selbst, z. B. pruefeQuellen mit Hinweis 'MCP neu verbinden').
 * Kein Schalter: reine Fehlerkorrektur (gueltige Aufrufe aendern sich nicht; vorher scheiterten diese Aufrufe oder die
 * Handler-Helfer objArray/strArray wandelten denselben Text ohnehin um).
 */
export type JsonParameterTyp = 'array' | 'object';

/** Je Tool die Parameter mit genau type 'array'/'object' - aus denselben Definitionen wie baueErlaubteParameter. */
export function baueJsonParameterTypen(
  definitionen: Array<{ name: string; inputSchema?: { properties?: Record<string, unknown> } }>,
): Map<string, Map<string, JsonParameterTyp>> {
  const tabelle = new Map<string, Map<string, JsonParameterTyp>>();
  for (const def of definitionen) {
    const props = def?.inputSchema?.properties;
    if (!def?.name || !props) continue;
    const typen = new Map<string, JsonParameterTyp>();
    for (const [name, schema] of Object.entries(props)) {
      const typ = (schema as { type?: unknown } | null)?.type;
      if (typ === 'array' || typ === 'object') typen.set(name, typ);
    }
    if (typen.size) tabelle.set(def.name, typen);
  }
  return tabelle;
}

/**
 * Wandelt in args (der Kopie des Aufrufs, wird veraendert) JSON-Text in Objekt/Liste um, wo das Schema es verlangt.
 * @returns die umgewandelten Parameternamen (leer = nichts geaendert).
 */
export function koerziereJsonParameter(
  typen: Map<string, JsonParameterTyp> | undefined,
  args: Record<string, unknown> | undefined,
): string[] {
  if (!typen || !args || typeof args !== 'object' || Array.isArray(args)) return [];
  const umgewandelt: string[] = [];
  for (const [name, typ] of typen) {
    const roh = args[name];
    if (typeof roh !== 'string') continue;
    const text = roh.trim();
    if (!text.startsWith(typ === 'array' ? '[' : '{')) continue;
    let wert: unknown;
    try { wert = JSON.parse(text); } catch { continue; }
    const passt = typ === 'array' ? Array.isArray(wert) : !!wert && typeof wert === 'object' && !Array.isArray(wert);
    if (!passt) continue;
    args[name] = wert;
    umgewandelt.push(name);
  }
  return umgewandelt;
}
