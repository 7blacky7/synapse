/**
 * P10-T90 Zwangs-Pin (User 08.11.2026, Freigabe thought 35bf1112, Vorgabe 12507835 "Sperre verwirft keine Plaene";
 * Architektur-Befunde a5e7af4e/37499: Pin an der Memory, Hinweis ueber Hinweisquellen-Registry, Geltung ueber Lauf-Herkunft).
 * Prueft packages/core/src/services/zwangs-pin.ts und den Weg in agent-token-tools.ts (mitAgentToolAufruf).
 *   A Katalog: Schalter zwangs_pin (nur ausdruecklich, Zweck), admin-Aktion zwangs_pins + Parameter, Hinweisquelle registrierbar
 *   B rein: Stamm-Glob, Spezifitaet, Geltung (Typ/Lauf/laufHerkunftAus; Codex/Web-KI/API/ohne Ausweis/ohne Kontext nur Hinweis)
 *   C Verwaltung: Rechte, Pflichtfelder, Pin = Tags pflicht:/pflicht-kurz: an der Memory (keine Pin-Tabelle)
 *   D Schalter AUS = keine Wirkung
 *   E Sperre (files plan/move unter dem Stamm), ausserhalb kein Eingriff, Debugfelder
 *   F User-Vorgabe 12507835: offener Plan bleibt bei Sperre unveraendert; nach memory read geht commit desselben Plans durch
 *   G Neuer Kontext / neuer Lauf / Memory geaendert -> erneut Pflicht
 *   H Hinweisquelle (zwangsPinHinweise): Codex, ohne Ausweis, lesende Ops; hinweis_id je Lauf + Epoche
 *   I mehrere Pins: spezifischster zuerst, alle genannt
 *   L echte Merkmale aus PG: Claude-Subagent-Ausweis ohne Modell -> Sperre; unbekannter Lauf, Codex-Typ, extern -> keine Sperre
 *   J mitAgentToolAufruf (Legacy, ohne Ausweis): keine Sperre, Handler laeuft
 *   K admin status und entfernen
 * Aufruf (Repo-Root, nach Build von core):
 *   DATABASE_URL=postgresql://...@<host>:5433/synapse_test node packages/core/tests/zwangs-pin-p10-t90.test.mjs
 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {pruefeTestDbUrl} from '../../../scripts/lib/test-db-schutz.mjs';
pruefeTestDbUrl('P10-T90');
const url = new URL(process.env.DATABASE_URL);
assert.equal(url.pathname, '/synapse_test', 'P10-T90: nur gegen synapse_test');
const schema = 'p10t90_' + randomUUID().replaceAll('-', '');
const project = 'p10-t90-' + randomUUID().slice(0, 8);
url.searchParams.set('options', '-c search_path=' + schema + ',public');
const repo = new URL('../../../', import.meta.url);
const load = p => import(new URL(p, repo).href);
Object.assign(process.env, {DATABASE_URL: url.toString(), SYNAPSE_DATABASE_URL: url.toString(), SYNAPSE_SCHEMA: 'aus', SYNAPSE_W1B_GATE_TTL_MS: '0',
  QDRANT_URL: 'http://127.0.0.1:9', OLLAMA_URL: 'http://127.0.0.1:9'});

let pass = 0;
// Herkunft je Pruefung (regel-tests-mit-herkunft-kommentieren): Label = Task + Teil + Quelle; bei Fehlschlag Debugzeile.
const ok = (cond, label, detail) => {
  if (!cond) console.error('DEBUG ' + label + ' | tatsaechlich: ' + JSON.stringify(detail ?? null).slice(0, 1200));
  assert.ok(cond, label);
  pass++; console.log('PASS ' + label);
};

let pool;
try {
  const core = await load('packages/core/dist/index.js');
  pool = (await load('packages/core/dist/db/client.js')).getPool();
  await pool.query('CREATE SCHEMA "' + schema + '"');
  for (const t of ['memories', 'file_batch_plans', 'file_versions', 'agent_profil_schalter', 'agent_identitaeten', 'agent_sessions', 'tool_calls',
    'agent_typen', 'agent_profil_revisionen', 'agent_identitaet_laeufe', 'agent_identitaet_wrapper_status']) {
    const ex = await pool.query("SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename=$1", [t]);
    if (ex.rows.length) await pool.query('CREATE TABLE "' + schema + '"."' + t + '" (LIKE public."' + t + '" INCLUDING ALL)');
  }
  await pool.query(core.ZWANGS_PIN_SCHEMA_SQL);
  await pool.query(core.ZWANGS_PIN_SCHEMA_SQL); // idempotent
  const Z = await load('packages/core/dist/services/zwangs-pin.js');
  const schalter = aktiv => core.setzeProfilProduktSchalter({ebene: 'projekt', project, funktion: 'zwangs_pin', aktiv, grund: 'P10-T90 Testlauf'}, {system: 'user'});
  const memory = (name, content) => pool.query(
    'INSERT INTO memories (id, project, name, content, category, tags) VALUES ($1,$2,$3,$4,$5,$6)', [randomUUID(), project, name, content, 'rules', []]);
  const tags = async name => (await pool.query('SELECT tags FROM memories WHERE project=$1 AND name=$2', [project, name])).rows[0]?.tags ?? [];
  const USER = {art: 'user'};
  const admin = (args, akteur = USER) => Z.fuehreZwangsPinAdminAus('zwangs_pins', {project, ...args}, akteur);
  const claude = (epoch = 1, lauf = 'lauf-1') => ({identity_id: 'id-claude', agent_id: 'claude-x', lauf_id: lauf, context_epoch: epoch, modell: null});
  const CLI = 'CLI (Claude Code)';
  // Merkmale: ueberwachter Lauf (context_epoch) wie aus PG; Teil L prueft die echte PG-Ermittlung.
  const pruefe = (args, aufrufer, herkunft = CLI, tool = 'files', merkmale = aufrufer ? {lauf_epoch: aufrufer.context_epoch, lauf_status: 'aktiv'} : null) =>
    Z.pruefeZwangsPin({tool, action: args.action, args, project, aufrufer, herkunft, merkmale});
  const planArgs = (pfad) => ({action: 'plan', ops: [{action: 'update', file_path: pfad, content: 'x'}]});
  // Hinweisquelle mit bezeugtem Principal (wie im Tool-Aufruf) bzw. ohne Ausweis.
  const BEZUG = {modus: 'beide', standard: 'alt', quelle: 'standard', bis: null, letzter_fehler: null};
  const hinweise = (tool, args, a) => core.mitAgentAufrufKontext({bezug: BEZUG, principal: a ? {art: 'identity', project, agent_id: a.agent_id,
    identity_id: a.identity_id, rolle: 'subagent', modell: a.modell, context_epoch: a.context_epoch, lauf_id: a.lauf_id} : null},
  () => Z.zwangsPinHinweise(core.baueHinweisKontext(tool, {project, ...args}, {}, 'x', 's', new AbortController().signal)));

  // A Katalog -------------------------------------------------------------------------------------------------
  ok(core.PROFIL_PRODUKT_FUNKTIONEN.includes('zwangs_pin') && core.NUR_AUSDRUECKLICH.includes('zwangs_pin'),
    'P10-T90 A agent-profil-schalter.ts: Schalter zwangs_pin im Katalog, nur ausdruecklich');
  const SL = await load('packages/core/dist/services/admin-schlank.js');
  ok(typeof SL.PROFIL_SCHALTER_ZWECK.zwangs_pin === 'string', 'P10-T90 A admin-schlank.ts PROFIL_SCHALTER_ZWECK: Zweckzeile zwangs_pin');
  ok(core.W1B_ADMIN_ACTIONS.includes('zwangs_pins') && ['pin_stamm', 'pin_memory', 'pin_kurzfassung'].every(k => k in core.W1B_ADMIN_PARAMETER),
    'P10-T90 A agent-profil-admin.ts: admin-Aktion zwangs_pins + Parameter (bestehendes Tool, keine neue MCP-Funktion)');
  core.initialisiereZwangsPinHinweise(); core.initialisiereZwangsPinHinweise();
  const HK = await load('packages/core/dist/services/hinweis-katalog.js');
  ok(JSON.stringify(HK.HINWEIS_PRODUZENTEN).includes('ausloeser.zwangs_pin'),
    'P10-T90 A zwangs-pin.ts initialisiereZwangsPinHinweise: Quelle zwangs_pin in der Registry (doppelt ohne Fehler) und im Hinweis-Katalog');
  const schemaSql = core.ZWANGS_PIN_SCHEMA_SQL;
  ok(!/CREATE TABLE IF NOT EXISTS zwangs_pins \(/.test(schemaSql) && /zwangs_pin_quittungen/.test(schemaSql),
    'P10-T90 A Schema 181: keine eigene Pin-Tabelle, nur Quittungen/Ereignisse');

  // B rein ----------------------------------------------------------------------------------------------------
  ok(Z.stammPasst('packages/web-ui/**', 'packages/web-ui/src/App.tsx') && Z.stammPasst('packages/web-ui/**', './packages/web-ui')
    && !Z.stammPasst('packages/web-ui/**', 'packages/web-uix/a.ts') && !Z.stammPasst('packages/web-ui/**', 'packages/core/a.ts'),
    'P10-T90 B zwangs-pin.ts stammPasst: Glob ** (Ordner selbst + darunter, kein Praefix-Nachbar)');
  ok(Z.stammPasst('packages/web-ui', 'packages/web-ui/src/a.ts') && Z.stammPasst('docs/a.md', 'docs/a.md') && !Z.stammPasst('docs/a.md', 'docs/a.mdx')
    && Z.stammPasst('packages/*/src/**/*.tsx', 'packages/web-ui/src/x/y.tsx') && !Z.stammPasst('packages/*/src/**/*.tsx', 'packages/web-ui/src/x/y.ts'),
    'P10-T90 B zwangs-pin.ts stammRegex: Ordner-Praefix, exakte Datei, * und ** gemischt');
  ok(Z.stammSpezifitaet('packages/web-ui/src/**') > Z.stammSpezifitaet('packages/web-ui/**'), 'P10-T90 B stammSpezifitaet: tieferer Stamm ist spezifischer');
  ok(Z.pinKurzfassung('Satz eins. Satz zwei! Satz drei.', []) === 'Satz eins. Satz zwei!' && Z.pinKurzfassung('x', ['pflicht-kurz:Kurz hier']) === 'Kurz hier',
    'P10-T90 B pinKurzfassung: Tag pflicht-kurz: vor den ersten zwei Saetzen');
  const G = Z.zwangsPinGeltung;
  const K = {lauf_epoch: 3, lauf_status: 'aktiv'};
  ok(G({mitAusweis: true, herkunft: CLI, merkmale: K}).gesperrt && G({mitAusweis: true, herkunft: null, modell: 'claude-opus-5-5', merkmale: K}).art === 'claude_modell'
    && G({mitAusweis: true, herkunft: 'CLI/stdio', modell: 'sonnet', merkmale: K}).art === 'claude_modell',
    'P10-T90 B zwangsPinGeltung: Claude CLI (Herkunft) bzw. Claude-Modell (laufHerkunftAus) mit ueberwachtem Lauf = gesperrt');
  let g = G({mitAusweis: true, herkunft: null, modell: null, merkmale: {...K, typ: 'claude-subagent'}});
  ok(g.gesperrt && g.art === 'claude_typ' && /typ:claude-subagent/.test(g.quelle) && /context_epoch 3/.test(g.quelle),
    'P10-T90 B zwangsPinGeltung: Ausweis-Typ claude-subagent ohne Modell/Herkunft = gesperrt, Quelle Typ + Epoche', g);
  g = G({mitAusweis: true, herkunft: null, merkmale: {...K, wrapper_provider: 'anthropic'}});
  ok(g.art === 'claude_wrapper' && /lauf_herkunft:provider:anthropic/.test(g.quelle)
    && G({mitAusweis: true, herkunft: null, merkmale: {...K, lauf_herkunftsort: 'CLI (Claude Code)'}}).art === 'claude_cli',
    'P10-T90 B zwangsPinGeltung: Wrapper anthropic ueber laufHerkunftAus bzw. Lauf-Herkunft CLI (Claude Code) = gesperrt', g);
  g = G({mitAusweis: true, herkunft: CLI, merkmale: {typ: 'claude-subagent'}});
  ok(!g.gesperrt && g.art === 'kontext_nicht_ueberwacht' && g.kontext_ueberwacht === false,
    'P10-T90 B zwangsPinGeltung: ohne Lauf mit context_epoch = Kontext nicht ueberwacht, nur Hinweis', g);
  // Startort wie von agent-start-ort.ts merkeStartOrt geschrieben (Anmeldung: extern + herkunftsortAusKopf; Container: target_runtime).
  g = G({mitAusweis: true, herkunft: null, merkmale: {...K, start_ort: 'extern', start_ziel: 'CLI (Claude Code)'}});
  ok(g.gesperrt && g.art === 'claude_cli' && /start_ort:extern\/CLI \(Claude Code\)/.test(g.quelle)
    && G({mitAusweis: true, herkunft: null, merkmale: {...K, start_ort: 'container', start_ziel: 'claude'}}).art === 'claude_wrapper'
    && G({mitAusweis: true, herkunft: null, merkmale: {...K, start_ort: 'container', start_ziel: 'codex'}}).art === 'codex'
    && G({mitAusweis: true, herkunft: null, merkmale: {...K, start_ort: 'extern', start_ziel: 'CLI (Codex)'}}).art === 'codex'
    && G({mitAusweis: true, herkunft: null, merkmale: {...K, start_ort: 'extern', start_ziel: 'chatgpt.com'}}).art === 'web_ki'
    && G({mitAusweis: true, herkunft: null, merkmale: {...K, start_ort: 'extern', start_ziel: 'Claude-Desktop'}}).art === 'nicht_identifizierbar',
    'P10-T90 B zwangsPinGeltung: Startort (merkeStartOrt) extern/CLI (Claude Code) bzw. container/claude = gesperrt; Codex/Web-KI/unbekannt nicht', g);
  // Entscheidung team-lead: 'Claude-User' (herkunftsortAusKopf agent-anmeldung.ts:90-91, Koordinator ueber cc-wrap) = Claude CLI.
  g = G({mitAusweis: true, herkunft: null, merkmale: {...K, start_ort: 'extern', start_ziel: 'Claude-User'}});
  ok(g.gesperrt && g.art === 'claude_cli' && /Claude-User/.test(g.quelle) && G({mitAusweis: true, herkunft: 'Claude-User', merkmale: K}).art === 'claude_cli'
    && G({mitAusweis: true, herkunft: 'Claude-User', merkmale: {start_ort: 'extern', start_ziel: 'Claude-User'}}).art === 'kontext_nicht_ueberwacht',
    'P10-T90 B zwangsPinGeltung: Claude-User (Koordinator) = Claude CLI, gesperrt nur mit ueberwachtem Lauf', g);
  ok(!G({mitAusweis: true, herkunft: CLI, merkmale: {...K, typ: 'claude-subagent', lauf_status: 'abgeloest'}}).gesperrt,
    'P10-T90 B zwangsPinGeltung: abgeloester Lauf = nicht ueberwacht');
  ok(G({mitAusweis: true, herkunft: CLI, merkmale: {...K, typ: 'codex-entwickler'}}).art === 'codex'
    && G({mitAusweis: true, herkunft: null, merkmale: {...K, wrapper_provider: 'openai'}}).art === 'codex'
    && G({mitAusweis: true, herkunft: 'chatgpt.com', merkmale: {...K, typ: 'claude-subagent'}}).art === 'web_ki',
    'P10-T90 B zwangsPinGeltung: Typ codex-*, Wrapper openai (laufHerkunftAus), Web-KI gewinnen vor Claude-Kennzeichen');
  ok(!G({mitAusweis: true, herkunft: 'CLI (Codex)', merkmale: K}).gesperrt && G({mitAusweis: true, herkunft: 'claude.ai', merkmale: K}).art === 'web_ki'
    && G({mitAusweis: true, herkunft: 'CLI/stdio', modell: 'gpt-5', merkmale: K}).art === 'codex'
    && G({mitAusweis: true, herkunft: CLI, modell: 'api-haiku', merkmale: K}).art === 'api_lauf' && G({mitAusweis: false, herkunft: CLI}).art === 'ohne_ausweis'
    && G({mitAusweis: true, herkunft: 'CLI/stdio', modell: null, merkmale: K}).art === 'nicht_identifizierbar',
    'P10-T90 B zwangsPinGeltung: Codex, Web-KI, API-Lauf, ohne Ausweis, unbekannt = keine Sperre');
  ok(Z.zwangsPinArt('files', 'plan') === 'schreiben' && Z.zwangsPinArt('files_batch', 'commit') === 'schreiben' && Z.zwangsPinArt('files', 'read') === 'lesen'
    && Z.zwangsPinArt('files', 'cancel') === null && Z.zwangsPinArt('files', 'plan_status') === null && Z.zwangsPinArt('code_intel', 'file') === 'lesen'
    && Z.zwangsPinArt('code_intel', 'search') === null && Z.zwangsPinArt('docs', 'get_for_file') === 'lesen' && Z.zwangsPinArt('memory', 'read') === null,
    'P10-T90 B zwangsPinArt: schreibende/lesende Ops; cancel/plan_status/search unberuehrt');

  // C Verwaltung (Pin = Tags an der Memory) -------------------------------------------------------------------
  await memory('webui-design-standard', 'Regeln fuer die Web-UI: vorhandene Tokens und Komponenten nutzen. Version 1.');
  let r = await admin({modus: 'setzen', pin_stamm: 'packages/web-ui/**', pin_memory: 'gibt-es-nicht', pin_kurzfassung: 'Kurzfassung lang genug.'});
  ok(r.success === false && r.error === 'memory_unbekannt', 'P10-T90 C fuehreZwangsPinAdminAus setzen: unbekannte Memory abgewiesen', r);
  r = await admin({modus: 'setzen', pin_stamm: 'packages/web-ui/**', pin_memory: 'webui-design-standard', pin_kurzfassung: 'kurz'});
  ok(r.success === false && r.error === 'pin_kurzfassung_fehlt', 'P10-T90 C setzen: Kurzfassung Pflicht (10..600)', r);
  r = await admin({modus: 'setzen', pin_stamm: '../x/**', pin_memory: 'webui-design-standard', pin_kurzfassung: 'Kurzfassung lang genug.'});
  ok(r.success === false && r.error === 'pin_stamm_ungueltig', 'P10-T90 C setzen: Stamm mit .. abgewiesen', r);
  const sub = {art: 'identitaet', principal: {art: 'identity', project, agent_id: 'sub', identity_id: 'id-sub', rolle: 'subagent', modell: null, context_epoch: 1, lauf_id: 'l'}};
  r = await admin({modus: 'setzen', pin_stamm: 'packages/web-ui/**', pin_memory: 'webui-design-standard', pin_kurzfassung: 'Kurzfassung lang genug.'}, sub);
  ok(r.success === false && r.error === 'recht_fehlt', 'P10-T90 C setzen: Subagent ohne Recht (nur User/Koordinator)', r);
  r = await admin({modus: 'setzen', pin_stamm: './packages/web-ui/**', pin_memory: 'webui-design-standard',
    pin_kurzfassung: 'Web-UI nur mit vorhandenen Tokens und Komponenten gestalten.', grund: 'P10-T90 Test'});
  const t1 = await tags('webui-design-standard');
  ok(r.success === true && r.pin?.stamm === 'packages/web-ui/**' && r.schalter?.aktiv === false && /AUS/.test(r.hinweis ?? '')
    && t1.includes('pflicht:packages/web-ui/**') && t1.includes('pflicht-kurz:Web-UI nur mit vorhandenen Tokens und Komponenten gestalten.'),
    'P10-T90 C setzen durch User: Tags pflicht:/pflicht-kurz: an der Memory (Stamm normalisiert), Hinweis Schalter AUS', {r, t1});

  // D Schalter AUS --------------------------------------------------------------------------------------------
  ok(await pruefe(planArgs('packages/web-ui/src/App.tsx'), claude()) === null && (await hinweise('code_intel', {action: 'file', file_path: 'packages/web-ui/a.ts'}, claude())).length === 0,
    'P10-T90 D pruefeZwangsPin/zwangsPinHinweise: Schalter AUS = keine Sperre, kein Hinweis');
  ok((await Z.quittiereZwangsPinLesen({project, aufrufer: claude(), namen: 'webui-design-standard'})).length === 0,
    'P10-T90 D quittiereZwangsPinLesen: Schalter AUS = keine Quittung');
  await schalter(true);

  // E Sperre ---------------------------------------------------------------------------------------------------
  r = await pruefe(planArgs('packages/web-ui/src/App.tsx'), claude());
  ok(r?.sperre?.success === false && r.sperre.error === 'pflicht_memory_ungelesen' && r.sperre.pflicht_memories?.[0]?.name === 'webui-design-standard'
    && /memory\(action:"read", name:"webui-design-standard"\)/.test(r.sperre.message) && /Tokens und Komponenten/.test(r.sperre.message)
    && r.sperre.zustand_unveraendert === true && r.sperre.zwangs_pin_debug?.geltung?.art === 'claude_cli',
    'P10-T90 E pruefeZwangsPin: files plan unter dem Stamm gesperrt (Name, Kurzfassung, Abruf, Debug-Geltung)', r);
  ok(await pruefe(planArgs('packages/core/src/x.ts'), claude()) === null, 'P10-T90 E ausserhalb des Stamms: kein Eingriff');
  ok(await pruefe({action: 'plan', ops: [{action: 'update', file_path: 'a.md'}], artefakt_id: 'x'}, claude()) === null,
    'P10-T90 E artefakt_id (keine Projektdatei): kein Eingriff');
  r = await pruefe({action: 'move', file_path: 'docs/a.md', new_path: 'packages/web-ui/a.md'}, claude());
  ok(r?.sperre?.error === 'pflicht_memory_ungelesen', 'P10-T90 E move mit Ziel unter dem Stamm: gesperrt', r);

  // F offener Plan bleibt unveraendert (User-Vorgabe 12507835) ----------------------------------------------
  const ops = [{action: 'update', file_path: 'packages/web-ui/src/Alt.tsx', content: 'alt'}];
  const planId = (await pool.query(
    "INSERT INTO file_batch_plans (project, owner_agent_id, ops, expected_hashes, previews, status) VALUES ($1,'claude-x',$2,'{}'::jsonb,'[]'::jsonb,'open') RETURNING id::text AS id",
    [project, JSON.stringify(ops)])).rows[0].id;
  const planVorher = (await pool.query('SELECT status::text, ops, open_for_coedit FROM file_batch_plans WHERE id=$1', [planId])).rows[0];
  r = await pruefe({action: 'commit', plan_id: planId}, claude());
  const planNachher = (await pool.query('SELECT status::text, ops, open_for_coedit FROM file_batch_plans WHERE id=$1', [planId])).rows[0];
  ok(r?.sperre?.error === 'pflicht_memory_ungelesen' && r.sperre.pflicht_memories[0].pfade.includes('packages/web-ui/src/Alt.tsx'),
    'P10-T90 F commit eines vor dem Pin entstandenen Plans: Pfade aus dem Plan erkannt, Aufruf gesperrt', r);
  ok(JSON.stringify(planVorher) === JSON.stringify(planNachher) && planNachher.status === 'open',
    'P10-T90 F Sperre veraendert keinen Zustand: Plan weiter open, Ops unveraendert', {planVorher, planNachher});
  let q = await Z.quittiereZwangsPinLesen({project, aufrufer: claude(), namen: ['webui-design-standard', 'nicht-gepinnt']});
  ok(q.length === 1 && q[0] === 'webui-design-standard', 'P10-T90 F quittiereZwangsPinLesen: nur gepinnte Memory quittiert', q);
  ok(await pruefe({action: 'commit', plan_id: planId}, claude()) === null && await pruefe(planArgs('packages/web-ui/src/App.tsx'), claude()) === null,
    'P10-T90 F nach memory read: commit desselben Plans und neue Plaene gehen durch');

  // G Kontextwechsel, neuer Lauf, Memory geaendert ------------------------------------------------------------
  r = await pruefe(planArgs('packages/web-ui/src/App.tsx'), claude(2));
  ok(r?.sperre?.error === 'pflicht_memory_ungelesen', 'P10-T90 G neuer context_epoch: erneut gesperrt', r);
  r = await pruefe(planArgs('packages/web-ui/src/App.tsx'), claude(1, 'lauf-2'));
  ok(r?.sperre?.error === 'pflicht_memory_ungelesen', 'P10-T90 G neuer Lauf (Neuanmeldung): erneut gesperrt', r);
  await pool.query("UPDATE memories SET content = content || ' Version 2.' WHERE project=$1 AND name='webui-design-standard'", [project]);
  r = await pruefe(planArgs('packages/web-ui/src/App.tsx'), claude());
  ok(r?.sperre?.pflicht_memories?.[0]?.grund === 'geaendert', 'P10-T90 G Memory geaendert: Quittung verfaellt (grund geaendert)', r);
  q = await Z.quittiereZwangsPinLesen({project, aufrufer: claude(), namen: 'webui-design-standard'});
  ok(q.length === 1 && await pruefe(planArgs('packages/web-ui/src/App.tsx'), claude()) === null, 'P10-T90 G erneutes Lesen quittiert die neue Fassung');

  // H Hinweisquelle ----------------------------------------------------------------------------------------------
  const codex = {identity_id: 'id-codex', agent_id: 'codex-x', lauf_id: 'lc', context_epoch: 1, modell: null};
  ok(await pruefe(planArgs('packages/web-ui/src/App.tsx'), codex, 'CLI (Codex)') === null, 'P10-T90 H Codex (Herkunft): keine Sperre');
  let h = await hinweise('files', planArgs('packages/web-ui/src/App.tsx'), codex);
  ok(h.length === 1 && h[0].modus === 'einmal_je_sitzung' && /webui-design-standard/.test(h[0].text) && /Keine Sperre/.test(h[0].text)
    && /\|lc\|1\|schreiben$/.test(h[0].hinweis_id) && h[0].folgeaktion?.tool === 'memory',
    'P10-T90 H zwangsPinHinweise: schreibend ohne Sperre -> Registry-Hinweis (Drossel je Lauf + Epoche, Folgeaktion memory read)', h);
  h = await hinweise('files', planArgs('packages/web-ui/a.ts'), null);
  ok(h.length === 1 && /ohne_ausweis/.test(h[0].text) && /\|legacy\|/.test(h[0].hinweis_id), 'P10-T90 H ohne Ausweis: nur Hinweis', h);
  h = await hinweise('code_intel', {action: 'file', file_path: 'packages/web-ui/src/App.tsx'}, claude(5));
  ok(h.length === 1 && /Reine Suche darf das ignorieren/.test(h[0].text), 'P10-T90 H code_intel file (lesen): Hinweis, keine Sperre', h);
  ok((await hinweise('files', planArgs('packages/core/a.ts'), claude(5))).length === 0, 'P10-T90 H ausserhalb des Stamms: kein Hinweis');

  // I mehrere Pins --------------------------------------------------------------------------------------------
  await memory('regel-web-ui-gestaltung-nur-claude-agenten', 'Web-UI-Gestaltung nur durch Claude-Agenten.');
  r = await admin({modus: 'setzen', pin_stamm: 'packages/web-ui/src/**', pin_memory: 'regel-web-ui-gestaltung-nur-claude-agenten',
    pin_kurzfassung: 'Gestaltung der Web-UI nur durch Claude-Agenten.'});
  ok(r.success === true, 'P10-T90 I zweiter Pin gesetzt', r);
  r = await pruefe(planArgs('packages/web-ui/src/App.tsx'), claude(7));
  ok(r?.sperre?.pflicht_memories?.length === 2 && r.sperre.pflicht_memories[0].name === 'regel-web-ui-gestaltung-nur-claude-agenten'
    && /insgesamt 2 ungelesen/.test(r.sperre.message), 'P10-T90 I zwei ungelesene Pins: spezifischster zuerst, beide genannt', r);

  // L echte Merkmale aus PG (Ausweis-Typ, Lauf mit context_epoch) --------------------------------------------
  const identitaet = async (id, typSchluessel, laufId, epoch) => {
    await pool.query("INSERT INTO agent_identitaeten (id, project, name, agent_id, rolle, erstellt_von) VALUES ($1,$2,$3,$3,'subagent','p10t90')", [id, project, 'a-' + id]);
    await pool.query("INSERT INTO agent_typen (id, scope, project, schluessel, erstellt_von) VALUES ($1,'projekt',$2,$3,'p10t90') ON CONFLICT DO NOTHING", ['typ-' + typSchluessel, project, typSchluessel]);
    await pool.query("INSERT INTO agent_profil_revisionen (identity_id, revision, snapshot, typ_id, typ_revision, wer, grund) VALUES ($1,1,'{}'::jsonb,$2,1,'p10t90','P10-T90 Test')", [id, 'typ-' + typSchluessel]);
    await pool.query("INSERT INTO agent_identitaet_laeufe (id, identity_id, context_epoch, status) VALUES ($1,$2,$3,'aktiv')", [laufId, id, epoch]);
    return {identity_id: id, agent_id: 'a-' + id, lauf_id: laufId, context_epoch: epoch, modell: null};
  };
  const subPg = await identitaet('id-sub-pg', 'claude-subagent', 'lauf-sub-pg', 4);
  r = await Z.pruefeZwangsPin({tool: 'files', action: 'plan', args: planArgs('packages/web-ui/src/App.tsx'), project, aufrufer: subPg, herkunft: null});
  ok(r?.sperre?.error === 'pflicht_memory_ungelesen' && r.sperre.zwangs_pin_debug?.geltung?.art === 'claude_typ'
    && r.sperre.zwangs_pin_debug?.merkmale?.typ === 'claude-subagent' && r.sperre.zwangs_pin_debug?.merkmale?.lauf_epoch === 4,
    'P10-T90 L ermittleZwangsPinMerkmale: Claude-Subagent-Ausweis OHNE Modell/Herkunft (PG: Typ + Lauf) -> Sperre, Kennzeichen im Debug', r);
  // Startort aus PG (agent_identitaeten.start_ort/start_ziel), ohne Typ, ohne Modell, ohne Herkunft im Aufruf.
  await pool.query("INSERT INTO agent_identitaeten (id, project, name, agent_id, rolle, erstellt_von, start_ort, start_ziel, start_ort_quelle) VALUES ('id-cli-pg',$1,'a-cli-pg','a-cli-pg','koordinator','p10t90','extern','CLI (Claude Code)','anmeldung')", [project]);
  await pool.query("INSERT INTO agent_identitaet_laeufe (id, identity_id, context_epoch, status) VALUES ('lauf-cli-pg','id-cli-pg',6,'aktiv')");
  r = await Z.pruefeZwangsPin({tool: 'files', action: 'plan', args: planArgs('packages/web-ui/src/App.tsx'), project,
    aufrufer: {identity_id: 'id-cli-pg', agent_id: 'a-cli-pg', lauf_id: 'lauf-cli-pg', context_epoch: 6, modell: null}, herkunft: null});
  ok(r?.sperre?.zwangs_pin_debug?.geltung?.art === 'claude_cli' && /start_ort:extern\/CLI \(Claude Code\)/.test(r.sperre.zwangs_pin_debug.geltung.quelle)
    && r.sperre.zwangs_pin_debug.merkmale?.start_ziel === 'CLI (Claude Code)',
    'P10-T90 L Startort aus PG (merkeStartOrt bei Anmeldung) extern/CLI (Claude Code) ohne Typ/Modell -> Sperre, Quelle im Debug', r);
  const fremd = {...subPg, lauf_id: 'lauf-gibt-es-nicht'};
  r = await Z.pruefeZwangsPin({tool: 'files', action: 'plan', args: planArgs('packages/web-ui/src/App.tsx'), project, aufrufer: fremd, herkunft: null});
  h = await hinweise('files', planArgs('packages/web-ui/src/App.tsx'), fremd);
  ok(r === null && /kontext_nicht_ueberwacht/.test(h[0]?.text ?? ''), 'P10-T90 L unbekannter Lauf: Kontext nicht ueberwacht, nur Hinweis', {r, h});
  const codexPg = await identitaet('id-codex-pg', 'codex-entwickler', 'lauf-codex-pg', 2);
  r = await Z.pruefeZwangsPin({tool: 'files', action: 'plan', args: planArgs('packages/web-ui/src/App.tsx'), project, aufrufer: codexPg, herkunft: null});
  h = await hinweise('files', planArgs('packages/web-ui/src/App.tsx'), codexPg);
  ok(r === null && /\(codex\)/.test(h[0]?.text ?? ''), 'P10-T90 L Codex-Ausweis (Typ codex-entwickler, PG): nur Hinweis', {r, h});
  r = await Z.pruefeZwangsPin({tool: 'files', action: 'plan', args: planArgs('packages/web-ui/src/App.tsx'), project,
    aufrufer: {identity_id: 'id-extern', agent_id: 'extern', lauf_id: 'x', context_epoch: 1, modell: null}, herkunft: 'CLI/stdio'});
  ok(r === null, 'P10-T90 L extern/unbekannt (keine Identitaet in PG): keine Sperre', r);

  // M Schutz der Pflicht-Tags (Entscheidung team-lead: nur User/Koordinator) --------------------------------
  const als = (rolle, id, f) => core.mitAgentAufrufKontext({bezug: BEZUG, principal: {art: 'identity', project, agent_id: 'a-' + id, identity_id: id,
    rolle, modell: null, context_epoch: 1, lauf_id: 'l-' + id}}, f);
  const schutz = (args, legacyAgent = null) => Z.pruefePflichtTagSchutz({tool: 'memory', action: args.action, args, project, legacyAgent});
  const alleTags = await tags('webui-design-standard');
  await memory('frei-memory', 'Ohne Pin.');
  r = await als('subagent', 'id-sub-pg', () => schutz({action: 'update', name: 'webui-design-standard', tags: alleTags.filter(t => !t.startsWith('pflicht'))}));
  ok(r?.success === false && r.error === 'pflicht_tags_nur_koordinator' && r.memories?.includes('webui-design-standard'),
    'P10-T90 M zwangs-pin.ts pruefePflichtTagSchutz: Subagent entfernt Pflicht-Tags per memory update -> Fachfehler', r);
  ok(await als('subagent', 'id-sub-pg', () => schutz({action: 'update', name: 'webui-design-standard', content: 'neu'})) === null
    && await als('subagent', 'id-sub-pg', () => schutz({action: 'update', name: 'webui-design-standard', tags: [...alleTags, 'zusatz']})) === null,
    'P10-T90 M Subagent: Inhalt aendern bzw. Tags ohne Pflicht-Aenderung bleibt erlaubt');
  r = await als('subagent', 'id-sub-pg', () => schutz({action: 'write', name: 'webui-design-standard', content: 'ueberschrieben'}));
  ok(r?.error === 'pflicht_tags_nur_koordinator', 'P10-T90 M Subagent: write (Upsert ohne tags) auf gepinnte Memory wuerde Pflicht-Tags entfernen -> Fachfehler', r);
  r = await als('subagent', 'id-sub-pg', () => schutz({action: 'write', items: [{name: 'frei-memory', content: 'x', tags: ['pflicht:docs/**']}]}));
  ok(r?.error === 'pflicht_tags_nur_koordinator', 'P10-T90 M Subagent: Pflicht-Tag per write items[] setzen -> Fachfehler', r);
  r = await als('subagent', 'id-sub-pg', () => schutz({action: 'delete', name: ['frei-memory', 'webui-design-standard']}));
  ok(r?.error === 'pflicht_tags_nur_koordinator' && r.memories.length === 1 && await als('subagent', 'id-sub-pg', () => schutz({action: 'delete', name: 'frei-memory'})) === null,
    'P10-T90 M Subagent: gepinnte Memory loeschen -> Fachfehler, ungepinnte loeschen erlaubt', r);
  ok(await als('koordinator', 'id-cli-pg', () => schutz({action: 'update', name: 'webui-design-standard', tags: []})) === null
    && await schutz({action: 'delete', name: 'webui-design-standard'}, 'koordinator') === null
    && (await schutz({action: 'delete', name: 'webui-design-standard'}, 'legacy-web'))?.error === 'pflicht_tags_nur_koordinator',
    'P10-T90 M Koordinator (Ausweis, PG-Rolle) und Legacy-Koordinator duerfen; Legacy-Nicht-Koordinator nicht');
  ok((await schutz({action: 'update', name: 'webui-design-standard', tags: []}))?.error === 'pflicht_tags_nur_koordinator',
    'P10-T90 M ohne Akteur (kein Ausweis, kein Agent): Fachfehler');
  ok(await als('subagent', 'id-sub-pg', () => Z.pruefePflichtTagSchutz({tool: 'memory', action: 'read', args: {name: 'webui-design-standard'}, project})) === null
    && await als('subagent', 'id-sub-pg', () => Z.pruefePflichtTagSchutz({tool: 'thought', action: 'add', args: {}, project})) === null,
    'P10-T90 M lesende Aktionen und andere Tools unberuehrt');

  // J mitAgentToolAufruf (Legacy, ohne Ausweis) ---------------------------------------------------------------
  let laeuft = 0;
  const ergebnis = await core.mitAgentToolAufruf('files', {action: 'plan', project, agent_id: 'legacy-web', ops: [{action: 'update', file_path: 'packages/web-ui/b.ts', content: 'x'}]},
    'p10t90-srv', async k => { laeuft++; return k.antwort ?? {success: true, plan_id: 'x'}; }, undefined, undefined, {herkunft: 'chatgpt.com'});
  ok(laeuft === 1 && ergebnis.success === true, 'P10-T90 J agent-token-tools.ts mitAgentToolAufruf: ohne Ausweis keine Sperre, Handler laeuft', ergebnis);
  ok(Z.zwangsPinAntwortErfolgreich({content: [{type: 'text', text: '{"success":true}'}]}) && !Z.zwangsPinAntwortErfolgreich({isError: true, content: []})
    && !Z.zwangsPinAntwortErfolgreich({content: [{type: 'text', text: '{"success":false}'}]}),
    'P10-T90 J zwangsPinAntwortErfolgreich: Fehlerantworten quittieren nicht');

  // K status / entfernen ---------------------------------------------------------------------------------------
  r = await admin({modus: 'status'});
  ok(r.success && r.pins.length === 2 && r.pins.every(p => p.quelle === 'memory_tag') && r.quittungen.some(x => x.memory_name === 'webui-design-standard' && x.aktuell === true)
    && r.letzte_sperren.length >= 5 && r.schalter.aktiv === true, 'P10-T90 K status: Pins aus Memory-Tags, Quittungen je Lauf/Epoche, letzte Sperren, Schalter', r);
  r = await admin({modus: 'status'}, sub);
  ok(r.success === false && r.error === 'recht_fehlt', 'P10-T90 K status: Subagent ohne Recht', r);
  r = await admin({modus: 'entfernen', pin_stamm: 'packages/web-ui/src/**', pin_memory: 'regel-web-ui-gestaltung-nur-claude-agenten'});
  const t2 = await tags('regel-web-ui-gestaltung-nur-claude-agenten');
  ok(r.success === true && (await admin({modus: 'status'})).pins.length === 1 && !t2.some(t => t.startsWith('pflicht')),
    'P10-T90 K entfernen: Pin-Tag und Kurzfassung-Tag weg', {r, t2});
  r = await admin({modus: 'entfernen', pin_stamm: 'packages/web-ui/src/**', pin_memory: 'regel-web-ui-gestaltung-nur-claude-agenten'});
  ok(r.success === false && r.error === 'pin_unbekannt', 'P10-T90 K entfernen: unbekannter Pin', r);
  console.log('TEST EXIT 0 - ' + pass + ' PASS');
} finally {
  if (pool) {
    await pool.query('DELETE FROM public.agent_profil_schalter WHERE project=$1', [project]).catch(() => undefined);
    await pool.query('DROP SCHEMA IF EXISTS "' + schema + '" CASCADE').catch(e => console.error('Aufraeumen: ' + e));
    await pool.end().catch(() => undefined);
  }
  process.exit(process.exitCode ?? 0);
}
