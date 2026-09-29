// Fixture fuer parser-felder-strings.test.mjs — die Zeilen sind im Test verankert.
export interface SucheOptionen {
  projectFilter?: string[];
  limit: number;
  'mit-bindestrich': boolean;
}

type Paar = { links: string; rechts: number };

class Speicher {
  eintraege: string[] = [];
  private zaehler = 0;
  zaehle(): number { return this.zaehler++; }
}

function suche(opts: SucheOptionen, projectFilter: string[]): number {
  const { limit } = opts;
  const auswahl = { projectFilter, limit: 3 };
  return (opts.projectFilter?.length ?? limit) + auswahl.limit + projectFilter.length;
}

log('Dieser Text ist genau vierundsechzig Zeichen lang, kein Symbol!!');
log('Dieser Text ist fuenfundsechzig Zeichen lang und wird erfasst!!!!');
const beschreibung = 'Schon heute als string-Symbol der Variablen erfasst, daher kein zweites Symbol.';
export const werkzeug = { description: 'Datei-CRUD im eigenen Projekt-Verzeichnis. Pfade sind relativ, action=\"create\" (ohne upsert).' };
log(`Vorlage ohne Platzhalter, aber laenger als vierundsechzig Zeichen insgesamt.`);
log(`Vorlage mit ${beschreibung} Platzhalter, laenger als vierundsechzig Zeichen insgesamt.`);
function log(_t: string): void {}
export { suche, Speicher };
export type { Paar };
