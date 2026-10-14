/**
 * P12-T13 Teil 2 (11.10.2026): SKILLS PG-FIRST SCHREIBEN — nur gegen die Test-DB.
 *  S1 add_section-Weg: Zeile in PG, embedded_at NULL -> Hintergrund-Nachtrag schreibt den Punkt
 *     (gleiche ID) in die Skill-Collection und setzt embedded_at.
 *  S2 gleicher Inhalt erneut: unveraendert, kein neuer Punkt. Modus anlegen auf Vorhandenes und
 *     aendern auf Fehlendes -> SkillSchreibFehler, nichts geschrieben.
 *  S3 Lesen aus PG (list/get_section/get_full), obwohl die Fake-Qdrant beim Scroll nichts liefert.
 *  S4 ersetzeSkill (Massenweg): kein eigenes Einbetten, Entferntes geloescht (PG + Qdrant-Delete);
 *     embeddeOffeneEintraege kennt skill_sections (zaehleOffeneEmbeddings).
 *  S5 loescheSkill: PG leer, skill_names-Zeile weg, Qdrant-Delete per ID und per Namensfilter.
 * Fake-Ollama + Fake-Qdrant lokal; bricht ab (Exit 2), wenn DB/Qdrant/Ollama nicht die Test-Ziele sind.
 * AUFRUF: (DATABASE_URL = Projekt-DB aus dem Synapse-shell-Job) node packages/core/tests/skills-pg-first.test.mjs
 */
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { pruefeTestDbUrl } from '../../../scripts/lib/test-db-schutz.mjs';
pruefeTestDbUrl('skills-pg-first.test');

const anfragen = [];
const embedAufrufe = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'fake-embed' }] }));
    if (req.url === '/api/embeddings') return res.end(JSON.stringify({ embedding: [0.1, 0.2, 0.3, 0.4] }));
    // P12-T14: der Provider spricht /api/embed (Listen). P15-T4: Aufrufe mitzaehlen (Stapel = ein Aufruf).
    if (req.url === '/api/embed') {
      const eingabe = JSON.parse(body).input;
      const liste = Array.isArray(eingabe) ? eingabe : [eingabe];
      embedAufrufe.push(liste.length);
      return res.end(JSON.stringify({ embeddings: liste.map(() => [0.1, 0.2, 0.3, 0.4]) }));
    }
    if (req.url?.startsWith('/collections/')) {
      anfragen.push({ methode: req.method, url: req.url, body: body ? JSON.parse(body) : null });
      if (req.url.includes('/points/scroll')) return res.end(JSON.stringify({ result: { points: [], next_page_offset: null } }));
      return res.end(JSON.stringify({ result: { status: 'completed' }, status: 'ok' }));
    }
    res.statusCode = 404; res.end('{}');
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const FAKE = `http://127.0.0.1:${server.address().port}`;
process.env.EMBEDDING_PROVIDER = 'ollama';
process.env.OLLAMA_URL = FAKE;
process.env.OLLAMA_MODEL = 'fake-embed';
// P15-T8: Praefixe kommen sonst aus dem Modellprofil (PG) - hier ohne Praefix.
process.env.EMBEDDING_QUERY_PREFIX = '';
process.env.EMBEDDING_DOC_PREFIX = '';
process.env.QDRANT_URL = FAKE;
process.env.SKILL_QDRANT_URL = FAKE;
delete process.env.EMBEDDING_TARGET_DIM;

const hier = dirname(fileURLToPath(import.meta.url));
const dist = join(hier, '..', 'dist');
const { getConfig } = await import(join(dist, 'config.js'));
if (getConfig().qdrant.url !== FAKE || getConfig().embeddings.ollama.url !== FAKE) {
  console.error('ABBRUCH: Qdrant/Ollama zeigen nicht auf die Test-Attrappe.');
  process.exit(2);
}
const skills = await import(join(dist, 'services', 'skills.js'));
const backlog = await import(join(dist, 'services', 'embed-backlog.js'));
const nachzug = await import(join(dist, 'services', 'embed-nachzug.js'));
const db = await import(join(dist, 'db', 'client.js'));
const pool = db.getPool();

