/**
 * STRECKENVERGLEICH: DIESELBE FRAGE UEBER ALLE DREI STRECKEN.
 *
 * WOZU: Die teuerste Fehlerklasse dieses Projekts sind zwei Strecken mit
 * gleichem Schema und still verschiedenem Verhalten (muster-stille-teilantwort,
 * Muster f: Fall 3 verlor string_occurrences seit jeher; G-b fand zwei
 * verschieden grosse Onboardings). Dieser Lauf stellt dieselbe Frage an
 *   stdio      = packages/mcp-server/dist, Handler direkt (ohne stdio-Transport)
 *   rest-mcp   = POST /mcp/messages (JSON-RPC tools/call) auf dem echten Server, via inject
 *   rest-route = GET /api/projects/:name/code-intel/*, via inject
 * und vergleicht die SCHLUESSELMENGEN der Antworten. Werte werden bewusst nicht
 * verglichen — die Daten aendern sich, die Form nicht.
 *
 * AUFRUF (braucht die DB-Umgebung; es wird KEIN Port geoeffnet, inject bleibt im Prozess):
 *   set -a; . ./.env; set +a; node packages/rest-api/tests/streckenvergleich.test.mjs
 * Exit 0 = keine unerwartete Abweichung. Exit 1 = mindestens eine.
 * Braucht gebaute dist von core, mcp-server und rest-api. Baut NICHT selbst.
 * SYNAPSE_AUTH_DISABLED wird NUR fuer diesen Prozess gesetzt.
 *
 * SCHREIBT: genau zwei Agenten-Registrierungen je Lauf (frische Kennungen
 * f-kern-probe-*), weil ein Onboarding nur beim ersten Besuch entsteht. Sonst nichts.
 *
 * ERWARTET-ROT (bekannte Abweichungen; einzeln benannt, brechen den Lauf nicht;
 * schlaegt eine GRUEN um, wird das laut gemeldet und die Kennzeichnung ist zu entfernen):
 *   1. calls-Antwort heisst auf stdio `calls`, auf beiden REST-Strecken `call_edges` (Befund K, 26.08.).
 *   2. setup_hinweis existiert nur auf der stdio-Strecke (entstand mit G-b; REST nachziehen).
 *   (frueher 3.) specialist(status, name:[...]) ignorierte den name-Filter: seit P10-T78 normale Zusage
 *      (Filter waehleSpezialisten wirkt, eigene wrapper_status-Zeilen im Testprojekt), nicht mehr erwartet-rot.
 *   (frueher 4.) message ergaenzte auf stdio erst der Server (server.ts:391): seit P10-T78 traegt der
 *      Onboarding-Baustein in core (agent-onboarding.ts) die message wieder selbst (REST verlor sie mit P7-T40);
 *      die Drift-Wache unten vergleicht core dist agent-onboarding.js mit mcp-server dist server.js.
 */
process.env.SYNAPSE_AUTH_DISABLED = '1';
// P10-T78 (P10-T56): createServer startet Hintergrund-Worker; ohne Attrappe verbanden sie sich mit dem
// Live-Qdrant/Ollama (192.168.50.65). Tests laufen nur gegen synapse_test mit eigenem Testprojekt.
process.env.QDRANT_URL = 'http://127.0.0.1:9';
process.env.OLLAMA_URL = 'http://127.0.0.1:9';
process.env.EMBEDDING_PROVIDER = 'ollama';

import { readFileSync } from 'node:fs';
import { pruefeTestDbUrl } from '../../../scripts/lib/test-db-schutz.mjs';
pruefeTestDbUrl('streckenvergleich.test');
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const hier = dirname(fileURLToPath(import.meta.url));
const repo = join(hier, '..', '..', '..');

let gruen = 0;
let rot = 0;
let erwartetRot = 0;
let umgeschlagen = 0;
const ok = (label) => { gruen += 1; console.log('OK      ' + label); };
const fehler = (label, detail) => { rot += 1; console.error('FEHLER  ' + label + '\n        ' + detail); };
function bekannteAbweichung(label, nochDa, grund) {
  if (nochDa) {
    erwartetRot += 1;
    console.log('ERWARTET-ROT  ' + label + '\n              ' + grund);
  } else {
    umgeschlagen += 1;
    console.log('UMGESCHLAGEN  ' + label + ' — bekannte Abweichung ist verschwunden. Kennzeichnung entfernen!');
  }
}

