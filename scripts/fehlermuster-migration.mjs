/**
 * P15-T17 E1: Migration der Bestands-Fehlermuster nach scripts/fehlermuster-migration-plan.mjs.
 *
 * TROCKENLAUF (Standard, schreibt nichts):
 *   node scripts/fehlermuster-migration.mjs [--bericht <datei.json>]
 *   Liest error_patterns aus DATABASE_URL, loest die Plan-IDs auf und prueft:
 *     - jedes Muster genau einmal im Plan, jede Plan-ID genau einmal in der DB
 *     - ersetzt_durch zeigt auf ein Muster, das selbst aktiv/themenhinweis bleibt
 *     - aktive Signaturen: gueltig (validiereErkennung) und Selbsttest bestanden
 *     - Kreuzprobe: keine aktive Signatur trifft das beispiel_richtig eines anderen aktiven Musters (Rauschwarnung)
 *   Ausgabe: vorher -> nachher je Muster, Dubletten-Gruppen, Memory-Ziele.
 *
 * AUSFUEHREN (nur nach Freigabe des Koordinators):
 *   node scripts/fehlermuster-migration.mjs --ausfuehren --freigabe "<wer, wann>"
 *   Eine Transaktion fuer alle UPDATEs; danach je Ziel-Projekt EIN memory (writeMemory) mit den stillgelegten Mustern.
 *   Bricht ab, wenn die E1-Spalten fehlen (Schema noch nicht deployt) oder der Trockenlauf Fehler hat.
 *   Nichts wird geloescht (User-Entscheidung E-d).
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PLAN, MEMORY_ZIELE } from './fehlermuster-migration-plan.mjs';

const hier = dirname(fileURLToPath(import.meta.url));
const dist = join(hier, '..', 'packages', 'core', 'dist');
const lade = (...teile) => import(pathToFileURL(join(...teile)).href);

export const E1_SPALTEN = ['titel', 'warum', 'erkennung', 'geltung', 'verweise', 'beispiel_falsch', 'beispiel_richtig',
  'status', 'stillgelegt_grund', 'ersetzt_durch', 'statistik'];

/** Loest den Plan gegen die DB-Zeilen auf und prueft ihn. Reine Funktion. */
export function planAufloesen(rows, plan, erkennungsModul) {
  const { validiereErkennung, selbsttest, pruefeErkennung } = erkennungsModul;
  const fehler = [];
  const hinweise = [];
  const zuId = (praefix) => {
    const kandidaten = rows.filter((r) => r.id.startsWith(praefix));
    if (kandidaten.length !== 1) { fehler.push(`ID ${praefix}: ${kandidaten.length} Treffer in der DB`); return null; }
    return kandidaten[0].id;
  };
  const eintraege = [];
  const gesehen = new Set();
  for (const p of plan) {
    const id = zuId(p.id);
    if (!id) continue;
    if (gesehen.has(id)) { fehler.push(`ID ${p.id} doppelt im Plan`); continue; }
    gesehen.add(id);
    const ziel = p.ersetzt_durch ? zuId(p.ersetzt_durch) : null;
    eintraege.push({ ...p, voll_id: id, ersetzt_durch_voll: ziel, row: rows.find((r) => r.id === id) });
  }
  for (const r of rows) if (!gesehen.has(r.id)) fehler.push(`Muster ${r.id.slice(0, 8)} fehlt im Plan: ${r.description.slice(0, 80)}`);

  const nachId = new Map(eintraege.map((e) => [e.voll_id, e]));
  for (const e of eintraege) {
    if (e.ersetzt_durch_voll) {
      const z = nachId.get(e.ersetzt_durch_voll);
      if (!z || !['aktiv', 'themenhinweis'].includes(z.aktion)) fehler.push(`${e.id}: ersetzt_durch ${e.ersetzt_durch} bleibt nicht aktiv/themenhinweis`);
    }
    if (e.aktion === 'aktiv') {
      const v = validiereErkennung(e.erkennung);
      if (v.length) fehler.push(`${e.id}: Erkennung ungueltig: ${v.join('; ')}`);
      e.selbsttest = selbsttest(e);
      if (!e.selbsttest.ok) fehler.push(`${e.id}: Selbsttest: ${e.selbsttest.fehler.join('; ')}`);
    }
    if (['aktiv', 'themenhinweis'].includes(e.aktion) && !e.titel) fehler.push(`${e.id}: titel fehlt`);
    if (e.aktion === 'stilllegen' && !e.grund) fehler.push(`${e.id}: grund fehlt`);
    if (e.ziel_projekt && !MEMORY_ZIELE[e.ziel_projekt]) fehler.push(`${e.id}: unbekanntes ziel_projekt ${e.ziel_projekt}`);
  }
  // Kreuzprobe: Rauschen gegen korrekte Beispiele anderer Muster
  const aktive = eintraege.filter((e) => e.aktion === 'aktiv');
  for (const a of aktive) {
    for (const b of aktive) {
      if (a === b || !b.beispiel_richtig) continue;
      if (pruefeErkennung(a.erkennung, b.beispiel_richtig).trifft) {
        hinweise.push(`Kreuztreffer: Signatur ${a.id} trifft beispiel_richtig von ${b.id}`);
      }
    }
  }
  return { eintraege, fehler, hinweise };
}

