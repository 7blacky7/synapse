#!/usr/bin/env node
/**
 * skills-seed-laden.mjs — P23-T5: Seed-Skills aus dem Repo in die Skill-Datenbank laden.
 *
 * QUELLE: skills/seed/** /*.json ({ bereich, skills: [{ skill_name, weg: beide|ausweis|legacy, sections: [{section, content, tags?}] }] }).
 * WEG: ueber das skills-Tool der Synapse-API (replace_skill; PostgreSQL zuerst, Vektor folgt). Kein DB-Direktzugriff.
 * REGEL: Vorhandene Skills werden UEBERSPRUNGEN (Deploy-Standard, auch fuer fremde Installationen).
 *   --aktualisieren ersetzt zusaetzlich vorhandene Seed-Skills, deren Inhalt abweicht (fuer uns nach Seed-Aenderungen).
 * AUFRUF:
 *   node scripts/skills-seed-laden.mjs                 Trockenlauf: zeigt fehlend / vorhanden / abweichend
 *   node scripts/skills-seed-laden.mjs --laden         laedt fehlende
 *   node scripts/skills-seed-laden.mjs --laden --aktualisieren
 *   node scripts/skills-seed-laden.mjs --pruefen       nur Seed-Dateien pruefen (ohne API), Exit 1 bei Fehlern
 *   Optional --verzeichnis <pfad> (Standard skills/seed). API-Zugang wie scripts/synapse-api.mjs
 *   (~/.synapse/file-watcher/config.json bzw. SYNAPSE_API_URL / SYNAPSE_API_TOKEN). mise run skills-seed.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEGE = new Set(['beide', 'ausweis', 'legacy']);
const NAME_RE = /^[a-z0-9][a-z0-9:_-]{1,99}$/;

async function jsonDateien(dir) {
  const out = [];
  for (const e of await readdir(dir)) {
    const p = join(dir, e);
    const s = await stat(p);
    if (s.isDirectory()) out.push(...await jsonDateien(p));
    else if (e.endsWith('.json')) out.push(p);
  }
  return out.sort();
}

/** Liest und prueft den Seed. Liefert {skills: [{skill_name, weg, bereich, datei, sections}], fehler: string[]}. */
export async function ladeSeed(verzeichnis) {
  const fehler = [];
  const skills = [];
  const namen = new Map();
  for (const datei of await jsonDateien(verzeichnis)) {
    let roh;
    try { roh = JSON.parse(await readFile(datei, 'utf8')); } catch (e) { fehler.push(`${datei}: kein JSON (${e.message})`); continue; }
    const bereich = typeof roh?.bereich === 'string' ? roh.bereich : '';
    if (!bereich) fehler.push(`${datei}: bereich fehlt`);
    if (!Array.isArray(roh?.skills) || roh.skills.length === 0) { fehler.push(`${datei}: skills[] fehlt`); continue; }
    for (const [i, s] of roh.skills.entries()) {
      const wo = `${datei} skills[${i}]`;
      if (typeof s?.skill_name !== 'string' || !NAME_RE.test(s.skill_name)) { fehler.push(`${wo}: skill_name ungueltig`); continue; }
      if (namen.has(s.skill_name)) fehler.push(`${wo}: ${s.skill_name} doppelt (auch in ${namen.get(s.skill_name)})`);
      namen.set(s.skill_name, datei);
      const weg = s.weg ?? 'beide';
      if (!WEGE.has(weg)) fehler.push(`${wo}: weg ${weg} ungueltig (beide|ausweis|legacy)`);
      if (!Array.isArray(s.sections) || s.sections.length === 0) { fehler.push(`${wo}: sections[] fehlt`); continue; }
      const secNamen = new Set();
      for (const sec of s.sections) {
        if (typeof sec?.section !== 'string' || !sec.section || typeof sec.content !== 'string' || !sec.content.trim()) fehler.push(`${wo}: section ohne Name/Inhalt`);
        else if (secNamen.has(sec.section)) fehler.push(`${wo}: section ${sec.section} doppelt`);
        secNamen.add(sec?.section);
      }
      if (!secNamen.has('uebersicht')) fehler.push(`${wo}: section uebersicht fehlt (Zweck + Ausloeser)`);
      skills.push({
        skill_name: s.skill_name, weg, bereich, datei,
        sections: s.sections.map((sec) => ({
          section: sec.section,
          content: sec.content,
          tags: [...new Set([...(Array.isArray(sec.tags) ? sec.tags : []), 'fall-skill', `weg:${weg}`, `bereich:${bereich}`, 'seed'])],
        })),
      });
    }
  }
  return { skills, fehler };
}

