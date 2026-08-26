/**
 * EIN TEST GEGEN DIE ECHTE DATENBANK: listeProjekte() muss 'synapse' liefern.
 *
 * WOZU: Fall 2 aus muster-stille-teilantwort — GET /api/projects leitete die
 * Projektliste aus den Qdrant-Collections ab: 476 Namen, das echte Projekt
 * fehlte. Ein Unit-Test mit gefaktem Qdrant waere gruen gewesen; diese Frage
 * kann nur die echte PG beantworten
 * (regel-postgres-ist-die-wahrheit-qdrant-ist-abgeleitet).
 * Zweck ist nicht Abdeckung, sondern der Nachweis, dass ueberhaupt ein Test
 * die echte Datenbank beruehrt. Der Test LIEST AUSSCHLIESSLICH.
 *
 * AUFRUF (braucht die DB-Umgebung des Projekts):
 *   set -a; . ./.env; set +a; node packages/core/tests/pg-projekt-registry.test.mjs
 * Exit 0 = 'synapse' steht in der Registry. Exit 1 = fehlt, oder DB nicht erreichbar.
 * Braucht ein gebautes packages/core/dist, baut NICHT selbst.
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const hier = dirname(fileURLToPath(import.meta.url));

let projekte;
try {
  const { listeProjekte } = await import(join(hier, '..', 'dist', 'services', 'project-registry.js'));
  projekte = await listeProjekte();
} catch (fehler) {
  // Ein fehlender Dienst muss als FEHLER ankommen — sonst sieht "nicht
  // erreichbar" aus wie "nichts vorhanden" (muster-stille-teilantwort, Fall 1).
  console.error('FEHLER  Datenbank oder Modul nicht erreichbar: ' + (fehler instanceof Error ? fehler.message : String(fehler)));
  process.exit(1);
}

const treffer = projekte.find((p) => p.name === 'synapse');
const aktive = projekte.filter((p) => p.enabled).length;
console.log('GEMESSEN  ' + projekte.length + ' Projekte in der Registry, davon ' + aktive + ' aktiv');

if (!treffer) {
  console.error("FEHLER  'synapse' fehlt in der Registry-Antwort — exakt Fall 2 aus muster-stille-teilantwort");
  process.exit(1);
}
console.log("OK      'synapse' vorhanden (enabled=" + treffer.enabled + ', path=' + treffer.path + ')');
process.exit(0);