/** Zielzustand je Muster (was die Ausfuehrung schreibt). */
export function zielZustand(e) {
  const basis = { id: e.voll_id };
  switch (e.aktion) {
    case 'aktiv':
      return { ...basis, status: 'aktiv', severity: 'warning', titel: e.titel, warum: e.warum ?? null,
        erkennung: { version: 1, fenster: 'block', ...e.erkennung }, geltung: e.geltung ?? null,
        beispiel_falsch: e.beispiel_falsch, beispiel_richtig: e.beispiel_richtig, verweise: e.verweise ?? null,
        statistik: { selbsttest_ok: true, geprueft_am: new Date().toISOString().slice(0, 10), migriert: 'P15-T17 E1' } };
    case 'themenhinweis':
      return { ...basis, status: 'themenhinweis', titel: e.titel, erkennung: { art: 'keine', version: 1 },
        statistik: { migriert: 'P15-T17 E1' } };
    case 'dublette':
      return { ...basis, status: 'stillgelegt', ersetzt_durch: e.ersetzt_durch_voll,
        stillgelegt_grund: `Dublette von ${e.ersetzt_durch} (zusammengelegt P15-T17 E1)`, statistik: { migriert: 'P15-T17 E1' } };
    case 'stilllegen':
      return { ...basis, status: 'stillgelegt', ersetzt_durch: e.ersetzt_durch_voll ?? null,
        stillgelegt_grund: e.grund, statistik: { migriert: 'P15-T17 E1', memory_projekt: e.ziel_projekt ?? null } };
    default:
      throw new Error('unbekannte aktion ' + e.aktion);
  }
}

/** Memory-Inhalte je Ziel-Projekt aus den stillgelegten Mustern. */
export function memoryInhalte(eintraege) {
  const jeZiel = new Map();
  for (const e of eintraege) {
    if (e.aktion !== 'stilllegen' || !e.ziel_projekt) continue;
    if (!jeZiel.has(e.ziel_projekt)) jeZiel.set(e.ziel_projekt, []);
    jeZiel.get(e.ziel_projekt).push(e);
  }
  const ergebnis = [];
  for (const [projekt, liste] of jeZiel) {
    const ziel = MEMORY_ZIELE[projekt];
    const teile = [ziel.kopf, `Anzahl: ${liste.length}. Global weiter einsehbar: code_check list_patterns (status stillgelegt, stillgelegt_grund).`, ''];
    for (const e of liste) {
      const r = e.row;
      teile.push(`## ${e.voll_id.slice(0, 8)} (${r.severity}, gefunden von ${r.found_by}, ${String(r.created_at).slice(0, 10)})`);
      teile.push(`WAS: ${r.description.trim()}`);
      teile.push(`FIX: ${r.fix.trim()}`);
      teile.push(`STILLGELEGT: ${e.grund}`);
      teile.push('');
    }
    ergebnis.push({ projekt, name: ziel.name, category: ziel.category, tags: ziel.tags, content: teile.join('\n'), anzahl: liste.length });
  }
  return ergebnis;
}

function kurzZeile(e) {
  const r = e.row;
  const vorher = `${r.severity}/${r.model_scope}`;
  const z = zielZustand(e);
  let nachher = z.status;
  if (z.severity && z.severity !== r.severity) nachher += ` (severity ${r.severity}->${z.severity})`;
  if (z.ersetzt_durch) nachher += ` -> ${e.ersetzt_durch}`;
  if (e.ziel_projekt) nachher += ` [memory ${e.ziel_projekt}]`;
  const titel = e.titel ?? r.description.replace(/\s+/g, ' ').slice(0, 70);
  return `${e.voll_id.slice(0, 8)} | ${vorher} -> ${nachher} | ${titel}`;
}

