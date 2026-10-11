/**
 * PRUEFT DIE BIBLIOTHEKSWAHL DES CONTEXT7-CLIENTS GEGEN MOCK-ERGEBNISLISTEN (P12-T17-Fix).
 *
 * WOZU: Die Context7-Automatik hat am 11.10.2026 in Produktion "Flask" auf
 * /maxcountryman/flask-login gesetzt und 312 fremde Chunks unter "flask" gespeichert — der
 * alte Namensabgleich hielt den Bindestrich fuer eine Wortgrenze, die Wahl lief nach
 * benchmarkScore. Seitdem gilt (bewerteNamen): exakt (title oder letzter id-Teil = Name) >
 * Titel-Wort (Titel nennt den Namen und sonst nur Doku-Woerter, "Flask Documentation") >
 * nicht gefunden; je Stufe trustScore, dann totalSnippets. Dieser Test haelt die Rangfolge fest.
 *
 * SOLLWERTE: Die hono-Liste ist eine ECHTE /v2/libs/search-Antwort (gemessen 11.10.2026),
 * die uebrigen Listen sind nachgebaut (Felder wie in der echten Antwort). Die Scores sind
 * absichtlich so gesetzt, dass das FALSCHE Paket den hoeheren trust/benchmarkScore hat —
 * sonst bestuende der Test auch mit der alten, kaputten Wahl.
 *
 * AUFRUF:
 *   node packages/core/tests/context7-bibliothekswahl.test.mjs
 * Exit 0 = alle Zusagen erfuellt, Exit 1 = mindestens eine verletzt.
 * Braucht ein gebautes packages/core/dist, baut NICHT selbst. Keine DB, kein Netz
 * (waehleBibliothek und bewerteNamen sind rein; der Client-Konstruktor liest nur die Config).
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const hier = dirname(fileURLToPath(import.meta.url));
const { Context7Client, bewerteNamen } = await import(join(hier, '..', 'dist', 'services', 'context7.js'));
const client = new Context7Client();

const bib = (id, title, trustScore = 5, totalSnippets = 100, benchmarkScore = 50) =>
  ({ id, title, trustScore, totalSnippets, benchmarkScore, versions: [] });

let fehler = 0;
function pruefe(name, liste, sollId, sollStufe, bevorzugteId) {
  const wahl = client.waehleBibliothek(liste, name, bevorzugteId);
  const istId = wahl?.bib.id ?? null;
  const istStufe = wahl?.stufe ?? null;
  const ok = istId === sollId && istStufe === sollStufe;
  if (!ok) fehler++;
  console.log(`${ok ? 'OK   ' : 'FEHLT'}  ${name.padEnd(16)} -> ${String(istId).padEnd(36)} (${istStufe})${ok ? '' : `   SOLL ${sollId} (${sollStufe})`}`);
}

// ── flask: das Produktionsbeispiel ──
const flask = [
  bib('/maxcountryman/flask-login', 'Flask-Login', 9.8, 312, 95),
  bib('/pallets-eco/flask-sqlalchemy', 'Flask-SQLAlchemy', 9.5, 400, 92),
  bib('/pallets/flask', 'Flask', 8.7, 900, 80),
];
pruefe('Flask', flask, '/pallets/flask', 'exakt');
pruefe('Flask', flask.slice(0, 2), null, null); // nur Plugins -> nicht gefunden
// Offizielle Doku unter Kompositum-id: der Titel entscheidet
const flaskDoku = [...flask.slice(0, 2), bib('/websites/flask_palletsprojects', 'Flask Documentation', 9.0, 1500, 85)];
pruefe('Flask', flaskDoku, '/websites/flask_palletsprojects', 'wort');

// ── react ──
const react = [
  bib('/remix-run/react-router', 'React Router', 9.9, 2000, 95),
  bib('/facebook/react-native', 'React Native', 9.8, 3000, 94),
  bib('/reactjs/react.dev', 'React', 9.0, 1800, 85),
];
pruefe('react', react, '/reactjs/react.dev', 'exakt');
pruefe('react', react.slice(0, 2), null, null); // Router/Native sind andere Pakete

// ── next ──
const next = [
  bib('/nextauthjs/next-auth', 'NextAuth.js', 9.5, 1200, 90),
  bib('/vercel/next.js', 'Next.js', 9.0, 3000, 80),
];
pruefe('Next.js', next, '/vercel/next.js', 'exakt');
pruefe('Next.js', next.slice(0, 1), null, null);

// ── pg: npm "pg" ist der Client node-postgres (Anzeigename seit dem Fix 'node-postgres') ──
const pg = [
  bib('/websites/postgresql', 'PostgreSQL', 9.5, 5000, 90),
  bib('/brianc/node-postgres', 'node-postgres', 8.0, 300, 70),
];
pruefe('node-postgres', pg, '/brianc/node-postgres', 'exakt');
pruefe('node-postgres', pg.slice(0, 1), null, null); // Server-Doku ist nicht der Client
// Klammerzusatz zaehlt als Name
pruefe('Foo (bar)', [bib('/x/bar', 'bar', 7, 50)], '/x/bar', 'exakt');

// ── zod ──
const zod = [
  bib('/aiji42/zod-i18n', 'zod-i18n', 9.9, 50, 99),
  bib('/fabian-hiller/valibot', 'Valibot', 9.5, 400, 90),
  bib('/colinhacks/zod', 'Zod', 9.0, 600, 85),
];
pruefe('zod', zod, '/colinhacks/zod', 'exakt');

// ── hono: ECHTE Antwort vom 11.10.2026 — alle fuenf heissen "Hono", also entscheidet trust, dann Snippets ──
const hono = [
  bib('/websites/hono_dev', 'Hono', 9.6, 1437, 86.98),
  bib('/honojs/website', 'Hono', 7.3, 1477, 84.73),
  bib('/honojs/hono', 'Hono', 7.3, 845, 77.23),
  bib('/llmstxt/hono_dev_llms-full_txt', 'Hono', 9.6, 1757, 81.73),
  bib('/llmstxt/hono_dev_llms_txt', 'Hono', 9.6, 1415, 81.76),
];
pruefe('hono', hono, '/llmstxt/hono_dev_llms-full_txt', 'exakt');
pruefe('hono', hono, '/honojs/hono', 'exakt', '/honojs/hono'); // gemerkte library_id bleibt

// ── Stufe 'wort' und Abgrenzung ──
pruefe('Tailwind CSS', [bib('/tailwindlabs/tailwindcss.com', 'Tailwind CSS Docs', 8, 900)], '/tailwindlabs/tailwindcss.com', 'wort');
pruefe('Tailwind CSS', [
  bib('/tailwindlabs/tailwindcss.com', 'Tailwind CSS Docs', 9.9, 900),
  bib('/websites/tailwindcss', 'Tailwind CSS', 7, 100),
], '/websites/tailwindcss', 'exakt'); // exakt schlaegt wort trotz geringerem trust
pruefe('archive', [bib('/node-archiver/archiver', 'Archiver', 9, 100)], null, null);
pruefe('flask', [bib('/websites/flask_extras', 'Extras', 9, 100)], null, null); // Titel gibt nichts her, id nur Kompositum

// ── bewerteNamen direkt ──
const stufen = [
  ['Flask', '/maxcountryman/flask-login', 'Flask-Login', null],
  ['Flask', '/pallets/flask', 'Flask', 'exakt'],
  ['Flask', '/websites/flask_palletsprojects', 'Flask Documentation', 'wort'],
  ['react', '/remix-run/react-router', 'React Router', null],
  ['react', '/facebook/react-native', 'React Native', null],
  ['OpenAI SDK', '/openai/openai-node', 'OpenAI', 'exakt'],
  ['mysql2', '/sidorares/node-mysql2', 'MySQL2', 'exakt'],
  ['ioredis', '/redis/ioredis', 'ioredis', 'exakt'],
  ['better-sqlite3', '/wiselibs/better-sqlite3', 'better-sqlite3', 'exakt'],
];
for (const [name, id, title, soll] of stufen) {
  const ist = bewerteNamen({ id, title }, name);
  const ok = ist === soll;
  if (!ok) fehler++;
  console.log(`${ok ? 'OK   ' : 'FEHLT'}  bewerteNamen(${name}, ${id}, "${title}") = ${ist}${ok ? '' : `   SOLL ${soll}`}`);
}

console.log(fehler ? `\n${fehler} Zusage(n) verletzt` : '\nAlle Zusagen erfuellt');
process.exit(fehler ? 1 : 0);
