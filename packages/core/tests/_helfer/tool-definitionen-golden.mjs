/**
 * P10-T78 (User-Entscheidung 444127bc Punkt 1): Golden der MCP-Tool-Definitionen mit Begruendungspflicht.
 *
 * Eingefroren ist je Strecke (rest = MCP_TOOLS der REST-API, stdio = consolidated-Tools des MCP-Servers) und je
 * Tool der sha256 von JSON.stringify(definition). Eine absichtliche Aenderung wird nicht durch Neu-Einfrieren
 * erledigt, sondern als Eintrag unter aenderungen (strecke, tool, alt, neu, grund, task, datum) nachgewiesen.
 * Die Eintraege bilden je Tool eine Kette ab dem eingefrorenen Hash; ein Eintrag ohne Grund/Task oder mit
 * falschem alt-Hash ist selbst ein Fehler. Ohne Eintrag schlaegt der Test mit einem fertigen Vorschlag fehl.
 */
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';

export const TOOL_DEFINITIONEN_DATEI = new URL('../fixtures/tool-definitionen-p18-rv9.json', import.meta.url);
export const definitionsHash = (definition) => createHash('sha256').update(JSON.stringify(definition)).digest('hex');
export const ladeToolDefinitionen = (datei = TOOL_DEFINITIONEN_DATEI) => JSON.parse(readFileSync(datei, 'utf8'));
/** {name: hash} aus einer Liste von Definitionen. */
export const hashJeTool = (definitionen) => Object.fromEntries(definitionen.map((d) => [d.name, definitionsHash(d)]));

const HEX = /^[0-9a-f]{64}$/;
const TASK = /^P\d+-[A-Z]+\d+$/;
const DATUM = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Vergleicht ist = {rest:{tool:hash}, stdio:{tool:hash}} mit eingefrorenem Stand + begruendeten Aenderungen.
 * Liefert {fehler: string[], vorschlaege: object[]} - leer heisst gruen.
 */
export function pruefeToolDefinitionen(ist, golden = ladeToolDefinitionen()) {
  const fehler = [];
  const erwartet = {rest: {...golden.eingefroren.rest}, stdio: {...golden.eingefroren.stdio}};
  (golden.aenderungen ?? []).forEach((a, i) => {
    const wo = `aenderungen[${i}] (${a?.strecke}/${a?.tool})`;
    if (!['rest', 'stdio'].includes(a?.strecke) || typeof a.tool !== 'string' || !a.tool) {
      fehler.push(wo + ': strecke (rest|stdio) und tool sind Pflicht');
      return;
    }
    if (typeof a.grund !== 'string' || a.grund.trim().length < 15) fehler.push(wo + ': grund fehlt oder ist kuerzer als 15 Zeichen');
    if (typeof a.task !== 'string' || !TASK.test(a.task)) fehler.push(wo + ': task (z. B. P10-T78) fehlt oder ist ungueltig');
    if (typeof a.datum !== 'string' || !DATUM.test(a.datum)) fehler.push(wo + ': datum (JJJJ-MM-TT) fehlt');
    const bisher = erwartet[a.strecke][a.tool] ?? null;
    if ((a.alt ?? null) !== bisher) fehler.push(wo + `: alt=${a.alt ?? null} passt nicht zum bisher erwarteten Hash ${bisher} (Kette unterbrochen)`);
    if (a.neu !== null && !HEX.test(String(a.neu))) fehler.push(wo + ': neu muss ein sha256-Hash sein (null = Tool entfernt)');
    if (a.neu === null) delete erwartet[a.strecke][a.tool];
    else erwartet[a.strecke][a.tool] = a.neu;
  });
  const vorschlaege = [];
  const datum = new Date().toISOString().slice(0, 10);
  for (const strecke of ['rest', 'stdio']) {
    const soll = erwartet[strecke];
    const hat = ist[strecke] ?? {};
    for (const tool of [...new Set([...Object.keys(soll), ...Object.keys(hat)])].sort()) {
      if (soll[tool] === hat[tool]) continue;
      const art = soll[tool] === undefined ? 'NEU' : hat[tool] === undefined ? 'ENTFERNT' : 'GEAENDERT';
      fehler.push(`${strecke}/${tool}: ${art} ohne begruendeten Eintrag (erwartet ${soll[tool] ?? '-'}, ist ${hat[tool] ?? '-'})`);
      vorschlaege.push({strecke, tool, alt: soll[tool] ?? null, neu: hat[tool] ?? null, grund: '<was und warum, mind. 15 Zeichen>', task: '<P..-T..>', datum});
    }
  }
  return {fehler, vorschlaege};
}

/** Lesbare Fehlermeldung mit fertigen Eintraegen fuer die Fixture. */
export function toolDefinitionenMeldung({fehler, vorschlaege}) {
  return 'Tool-Definitionen weichen vom eingefrorenen Stand ab:\n  - ' + fehler.join('\n  - ') +
    (vorschlaege.length
      ? '\nAbsichtlich? In packages/core/tests/fixtures/tool-definitionen-p18-rv9.json unter "aenderungen" anhaengen ' +
        '(grund + task ausfuellen):\n' + vorschlaege.map((v) => '  ' + JSON.stringify(v)).join(',\n') +
        '\nUnbeabsichtigt? Definition zuruecknehmen.'
      : '');
}
