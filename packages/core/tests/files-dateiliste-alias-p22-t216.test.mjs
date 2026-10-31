/**
 * P22-T216 (31.10.2026): files-Dateilisten mit Alias file_path <-> files.
 * HERKUNFT: Stresstest P22-T214 Befund B1 (Ergebnis-Thought c9092c3b): 6 von 10 GPT-Agenten riefen
 * files(reservation_add, files:[...]) auf und bekamen 'Parameter file_path ist erforderlich'; coedit_no_changes
 * verlangte umgekehrt files und lehnte file_path ab.
 *
 * ZUSAGEN:
 *   U1-U6 core.waehleReservierungsDateiliste: Name allein, Alias allein (normalisiert), beide gleich (Reihenfolge
 *         egal), beide verschieden -> Fehler, Pflicht fehlt -> Fehler mit Name und Beispiel, optional fehlt -> [].
 *   R1    reservation_add mit files:[...] reserviert (Alias).
 *   R2    reservation_add mit file_path (bisheriger Weg) reserviert.
 *   R3    reservation_add mit file_path und files verschieden -> Fehler, nichts reserviert.
 *   R4    reservation_add ohne beides -> Fehler nennt "file_path" und ein Beispiel.
 *   R5    reservation_release mit files:[...] gibt frei.
 *   R6    coedit_no_changes mit file_path wird wie mit files behandelt (gleiche Antwort, kein Parameterfehler).
 *   R7    coedit_no_changes ohne beides -> Fehler nennt "files" und ein Beispiel mit plan_id.
 *   R8    coedit_no_changes mit files und file_path verschieden -> Fehler.
 *
 * ABSICHERUNG: nur Test-DB (...:5433/synapse_test, sonst Exit 2). Qdrant/Ollama hart auf 127.0.0.1:9.
 * AUFRUF: (DATABASE_URL = Test-DB) node packages/core/tests/files-dateiliste-alias-p22-t216.test.mjs
 * Exit 0 = alle Zusagen erfuellt, 1 = mindestens eine verletzt, 2 = falsche DB.
 * Braucht gebautes packages/core/dist und packages/rest-api/dist.
 */
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pruefeTestDbUrl } from '../../../scripts/lib/test-db-schutz.mjs';

pruefeTestDbUrl('files-dateiliste-alias-p22-t216.test');
process.env.EMBEDDING_PROVIDER = 'ollama';
process.env.QDRANT_URL = 'http://127.0.0.1:9';
process.env.OLLAMA_URL = 'http://127.0.0.1:9';
process.env.FEHLERMUSTER_WARTE_MS = '0';

const hier = dirname(fileURLToPath(import.meta.url));
const repo = join(hier, '..', '..', '..');
const dist = join(hier, '..', 'dist');
const lade = (...teile) => import(pathToFileURL(join(...teile)).href);

const core = await lade(dist, 'index.js');
const PROJECT = 'alias-t216';
const AGENT = 'alias-t216-agent';
const wurzel = mkdtempSync(join(tmpdir(), 'alias-t216-'));
const pool = core.getPool();

let ok = 0;
const fehler = [];
const pruefe = (bed, text, detail) => {
  if (bed) { ok++; console.log('OK  ' + text); return; }
  fehler.push(text);
  console.log('FEHLER ' + text + (detail !== undefined ? '\n   ' + JSON.stringify(detail).slice(0, 900) : ''));
};

async function aufraeumen() {
  for (const t of ['file_batch_waits', 'file_batch_plans', 'file_reservations']) {
    await pool.query(`DELETE FROM ${t} WHERE project = $1`, [PROJECT]).catch(() => {});
  }
}

await aufraeumen();
await core.registerProject(PROJECT, wurzel);

