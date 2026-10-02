/**
 * Fixture-Generator fuer die Asset-Intel-Tests (P4-T60).
 * Erzeugt kleine Dateien DETERMINISTISCH (gleiche Bytes bei jedem Lauf) in einem Verzeichnis unter
 * os.tmpdir() — es werden KEINE Binaerdateien eingecheckt.
 * AUFRUF: node packages/core/scripts/asset-fixtures.mjs   (gibt das Verzeichnis aus)
 * ALS MODUL: const { dir, pfade, aufraeumen } = await erzeugeFixtures();
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Deterministische Fuellbytes (kein Math.random). */
function fuell(n, start = 1) {
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) b[i] = (start + i * 7) & 0xff;
  return b;
}

function u32le(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
}

const PNG_KOPF = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Minimale, formal einfache PNG-Huelle (Signatur + IHDR-Chunk, CRC nicht echt — reicht fuer Magic-Tests). */
function pngMinimal() {
  const ihdr = Buffer.concat([Buffer.from([0, 0, 0, 13]), Buffer.from('IHDR'), Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]), Buffer.alloc(4)]);
  return Buffer.concat([PNG_KOPF, ihdr]);
}

/** Minimaler GLB-Kopf: 'glTF', Version 2, Gesamtlaenge, JSON-Chunk '{}'. */
function glbMinimal() {
  const json = Buffer.from('{}  ');
  const chunk = Buffer.concat([u32le(json.length), Buffer.from('JSON'), json]);
  const gesamt = 12 + chunk.length;
  return Buffer.concat([Buffer.from('glTF'), u32le(2), u32le(gesamt), chunk]);
}

/**
 * @param {string} [ziel] Zielverzeichnis; fehlt es, wird ein neues unter os.tmpdir() angelegt.
 * @returns {Promise<{dir:string, pfade:Record<string,string>, aufraeumen:()=>Promise<void>}>}
 */
export async function erzeugeFixtures(ziel) {
  const dir = ziel ?? (await mkdtemp(join(tmpdir(), 'synapse-asset-fixtures-')));
  await mkdir(dir, { recursive: true });
  const glb = glbMinimal();
  const dateien = {
    pngMinimal: ['png-minimal.png', pngMinimal()],
    glbMinimal: ['glb-minimal.glb', glb],
    // GLB nach 10 von 12+ Kopf-Bytes abgeschnitten: Magic da, Rest fehlt.
    glbAbgeschnitten: ['glb-abgeschnitten.glb', glb.subarray(0, 10)],
    // PNG-Inhalt unter GLB-Endung: Magic muss vor der Endung gelten.
    pngAlsGlb: ['png-als-glb.glb', pngMinimal()],
    // GLB-Endung, aber Inhalt ohne Magic (Muellbytes).
    glbKaputt: ['glb-kaputt.glb', fuell(64, 3)],
    leer: ['leer.bin', Buffer.alloc(0)],
    unbekannt: ['unbekannt.xyz', fuell(200, 11)],
    zipMinimal: ['zip-minimal.zip', Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), fuell(60, 5)])],
    // Grosse Datei fuer Grenzentests (mit kleinen Test-Grenzen "gross").
    gross: ['gross.bin', Buffer.concat([PNG_KOPF, fuell(8000, 9)])],
  };
  const pfade = {};
  for (const [schluessel, [name, inhalt]] of Object.entries(dateien)) {
    const p = join(dir, name);
    await writeFile(p, inhalt);
    pfade[schluessel] = p;
  }
  return { dir, pfade, aufraeumen: () => rm(dir, { recursive: true, force: true }) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { dir, pfade } = await erzeugeFixtures();
  console.log(dir);
  for (const [k, p] of Object.entries(pfade)) console.log(`  ${k}: ${p}`);
}
