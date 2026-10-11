/**
 * P15-T17 E1 (11.10.2026): Unit-Test fuer packages/core/src/services/fehlermuster-erkennung.ts
 * und fuer den Migrationsplan scripts/fehlermuster-migration-plan.mjs. Reine Tests ohne DB und ohne Netz.
 *
 * ZUSAGEN:
 *   V  validiereErkennung lehnt ab: kein Objekt, unbekannte art, (a+)+ / (\w*)*, Flags ausser imsu,
 *      leere Signatur-Liste, leerer Ausdruck, ungueltiger Regex, mehr als MAX_AUSDRUECKE, unbekanntes fenster.
 *      Gueltig: art 'keine', einfache Regex.
 *   P  pruefeErkennung: UND-Verknuepfung der Signaturen, Gegen-Signatur hebt auf, Zeilennummern 1-basiert,
 *      Flags wirken, Textkappung MAX_TEXT_ZEICHEN, wirft nie (kaputter Regex -> trifft:false), wiederholter
 *      Aufruf mit gecachtem Regex liefert dasselbe (lastIndex wird zurueckgesetzt).
 *   S  selbsttest: ok, beispiel_richtig trifft -> nicht ok, Beispiel fehlt -> nicht ok, art keine -> nicht ok.
 *   G  giltFuer: ohne geltung, sprachen (Endung case-insensitiv), dateimuster (** und *), projekte.
 *   M  Migrationsplan (User-Freigabe 37673ac6): alle 27 aktiven Muster gueltig und Selbsttest bestanden,
 *      planAufloesen gegen synthetische Zeilen ohne Fehler und ohne Kreuztreffer, Zaehlung
 *      27/28/29/20 + 35 loeschen, zielZustand je aktion, nur noch die synapse-memory.
 * AUFRUF: node scripts/test-fehlermuster-erkennung.mjs  (core vorher bauen)
 */
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PLAN, MEMORY_ZIELE } from './fehlermuster-migration-plan.mjs';
import { planAufloesen, zielZustand, memoryInhalte } from './fehlermuster-migration.mjs';

const hier = dirname(fileURLToPath(import.meta.url));
const E = await import(pathToFileURL(join(hier, '..', 'packages', 'core', 'dist', 'services', 'fehlermuster-erkennung.js')).href);
const { validiereErkennung, pruefeErkennung, selbsttest, giltFuer, MAX_AUSDRUECKE, MAX_TEXT_ZEICHEN } = E;

let fehler = 0;
let ok = 0;
function pruefe(b, text, detail) {
  if (b) { ok++; console.log('OK      ' + text); }
  else { fehler++; console.log('FEHLER  ' + text + (detail !== undefined ? '\n        ' + JSON.stringify(detail).slice(0, 800) : '')); }
}
const abgelehnt = (erk, teil) => {
  const f = validiereErkennung(erk);
  return f.length > 0 && (!teil || f.some((x) => x.includes(teil)));
};

// ---- V: validiereErkennung ----
pruefe(abgelehnt(null, 'Objekt'), 'V1 null -> kein Objekt');
pruefe(abgelehnt('regex', 'Objekt'), 'V2 String -> kein Objekt');
pruefe(abgelehnt({ art: 'struktur', signatur: ['x'] }, 'art'), 'V3 unbekannte art');
pruefe(abgelehnt({ art: 'regex', signatur: ['(a+)+$'] }, 'verschachtelte'), 'V4 (a+)+ abgelehnt');
pruefe(abgelehnt({ art: 'regex', signatur: ['(\\w*)*x'] }, 'verschachtelte'), 'V5 (\\w*)* abgelehnt');
pruefe(abgelehnt({ art: 'regex', signatur: ['x'], gegen_signatur: ['(.+)+'] }, 'gegen_signatur[0]'), 'V6 verschachtelt auch in gegen_signatur');
pruefe(abgelehnt({ art: 'regex', signatur: ['x'], flags: 'g' }, 'flags'), 'V7 Flag g abgelehnt');
pruefe(abgelehnt({ art: 'regex', signatur: ['x'], flags: 'mx' }, 'flags'), 'V8 Flag x abgelehnt');
pruefe(abgelehnt({ art: 'regex', signatur: [] }, 'mindestens'), 'V9 leere Signatur-Liste');
pruefe(abgelehnt({ art: 'regex' }, 'Liste'), 'V10 fehlende Signatur');
pruefe(abgelehnt({ art: 'regex', signatur: [''] }, 'leer'), 'V11 leerer Ausdruck');
pruefe(abgelehnt({ art: 'regex', signatur: ['(abc'] }, 'ungueltig'), 'V12 ungueltiger Regex');
pruefe(abgelehnt({ art: 'regex', signatur: Array(MAX_AUSDRUECKE + 1).fill('a') }, 'hoechstens'), 'V13 zu viele Ausdruecke');
pruefe(abgelehnt({ art: 'regex', signatur: ['a'], fenster: 'projekt' }, 'fenster'), 'V14 unbekanntes fenster');
pruefe(abgelehnt({ art: 'regex', signatur: ['a'.repeat(1001)] }, 'laenger'), 'V15 Ausdruck zu lang');
pruefe(validiereErkennung({ art: 'keine' }).length === 0, 'V16 art keine ist gueltig');
const v17 = { art: 'regex', signatur: ['^\\s*use server\\b'], gegen_signatur: ['x'], flags: 'mi', fenster: 'zeile' };
pruefe(validiereErkennung(v17).length === 0, 'V17 gueltige Regex-Erkennung', validiereErkennung(v17));
const v18 = { art: 'regex', signatur: ['(ab)+', '\\(x+\\)+'] };
pruefe(validiereErkennung(v18).length === 0, 'V18 einfache Gruppe mit Quantor und escapte Klammern sind erlaubt', validiereErkennung(v18));