// Schluesselmenge einer Antwort ohne die streckenspezifischen Rahmen- und
// Anbaufelder: 'success'/'project' rahmen jede Antwort; der Rest sind Anbauten
// der REST-Attach-Kette (Hinweise, Skill-Vorschlaege, Shell-Aktivitaet), die
// lageabhaengig erscheinen und bewusst NICHT zum Werkzeug-Schema gehoeren —
// wer sie mitvergleicht, macht den Lauf flatterhaft.
// P10-T78: agentOnboarding haengt die REST-Kette beim ersten Besuch einer Kennung an (lageabhaengig, wie die anderen).
const RAHMEN = new Set(['success', 'project', 'hinweis_agent_id', 'skill_suggestions', 'skill_hook_metrics', 'shell_activity', 'unread_channels', 'agentOnboarding']);
// P10-T51 (K3): die MCP-Huelle laesst null-Felder weg, der stdio-Handler liefert sie noch;
// ein Feld mit null zaehlt deshalb wie ein fehlendes.
const kern = (objekt) => Object.keys(objekt ?? {}).filter((k) => !RAHMEN.has(k) && objekt[k] !== null && objekt[k] !== undefined).sort();
const gleich = (a, b) => a.length === b.length && a.every((k, i) => k === b[i]);

// Selbsttest: ein Vergleich, der nie rot werden kann, ist keiner.
{
  if (!gleich(kern({ a: 1, success: true }), kern({ a: 2, project: 'x' }))) {
    console.error('FEHLER  Selbsttest: gleiche Kerne wurden als verschieden erkannt');
    process.exit(1);
  }
  if (gleich(kern({ a: 1 }), kern({ a: 1, b: 2 }))) {
    console.error('FEHLER  Selbsttest: ein fehlendes Feld blieb unbemerkt');
    process.exit(1);
  }
}

// ── Testprojekt (P10-T78): eigene Fixture statt Live-Projekt 'synapse' ───────────
// Frueher fragte der Lauf das Projekt synapse ab; in synapse_test fehlt dessen Index (calls total=0).
// Die Fixture hat genug Kanten (getPool 3x) und Referenzen (update), damit jede Zusage pruefbar bleibt.
const P = 'test-p10-t78-strecke-' + process.pid;
const PFAD = '/nonexistent/' + P;
const { getPool } = await import(join(repo, 'packages', 'core', 'dist', 'db', 'client.js'));
const codeMod = await import(join(repo, 'packages', 'core', 'dist', 'services', 'code.js'));
const pool = getPool();
const FIXTURE = {
  'src/db.ts': [
    'export function getPool() { return { query: (..._a: unknown[]) => 1 }; }',
    'export function lies() { return getPool().query("a"); }',
    '',
  ].join('\n'),
  'src/a.ts': [
    "import { getPool } from './db';",
    'export function update(id: string) { return getPool().query("u", [id]); }',
    'export function nutze() { update("1"); return getPool(); }',
    '',
  ].join('\n'),
};
async function aufraeumen() {
  for (const t of ['code_call_edges', 'code_statements', 'code_chunks', 'code_references', 'code_symbols', 'code_files',
    'agent_events', 'tool_calls', 'agent_onboardings', 'memories', 'agent_sessions', 'project_setup_status', 'wrapper_status']) {
    await pool.query('DELETE FROM ' + t + ' WHERE project = $1', [P]).catch(() => {});
  }
  await pool.query('DELETE FROM projects WHERE name = $1', [P]);
}
await aufraeumen();
await pool.query('INSERT INTO projects (name, hostname, path, enabled) VALUES ($1, $2, $3, true)', [P, 'test-ohne-daemon', PFAD]);
for (const [pfad, inhalt] of Object.entries(FIXTURE)) {
  await pool.query(
    `INSERT INTO code_files (id, project, file_path, file_name, file_type, content, content_hash, file_size, updated_at, ignored)
     VALUES ($1, $2, $3, $4, 'ts', $5, $6, $7, NOW(), false)`,
    [P + ':' + pfad, P, pfad, pfad.split('/').pop(), inhalt, 'fixture-' + inhalt.length, inhalt.length]);
  try { await codeMod.parseAndEmbed(P, pfad, { erzwingeParse: true }); } catch { /* Embedding-Attrappe 127.0.0.1:9 */ }
}
// Anker fuer Vergleich 4: fuenf Spezialisten, angefragt werden drei (regel-nullzusagen-brauchen-anker).
const SPEZIALISTEN = ['ui-planer', 'pool-planer', 'koordinator', 'fixture-extra-a', 'fixture-extra-b'];
await pool.query("INSERT INTO wrapper_status (agent_name, project, status) SELECT n, $2, 'idle' FROM unnest($1::text[]) AS n", [SPEZIALISTEN, P]);

