/**
 * P22-T236: Projekt-Assets 'Index = Wirklichkeit' (User-Grundsatz 31.10.2026, thought 4d6e67d6; SVG = Code, thought 5eae0647).
 *   'Was asset_intel/Suche als vorhandenes Projekt-Asset zeigt, existiert und laesst sich oeffnen; was geloescht ist,
 *    verschwindet samt Index-Eintrag und Metadaten aus allen Abfragen.'
 * GEPRUEFT:
 *   A core services/intel-bereich.ts assetBereichSql/projektAssetSql: nurVorhandene filtert asset_files/objects/references,
 *     quotiertes "asset_files" bleibt, AUS = SQL unveraendert, Reverse unveraendert.
 *   B core services/asset-ansicht.ts projektAnsichtAdapter.aufloesen: ehrliche Codes asset_geloescht | asset_quelle_fehlt |
 *     asset_nur_lokal (Befund: legacy_local meldete 'geloescht'). Fake-DB, kein PG.
 *   C file-watcher-daemon-ts asset-sync.ts DaemonAssetSync.meldeQuelleFehlt: Route quelle-fehlt, Ruhe nach funktion_aus/404.
 *   D (nur DATABASE_URL = synapse_test) asset-intel-abfragen.ts holeAssetBaum/sucheAssets/assetHealth mit Schalter
 *     asset_index_wirklichkeit AUS/EIN (eigenes Testprojekt, aufgeraeumt), asset-altbestand.ts meldeAssetQuellenFehlen +
 *     pruefeAssetAltbestand (Vorschau/ausfuehren, text_doppelt nur fuer Text), Schalter-Katalog.
 * AUFRUF: mise run build:core && pnpm --filter @synapse/file-watcher-daemon-ts run build &&
 *   node packages/core/tests/asset-index-wirklichkeit-p22-t236.test.mjs
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.SYNAPSE_W1B_GATE_TTL_MS = '0'; // Produkt-Schalter ohne Prozess-Puffer (Teil D)
const here = dirname(fileURLToPath(import.meta.url));
const B = await import(resolve(here, '../dist/services/intel-bereich.js'));
const { projektAnsichtAdapter } = await import(resolve(here, '../dist/services/asset-ansicht.js'));
const { ladeAssetKonfiguration } = await import(resolve(here, '../dist/config/asset-konfig.js'));

let fehler = 0, ok = 0;
function check(herkunft, bedingung, debug) {
  if (bedingung) { ok++; console.log('PASS ' + herkunft); return; }
  fehler++;
  console.log('FAIL ' + herkunft + (debug === undefined ? '' : ' | tatsaechlich: ' + JSON.stringify(debug).slice(0, 400)));
}
async function wirft(fn) { try { await fn(); return null; } catch (e) { return e; } }

// ------------------------------------------------------------------ A Sicht nur vorhandener Assets (intel-bereich.ts)
{
  const sql = 'SELECT a.id FROM asset_files a JOIN asset_objects o ON o.asset_id = a.id WHERE a.project = $1';
  check('P22-T236 A intel-bereich.ts assetBereichSql: ohne nurVorhandene bleibt Projekt-SQL bytegleich', B.assetBereichSql(sql) === sql);
  const neu = B.projektAssetSql(sql, true);
  check("P22-T236 A intel-bereich.ts projektAssetSql: asset_files gefiltert (deleted_at, quelle_nicht_gefunden)",
    /FROM \(SELECT \* FROM asset_files WHERE deleted_at IS NULL AND status IS DISTINCT FROM 'quelle_nicht_gefunden'\) a/.test(neu), neu);
  check('P22-T236 A intel-bereich.ts projektAssetSql: asset_objects folgt der Datei', /asset_objects o WHERE EXISTS \(SELECT 1 FROM asset_files f WHERE f\.id = o\.asset_id AND f\.deleted_at IS NULL AND f\.status/.test(neu), neu);
  const roh = 'SELECT count(*) FROM "asset_files" WHERE project = $1';
  check('P22-T236 A intel-bereich.ts: quotiertes "asset_files" (health-Zaehler) bleibt unveraendert', B.projektAssetSql(roh, true) === roh);
  check('P22-T236 A intel-bereich.ts: code_files bleibt unveraendert', B.projektAssetSql('SELECT 1 FROM code_files', true) === 'SELECT 1 FROM code_files');
  check('P22-T236 A intel-bereich.ts: Reverse-Bereich unveraendert gegenueber nurVorhandene', B.assetBereichSql(sql, B.REVERSE_ASSET_BEREICH, { nurVorhandene: true }) === B.assetBereichSql(sql, B.REVERSE_ASSET_BEREICH));
}

// ------------------------------------------------------------------ B ehrliche Ansicht (asset-ansicht.ts)
{
  const cfg = ladeAssetKonfiguration({});
  const adapter = (zeile) => projektAnsichtAdapter({
    db: { async query(sql) { return { rows: /JOIN asset_revisionen/.test(sql) ? [] : (zeile ? [zeile] : []) }; } },
    speicher: {}, retention: {}, konfiguration: cfg,
  });
  const ref = { bereich: 'projekt', ziel_ref: 'p22t236', id: '7' };
  let e = await wirft(() => adapter({ deleted_at: new Date(), status: 'ok', storage_status: 'ready', storage_key: 'k' }).aufloesen(ref));
  check('P22-T236 B asset-ansicht.ts: deleted_at -> asset_geloescht', e?.code === 'asset_geloescht', e?.code);
  e = await wirft(() => adapter({ deleted_at: null, status: 'nicht_erkannt', storage_status: 'legacy_local', storage_key: null, format: null, extension: 'avif' }).aufloesen(ref));
  // Befund thought 4d6e67d6: bildtest.avif lag auf der Platte, die Ansicht meldete 'geloescht'.
  check('P22-T236 B asset-ansicht.ts: legacy_local ohne storage_key -> asset_nur_lokal (NICHT geloescht), Format im Grund',
    e?.code === 'asset_nur_lokal' && /NICHT gelöscht/.test(e.message) && /avif/.test(e.message), { code: e?.code, msg: e?.message });
  e = await wirft(() => adapter({ deleted_at: null, status: 'quelle_nicht_gefunden', storage_status: 'legacy_local', storage_key: null }).aufloesen(ref));
  check('P22-T236 B asset-ansicht.ts: quelle_nicht_gefunden -> asset_quelle_fehlt', e?.code === 'asset_quelle_fehlt', e?.code);
  e = await wirft(() => adapter(null).aufloesen(ref));
  check('P22-T236 B asset-ansicht.ts: keine Zeile -> ansicht_quelle_fehlt', e?.code === 'ansicht_quelle_fehlt', e?.code);
}

// ------------------------------------------------------------------ C Daemon-Meldung (asset-sync.ts)
{
  const { DaemonAssetSync } = await import(resolve(here, '../../file-watcher-daemon-ts/dist/asset-sync.js'));
  const aufrufe = [];
  let antwort = { success: true, markiert: 1 };
  const api = { async json(pfad, body, methode) { aufrufe.push({ pfad, body, methode }); return antwort; } };
  const sync = new DaemonAssetSync(() => ({ projekte: [] }), api);
  await sync.meldeQuelleFehlt('p22t236', ['bilder/weg.avif']);
  check('P22-T236 C asset-sync.ts meldeQuelleFehlt: POST /api/projects/<p>/assets/quelle-fehlt mit pfade',
    aufrufe.length === 1 && aufrufe[0].pfad === '/api/projects/p22t236/assets/quelle-fehlt' && aufrufe[0].methode === 'POST' && aufrufe[0].body.pfade[0] === 'bilder/weg.avif', aufrufe);
  antwort = { success: false, error: { code: 'funktion_aus' } };
  await sync.meldeQuelleFehlt('p22t236', ['a.bin']);
  await sync.meldeQuelleFehlt('p22t236', ['b.bin']);
  check('P22-T236 C asset-sync.ts meldeQuelleFehlt: nach funktion_aus Ruhe (kein weiterer Aufruf)', aufrufe.length === 2, aufrufe.length);
  await sync.meldeQuelleFehlt('anderes', []);
  check('P22-T236 C asset-sync.ts meldeQuelleFehlt: leere Liste ruft nicht', aufrufe.length === 2, aufrufe.length);
}

// ------------------------------------------------------------------ E weitere Lesewege (Nachtrag Koordinator 31.10.: alle Lesewege, Task-Punkt d)
{
  // rest-api services/verweise.ts loeseAssetVerweis: mit Schalter nur vorhandene Assets (Sicht-SQL), ohne Schalter bytegleich.
  const { loeseAssetVerweis } = await import(resolve(here, '../../rest-api/dist/services/verweise.js'));
  const gesehen = [];
  const dienste = (nur) => ({ frage: async (sql) => { gesehen.push(sql); return []; }, wurzeln: async () => [], nurVorhandene: async () => nur });
  await loeseAssetVerweis('p22t236', 'bilder/a.png', dienste(true));
  await loeseAssetVerweis('p22t236', 'bilder/a.png', dienste(false));
  check("P22-T236 E verweise.ts loeseAssetVerweis: Schalter EIN -> Sicht ohne quelle_nicht_gefunden", /status IS DISTINCT FROM 'quelle_nicht_gefunden'/.test(gesehen[0] ?? ''), gesehen[0]);
  check('P22-T236 E verweise.ts loeseAssetVerweis: Schalter AUS -> bisheriges SQL', !/IS DISTINCT FROM/.test(gesehen[1] ?? ''), gesehen[1]);
  // core services/asset-altbestand.ts ausgeblendeteAssetPfade (Filter der Medien-Suche code.ts searchMedia): leere Liste ohne DB.
  const ALT = await import(resolve(here, '../dist/services/asset-altbestand.js'));
  check('P22-T236 E asset-altbestand.ts ausgeblendeteAssetPfade: leere Liste -> leere Menge', (await ALT.ausgeblendeteAssetPfade('p22t236', [])).size === 0);
  // thought 5eae0647: SVG/Text ist Code, nie Asset; Binaer- und Asset-Endungen nie Text (Upload-Sperre asset-upload.ts, Altbestand text_doppelt).
  check('P22-T236 E asset-altbestand.ts istTextFormatPfad: svg/lock/txt -> Text',
    await ALT.istTextFormatPfad('docs/bilder/a.svg') && await ALT.istTextFormatPfad('pnpm.lock') && await ALT.istTextFormatPfad('notiz.txt'));
  check('P22-T236 E asset-altbestand.ts istTextFormatPfad: png/avif/gltf/woff2 -> kein Text',
    !(await ALT.istTextFormatPfad('a.png')) && !(await ALT.istTextFormatPfad('a.avif')) && !(await ALT.istTextFormatPfad('m.gltf')) && !(await ALT.istTextFormatPfad('f.woff2')));
}

// ------------------------------------------------------------------ D Datenbank (nur synapse_test)
const url = process.env.DATABASE_URL ?? '';
if (!url || !/synapse_test/.test(url)) {
  console.log('# D DB-Teil uebersprungen: DATABASE_URL fehlt oder ist nicht synapse_test (regel-tests-nur-testdatenbank)');
} else {
  const S = await import(resolve(here, '../dist/services/agent-profil-schalter.js'));
  const A = await import(resolve(here, '../dist/services/asset-intel-abfragen.js'));
  const ALT = await import(resolve(here, '../dist/services/asset-altbestand.js'));
  const { getPool } = await import(resolve(here, '../dist/db/client.js'));
  const pool = getPool();
  const P = 'p22-t236-' + Date.now().toString(36);
  const zeile = (pfad, extra) => pool.query(
    "INSERT INTO asset_files(project,file_path,file_name,extension,asset_type,format,status,deleted_at) VALUES($1,$2,$3,$4,'image','png',$5,$6)",
    [P, pfad, pfad.split('/').pop(), pfad.split('.').pop(), extra.status ?? 'ok', extra.deleted_at ?? null]);
  const schalter = (aktiv) => S.setzeProfilProduktSchalter({ ebene: 'projekt', project: P, funktion: 'asset_index_wirklichkeit', aktiv, grund: 'P22-T236 Test' }, { system: 'user' });
  try {
    check('P22-T236 D agent-profil-schalter.ts: asset_index_wirklichkeit im Katalog, nur ausdruecklich, Standard AUS',
      S.PROFIL_PRODUKT_FUNKTIONEN.includes('asset_index_wirklichkeit') && S.NUR_AUSDRUECKLICH.includes('asset_index_wirklichkeit') && !S.STANDARD_EIN.includes('asset_index_wirklichkeit'));
    await zeile('bilder/da.png', {});
    await zeile('bilder/geloescht.png', { deleted_at: new Date() });
    await zeile('coedit-test/t51-golden-x/weg.png', { status: 'quelle_nicht_gefunden' });
    await pool.query("INSERT INTO asset_files(project,file_path,file_name,extension,status) VALUES($1,'icons/logo.svg','logo.svg','svg','nicht_erkannt')", [P]);
    await pool.query("INSERT INTO code_files(id,project,file_path,file_name,file_type,content) VALUES(gen_random_uuid(),$1,'icons/logo.svg','logo.svg','svg','<svg/>') ON CONFLICT DO NOTHING", [P]).catch((e) => console.log('# code_files-Insert: ' + e.message));
    const pfade = (t) => t.baum ?? JSON.stringify(t);
    let baum = await A.holeAssetBaum(P, {});
    check('P22-T236 D holeAssetBaum: Schalter AUS = Altverhalten (alle Zeilen sichtbar)', /geloescht\.png/.test(pfade(baum)) && /weg\.png/.test(pfade(baum)), pfade(baum));
    await schalter(true);
    baum = await A.holeAssetBaum(P, {});
    check('P22-T236 D holeAssetBaum: Schalter EIN -> nur vorhandene (da.png ja, geloescht/weg nein)',
      /da\.png/.test(pfade(baum)) && !/geloescht\.png/.test(pfade(baum)) && !/weg\.png/.test(pfade(baum)), pfade(baum));
    const such = await A.sucheAssets(P, { query: 'png' });
    check('P22-T236 D sucheAssets: Schalter EIN -> keine geloeschten/fehlenden Treffer', such.treffer.every((t) => !/geloescht|weg/.test(t.file_path)), such.treffer);
    const h = await A.assetHealth(P);
    check('P22-T236 D assetHealth: ausgeblendet zaehlt quelle_fehlt=1, im_wiederherstellungsfenster=1',
      h.ausgeblendet?.quelle_fehlt === 1 && h.ausgeblendet?.im_wiederherstellungsfenster === 1, h.ausgeblendet);
    const v = await ALT.pruefeAssetAltbestand({ project: P });
    check('P22-T236 D asset-altbestand.ts Vorschau: quelle_fehlt 1 (+ text_doppelt fuer SVG, falls code_files-Zeile), nichts entfernt',
      v.success === true && v.modus === 'vorschau' && v.je_art.quelle_fehlt === 1 && v.entfernt === 0, v);
    const x = await ALT.pruefeAssetAltbestand({ project: P, ausfuehren: true });
    const rest = (await pool.query('SELECT file_path FROM asset_files WHERE project=$1 ORDER BY 1', [P])).rows.map((r) => r.file_path);
    check('P22-T236 D asset-altbestand.ts ausfuehren: weg.png entfernt, da.png und geloescht.png (Share-Fenster) bleiben',
      x.success === true && !rest.includes('coedit-test/t51-golden-x/weg.png') && rest.includes('bilder/da.png') && rest.includes('bilder/geloescht.png'), { x, rest });
    const m = await ALT.meldeAssetQuellenFehlen(P, ['bilder/da.png', '../boese']);
    check('P22-T236 D meldeAssetQuellenFehlen: markiert legacy-Zeile, ungueltiger Pfad gezaehlt', m.success === true && m.markiert === 1 && m.ungueltig === 1, m);
    await schalter(false);
    const aus = await ALT.meldeAssetQuellenFehlen(P, ['bilder/da.png']);
    check('P22-T236 D meldeAssetQuellenFehlen: Schalter AUS -> funktion_aus', aus.success === false && aus.error?.code === 'funktion_aus', aus);
    const xa = await ALT.pruefeAssetAltbestand({ project: P, ausfuehren: true });
    check('P22-T236 D pruefeAssetAltbestand: ausfuehren bei Schalter AUS -> funktion_aus', xa.success === false && xa.error === 'funktion_aus', xa);
  } finally {
    await pool.query('DELETE FROM asset_files WHERE project=$1', [P]).catch(() => undefined);
    await pool.query('DELETE FROM code_files WHERE project=$1', [P]).catch(() => undefined);
    await pool.query("DELETE FROM agent_profil_schalter WHERE ebene='projekt' AND project=$1", [P]).catch(() => undefined);
  }
}

console.log(`\nP22-T236: ${ok} PASS, ${fehler} FAIL`);
process.exit(fehler ? 1 : 0);