// ---- P: pruefeErkennung ----
const text = 'zeile eins\nimport x from "y"\nfoo(bar)\n// ende';
const und = { art: 'regex', signatur: ['import', 'foo\\('], flags: 'm' };
let r = pruefeErkennung(und, text);
pruefe(r.trifft && !r.aufgehoben && r.zeilen.join() === '2,3', 'P1 UND: beide Signaturen treffen, Zeilen 2 und 3', r);
r = pruefeErkennung({ ...und, signatur: ['import', 'gibtsnicht'] }, text);
pruefe(!r.trifft && !r.aufgehoben && r.zeilen.length === 0, 'P2 UND: eine Signatur fehlt -> kein Treffer', r);
r = pruefeErkennung({ ...und, gegen_signatur: ['ende$'] }, text);
pruefe(!r.trifft && r.aufgehoben && r.zeilen.join() === '2,3', 'P3 Gegen-Signatur hebt den Treffer auf', r);
r = pruefeErkennung({ ...und, gegen_signatur: ['nirgends'] }, text);
pruefe(r.trifft, 'P4 Gegen-Signatur ohne Treffer hebt nicht auf', r);
pruefe(!pruefeErkennung({ art: 'regex', signatur: ['^foo'] }, text).trifft, 'P5 ohne Flag m greift ^ nur am Textanfang');
pruefe(pruefeErkennung({ art: 'regex', signatur: ['^foo'], flags: 'm' }, text).zeilen[0] === 3, 'P6 mit Flag m: ^ je Zeile, Zeile 3');
pruefe(pruefeErkennung({ art: 'regex', signatur: ['IMPORT'], flags: 'i' }, text).trifft, 'P7 Flag i');
pruefe(pruefeErkennung({ art: 'regex', signatur: ['eins'] }, text).zeilen[0] === 1, 'P8 Treffer in Zeile 1');
pruefe(!pruefeErkennung(null, text).trifft && !pruefeErkennung(undefined, text).trifft, 'P9 null/undefined -> kein Treffer');
pruefe(!pruefeErkennung({ art: 'keine' }, text).trifft, 'P10 art keine -> kein Treffer');
let geworfen = false;
try { r = pruefeErkennung({ art: 'regex', signatur: ['(kaputt'] }, text); } catch { geworfen = true; }
pruefe(!geworfen && !r.trifft, 'P11 kaputter Regex wirft nicht, trifft:false', r);
const lang = 'a'.repeat(MAX_TEXT_ZEICHEN) + 'SPAET';
pruefe(!pruefeErkennung({ art: 'regex', signatur: ['SPAET'] }, lang).trifft, 'P12 Text ueber MAX_TEXT_ZEICHEN wird gekappt');
const wieder = { art: 'regex', signatur: ['foo'] };
const w1 = pruefeErkennung(wieder, text).trifft;
const w2 = pruefeErkennung(wieder, text).trifft;
const w3 = pruefeErkennung(wieder, 'foo').trifft;
pruefe(w1 && w2 && w3, 'P13 gecachter Regex (g) trifft auch beim zweiten und dritten Aufruf', [w1, w2, w3]);