// ── Strecke 1: stdio (Handler direkt aus dem dist) ─────────────────────
const { codeIntelTool } = await import(join(repo, 'packages', 'mcp-server', 'dist', 'tools', 'consolidated', 'code-intel.js'));
const { checkAgentOnboarding } = await import(join(repo, 'packages', 'mcp-server', 'dist', 'tools', 'onboarding.js'));

// ── Strecken 2+3: echter Server, inject (kein listen) ───────────────────
const { createServer } = await import(join(repo, 'packages', 'rest-api', 'dist', 'server.js'));
const server = await createServer();
await server.ready();

let rpcId = 0;
let mcpSession = null;
async function mcpPost(payload) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  if (mcpSession) headers['mcp-session-id'] = mcpSession;
  const antwort = await server.inject({ method: 'POST', url: '/mcp/messages', headers, payload });
  const sitzung = antwort.headers['mcp-session-id'];
  if (typeof sitzung === 'string' && sitzung) mcpSession = sitzung;
  return antwort;
}

function rumpfAus(antwort) {
  const typ = String(antwort.headers['content-type'] ?? '');
  if (typ.includes('text/event-stream')) {
    const zeilen = antwort.body.split('\n').filter((z) => z.startsWith('data:'));
    if (zeilen.length === 0) throw new Error('SSE-Antwort ohne data-Zeile');
    return JSON.parse(zeilen[zeilen.length - 1].slice(5).trim());
  }
  return JSON.parse(antwort.body);
}

let initialisiert = false;
async function restMcp(toolName, argumente) {
  if (!initialisiert) {
    // Manche MCP-Transporte verlangen initialize vor tools/call; ein Server,
    // der es nicht braucht, nimmt es trotzdem entgegen.
    const init = await mcpPost({ jsonrpc: '2.0', id: ++rpcId, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'streckenvergleich', version: '1.0' } } });
    if (init.statusCode === 200) {
      await mcpPost({ jsonrpc: '2.0', method: 'notifications/initialized' });
    }
    initialisiert = true;
  }
  const antwort = await mcpPost({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name: toolName, arguments: argumente } });
  if (antwort.statusCode !== 200) throw new Error('POST /mcp/messages (' + toolName + ') -> HTTP ' + antwort.statusCode + ': ' + antwort.body.slice(0, 300));
  const rumpf = rumpfAus(antwort);
  if (rumpf.error) throw new Error('JSON-RPC-Fehler (' + toolName + '): ' + JSON.stringify(rumpf.error).slice(0, 300));
  const text = rumpf.result && rumpf.result.content && rumpf.result.content[0] ? rumpf.result.content[0].text : undefined;
  if (typeof text !== 'string') throw new Error('Unerwartete Antwortform (' + toolName + '): ' + JSON.stringify(rumpf.result ?? rumpf).slice(0, 300));
  return JSON.parse(text);
}

async function restRoute(pfad) {
  const antwort = await server.inject({ method: 'GET', url: pfad });
  if (antwort.statusCode !== 200) throw new Error('GET ' + pfad + ' -> HTTP ' + antwort.statusCode + ': ' + antwort.body.slice(0, 300));
  return JSON.parse(antwort.body);
}

// ── Vergleich 1: references(update) ─────────────────────────────────
try {
  const stdio = await codeIntelTool.handler({ action: 'references', project: P, name: 'update', agent_id: 'f-kern-probe' });
  const mcp = await restMcp('code_intel', { action: 'references', project: P, name: 'update', agent_id: 'f-kern-probe' });
  const route = await restRoute('/api/projects/' + P + '/code-intel/references?name=update');
  const [a, b, c] = [kern(stdio), kern(mcp), kern(route)];
  if (gleich(a, b) && gleich(b, c)) ok('references: alle drei Strecken liefern dieselben Felder (' + a.join(',') + ')');
  else fehler('references: Felder weichen ab', 'stdio=[' + a + ']\n        rest-mcp=[' + b + ']\n        rest-route=[' + c + ']');
  for (const [name, antwort] of [['stdio', stdio], ['rest-mcp', mcp], ['rest-route', route]]) {
    if (typeof antwort.gekappt === 'boolean' && typeof antwort.total_references === 'number') ok('references/' + name + ': traegt gekappt + total_references (E1)');
    else fehler('references/' + name + ': E1-Felder fehlen', 'gekappt=' + antwort.gekappt + ' total_references=' + antwort.total_references);
  }
} catch (f) {
  fehler('references: Vergleich abgebrochen', String(f && f.message ? f.message : f));
}