const S = 'pgfirst-test-skill';
let fehler = 0;
const pruefe = (b, text, detail) => { if (b) console.log('OK      ' + text); else { fehler++; console.error('FEHLER  ' + text + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 500) : '')); } };
const zeile = async (section) => (await pool.query('SELECT punkt_id::text AS id, content, embedded_at, embedding_modell FROM skill_sections WHERE skill_name=$1 AND section=$2', [S, section])).rows[0];
const warte = (ms) => new Promise((r) => setTimeout(r, ms));
const aufraeumen = async () => {
  await pool.query('DELETE FROM skill_sections WHERE skill_name = $1', [S]);
  await pool.query('DELETE FROM skill_names WHERE skill_name = $1', [S]);
};

try {
  await aufraeumen();
  // S1
  const r1 = await skills.speichereSkillSection({ skill_name: S, section: 'eins', content: 'Inhalt eins', tags: ['a'] }, { modus: 'anlegen' });
  pruefe(r1.status === 'neu' && r1.embeddings_pending, 'S1: neu angelegt, embeddings_pending', r1);
  await warte(500);
  const z1 = await zeile('eins');
  const put1 = anfragen.find((a) => a.methode === 'PUT' && a.body?.points?.[0]?.id === Number(z1?.id));
  pruefe(z1 && z1.embedded_at && z1.embedding_modell && put1?.body.points[0].payload.content === 'Inhalt eins',
    'S1: Hintergrund-Nachtrag schrieb den Punkt (gleiche ID) und setzte embedded_at', { z1, put1 });
  // S2
  const vorher = anfragen.length;
  const r2 = await skills.speichereSkillSection({ skill_name: S, section: 'eins', content: 'Inhalt eins', tags: ['a'] });
  await warte(200);
  pruefe(r2.status === 'unveraendert' && anfragen.length === vorher, 'S2: gleicher Inhalt -> unveraendert, kein Schreiben', r2);
  const doppelt = await skills.speichereSkillSection({ skill_name: S, section: 'eins', content: 'x' }, { modus: 'anlegen' }).catch((e) => e);
  const fehlt = await skills.speichereSkillSection({ skill_name: S, section: 'gibtsnicht', content: 'x' }, { modus: 'aendern' }).catch((e) => e);
  pruefe(doppelt?.code === 'exists' && fehlt?.code === 'not_found' && (await zeile('eins')).content === 'Inhalt eins' && !(await zeile('gibtsnicht')),
    'S2: anlegen auf Vorhandenes / aendern auf Fehlendes -> Fehler, nichts geschrieben', { doppelt: doppelt?.code, fehlt: fehlt?.code });
  const r2b = await skills.speichereSkillSection({ skill_name: S, section: 'eins', content: 'Inhalt eins neu' }, { modus: 'aendern', nurBacklog: true });
  const z2 = await zeile('eins');
  pruefe(r2b.status === 'geaendert' && z2.embedded_at === null && z2.id === z1.id, 'S2: aendern -> gleiche punkt_id, embedded_at NULL (nurBacklog)', { r2b, z2 });
  // S3
  await skills.speichereSkillSection({ skill_name: S, section: 'zwei', content: 'Inhalt zwei' }, { nurBacklog: true });
  const liste = (await skills.listSkills(S))[0];
  const sec = await skills.getSkillSection(S, 'zwei');
  const voll = await skills.getSkillFull(S);
  pruefe(liste?.quelle === 'pg' && liste.section_count === 2 && sec?.content === 'Inhalt zwei' && voll.length === 2,
    'S3: list/get_section/get_full aus PG (Fake-Qdrant liefert nichts)', { liste, sec, n: voll.length });
  const name = (await pool.query('SELECT section_count FROM skill_names WHERE skill_name=$1', [S])).rows[0];
  pruefe(name?.section_count === 2, 'S3: skill_names zaehlt mit', name);
  // S4
  const putVorher = anfragen.filter((a) => a.methode === 'PUT').length;
  const r4 = await skills.ersetzeSkill(S, [{ section: 'eins', content: 'Inhalt eins neu' }, { section: 'drei', content: 'Inhalt drei' }]);
  await warte(300);
  const del4 = anfragen.filter((a) => a.url.includes('/points/delete')).pop();
  pruefe(r4.unveraendert === 1 && r4.neu === 1 && r4.geloescht === 1 && !(await zeile('zwei'))
    && anfragen.filter((a) => a.methode === 'PUT').length === putVorher && Array.isArray(del4?.body?.points),
    'S4: ersetzeSkill — unveraendert/neu/geloescht korrekt, kein eigenes Einbetten, Qdrant-Delete per ID', { r4, del4 });
  const offen = await backlog.zaehleOffeneEmbeddings();
  pruefe(typeof offen.skill_sections === 'number' && offen.skill_sections >= 2, 'S4: Backlog kennt skill_sections (offene Zeilen gezaehlt)', offen);
  const z3 = await zeile('drei');
  await skills.embeddeSkillSectionNach(null, z3.id, { priority: 'background' });
  pruefe((await zeile('drei')).embedded_at !== null, 'S4: Nachtrag (wie im Backlog) bettet die Massen-Zeile ein', null);
  // S4b (P15-T4): Backlog im Stapel — zwei offene Sections in EINEM Ollama-Aufruf und EINEM Qdrant-PUT
  await skills.speichereSkillSection({ skill_name: S, section: 'vier', content: 'Inhalt vier' }, { nurBacklog: true });
  const offenEins = await zeile('eins');
  const offenVier = await zeile('vier');
  const aufrufeVorher = embedAufrufe.length;
  const erg = await backlog.embeddeOffeneEintraege(500, undefined, 'skill_sections');
  const putStapel = anfragen.filter((a) => a.methode === 'PUT' && a.body?.points?.length >= 2)
    .find((a) => [offenEins.id, offenVier.id].every((id) => a.body.points.some((p) => p.id === Number(id))));
  const pVier = putStapel?.body.points.find((p) => p.id === Number(offenVier.id));
  const neueAufrufe = embedAufrufe.slice(aufrufeVorher);
  pruefe(erg.fehlgeschlagen === 0 && (await zeile('eins')).embedded_at && (await zeile('vier')).embedded_at
    && (await zeile('vier')).embedding_modell && pVier?.payload.content === 'Inhalt vier' && pVier.payload.skill_name === S
    && pVier.payload.embedding_modell && neueAufrufe.some((n) => n >= 2),
    'S4b: Backlog bettet im Stapel ein (ein /api/embed mit mehreren Texten, ein PUT, embedded_at + Modell gesetzt)', { erg, neueAufrufe, pVier });
  // S4c (P15-T4): Stand-Schutz — aendert sich der Inhalt waehrend des Einbettens, bleibt embedded_at NULL
  await skills.speichereSkillSection({ skill_name: S, section: 'vier', content: 'Inhalt vier B' }, { modus: 'aendern', nurBacklog: true });
  const punkte = await skills.skillSectionNachzug.lese([offenVier.id]);
  await skills.speichereSkillSection({ skill_name: S, section: 'vier', content: 'Inhalt vier C' }, { modus: 'aendern', nurBacklog: true });
  const markiert = await nachzug.markiereEingebettet(skills.skillSectionNachzug, punkte);
  pruefe(punkte.length === 1 && markiert === 0 && (await zeile('vier')).embedded_at === null,
    'S4c: Inhalt nach dem Lesen geaendert -> markiereEingebettet setzt embedded_at NICHT', { markiert });
  // S5
  const r5 = await skills.loescheSkill(S);
  const rest = (await pool.query('SELECT count(*)::int AS n FROM skill_sections WHERE skill_name=$1', [S])).rows[0].n;
  const nameWeg = (await pool.query('SELECT count(*)::int AS n FROM skill_names WHERE skill_name=$1', [S])).rows[0].n;
  const dels = anfragen.filter((a) => a.url.includes('/points/delete')).slice(-2);
  pruefe(r5.geloescht === 3 && rest === 0 && nameWeg === 0 && dels.some((d) => Array.isArray(d.body?.points)) && dels.some((d) => d.body?.filter),
    'S5: loescheSkill — PG leer, skill_names weg, Qdrant-Delete per ID und per Namensfilter', { r5, rest, nameWeg });
} catch (e) {
  fehler++;
  console.error('ABBRUCH ' + (e?.stack ?? e));
} finally {
  await aufraeumen().catch(() => {});
  await db.closePool();
  server.close();
}
console.log(fehler === 0 ? 'ALLE PRUEFUNGEN GRUEN' : `${fehler} FEHLER`);
process.exit(fehler === 0 ? 0 : 1);
