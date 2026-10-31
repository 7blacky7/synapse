/**
 * P22-T238: Asset-Transfer vom Inspector-Katalog entkoppeln (User 31.10.2026 ~17:30, thoughts 4d6e67d6, 54ff9ce7, 5eae0647).
 *   'Ob eine Datei als Projekt-Asset in den Share darf, haengt NICHT davon ab, ob Synapse sie schon inhaltlich versteht.'
 *   'SVG sind ja auch Code-Dateien.' -> Textformate nie als generisches Asset.
 * GEPRUEFT:
 *   A core config/asset-konfig.ts: ladeAssetKonfiguration transferAlle, loeseAssetProjektoptionen alleTypen/erlaubteTypen
 *     (generische Namen, Betreiberliste), gueltigerAssetFormatName, generischesTransferFormat, assetFormatFreigegeben.
 *   B core config/asset-konfig.ts ermittleTransferFormat: Inspector vor generisch, generisch nur fuer Binaerinhalt (AVIF ja, SVG/Text nie).
 *   C core services/asset-upload.ts AssetUploadKern.erstellen: Formatgate mit Schalter (AUS = Altverhalten format_verboten,
 *     EIN = avif angenommen, svg/Projektliste weiter abgewiesen). Fake-DB, kein PG.
 *   D file-watcher-daemon-ts asset-erkennung.ts pruefeLokalesAsset: generisch aus/ein, erlaubteTypen, SVG bleibt Code.
 *   E core services/asset-transfer-generisch.ts leseAssetTransferGenerisch + agent-profil-schalter.ts Katalog (nur ausdruecklich)
 *     + intern-schalter.ts; Produkt-Schalter projekt EIN/AUS gegen synapse_test (nur wenn DATABASE_URL gesetzt; eigene Projektzeile, aufgeraeumt).
 * AUFRUF: mise run build:core && pnpm --filter @synapse/file-watcher-daemon-ts run build &&
 *   node packages/core/tests/asset-transfer-generisch-p22-t238.test.mjs   (DATABASE_URL nur synapse_test)
 */
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

process.env.SYNAPSE_W1B_GATE_TTL_MS = '0'; // Produkt-Schalter ohne Prozess-Puffer lesen (Teil E)
const here = dirname(fileURLToPath(import.meta.url));
const K = await import(resolve(here, '../dist/config/asset-konfig.js'));
const { AssetUploadKern } = await import(resolve(here, '../dist/services/asset-upload.js'));
const { pruefeLokalesAsset } = await import(resolve(here, '../../file-watcher-daemon-ts/dist/asset-erkennung.js'));

let fehler = 0, ok = 0;
function check(herkunft, bedingung, debug) {
  if (bedingung) { ok++; console.log('PASS ' + herkunft); return; }
  fehler++;
  console.log('FAIL ' + herkunft + (debug === undefined ? '' : ' | tatsaechlich: ' + JSON.stringify(debug).slice(0, 400)));
}
async function wirft(fn) { try { await fn(); return null; } catch (e) { return e; } }