// ── Vergleich 2: calls(getPool, limit:1) + Filter-Regel ──────────────────
try {
  const stdio = await codeIntelTool.handler({ action: 'calls', project: P, callee: 'getPool', limit: 1, agent_id: 'f-kern-probe' });
  const mcp = await restMcp('code_intel', { action: 'calls', project: P, callee: 'getPool', limit: 1, agent_id: 'f-kern-probe' });
  const route = await restRoute('/api/projects/' + P + '/code-intel/calls?callee=getPool&limit=1');

  bekannteAbweichung(
    'calls: Feldname stdio=calls vs. REST=call_edges (Befund K)',
    Array.isArray(stdio.calls) && Array.isArray(mcp.call_edges) && Array.isArray(route.call_edges),
    'stdio liefert `calls`, beide REST-Strecken `call_edges`. Angleichen braeche bestehende Konsumenten — Entscheidung steht aus.'
  );

  // FILTER-REGEL: Filter gesetzt -> Ergebnis kleiner oder Fehler, niemals still voll.
  for (const [name, liste, antwort] of [['stdio', stdio.calls, stdio], ['rest-mcp', mcp.call_edges, mcp], ['rest-route', route.call_edges, route]]) {
    const anzahl = Array.isArray(liste) ? liste.length : NaN;
    if (anzahl <= 1 && antwort.gekappt === true && typeof antwort.total === 'number' && antwort.total > 1) {
      ok('calls/' + name + ': limit:1 -> ' + anzahl + ' Kante, total=' + antwort.total + ', gekappt=true (Filter-Regel erfuellt)');
    } else {
      fehler('calls/' + name + ': Filter-Regel verletzt', 'anzahl=' + anzahl + ' total=' + antwort.total + ' gekappt=' + antwort.gekappt);
    }
  }
} catch (f) {
  fehler('calls: Vergleich abgebrochen', String(f && f.message ? f.message : f));
}

// ── Vergleich 3: Onboarding (nach G-b) ───────────────────────────────
try {
  const stempel = Date.now();
  const stdioOnboarding = await checkAgentOnboarding(P, 'f-kern-probe-stdio-' + stempel, PFAD, 'subagent');
  // REST-Strecke: ein beliebiger Tool-Aufruf mit frischer Kennung traegt den Block.
  const restAntwort = await restMcp('admin', { action: 'index_stats', project: P, agent_id: 'f-kern-probe-rest-' + stempel, role: 'subagent' });
  const restOnboarding = restAntwort.agentOnboarding ?? null;
  if (!stdioOnboarding || !restOnboarding) {
    fehler('onboarding: mindestens eine Strecke lieferte keinen Block', 'stdio=' + (stdioOnboarding ? 'da' : 'FEHLT') + ' rest=' + (restOnboarding ? 'da' : 'FEHLT'));
  } else {
    // Praezisierung Befund (N), 26.08.: `message` ("WILLKOMMEN ...") existiert
    // zur LAUFZEIT auf BEIDEN Strecken — der stdio-Server ergaenzt es beim
    // Durchreichen (server.ts:391), der Baustein checkAgentOnboarding traegt es
    // nicht. Dieser Test misst den Baustein, deshalb wird message auf der
    // stdio-Seite hier ERGAENZT statt ausgeblendet. Der wahre Kern von (N):
    // dieselbe Konstante ist doppelt gepflegt (server.ts:391 und
    // routes/mcp.ts:1770) und kann driften — darauf wacht die Pruefung darunter.
    const a = [...new Set([...kern(stdioOnboarding), 'message'])].sort();
    const b = kern(restOnboarding);
    if (gleich(a, b)) ok('onboarding: beide Strecken liefern dieselben Felder (' + b.join(',') + ')');
    else fehler('onboarding: Felder weichen ab', 'stdio+server.ts=[' + a + ']\n        rest =[' + b + ']');
    // Drift-Wache fuer die doppelt gepflegte Begruessungs-Konstante. P10-T78: seit P7-T40 baut die REST-Strecke
    // ihren Block in core (agent-onboarding.ts, holeAgentOnboarding) - dort steht die Konstante jetzt.
    const stdioServerQuell = readFileSync(join(repo, 'packages', 'mcp-server', 'dist', 'server.js'), 'utf8');
    const restMcpQuell = readFileSync(join(repo, 'packages', 'core', 'dist', 'services', 'agent-onboarding.js'), 'utf8');
    const begruessung = 'WILLKOMMEN! Als neuer Agent beachte bitte folgende Projekt-Regeln:';
    if (stdioServerQuell.includes(begruessung) && restMcpQuell.includes(begruessung)) {
      ok('onboarding: Begruessungs-Konstante auf beiden Strecken wortgleich (Drift-Wache)');
    } else {
      fehler('onboarding: Begruessungs-Konstante weicht ab oder fehlt', 'stdio-server=' + stdioServerQuell.includes(begruessung) + ' rest=' + restMcpQuell.includes(begruessung));
    }
    for (const [name, block] of [['stdio', stdioOnboarding], ['rest', restOnboarding]]) {
      if ('rulesMessage' in block) fehler('onboarding/' + name + ': rulesMessage ist wieder da', 'G-b hat den doppelten Volltext-Block entfernt — er darf nicht zurueckkommen.');
      else ok('onboarding/' + name + ': kein doppelter Volltext-Block (G-b haelt)');
    }
  }

  // setup_hinweis: statisch gegen die gebauten Strecken geprueft, weil er zur
  // Laufzeit nur bei einem Projekt in initial-pending entsteht (hier nicht ausloesbar).
  const stdioQuell = readFileSync(join(repo, 'packages', 'mcp-server', 'dist', 'tools', 'onboarding.js'), 'utf8');
  const restQuell = readFileSync(join(repo, 'packages', 'rest-api', 'dist', 'routes', 'mcp.js'), 'utf8');
  const kernQuell = readFileSync(join(repo, 'packages', 'core', 'dist', 'services', 'project-status.js'), 'utf8');
  const stdioHat = stdioQuell.includes('setup_hinweis');
  const restHat = restQuell.includes('setup_hinweis') || kernQuell.includes('setup_hinweis');
  bekannteAbweichung(
    'onboarding: setup_hinweis nur auf der stdio-Strecke',
    stdioHat && !restHat,
    'Mit G-b auf stdio entstanden; die REST-Strecke kennt das Feld nicht. Nachziehen steht aus.'
  );
} catch (f) {
  fehler('onboarding: Vergleich abgebrochen', String(f && f.message ? f.message : f));
}

