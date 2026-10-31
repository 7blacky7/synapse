/**
 * MODUL: Stau-Schnappschuss (P27-T2/T3, 31.10.2026)
 * ZWECK: Der Stau-Waechter (warteschlangen-waechter.ts) legt hier nach jedem Takt seinen Schnappschuss ab; der Antworthinweis
 *        (tool-antwort.ts, T3) liest ihn NUR von hier. Bewusst ein Blattmodul OHNE Importe: der Hinweisweg kann damit
 *        weder PG noch Netz, Daemon, Schalter oder Embedding erreichen (Architekturvertrag T3/T7e).
 * ZUSTAND: nur im Speicher dieses Prozesses; ein Neustart beginnt leer (keine Meldung, kein 'behoben').
 */

export type StauBewertung = 'gesund' | 'stau' | 'unbekannt' | 'nicht_zutreffend';

export interface StauEintrag {
  /** instanzSchluessel (Ort|Host|Prozess|Boot|Queue|Projekt|Klasse) */
  schluessel: string;
  /** Episode = Schluessel + Beginn; null ausser bei stau */
  episode: string | null;
  name: string;
  ort: string;
  host: string;
  prozess: string;
  boot_id: string;
  projekt: string | null;
  klasse: string | null;
  bewertung: StauBewertung;
  /** kurzer Grund (gekuerzt) */
  grund: string;
  /** seit wann ohne Fortschritt (ISO), nur bei stau */
  seit: string | null;
  seit_min: number | null;
  schwelle_s: number;
  schwelle_quelle: 'einstellung' | 'standard_queue' | 'standard';
  beobachtet_am: string;
  datenalter_s: number;
  dauer_ms: number;
  /** Folgestufe einer Pipeline: Name der verursachenden Stufe (dann kein eigener Hinweis) */
  folge_von: string | null;
  /** Diagnose-Weg (Produkt bzw. intern nur bei SYNAPSE_INTERN_TOOL=1) */
  diagnose: string;
}

export interface StauSchnappschuss {
  /** Schalter warteschlangen_stau wirksam EIN beim Takt */
  aktiv: boolean;
  takt_nr: number;
  erstellt_am: string;
  /** performance.now() beim Erstellen (Alter ohne Uhrenvergleich) */
  erstellt_mono_ms: number;
  /** aelter = kein Hinweis (und kein 'behoben') */
  max_alter_s: number;
  /** Wiederholung eines laufenden Staus je Agent */
  wiederholung_s: number;
  /** hoechstens so viele Eintraege je Antwort */
  hinweis_max: number;
  eintraege: StauEintrag[];
}

let stand: StauSchnappschuss | null = null;

/** Nur der Waechter schreibt. */
export function setzeStauSchnappschuss(s: StauSchnappschuss | null): void {
  stand = s;
}

/** Synchron, ohne I/O. null = noch kein Takt bzw. Waechter nicht gestartet. */
export function stauSchnappschuss(): StauSchnappschuss | null {
  return stand;
}

/**
 * Produkt-Status fuer Verwaltung (admin runtime_ueberwachung status, Web-UI GET /api/main-agent/ueberwachung): nur der
 * Schnappschuss, kein I/O. Funktioniert auch bei intern AUS (Produktionsmodus).
 */
export function stauVerwaltungsStatus(jetztMono: number = performance.now()): Record<string, unknown> {
  if (!stand) {
    return { vorhanden: false, hinweis: 'Kein Schnappschuss: Waechter nicht gestartet (SYNAPSE_WARTESCHLANGEN_STAU_DISABLED=1) oder noch kein Takt.' };
  }
  const alter = Math.max(0, (jetztMono - stand.erstellt_mono_ms) / 1000);
  return {
    vorhanden: true,
    aktiv: stand.aktiv,
    takt_nr: stand.takt_nr,
    erstellt_am: stand.erstellt_am,
    alter_s: Math.round(alter),
    veraltet: alter > stand.max_alter_s,
    gesamt: stand.eintraege.length,
    staus: stand.eintraege.filter((e) => e.bewertung === 'stau').map((e) => ({
      name: e.name, ort: e.ort, host: e.host, projekt: e.projekt, klasse: e.klasse, seit: e.seit, seit_min: e.seit_min,
      grund: e.grund, schwelle_s: e.schwelle_s, schwelle_quelle: e.schwelle_quelle, folge_von: e.folge_von,
    })),
    unbekannt: stand.eintraege.filter((e) => e.bewertung === 'unbekannt').map((e) => ({ name: e.name, ort: e.ort, host: e.host, grund: e.grund })),
  };
}

/** Alter des Schnappschusses in s (Infinity ohne Schnappschuss). */
export function stauSchnappschussAlterS(jetztMono: number = performance.now()): number {
  return stand ? Math.max(0, (jetztMono - stand.erstellt_mono_ms) / 1000) : Number.POSITIVE_INFINITY;
}