// ───────────────────────── U: reine Funktion ─────────────────────────
const waehle = core.waehleReservierungsDateiliste;
const meldungVon = (fn) => { try { fn(); return ''; } catch (e) { return e.message; } };
if (typeof waehle !== 'function') {
  pruefe(false, 'U0: core exportiert waehleReservierungsDateiliste');
} else {
  const basis = { action: 'reservation_add', name: 'file_path', alias: 'files' };
  let w = waehle({ ...basis, wert: ['a.ts'], aliasWert: undefined, required: true });
  pruefe(JSON.stringify(w) === '["a.ts"]', 'U1: Name allein', w);
  w = waehle({ ...basis, wert: undefined, aliasWert: ['./b.ts'], required: true });
  pruefe(JSON.stringify(w) === '["b.ts"]', 'U2: Alias allein, normalisiert', w);
  w = waehle({ ...basis, wert: ['a.ts', 'b.ts'], aliasWert: ['b.ts', 'a.ts'], required: true });
  pruefe(JSON.stringify(w) === '["a.ts","b.ts"]', 'U3: beide gleich (Reihenfolge egal) ist kein Fehler', w);
  let m = meldungVon(() => waehle({ ...basis, wert: ['a.ts'], aliasWert: ['b.ts'], required: true }));
  pruefe(/"file_path"/.test(m) && /"files"/.test(m) && /verschieden/.test(m), 'U4: beide verschieden -> Fehler nennt beide Namen', m);
  m = meldungVon(() => waehle({ ...basis, wert: undefined, aliasWert: undefined, required: true }));
  pruefe(/Parameter "file_path" ist erforderlich/.test(m) && /Beispiel: files\(action:"reservation_add"/.test(m), 'U5: Pflicht fehlt -> Name und Beispiel', m);
  w = waehle({ ...basis, wert: undefined, aliasWert: undefined });
  pruefe(Array.isArray(w) && w.length === 0, 'U6: optional ohne Wert -> []', w);
}

// ───────────────────────── R: REST /mcp tools/call ─────────────────────────
const requireRest = createRequire(join(repo, 'packages', 'rest-api', 'package.json'));
const Fastify = requireRest('fastify');
const { mcpRoutes } = await lade(repo, 'packages', 'rest-api', 'dist', 'routes', 'mcp.js');
const app = Fastify({ logger: false });
await app.register(mcpRoutes);
await app.ready();
const tool = async (name, args) => {
  const res = await app.inject({ method: 'POST', url: '/', payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { project: PROJECT, agent_id: AGENT, ...args } } } });
  const body = res.json();
  try { return JSON.parse(body.result.content[0].text); } catch { return body; }
};
const files = (args) => tool('files', args);
// Fehlertext unabhaengig von der Antwortform (success:false + error/message oder JSON-RPC-Fehler).
const text = (r) => { const roh = JSON.stringify(r) ?? ''; try { return JSON.parse(`"${roh.replace(/\\"/g, "'").replace(/"/g, '')}"`); } catch { return roh.replace(/\\"/g, "'"); } };
const aktive = async () => {
  const r = await files({ action: 'reservation_list', reservation_agent_id: AGENT });
  return (r?.reservations ?? []).map((x) => x.file_path).sort();
};
const kern = (r) => ({ success: r?.success, error: r?.error, message: r?.message, code: r?.code });

try {
  let r = await files({ action: 'reservation_add', files: ['alias/a.ts', 'alias/b.ts'] });
  pruefe(r?.success === true && r?.count === 2, 'R1: reservation_add mit files:[...] reserviert', r);
  let a = await aktive();
  pruefe(JSON.stringify(a) === '["alias/a.ts","alias/b.ts"]', 'R1b: reservation_list zeigt beide Pfade', a);

  r = await files({ action: 'reservation_add', file_path: 'alias/c.ts' });
  pruefe(r?.success === true && r?.count === 1, 'R2: reservation_add mit file_path (bisheriger Weg)', r);

  r = await files({ action: 'reservation_add', file_path: 'alias/d.ts', files: ['alias/e.ts'] });
  pruefe(r?.success !== true && /verschieden/.test(text(r)), 'R3: file_path und files verschieden -> Fehler', r);
  a = await aktive();
  pruefe(!a.includes('alias/d.ts') && !a.includes('alias/e.ts'), 'R3b: dabei nichts reserviert', a);

  r = await files({ action: 'reservation_add' });
  pruefe(r?.success !== true && /Parameter 'file_path' ist erforderlich/.test(text(r)) && /Beispiel/.test(text(r)),
    'R4: ohne Dateiliste -> Fehler nennt file_path und Beispiel', r);

  r = await files({ action: 'reservation_release', files: ['alias/a.ts'] });
  pruefe(r?.success === true && r?.released_count === 1, 'R5: reservation_release mit files:[...]', r);
  a = await aktive();
  pruefe(JSON.stringify(a) === '["alias/b.ts","alias/c.ts"]', 'R5b: nur alias/a.ts freigegeben', a);

  const mitPfad = await files({ action: 'coedit_no_changes', plan_id: '999999999', file_path: 'alias/b.ts' });
  const mitFiles = await files({ action: 'coedit_no_changes', plan_id: '999999999', files: ['alias/b.ts'] });
  pruefe(!/Parameter 'files'/.test(text(mitPfad)) && JSON.stringify(kern(mitPfad)) === JSON.stringify(kern(mitFiles)),
    'R6: coedit_no_changes mit file_path wie mit files (kein Parameterfehler)', { mitPfad: kern(mitPfad), mitFiles: kern(mitFiles) });

  r = await files({ action: 'coedit_no_changes', plan_id: '999999999' });
  pruefe(r?.success !== true && /Parameter 'files' ist erforderlich/.test(text(r)) && /plan_id:'<plan_id>'/.test(text(r)),
    'R7: coedit_no_changes ohne Dateiliste -> Fehler nennt files und Beispiel mit plan_id', r);

  r = await files({ action: 'coedit_no_changes', plan_id: '999999999', files: ['alias/b.ts'], file_path: 'alias/c.ts' });
  pruefe(r?.success !== true && /verschieden/.test(text(r)), 'R8: coedit_no_changes mit files und file_path verschieden -> Fehler', r);
} finally {
  await aufraeumen();
  await app.close();
  rmSync(wurzel, { recursive: true, force: true });
  await pool.end().catch(() => {});
}

console.log(`\n${ok} OK, ${fehler.length} FEHLER`);
if (fehler.length) console.log(fehler.map((f) => ' - ' + f).join('\n'));
process.exit(fehler.length ? 1 : 0);