// ── Vergleich 4: specialist-Filter (Filter-Regel) ────────────
// P10-T78: frueher ERWARTET-ROT (Abweichung 3). Seit waehleSpezialisten (REST mcp.ts specialist status) gilt
// der name-Filter; mit dem Fixture-Anker (5 vorhanden, 3 angefragt) ist das jetzt eine normale Zusage.
try {
  const vorhanden = (await pool.query('SELECT count(*)::int AS n FROM wrapper_status WHERE project = $1', [P])).rows[0].n;
  const antwort = await restMcp('specialist', { action: 'status', project: P, name: ['ui-planer', 'pool-planer', 'koordinator'], agent_id: 'f-kern-probe' });
  const eintraege = antwort.specialists ?? antwort.status ?? antwort.agents ?? null;
  const anzahl = Array.isArray(eintraege)
    ? eintraege.length
    : eintraege && typeof eintraege === 'object'
      ? Object.keys(eintraege).length
      : NaN;
  if (vorhanden === SPEZIALISTEN.length && anzahl === 3) ok('specialist(status, name:[3]) liefert genau die 3 angefragten von ' + vorhanden + ' (Filter-Regel erfuellt)');
  else fehler('specialist(status, name:[...]): Filter-Regel verletzt', 'vorhanden=' + vorhanden + ' angefragt=3 geliefert=' + anzahl);
} catch (f) {
  fehler('specialist: Vergleich abgebrochen', String(f && f.message ? f.message : f));
}

const gesamt = gruen + rot + erwartetRot + umgeschlagen;
console.log('\nERGEBNIS  ' + gesamt + ' Pruefungen: ' + gruen + ' gruen, ' + rot + ' unerwartet rot, ' + erwartetRot + ' erwartet-rot (bekannte Abweichungen), ' + umgeschlagen + ' umgeschlagen');
// server.close() kehrt nicht zurueck — Hintergrund-Worker halten den Prozess
// offen (deploy-synapse-api-unraid). Deshalb hartes exit nach der Auswertung.
await aufraeumen().catch((e) => console.error('Aufraeumen fehlgeschlagen: ' + e.message));
process.exit(rot > 0 ? 1 : 0);