// ---- S: selbsttest ----
const sig = { erkennung: { art: 'regex', signatur: ['^\\s*use server\\b'], flags: 'm' },
  beispiel_falsch: 'use server\nexport async function a() {}', beispiel_richtig: '"use server"\nexport async function a() {}' };
pruefe(selbsttest(sig).ok, 'S1 Selbsttest bestanden', selbsttest(sig));
const s2 = selbsttest({ ...sig, beispiel_richtig: 'use server;' });
pruefe(!s2.ok && s2.fehler.some((f) => f.includes('beispiel_richtig')), 'S2 beispiel_richtig trifft -> nicht ok', s2);
const s3 = selbsttest({ ...sig, beispiel_falsch: null });
pruefe(!s3.ok && s3.fehler.some((f) => f.includes('beispiel_falsch fehlt')), 'S3 beispiel_falsch fehlt', s3);
const s4 = selbsttest({ ...sig, erkennung: { art: 'keine' } });
pruefe(!s4.ok, 'S4 art keine -> kein Selbsttest', s4);
const s5 = selbsttest({ ...sig, erkennung: { ...sig.erkennung, gegen_signatur: ['export'] } });
pruefe(!s5.ok && s5.fehler.some((f) => f.includes('Gegen-Signatur')), 'S5 Gegen-Signatur hebt beispiel_falsch auf', s5);
const s6 = selbsttest({ ...sig, erkennung: { art: 'regex', signatur: ['(a+)+'] } });
pruefe(!s6.ok && s6.fehler.some((f) => f.includes('verschachtelte')), 'S6 ungueltige Erkennung -> Validierungsfehler', s6);

// ---- G: giltFuer ----
pruefe(giltFuer(null, 'a/b.py') && giltFuer({}, 'a/b.py'), 'G1 ohne geltung gilt alles');
pruefe(giltFuer({ sprachen: ['ts', 'tsx'] }, 'src/a.ts') && giltFuer({ sprachen: ['ts'] }, 'src/A.TS'), 'G2 sprachen, Endung case-insensitiv');
pruefe(!giltFuer({ sprachen: ['ts'] }, 'src/a.js'), 'G3 andere Endung gilt nicht');
pruefe(giltFuer({ sprachen: ['TSX'] }, 'x/y.tsx'), 'G4 sprachen-Angabe gross geschrieben');
pruefe(giltFuer({ dateimuster: ['**/error.tsx'] }, 'src/app/error.tsx') && giltFuer({ dateimuster: ['**/error.tsx'] }, 'error.tsx'),
  'G5 ** am Anfang trifft auch die Wurzel');
pruefe(!giltFuer({ dateimuster: ['**/error.tsx'] }, 'src/app/page.tsx'), 'G6 dateimuster ohne Treffer');
pruefe(giltFuer({ dateimuster: ['app/*/page.tsx'] }, 'app/x/page.tsx') && !giltFuer({ dateimuster: ['app/*/page.tsx'] }, 'app/x/y/page.tsx'),
  'G7 * ueberspringt keinen Ordner');
pruefe(giltFuer({ dateimuster: ['a.ts', 'packages/core/**'] }, 'packages/core/src/x.ts'), 'G8 mehrere dateimuster = ODER');
pruefe(!giltFuer({ projekte: ['moo'] }, 'a.c') && !giltFuer({ projekte: ['moo'] }, 'a.c', 'synapse') && giltFuer({ projekte: ['moo'] }, 'a.c', 'moo'),
  'G9 projekte: ohne/anderes Projekt nein, passendes ja');
pruefe(!giltFuer({ projekte: ['moo'], sprachen: ['c'] }, 'a.h', 'moo'), 'G10 alle Angaben muessen passen (UND)');
pruefe(giltFuer({ frameworks: ['next>=15'] }, 'a.ts'), 'G11 frameworks schraenkt (noch) nicht ein');

