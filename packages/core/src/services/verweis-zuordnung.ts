/**
 * P4-T80: Verweise einer Datei ihren Symbolen zuordnen - rein, ohne DB, damit testbar.
 *
 * ANLASS 25.10.2026: Die Zuordnung lief in parseAndEmbed als references.filter() je Symbol, ueber den
 * NAMEN. In minifiziertem Code heissen hunderte Symbole 'n', 'r', 'e' - jedes bekam jeden gleichnamigen
 * Verweis (627 Symbole 'n' x 4.188 Verweise 'n'). Ein 962-KB-Vite-Bundle ergab so 20.992.623
 * Verweiszeilen im Haupt-Thread, der Heap lief auf 6 GB, die API starb und startete im Minutentakt neu.
 * Der Parser selbst war unauffaellig (1,2 s im Worker). Normale Dateien liegen Groessenordnungen
 * darunter (SynapseWorkspaceMock.tsx: 1.827 Verweise -> 3.910 Zeilen).
 *
 * VERHALTEN:
 *   - Unterhalb des Deckels exakt wie vorher: dieselben Verweise je Symbol, in Dateireihenfolge.
 *   - Zuordnung per Map statt Filter je Symbol (vorher O(Symbole x Verweise)).
 *   - Ueber PARSER_MAX_VERWEISZEILEN (Standard 500.000; 0 = kein Deckel) bleiben Namen mit mehr als
 *     PARSER_MAX_GLEICHNAMIGE (Standard 20) Symbolen unverknuepft - bei so vielen Kandidaten sagt die
 *     Namensgleichheit nichts. Reicht das nicht, bekommt die Datei keine Verweise.
 *   Die Symbole selbst bleiben immer vollstaendig.
 */

export interface ZuordnungsSymbol {
  name?: string | null;
  symbol_type: string;
  params?: string[];
}

export interface ZuordnungsVerweis {
  symbol_name: string;
  nur_feld?: boolean;
}

export interface VerweisGrenzen {
  /** Hoechstzahl Verweiszeilen je Datei; 0 = kein Deckel. */
  maxZeilen: number;
  /** Ueber dem Deckel: Namen mit mehr Symbolen bleiben unverknuepft. */
  maxGleichnamige: number;
}

export interface VerweisZuordnung<V> {
  /** Je Symbol (gleicher Index wie die Eingabe) die zugeordneten Verweise. */
  jeSymbol: V[][];
  zeilen: number;
  /** Gesetzt, wenn der Deckel gegriffen hat. */
  gekappt: { zeilenOhneDeckel: number; uebergangeneNamen: number; alleVerworfen: boolean } | null;
}

function zahlAusEnv(name: string, standard: number): number {
  const roh = process.env[name];
  // Leerstring nicht als 0 werten - das wuerde den Deckel still abschalten.
  const wert = roh === undefined || roh.trim() === '' ? NaN : Number(roh);
  return Number.isSafeInteger(wert) && wert >= 0 ? wert : standard;
}

export function leseVerweisGrenzen(): VerweisGrenzen {
  return {
    maxZeilen: zahlAusEnv('PARSER_MAX_VERWEISZEILEN', 500_000),
    maxGleichnamige: zahlAusEnv('PARSER_MAX_GLEICHNAMIGE', 20),
  };
}

const schluessel = (name: string, feld: boolean): string => (feld ? '1' : '0') + '\u0000' + name;

export function verweiseJeSymbol<V extends ZuordnungsVerweis>(
  symbole: readonly ZuordnungsSymbol[],
  verweise: readonly V[],
  grenzen: VerweisGrenzen = leseVerweisGrenzen(),
): VerweisZuordnung<V> {
  if (verweise.length === 0) return { jeSymbol: symbole.map(() => []), zeilen: 0, gekappt: null };

  // Verweis-Indizes je (Name, nur_feld) in Dateireihenfolge.
  const jeSchluessel = new Map<string, number[]>();
  verweise.forEach((r, i) => {
    const k = schluessel(r.symbol_name, r.nur_feld === true);
    const liste = jeSchluessel.get(k);
    if (liste) liste.push(i);
    else jeSchluessel.set(k, [i]);
  });

  // Dieselbe Namenswahl wie bisher: bei Imports enthaelt params die einzelnen Namen, name ist
  // komma-separiert. Feld-Verweise (nur_feld) gehoeren NUR zu field-Symbolen, alle anderen NIE.
  const symSchluessel: string[][] = symbole.map((s) => {
    if (!s.name) return [];
    const namen = s.symbol_type === 'import' && s.params ? new Set(s.params) : new Set([s.name]);
    const feld = s.symbol_type === 'field';
    return [...namen].map((n) => schluessel(n, feld)).filter((k) => jeSchluessel.has(k));
  });

  const zaehle = (erlaubt: (k: string) => boolean): number => {
    let summe = 0;
    for (const ks of symSchluessel) for (const k of ks) if (erlaubt(k)) summe += jeSchluessel.get(k)!.length;
    return summe;
  };
  const alle = (): boolean => true;
  const ohneDeckel = zaehle(alle);
  let erlaubt: (k: string) => boolean = alle;
  let gekappt: VerweisZuordnung<V>['gekappt'] = null;

  if (grenzen.maxZeilen > 0 && ohneDeckel > grenzen.maxZeilen) {
    const symboleJeSchluessel = new Map<string, number>();
    for (const ks of symSchluessel) for (const k of ks) symboleJeSchluessel.set(k, (symboleJeSchluessel.get(k) ?? 0) + 1);
    const mehrdeutig = new Set<string>();
    for (const [k, n] of symboleJeSchluessel) if (n > grenzen.maxGleichnamige) mehrdeutig.add(k);
    const eindeutig = (k: string): boolean => !mehrdeutig.has(k);
    const alleVerworfen = zaehle(eindeutig) > grenzen.maxZeilen;
    erlaubt = alleVerworfen ? () => false : eindeutig;
    gekappt = { zeilenOhneDeckel: ohneDeckel, uebergangeneNamen: mehrdeutig.size, alleVerworfen };
  }

  let zeilen = 0;
  const jeSymbol = symSchluessel.map((ks) => {
    const gewaehlt = ks.filter(erlaubt);
    if (gewaehlt.length === 0) return [];
    // Mehrere Namen (Import): zusammenfuehren in Dateireihenfolge, wie beim frueheren filter().
    const idx = gewaehlt.length === 1
      ? jeSchluessel.get(gewaehlt[0])!
      : gewaehlt.flatMap((k) => jeSchluessel.get(k)!).sort((a, b) => a - b);
    zeilen += idx.length;
    return idx.map((i) => verweise[i]);
  });
  return { jeSymbol, zeilen, gekappt };
}