const norm = (t) => String(t ?? '').replace(/\r\n/g, '\n').trim();

/** Vergleicht Seed-Skill mit DB-Stand (get_full). true = gleich. */
function gleich(seed, voll) {
  const db = new Map((voll?.sections ?? []).map((s) => [s.section, norm(s.content)]));
  if (db.size !== seed.sections.length) return false;
  return seed.sections.every((s) => db.get(s.section) === norm(s.content));
}

export async function main(argv = process.argv.slice(2)) {
  const hier = dirname(fileURLToPath(import.meta.url));
  const idx = argv.indexOf('--verzeichnis');
  const verzeichnis = resolve(idx >= 0 ? argv[idx + 1] : join(hier, '..', 'skills', 'seed'));
  const { skills, fehler } = await ladeSeed(verzeichnis);
  console.log(`Seed: ${skills.length} Skills aus ${verzeichnis}`);
  if (fehler.length) {
    console.error('Seed-Fehler:\n  - ' + fehler.join('\n  - '));
    return 1;
  }
  if (argv.includes('--pruefen')) return 0;

  const { loadApiConfig, callMcpTool } = await import('./synapse-api.mjs');
  const config = await loadApiConfig();
  const liste = await callMcpTool(config, 'skills', { action: 'list' }, { timeoutMs: 30000 });
  const vorhanden = new Set((liste?.skills ?? []).map((s) => s.skill_name));
  const fehlend = skills.filter((s) => !vorhanden.has(s.skill_name));
  const da = skills.filter((s) => vorhanden.has(s.skill_name));
  const abweichend = [];
  if (argv.includes('--aktualisieren')) {
    for (const s of da) {
      const voll = await callMcpTool(config, 'skills', { action: 'get_full', skill_name: s.skill_name }, { timeoutMs: 30000 });
      if (!gleich(s, voll)) abweichend.push(s);
    }
  }
  console.log(`fehlend: ${fehlend.length}, vorhanden: ${da.length}${argv.includes('--aktualisieren') ? `, abweichend: ${abweichend.length}` : ' (uebersprungen)'}`);
  if (!argv.includes('--laden')) {
    for (const s of fehlend) console.log('  fehlt: ' + s.skill_name);
    for (const s of abweichend) console.log('  weicht ab: ' + s.skill_name);
    console.log('Trockenlauf - mit --laden schreiben.');
    return 0;
  }
  let ok = 0;
  const probleme = [];
  for (const s of [...fehlend, ...abweichend]) {
    try {
      await callMcpTool(config, 'skills', { action: 'replace_skill', skill_name: s.skill_name, sections: s.sections }, { timeoutMs: 60000 });
      ok++;
      console.log('  geladen: ' + s.skill_name);
    } catch (e) {
      probleme.push(`${s.skill_name}: ${e.message}`);
    }
  }
  console.log(`geladen: ${ok}, Fehler: ${probleme.length}, uebersprungen: ${da.length - abweichend.length}`);
  if (probleme.length) console.error('  - ' + probleme.join('\n  - '));
  return probleme.length ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code), (e) => { console.error(e.message); process.exit(1); });
}
