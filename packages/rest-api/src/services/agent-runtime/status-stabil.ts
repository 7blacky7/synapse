/**
 * P22-T64: Stabile Bewertung des Runtime-Status (Befund thought 1a233265). Unter RAM-Druck ueberschreitet der kalte CLI-Start
 * ('claude --version', 'claude auth status') das 5-s-Limit der Status-Probe; ein einzelner haengender Lauf wurde bisher als
 * 'nicht installiert / nicht angemeldet' ausgeliefert und die Web-UI sperrte sofort (Flackern).
 *
 * REGEL (Schalter runtime_status_stabil EIN):
 *   - Lauf eindeutig gut (laeuft, installiert, angemeldet)      -> frisch, guter Stand gemerkt, Negativzaehler 0.
 *   - Lauf unklar (timeout, fehler)                             -> letzter guter Stand gilt weiter (haengt=true, Alter, Hinweis),
 *                                                                  solange er juenger als status_guter_stand_minuten ist.
 *   - Lauf eindeutig 'ausgeloggt'                               -> erst nach status_negativ_bestaetigung Laeufen in Folge umschalten,
 *                                                                  bis dahin guter Stand mit Hinweis 'Bestaetigung ausstehend'.
 *   - Container laeuft nicht / CLI nicht installiert            -> sofort frisch (eindeutig), guter Stand verworfen.
 * AUS: Status ungefiltert wie bisher; das Feld pruefung (Debug: letzter Lauf, Dauer, Ergebnis) steht trotzdem in der Antwort.
 * Gleich fuer Claude und Codex (je Treiber eine Instanz).
 */
import { leseRuntimeStatusStabil } from '@synapse/core';
import type { ProbeErgebnis, RuntimeStatus, StatusPruefung } from './types.js';

export type StabilSchalter = Awaited<ReturnType<typeof leseRuntimeStatusStabil>>;

/** Ergebnis eines Laufs aus dem frischen Status. authEindeutig = Ausgabe von auth/login status war lesbar. */
export function klassifiziereLauf(s: RuntimeStatus, authEindeutig: boolean): { ergebnis: ProbeErgebnis; eindeutig: boolean } {
  if (s.diagnostic) return { ergebnis: s.diagnostic.code === 'probe_timeout' ? 'timeout' : 'fehler', eindeutig: false };
  if (s.container.status === 'error') return { ergebnis: 'fehler', eindeutig: false };
  if (s.container.status !== 'running') return { ergebnis: 'container_aus', eindeutig: true };
  if (!s.installed) return { ergebnis: 'nicht_installiert', eindeutig: true };
  if (s.authentication.status === 'authenticated') return { ergebnis: 'ok', eindeutig: true };
  if (s.authentication.status === 'not_authenticated' && authEindeutig) return { ergebnis: 'ausgeloggt', eindeutig: true };
  return { ergebnis: 'fehler', eindeutig: false };
}

export class StatusStabilisierer {
  private gut: { status: RuntimeStatus; zeit: number } | null = null;
  private negativ = 0;

  constructor(
    private readonly schalter: () => Promise<StabilSchalter> = leseRuntimeStatusStabil,
    private readonly now: () => number = Date.now,
  ) {}

  async bewerte(frisch: RuntimeStatus, authEindeutig: boolean, dauerMs: number): Promise<RuntimeStatus> {
    const jetzt = this.now();
    const { ergebnis, eindeutig } = klassifiziereLauf(frisch, authEindeutig);
    let sch: StabilSchalter;
    try { sch = await this.schalter(); } catch { sch = { aktiv: false, quelle: 'standard', negativ_bestaetigung: 2, guter_stand_minuten: 10, letzter_fehler: 'schalter_nicht_lesbar' }; }
    const lauf = { zeit: new Date(jetzt).toISOString(), dauer_ms: Math.max(0, Math.round(dauerMs)), ergebnis, eindeutig,
      meldung: frisch.diagnostic?.message ?? frisch.lastError ?? null };

    if (ergebnis === 'ok') { this.gut = { status: frisch, zeit: jetzt }; this.negativ = 0; }
    else if (ergebnis === 'ausgeloggt') this.negativ++;
    else if (ergebnis === 'container_aus' || ergebnis === 'nicht_installiert') { this.gut = null; this.negativ = 0; }

    const gutAlter = this.gut ? jetzt - this.gut.zeit : null;
    const gutGueltig = !!this.gut && gutAlter !== null && gutAlter <= sch.guter_stand_minuten * 60_000;
    const pruefung = (quelle: StatusPruefung['quelle'], haengt: boolean, hinweis: string | null): StatusPruefung => ({
      schalter: { aktiv: sch.aktiv, quelle: sch.quelle }, letzter_lauf: lauf, quelle,
      bestaetigt_am: this.gut ? new Date(this.gut.zeit).toISOString() : null,
      alter_sekunden: gutAlter === null ? null : Math.round(gutAlter / 1000), haengt, negativ_in_folge: this.negativ, hinweis,
    });

    if (ergebnis === 'ok' || !sch.aktiv || !gutGueltig) {
      if (ergebnis === 'ausgeloggt' && this.negativ >= sch.negativ_bestaetigung) this.gut = null;
      const hinweis = !sch.aktiv && !eindeutig ? 'Pruefung ' + ergebnis + ' (Schalter runtime_status_stabil AUS: ungefiltert)'
        : sch.aktiv && !eindeutig && this.gut && !gutGueltig ? 'Pruefung haengt; letzter guter Stand aelter als ' + sch.guter_stand_minuten + ' min' : null;
      return { ...frisch, pruefung: pruefung('frisch', !eindeutig, hinweis) };
    }
    const alterText = Math.round((gutAlter ?? 0) / 1000) + ' s';
    if (ergebnis === 'ausgeloggt') {
      if (this.negativ >= sch.negativ_bestaetigung) {
        this.gut = null;
        return { ...frisch, pruefung: pruefung('frisch', false, 'nicht angemeldet bestaetigt (' + this.negativ + 'x in Folge)') };
      }
      return { ...this.gut!.status, pruefung: pruefung('letzter_guter_stand', false,
        'CLI meldet nicht angemeldet, Bestaetigung ausstehend (' + this.negativ + '/' + sch.negativ_bestaetigung + '); angemeldet, geprueft vor ' + alterText) };
    }
    return { ...this.gut!.status, pruefung: pruefung('letzter_guter_stand', true,
      'Pruefung haengt (' + ergebnis + ', ' + lauf.dauer_ms + ' ms); angemeldet, geprueft vor ' + alterText) };
  }
}
