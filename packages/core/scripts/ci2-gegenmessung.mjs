/**
 * CI-2 GEGENMESSUNG (15.08.2026)
 *
 * Beantwortet EINE Frage: kommt an, was die Vorab-Messung versprochen hat?
 *
 * SPALTEN
 *   belegt   = Dateien, die den Text nachweislich enthalten (ILIKE).
 *   frueher  = davon die, die tsv allein NICHT findet — der Zustand vor CI-2.
 *   jetzt    = davon die, die WEDER tsv NOCH tsv_zerlegt findet — der Zustand mit CI-2.
 *
 * ⚠️ ILIKE ist Teilstring: "printf" trifft auch sprintf/fprintf, "self." auch Fliesstext.
 * Die Prozente sind daher eher eine Untergrenze der Heilung, nicht das letzte Wort.
 * Beide Spalten messen dieselbe Grundmenge, der VERGLEICH ist dadurch belastbar.
 */
import pg from 'pg';

const BEGRIFFE = [
  'this.', 'System.out', 'self.', 'printf', 'db.query', 'Log.', 'logger',
  'Request', 'async', 'await', 'console.log', 'std::', 'okhttp', 'res.json', 'fmt.Println',
];

// Anfrage und Text muessen GLEICH zerlegt werden — sonst sucht man 'system.out'
// in einem Index, der nur 'system' und 'out' kennt.
const ZERLEGT = `regexp_replace($1, '[^A-Za-z0-9]+', ' ', 'g')`;

const client = new pg.Client({
  connectionString: 'postgresql://synapse:synapse2026@192.168.50.65:5432/synapse',
});
await client.connect();
await client.query("SET statement_timeout='900s'");

console.log('BEGRIFF       | belegt | frueher | jetzt | geheilt');
console.log('--------------+--------+---------+-------+--------');

let summeFrueher = 0;
let summeJetzt = 0;

for (const begriff of BEGRIFFE) {
  const { rows } = await client.query(
    `WITH belegt AS (
       SELECT tsv, tsv_zerlegt FROM code_files
        WHERE deleted_at IS NULL AND content ILIKE '%' || $1 || '%'
     )
     SELECT count(*)::int AS belegt,
            count(*) FILTER (
              WHERE NOT (tsv @@ plainto_tsquery('english', $1))
            )::int AS frueher,
            count(*) FILTER (
              WHERE NOT (tsv @@ plainto_tsquery('english', $1))
                AND NOT (tsv_zerlegt @@ plainto_tsquery('simple', ${ZERLEGT}))
            )::int AS jetzt
       FROM belegt`,
    [begriff],
  );
  const { belegt, frueher, jetzt } = rows[0];
  summeFrueher += frueher;
  summeJetzt += jetzt;
  const geheilt = frueher > 0 ? Math.round((100 * (frueher - jetzt)) / frueher) : 0;
  console.log(
    begriff.padEnd(13) + '|' + String(belegt).padStart(7) + ' |' +
    String(frueher).padStart(8) + ' |' + String(jetzt).padStart(6) + ' |' +
    String(geheilt).padStart(6) + '%',
  );
}

console.log('--------------+--------+---------+-------+--------');
console.log(
  'SUMME'.padEnd(13) + '|        |' + String(summeFrueher).padStart(8) + ' |' +
  String(summeJetzt).padStart(6) + ' |' +
  String(summeFrueher > 0 ? Math.round((100 * (summeFrueher - summeJetzt)) / summeFrueher) : 0).padStart(6) + '%',
);

await client.end();
process.exit(0);