// Testdaten: AVIF-Kopf (ISO-BMFF ftyp avif, kein Inspector), PNG-Magic (Inspector textur), SVG-Text, Woff2-Kopf.
const AVIF = Buffer.concat([Buffer.from([0, 0, 0, 0x1c]), Buffer.from('ftypavif'), Buffer.alloc(20)]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>\n');
const WOFF2 = Buffer.concat([Buffer.from('wOF2'), Buffer.from([0, 1, 0, 0]), Buffer.alloc(40)]);

// ------------------------------------------------------------------ A Konfiguration (asset-konfig.ts)
{
  const c = K.ladeAssetKonfiguration({});
  check('P22-T238 A asset-konfig.ts ladeAssetKonfiguration: ohne SYNAPSE_ASSET_TRANSFER_FORMATS transferAlle=true', c.speicher.transferAlle === true, c.speicher.transferAlle);
  check('P22-T238 A asset-konfig.ts: transferFormate bleibt der Inspector-Katalog (bekannte Formate)', !c.speicher.transferFormate.includes('avif'), c.speicher.transferFormate);
  const w = K.loeseAssetProjektoptionen(c, {});
  check('P22-T238 A loeseAssetProjektoptionen: ohne Projektliste alleTypen=true', w.alleTypen === true, w);
  const p = K.loeseAssetProjektoptionen(c, { erlaubteTypen: ['AVIF', 'png'] });
  check('P22-T238 A loeseAssetProjektoptionen: generischer Name avif in Projektliste erlaubt, normalisiert, alleTypen=false',
    p.alleTypen === false && JSON.stringify(p.erlaubteTypen) === '["avif","png"]', p);
  const e1 = await wirft(() => K.loeseAssetProjektoptionen(c, { erlaubteTypen: ['a b'] }));
  check('P22-T238 A loeseAssetProjektoptionen: ungueltiger Formatname -> Fehler', /ungueltige Formatnamen: a b/.test(String(e1?.message)), e1?.message);
  const r = K.ladeAssetKonfiguration({ SYNAPSE_ASSET_TRANSFER_FORMATS: 'png,BMP' });
  check('P22-T238 A ladeAssetKonfiguration: Betreiberliste darf Formate ohne Inspector nennen (bmp), transferAlle=false',
    r.speicher.transferAlle === false && JSON.stringify(r.speicher.transferFormate) === '["bmp","png"]', r.speicher);
  const e2 = await wirft(() => K.loeseAssetProjektoptionen(r, { erlaubteTypen: ['avif'] }));
  check('P22-T238 A loeseAssetProjektoptionen: mit Betreiberliste bleibt Projektliste Teilmenge (avif -> Fehler)', /nicht registrierte Formate: avif/.test(String(e2?.message)), e2?.message);
  check('P22-T238 A loeseAssetProjektoptionen: mit Betreiberliste alleTypen=false', K.loeseAssetProjektoptionen(r, {}).alleTypen === false);
  const e3 = await wirft(() => K.ladeAssetKonfiguration({ SYNAPSE_ASSET_TRANSFER_FORMATS: 'png,../x' }));
  check('P22-T238 A ladeAssetKonfiguration: ungueltiger Name in Betreiberliste -> Fehler mit Env-Namen', /SYNAPSE_ASSET_TRANSFER_FORMATS.*ungueltige Formatnamen/.test(String(e3?.message)), e3?.message);
  check('P22-T238 A generischesTransferFormat: Endung klein (bild.AVIF -> avif)', K.generischesTransferFormat('a/bild.AVIF') === 'avif', K.generischesTransferFormat('a/bild.AVIF'));
  check('P22-T238 A generischesTransferFormat: ohne Endung -> binaer', K.generischesTransferFormat('bin/werkzeug') === 'binaer', K.generischesTransferFormat('bin/werkzeug'));
  check('P22-T238 A assetFormatFreigegeben: alleTypen / Liste / leer', K.assetFormatFreigegeben({ alleTypen: true, erlaubteTypen: [] }, 'avif')
    && !K.assetFormatFreigegeben({ alleTypen: false, erlaubteTypen: ['png'] }, 'avif') && !K.assetFormatFreigegeben({ alleTypen: true, erlaubteTypen: [] }, null));
}

// ------------------------------------------------------------------ B ermittleTransferFormat (asset-konfig.ts)
{
  check('P22-T238 B ermittleTransferFormat: AVIF ohne Schalter -> null (Altverhalten)', K.ermittleTransferFormat('x/bild.avif', AVIF, false) === null);
  const a = K.ermittleTransferFormat('x/bild.avif', AVIF, true);
  check('P22-T238 B ermittleTransferFormat: AVIF mit Schalter -> avif via generisch', a?.format === 'avif' && a?.via === 'generisch', a);
  const w = K.ermittleTransferFormat('fonts/a.woff2', WOFF2, true);
  check('P22-T238 B ermittleTransferFormat: woff2 mit Schalter -> woff2 via generisch', w?.format === 'woff2' && w?.via === 'generisch', w);
  const p = K.ermittleTransferFormat('x/bild.png', PNG, true);
  check('P22-T238 B ermittleTransferFormat: PNG bleibt Inspector-Format (via inspektor)', p?.format === 'png' && p?.via === 'inspektor', p);
  // thought 5eae0647: SVG ist Code -> nie ein generisches Asset, auch mit Schalter.
  check('P22-T238 B ermittleTransferFormat: SVG (Text) mit Schalter -> null', K.ermittleTransferFormat('icons/a.svg', SVG, true) === null);
  check('P22-T238 B ermittleTransferFormat: .lock/.txt (Text) mit Schalter -> null',
    K.ermittleTransferFormat('pnpm.lock', Buffer.from('lockfileVersion: 9\n'), true) === null && K.ermittleTransferFormat('a.txt', Buffer.from('hallo\n'), true) === null);
}

// ------------------------------------------------------------------ C AssetUploadKern.erstellen (asset-upload.ts)
{
  const cfg = K.ladeAssetKonfiguration({ SYNAPSE_ASSET_ENABLED: '1', SYNAPSE_PROJEKTE_ROOT: '/srv/p22-t238-unbenutzt' });
  // Fake-DB: keine Projektoptionen; erreicht der Upload die Transaktion, ist das Formatgate bestanden (Marker).
  const db = (optionen) => ({
    async query(sql) { if (/asset_projekt_optionen/.test(sql)) return { rows: optionen ? [optionen] : [] }; return { rows: [] }; },
    async connect() { throw new Error('TX_ERREICHT'); },
  });
  const kern = (generisch, optionen) => new AssetUploadKern({ db: db(optionen), konfiguration: cfg, speicher: {}, transferGenerisch: async () => generisch });
  const ctx = { bereich: 'projekt', ziel_ref: 'p22t238', host_id: 'h1' };
  const eingang = (pfad, format) => ({ logischer_pfad: pfad, storage_kind: 'assets', groesse: 10, sha256: 'a'.repeat(64), basis_revision: '0',
    idempotency_key: 'k-' + pfad, ...(format ? { format } : {}) });
  let e = await wirft(() => kern(false).erstellen(ctx, eingang('bilder/bildtest.avif', 'avif')));
  check('P22-T238 C asset-upload.ts erstellen: Schalter AUS -> avif format_verboten mit Schalter-Hinweis',
    e?.code === 'format_verboten' && /asset_transfer_generisch/.test(e.message), { code: e?.code, msg: e?.message });
  e = await wirft(() => kern(true).erstellen(ctx, eingang('bilder/bildtest.avif', 'avif')));
  check('P22-T238 C asset-upload.ts erstellen: Schalter EIN -> avif passiert das Formatgate', e?.message === 'TX_ERREICHT', { code: e?.code, msg: e?.message });
  e = await wirft(() => kern(true).erstellen(ctx, eingang('bilder/bildtest.avif')));
  check('P22-T238 C asset-upload.ts erstellen: Schalter EIN ohne Clientformat -> generisch aus Endung', e?.message === 'TX_ERREICHT', { code: e?.code, msg: e?.message });
  e = await wirft(() => kern(true, { erlaubte_typen: ['png'] }).erstellen(ctx, eingang('bilder/bildtest.avif', 'avif')));
  check('P22-T238 C asset-upload.ts erstellen: Projektliste [png] schraenkt auch generisch ein', e?.code === 'format_verboten', { code: e?.code, msg: e?.message });
  e = await wirft(() => kern(false).erstellen(ctx, eingang('bilder/a.png', 'png')));
  check('P22-T238 C asset-upload.ts erstellen: Inspector-Format png auch bei Schalter AUS (Altverhalten)', e?.message === 'TX_ERREICHT', { code: e?.code, msg: e?.message });
  e = await wirft(() => kern(true).erstellen(ctx, eingang('bilder/a.avif', 'A V')));
  check('P22-T238 C asset-upload.ts erstellen: ungueltiger Clientformatname -> format_verboten', e?.code === 'format_verboten', { code: e?.code, msg: e?.message });
}

// ------------------------------------------------------------------ D Daemon pruefeLokalesAsset (asset-erkennung.ts)
{
  const root = await mkdtemp(join(tmpdir(), 'p22-t238-'));
  try {
    await writeFile(join(root, 'bildtest.avif'), AVIF);
    await writeFile(join(root, 'icon.svg'), SVG);
    await writeFile(join(root, 'a.png'), PNG);
    const o = { maxDateiBytes: 1_000_000 };
    check('P22-T238 D asset-erkennung.ts: avif ohne generisch -> null (Altverhalten)', await pruefeLokalesAsset(root, 'p22t238', 'bildtest.avif', o) === null);
    const a = await pruefeLokalesAsset(root, 'p22t238', 'bildtest.avif', { ...o, generisch: true });
    check('P22-T238 D asset-erkennung.ts: avif mit generisch -> format avif, via generisch', a?.format === 'avif' && a?.via === 'generisch' && a?.groesse === AVIF.length, a);
    check('P22-T238 D asset-erkennung.ts: svg mit generisch -> null (SVG ist Code, thought 5eae0647)', await pruefeLokalesAsset(root, 'p22t238', 'icon.svg', { ...o, generisch: true }) === null);
    check('P22-T238 D asset-erkennung.ts: erlaubteTypen [png] blockt generisches avif',
      await pruefeLokalesAsset(root, 'p22t238', 'bildtest.avif', { ...o, generisch: true, erlaubteTypen: ['png'] }) === null);
    const p = await pruefeLokalesAsset(root, 'p22t238', 'a.png', o);
    check('P22-T238 D asset-erkennung.ts: png via inspektor wie bisher', p?.format === 'png' && p?.via === 'inspektor', p);
  } finally { await rm(root, { recursive: true, force: true }); }
}

// ------------------------------------------------------------------ E Schalter (asset-transfer-generisch.ts, agent-profil-schalter.ts, intern-schalter.ts)
{
  const S = await import(resolve(here, '../dist/services/agent-profil-schalter.js'));
  const I = await import(resolve(here, '../dist/services/intern-schalter.js'));
  check('P22-T238 E agent-profil-schalter.ts: asset_transfer_generisch im Katalog und nur ausdruecklich',
    S.PROFIL_PRODUKT_FUNKTIONEN.includes('asset_transfer_generisch') && S.NUR_AUSDRUECKLICH.includes('asset_transfer_generisch') && !S.STANDARD_EIN.includes('asset_transfer_generisch'));
  check('P22-T238 E intern-schalter.ts: Override asset_transfer_generisch (freigegeben)', JSON.stringify(I.INTERN_SCHALTER.asset_transfer_generisch) === '["freigegeben"]');
  const url = process.env.DATABASE_URL ?? '';
  if (!url) {
    console.log('# E DB-Teil uebersprungen: DATABASE_URL fehlt');
  } else if (!/synapse_test/.test(url)) {
    console.log('# E DB-Teil uebersprungen: DATABASE_URL ist nicht synapse_test (regel-tests-nur-testdatenbank)');
  } else {
    const G = await import(resolve(here, '../dist/services/asset-transfer-generisch.js'));
    const { getPool, closePool } = await import(resolve(here, '../dist/db/client.js'));
    const projekt = 'p22-t238-' + Date.now().toString(36);
    try {
      let s = await G.leseAssetTransferGenerisch(projekt);
      check('P22-T238 E leseAssetTransferGenerisch: Standard AUS (Quelle standard oder globale Zeile AUS)', s.aktiv === false, s);
      await S.setzeProfilProduktSchalter({ ebene: 'projekt', project: projekt, funktion: 'asset_transfer_generisch', aktiv: true, grund: 'P22-T238 Test' }, { system: 'user' });
      s = await G.leseAssetTransferGenerisch(projekt);
      check('P22-T238 E leseAssetTransferGenerisch: Produkt-Schalter Projekt EIN -> aktiv, Quelle produkt-schalter', s.aktiv === true && s.quelle === 'produkt-schalter', s);
      await S.setzeProfilProduktSchalter({ ebene: 'projekt', project: projekt, funktion: 'alle', aktiv: true, grund: 'P22-T238 Test alle' }, { system: 'user' }).catch(() => undefined);
      await getPool().query("DELETE FROM agent_profil_schalter WHERE ebene='projekt' AND project=$1 AND funktion='asset_transfer_generisch'", [projekt]);
      s = await G.leseAssetTransferGenerisch(projekt);
      check("P22-T238 E leseAssetTransferGenerisch: 'alle' schaltet den generischen Transfer NICHT ein", s.aktiv === false, s);
    } finally {
      await getPool().query("DELETE FROM agent_profil_schalter WHERE ebene='projekt' AND project=$1", [projekt]).catch(() => undefined);
      await closePool?.().catch?.(() => undefined);
    }
  }
}

console.log(`\nP22-T238: ${ok} PASS, ${fehler} FAIL`);
process.exit(fehler ? 1 : 0);