/** Fuehrt die Migration in einer Transaktion aus. writeMemory(project, name, content, category, tags). */
export async function ausfuehren(pool, eintraege, writeMemory) {
  const spalten = (await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'error_patterns'`)).rows.map((r) => r.column_name);
  const fehlend = E1_SPALTEN.filter((s) => !spalten.includes(s));
  if (fehlend.length) throw new Error('E1-Spalten fehlen (Schema noch nicht deployt): ' + fehlend.join(', '));
  const client = await pool.connect();
  let geaendert = 0;
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    for (const e of eintraege) {
      const z = zielZustand(e);
      const res = await client.query(
        `UPDATE error_patterns SET
           status = $2, titel = COALESCE($3, titel), warum = COALESCE($4, warum),
           erkennung = COALESCE($5::jsonb, erkennung), geltung = COALESCE($6::jsonb, geltung),
           beispiel_falsch = COALESCE($7, beispiel_falsch), beispiel_richtig = COALESCE($8, beispiel_richtig),
           verweise = COALESCE($9::jsonb, verweise), ersetzt_durch = $10, stillgelegt_grund = $11,
           statistik = COALESCE(statistik, '{}'::jsonb) || $12::jsonb,
           severity = COALESCE($13, severity)
         WHERE id = $1`,
        [z.id, z.status, z.titel ?? null, z.warum ?? null,
          z.erkennung ? JSON.stringify(z.erkennung) : null, z.geltung ? JSON.stringify(z.geltung) : null,
          z.beispiel_falsch ?? null, z.beispiel_richtig ?? null, z.verweise ? JSON.stringify(z.verweise) : null,
          z.ersetzt_durch ?? null, z.stillgelegt_grund ?? null, JSON.stringify(z.statistik ?? {}), z.severity ?? null]);
      geaendert += res.rowCount ?? 0;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  const memories = [];
  for (const m of memoryInhalte(eintraege)) {
    await writeMemory(m.projekt, m.name, m.content, m.category, m.tags);
    memories.push({ projekt: m.projekt, name: m.name, anzahl: m.anzahl });
  }
  return { geaendert, memories };
}

async function main() {
  const args = process.argv.slice(2);
  const ausf = args.includes('--ausfuehren');
  const freigabe = args.includes('--freigabe') ? args[args.indexOf('--freigabe') + 1] : null;
  const berichtPfad = args.includes('--bericht') ? args[args.indexOf('--bericht') + 1] : null;
  const erkennung = await lade(dist, 'services', 'fehlermuster-erkennung.js');
  const db = await lade(dist, 'db', 'client.js');
  const pool = db.getPool();
  const rows = (await pool.query(
    `SELECT id::text, description, fix, severity, model_scope, found_by, found_in_model, created_at FROM error_patterns ORDER BY created_at, id`)).rows;
  const { eintraege, fehler, hinweise } = planAufloesen(rows, PLAN, erkennung);

  const zaehl = (a) => eintraege.filter((e) => e.aktion === a).length;
  console.log(`MUSTER in DB: ${rows.length} | im Plan: ${eintraege.length}`);
  console.log(`aktiv ${zaehl('aktiv')} | themenhinweis ${zaehl('themenhinweis')} | dublette ${zaehl('dublette')} | stilllegen ${zaehl('stilllegen')}`);
  for (const a of ['aktiv', 'themenhinweis', 'dublette', 'stilllegen']) {
    console.log(`\n== ${a.toUpperCase()} ==`);
    for (const e of eintraege.filter((x) => x.aktion === a)) console.log(kurzZeile(e));
  }
  console.log('\n== DUBLETTEN-GRUPPEN ==');
  const gruppen = new Map();
  for (const e of eintraege) if (e.ersetzt_durch) {
    if (!gruppen.has(e.ersetzt_durch)) gruppen.set(e.ersetzt_durch, []);
    gruppen.get(e.ersetzt_durch).push(e.id);
  }
  for (const [ziel, liste] of gruppen) console.log(`${ziel} <- ${liste.join(', ')}`);
  console.log('\n== MEMORY-ZIELE ==');
  for (const m of memoryInhalte(eintraege)) console.log(`${m.projekt}: memory ${m.name} (${m.anzahl} Muster, ${m.content.length} Zeichen)`);
  console.log(`\n== HINWEISE (${hinweise.length}) ==`);
  for (const h of hinweise) console.log(h);
  console.log(`\n== FEHLER (${fehler.length}) ==`);
  for (const f of fehler) console.log(f);
  if (berichtPfad) {
    writeFileSync(berichtPfad, JSON.stringify({ fehler, hinweise, eintraege: eintraege.map((e) => ({ plan: { ...e, row: undefined }, vorher: e.row, nachher: zielZustand(e) })), memories: memoryInhalte(eintraege) }, null, 1));
    console.log('Bericht: ' + berichtPfad);
  }
  if (!ausf) { console.log('\nTROCKENLAUF - nichts geschrieben.'); await pool.end(); process.exit(fehler.length ? 1 : 0); }
  if (!freigabe) { console.error('ABBRUCH: --ausfuehren braucht --freigabe "<wer, wann>"'); await pool.end(); process.exit(2); }
  if (fehler.length) { console.error('ABBRUCH: Trockenlauf hat Fehler.'); await pool.end(); process.exit(2); }
  const { writeMemory } = await lade(dist, 'services', 'memory.js');
  const erg = await ausfuehren(pool, eintraege, writeMemory);
  console.log(`AUSGEFUEHRT (Freigabe: ${freigabe}): ${erg.geaendert} Muster geaendert, memories: ${JSON.stringify(erg.memories)}`);
  await pool.end();
  process.exit(0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => { console.error('FEHLER', err); process.exit(1); });
}