// ---- M: Migrationsplan ----
const aktive = PLAN.filter((p) => p.aktion === 'aktiv');
pruefe(aktive.length === 27, `M1 27 aktive Signatur-Muster im Plan (ist ${aktive.length})`);
const kaputt = aktive.map((p) => ({ id: p.id, v: validiereErkennung(p.erkennung), s: selbsttest(p) })).filter((x) => x.v.length || !x.s.ok);
pruefe(kaputt.length === 0, 'M2 alle aktiven Muster: Erkennung gueltig und Selbsttest bestanden', kaputt);
const sprachenKaputt = aktive.filter((p) => (p.geltung?.sprachen ?? []).some((s) => !/^[a-z0-9]+$/.test(s)));
pruefe(sprachenKaputt.length === 0, 'M3 sprachen-Angaben sind reine Endungen (klein, ohne Punkt)', sprachenKaputt.map((p) => p.id));
// synthetische DB-Zeilen: je Plan-ID eine volle UUID mit diesem Praefix
const rows = PLAN.map((p, i) => ({ id: `${p.id}-0000-4000-8000-${String(i).padStart(12, '0')}`, description: 'ZZ ' + p.id,
  fix: 'ZZ fix', severity: 'error', model_scope: 'haiku', found_by: 'zz', created_at: '2026-03-28' }));
const auf = planAufloesen(rows, PLAN, E);
pruefe(auf.fehler.length === 0, 'M4 planAufloesen gegen synthetische Zeilen ohne Fehler', auf.fehler.slice(0, 5));
pruefe(auf.hinweise.length === 0, 'M5 keine Kreuztreffer (aktive Signatur trifft kein korrektes Beispiel eines anderen Musters)', auf.hinweise.slice(0, 5));
const zaehl = (a) => auf.eintraege.filter((e) => e.aktion === a).length;
const zahlen = { aktiv: zaehl('aktiv'), th: zaehl('themenhinweis'), d: zaehl('dublette'), s: zaehl('stilllegen'), l: zaehl('loeschen'), n: auf.eintraege.length };
pruefe(zahlen.aktiv === 27 && zahlen.th === 28 && zahlen.d === 29 && zahlen.s === 20 && zahlen.l === 35 && zahlen.n === 139,
  'M6 Zaehlung aktiv 27, themenhinweis 28, dublette 29, stilllegen 20, loeschen 35 = 139', zahlen);
const zz = auf.eintraege.map(zielZustand);
pruefe(zz.filter((z) => z.status === 'aktiv').every((z) => z.severity === 'warning' && z.erkennung.version === 1 && z.statistik.selbsttest_ok),
  'M7 aktiv: severity warning, erkennung.version 1, selbsttest_ok');
pruefe(zz.filter((z) => z.status === 'stillgelegt').every((z) => z.stillgelegt_grund), 'M8 jedes stillgelegte Muster hat einen grund');
const dub = auf.eintraege.filter((e) => e.aktion === 'dublette');
pruefe(dub.every((e) => e.ersetzt_durch_voll && zielZustand(e).ersetzt_durch === e.ersetzt_durch_voll), 'M9 Dubletten zeigen per ersetzt_durch auf das kanonische Muster');
const mem = memoryInhalte(auf.eintraege);
pruefe(mem.length === 1 && mem[0].projekt === 'synapse' && mem[0].anzahl === 14 && !MEMORY_ZIELE['saar-quiz'],
  'M10 nur noch EIN memory (synapse, 14 Prozessregeln), keine saar-quiz-memory', mem.map((m) => ({ p: m.projekt, n: m.anzahl })));
const loesch = zz.filter((z) => z.loeschen);
pruefe(loesch.length === 35 && loesch.every((z) => z.grund && !z.status), 'M11 loeschen: 35 Zielzustaende mit grund, ohne status-Update');
const ziele = new Set(auf.eintraege.map((e) => e.ersetzt_durch_voll).filter(Boolean));
pruefe(!auf.eintraege.some((e) => e.aktion === 'loeschen' && ziele.has(e.voll_id)), 'M12 kein ersetzt_durch zeigt auf ein geloeschtes Muster');
const falscheId = planAufloesen(rows.slice(1), PLAN, E);
pruefe(falscheId.fehler.some((f) => f.includes('0 Treffer')), 'M13 fehlende DB-Zeile wird als Fehler gemeldet');
const extra = planAufloesen([...rows, { ...rows[0], id: 'ffffffff-0000-4000-8000-000000000000', description: 'ZZ extra' }], PLAN, E);
pruefe(extra.fehler.some((f) => f.includes('fehlt im Plan')), 'M14 Muster ohne Plan-Eintrag wird als Fehler gemeldet');
const ohneGrund = planAufloesen(rows, PLAN.map((p) => (p.aktion === 'loeschen' ? { ...p, grund: undefined } : p)), E);
pruefe(ohneGrund.fehler.filter((f) => f.includes('grund fehlt')).length === 35, 'M15 loeschen ohne grund wird abgelehnt');

console.log(`\nERGEBNIS: ${ok} OK, ${fehler} FEHLER`);
process.exit(fehler ? 1 : 0);
