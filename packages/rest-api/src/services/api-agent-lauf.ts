/**
 * P22-T183 B6: LAUF-VERWALTUNG der API-Agenten IM synapse-api-Prozess (kein Runtime-Container, kein Wrapper).
 * PG-Seite (Schalter, Einstellwerte, Eingang, Stand, Steuerung): core services/api-agent-lauf-dienst.ts.
 * TAKT (TAKT_MS): Laeufe mit faelligem Eingang -> je Identitaet hoechstens EIN Turn, insgesamt hoechstens api_laeufe_max gleichzeitig,
 *   nur mit Schalter api_agenten_lauf_intern EIN im Projekt des Laufs (AUS: Eingaenge bleiben liegen, Debug nennt das Projekt).
 * SPERRE (Entscheid F4): es gibt EINE API-Instanz; die PG-Sperre lease_token/lease_bis schuetzt trotzdem gegen Doppel-Turn (zweiter
 *   Takt, API-Neustart waehrend eines Turns). Ein laufender Turn verlaengert seine Sperre in jedem Takt; nach einem Absturz gibt die
 *   abgelaufene Sperre den Lauf wieder frei, VerlaufPg repariert offene Werkzeugaufrufe (werden NICHT wiederholt).
 * TURN = fuehreApiNachrichtAus mit AnbieterDirekt (Transport: Freigabe, Budget, Buchung je Aufruf), WerkzeugeDirekt (Gate wie
 *   tools/call mit Ausweis) und VerlaufPg (api_agent_verlauf). Alle offenen Eingaenge bilden EINE user-Nachricht (Buendelung, O3).
 *   Grenzen aus den Einstellwerten T8 (toolrunden_max, laufzeit_minuten, max_tokens_obergrenze); je Turn eine Zeile api_agent_turns
 *   (Kosten, Tokens, Kontext, Ende).
 * KONTEXT je Turn: Eingabe-Tokens des letzten Aufrufs / context_window des Modells -> api_agent_laeufe.kontext_*. Ab
 *   neustart_schwelle_prozent: Uebergabe-Turn (der Agent fasst seinen Stand zusammen), Uebergabe als thought (Tags
 *   session-uebergabe, api-lauf-neustart), neue Sitzung, deren Verlauf mit der Uebergabe beginnt (kein weiterer Anbieteraufruf).
 * FEHLER vor dem ersten Anbieteraufruf (Freigabe fehlt, Budget, Schalter api_agenten, Preis, Key): kein Verlaufseintrag, Eingaenge
 *   bleiben offen, Status fehler mit Code (fortsetzen nach Behebung). ueberlastet/nicht erreichbar: Eingaenge WIEDERHOL_SEKUNDEN spaeter.
 * STOP: Status gestoppt (admin api_lauf / REST) bricht den laufenden Turn im naechsten Takt per AbortController ab.
 * AUTONOM (User-Korrektur 26.10.): die EINZIGE Grenze ist das Tageslimit (API-Budget). budget_erschoepft (vor oder mitten im Turn) ->
 *   RUECKFALL AUF CONTAINER: Uebergabe-thought (Tags session-uebergabe, api-lauf-rueckfall) aus Verlauf + offenen Eingaengen, danach
 *   Spawn des Container-Agenten (Claude Code bzw. Codex ueber core spawneRueckfallImContainer = Bestand specialist spawn ort container)
 *   mit DERSELBEN Identitaet/demselben Ausweis; die offenen Eingaenge gehen im Auftrag mit. Main: kein Spawn, der naechste Chat-Turn
 *   laeuft ueber den Container-Main (Bestand). Lauf -> gestoppt mit letzter_fehler 'rueckfall_container: ...'; KEIN automatischer
 *   Rueckwechsel bei neuem Budget (User: fortsetzen). Scheitert der Spawn: Status fehler 'rueckfall_container_fehlgeschlagen: ...',
 *   Eingaenge bleiben offen. Debug: zustand().ruckfall_container. Modell des Container-Agenten: Rueckfall-Kette (core api-rueckfall.ts,
 *   Standard haiku -> codex/gpt-6.1-terra -> codex/gpt-6.1-luna, einstellbar nur durch den User) fuer ALLE API-Anbieter (User ae449129,
 *   P22-T278); Main: Modellwechsel-Auftrag (erstellt_von RUECKFALL_AUFTRAG_VON) auf das erste verfuegbare Modell seiner Runtime.
 * DEBUG: intern(status) quellen.api_agenten_lauf (Takte, aktive Turns, letzte Ergebnisse, Fehler, Projekte mit Schalter AUS,
 *   Preisabgleich beim Start). Notbremse: Env SYNAPSE_API_AGENTEN_LAUF_DISABLED=1 (Worker startet nicht), pausierbar per intern(worker_*).
 */
import { randomUUID } from 'node:crypto';
import {
  getPool, fuehreApiNachrichtAus, leseApiEinstellungen, leseApiModelle, ausweisFuerStart, leseApiLaufSchalter, leseApiLaufEinstellungen,
  leseApiLaufWahl, mitApiWahlSperre, schreibeApiLaufWahl, importiereSitzungsEintraege,
  schreibeWechselZeile, setzeGemesseneTokens, leseApiVerlaufHauptverlaufSchalter, baueStartkontext, baueUebergabeText,
  type SitzungsEintragEingabe,
  type ApiLaufEinstellungen, type ApiNachricht, type ApiVerlaufSpeicher, type ApiWerkzeugAufruf, type ApiWerkzeugErgebnis, type ApiWerkzeugDef,
  type ApiAnbieterAdapter, type ApiNachrichtErgebnis,
} from '@synapse/core';
import { spawneRueckfallImContainer, leseApiRueckfall, pruefeRueckfallModell, rueckfallLimitName } from '@synapse/core';
import { AnbieterDirekt, WerkzeugeDirekt, WERKZEUG_PRAEFIX } from './api-agent-direkt.js';
import type { rufeApiTransport } from './api-agent-transport.js';
import type { apiLaufWerkzeugListe, apiLaufWerkzeugAufruf } from '../routes/mcp.js';

type Db = NonNullable<Parameters<typeof leseApiLaufEinstellungen>[0]>;

export const TAKT_MS = 2_000;
const MAX_TOKENS_WUNSCH = 128_000;
const WIEDERHOL_SEKUNDEN = 60;
const VORUEBERGEHEND = new Set(['ueberlastet', 'anbieter_nicht_erreichbar']);
const ANMELDUNG_MAX_ZEICHEN = 20_000;
const ANTWORT_MAX_ZEICHEN = 20_000;
const LETZTE_MAX = 20;
/** Tageslimit global (budget_erschoepft) bzw. je Agent (agent_budget_erschoepft, Freigabe-Grenze) -> Rueckfall auf Container. */
export const RUECKFALL_CODES: ReadonlySet<string> = new Set(['budget_erschoepft', 'agent_budget_erschoepft']);
export const RUECKFALL_MARKE = 'rueckfall_container:' as const;
/** Herkunft des Main-Modellwechsels nach erreichtem Tageslimit (keine User-Wahl); der Main-Chat wartet auf ihn (dauerhafter-main.ts). */
export const RUECKFALL_AUFTRAG_VON = 'api-tageslimit' as const;
// P22-T278 (User ae449129): containerModellFuer (api-<cli> -> <cli>, sonst sonnet; Env SYNAPSE_API_RUECKFALL_MODELL) entfaellt,
// alle Anbieter nutzen die Rueckfall-Kette (core leseApiRueckfall).

export const NACH_NEUSTART_UNBEKANNT = 'Ergebnis nach Neustart der synapse-api unbekannt - der Aufruf wurde NICHT wiederholt. '
  + 'Vor einem erneuten Aufruf den Zustand pruefen (z. B. files history, plan, thought), damit nichts doppelt geschrieben wird.';
export const UEBERGABE_AUFTRAG = 'Dein Kontext ist fast voll, gleich beginnt eine neue Sitzung mit leerem Verlauf. Schreibe JETZT eine vollstaendige '
  + 'Uebergabe fuer dich selbst: Auftrag, erledigt, offen, naechster Schritt, wichtige IDs (Tasks, thoughts, Plaene, Dateien). '
  + 'Antworte NUR mit dem Uebergabetext, ohne Werkzeugaufrufe.';

// ---------------------------------------------------------------------------------------------
// Verlauf in PG (api_agent_verlauf): Nachrichten und Vermerke VOR jedem Werkzeugaufruf (Neustart-Schutz wie agents verlauf.ts).
// ---------------------------------------------------------------------------------------------
export class VerlaufPg implements ApiVerlaufSpeicher {
  private liste: ApiNachricht[] = [];
  private nr = 0;
  private letzteNr: number | null = null;

  private constructor(private readonly db: Db, readonly identity_id: string, readonly sitzung: string,
    private readonly schreibe?: (n: ApiNachricht, nr: number) => void,
    private readonly loesche?: (nr: number) => void) {}

  /** Laedt die Sitzung und repariert offene Werkzeugaufrufe (Fehler-Ergebnis statt Wiederholung); schreibt die Reparatur sofort. */
  static async oeffne(db: Db, identity_id: string, sitzung: string,
    schreibe?: (n: ApiNachricht, nr: number) => void, loesche?: (nr: number) => void): Promise<VerlaufPg> {
    const v = new VerlaufPg(db, identity_id, sitzung, schreibe, loesche);
    const r = await db.query<{ nr: number; art: string; inhalt: unknown }>(
      'SELECT nr, art, inhalt FROM api_agent_verlauf WHERE identity_id = $1 AND sitzung = $2 ORDER BY nr', [identity_id, sitzung]);
    const vermerkt = new Set<string>();
    for (const z of r.rows) {
      v.nr = Math.max(v.nr, z.nr);
      if (z.art === 'nachricht') { v.liste.push(z.inhalt as ApiNachricht); v.letzteNr = z.nr; }
      else if (typeof (z.inhalt as { id?: unknown })?.id === 'string') vermerkt.add((z.inhalt as { id: string }).id);
    }
    const offen = v.offeneAufrufe();
    if (offen.length) {
      const ergebnisse: ApiWerkzeugErgebnis[] = offen.map(a => ({
        typ: 'werkzeug_ergebnis', aufruf_id: a.id, fehler: true,
        inhalt: [{ typ: 'text', text: (vermerkt.has(a.id) ? '' : '(Aufruf war noch nicht gestartet) ') + NACH_NEUSTART_UNBEKANNT }],
      }));
      await v.fuegeHinzu({ rolle: 'user', inhalt: ergebnisse });
    }
    return v;
  }

  private offeneAufrufe(): ApiWerkzeugAufruf[] {
    const letzte = this.liste[this.liste.length - 1];
    if (!letzte || letzte.rolle !== 'assistant') return [];
    return letzte.inhalt.filter((b): b is ApiWerkzeugAufruf => b.typ === 'werkzeug_aufruf');
  }

  nachrichten(): ApiNachricht[] { return this.liste; }

  private async zeile(art: 'nachricht' | 'aufruf', inhalt: unknown): Promise<number> {
    const nr = this.nr + 1;
    await this.db.query('INSERT INTO api_agent_verlauf (identity_id, sitzung, nr, art, inhalt) VALUES ($1,$2,$3,$4,$5::jsonb)',
      [this.identity_id, this.sitzung, nr, art, JSON.stringify(inhalt)]);
    this.nr = nr;
    return nr;
  }

  /** P22-T286: haengt eine Nachricht an und schreibt sie LIVE nach hauptagent_verlauf (ref <sitzung>:<nr>:<block>). */
  async fuegeHinzu(n: ApiNachricht, o: { marke?: 'uebergabe'; hauptverlauf?: boolean } = {}): Promise<void> {
    const nr = await this.zeile('nachricht', o.marke === 'uebergabe' ? { ...n, meta: { uebergabe: true } } : n);
    this.letzteNr = nr;
    this.liste.push(n);
    if (o.hauptverlauf !== false) this.schreibe?.(n, nr);
  }

  async vermerkeAufruf(a: ApiWerkzeugAufruf): Promise<void> {
    await this.zeile('aufruf', { id: a.id, name: a.name, zeit: new Date().toISOString() });
  }

  /** Nur fuer "Turn nicht begonnen" (Fehler vor dem ersten Anbieteraufruf): nimmt die eben angehaengte Nachricht zurueck. */
  async entferneLetzte(): Promise<void> {
    const nr = this.letzteNr;
    if (nr === null) return;
    await this.db.query('DELETE FROM api_agent_verlauf WHERE identity_id = $1 AND sitzung = $2 AND nr = $3', [this.identity_id, this.sitzung, nr]);
    this.liste.pop();
    this.letzteNr = null;
    this.loesche?.(nr);
  }
}

// ---------------------------------------------------------------------------------------------
// Lauf-Verwaltung
// ---------------------------------------------------------------------------------------------
interface LaufZeile {
  identity_id: string; project: string; agent_id: string; rolle: string; modell: string; anbieter: string; status: string;
  sitzung: string; system_prompt: string | null; lease_token: string;
}
interface EingangZeile { id: string; text: string; quelle: string; absender: string | null; erstellt_am: Date }
interface Sitzung { sitzung: string; system: string; werkzeuge: ApiWerkzeugDef[]; ausfuehrer: WerkzeugeDirekt }
interface Aktiv { abbruch: AbortController; start: number; lease: string; fertig: Promise<void> }
interface Ausfuehrung {
  ergebnis: ApiNachrichtErgebnis; aufrufe: number; code: string | null; input: number; output: number;
  kontext: number | null; fenster: number | null; anteil: number | null;
}

export interface LaufVerwaltungOptionen {
  db?: Db;
  takt_ms?: number;
  /** Nur Tests: Ersatz fuer Transport, tools/list, tools/call und den Ausweis. */
  transport?: typeof rufeApiTransport;
  liste?: typeof apiLaufWerkzeugListe;
  aufruf?: typeof apiLaufWerkzeugAufruf;
  ausweis?: (project: string, identity_id: string) => Promise<string>;
  pausiert?: () => boolean;
  /** Nur Tests: Ersatz fuer den Container-Spawn des Rueckfalls (core spawneRueckfallImContainer). */
  rueckfall?: typeof spawneRueckfallImContainer;
}

function eingangText(z: EingangZeile[]): string {
  const kopf = (e: EingangZeile) => `[${e.quelle}${e.absender ? ' von ' + e.absender : ''}, ${e.erstellt_am.toISOString()}]`;
  if (z.length === 1) return z[0].quelle === 'auftrag' || z[0].quelle === 'main_chat' ? z[0].text : `${kopf(z[0])}\n${z[0].text}`;
  return `${z.length} Nachrichten (gebuendelt):\n\n` + z.map(e => `${kopf(e)}\n${e.text}`).join('\n\n');
}

const text = (inhalt: Array<{ typ: string; text?: string }>): string => inhalt.filter(b => b.typ === 'text').map(b => b.text ?? '').join('\n');

/** P22-T286/K1: Kontext EINES Turns (kein Instanzfeld - takt() faehrt mehrere Identitaeten parallel). */
export interface TurnKontext { verlaufAn: boolean; mainChat: boolean; letzteTextRef: string | null }

/** P22-T286/K4: mit Startkontext uebernimmt der Prompt aus der Anmeldung nur principal/lauf_id (kein zweites Onboarding). */
export function anmeldeKurz(t: string): string {
  try {
    const o = JSON.parse(t) as Record<string, unknown>;
    return JSON.stringify({ success: o.success ?? true, principal: o.principal ?? null, ...(typeof o.lauf_id === 'string' ? { lauf_id: o.lauf_id } : {}) });
  } catch { return 'Anmeldung bestaetigt.'; }
}

/** P22-T286: Verlaufs-Schreiber der Web-UI-Route (strukturell, damit rest-api keinen core-Interna importiert). */
export interface VerlaufsSchreiber {
  ereignis(event: string, data: Record<string, unknown>): void;
  abschliessen(status: 'fertig' | 'fehler' | 'abgebrochen', extra?: Record<string, unknown>): Promise<void>;
}

type VerlaufsBlock = { typ?: string; text?: string; id?: string; name?: string; eingabe?: unknown; aufruf_id?: string; inhalt?: unknown; fehler?: unknown };

/**
 * P22-T286/N1: Eintraege EINER Nachricht fuer hauptagent_verlauf. ref = '<sitzung>:<nr>:<blockindex>' (stabil und kollisionsfrei,
 * auch bei Zwischentexten und mehreren Anbieteraufrufen). Die EINGABE des Turns schreibt der Aufrufer getrennt mit 'eingang:<ids>'.
 */
export function eintraegeAusNachricht(sitzung: string, nr: number, n: ApiNachricht, modell: string | null): SitzungsEintragEingabe[] {
  const bloecke = (Array.isArray(n.inhalt) ? n.inhalt : []) as unknown as VerlaufsBlock[];
  const out: SitzungsEintragEingabe[] = [];
  bloecke.forEach((b, i) => {
    const ref = sitzung + ':' + nr + ':' + i;
    if (b.typ === 'text' && typeof b.text === 'string' && b.text) {
      if (n.rolle !== 'assistant') return;
      out.push({ ref, art: 'text', inhalt: b.text, modell });
    } else if (b.typ === 'denken') {
      out.push({ ref, art: 'denken', inhalt: String(b.text ?? ''), modell });
    } else if (b.typ === 'werkzeug_aufruf') {
      out.push({ ref, art: 'werkzeug_aufruf', name: b.name ?? null, werkzeug_id: b.id ?? null, inhalt: b.eingabe ?? null, modell });
    } else if (b.typ === 'werkzeug_ergebnis') {
      out.push({ ref, art: 'werkzeug_ergebnis', werkzeug_id: b.aufruf_id ?? null, inhalt: b.inhalt ?? null, fehler: b.fehler === true, modell });
    }
  });
  return out;
}

export class LaufVerwaltung {
  private timer: NodeJS.Timeout | null = null;
  private taktLaeuft = false;
  private readonly aktiv = new Map<string, Aktiv>();
  private readonly sitzungen = new Map<string, Sitzung>();
  private readonly stat = {
    gestartet_am: new Date().toISOString(), takte: 0, turns: 0, letzter_takt: null as string | null, fehler_takt: null as string | null,
    schalter_aus: {} as Record<string, string>, letzte: [] as Array<Record<string, unknown>>, preisabgleich: null as unknown,
    ruckfall_container: { anzahl: 0, fehlgeschlagen: 0, letzter: null as Record<string, unknown> | null },
    // P22-T286: Debug des API-Verlaufs in hauptagent_verlauf (Schalter, Zeilen, Gruende).
    hauptverlauf: { zeilen: 0, uebersprungen: 0, anmeldung_lang: 0, letzter_grund: null as string | null,
      letzter_fehler: null as string | null, main_schreiber_weg: 0 },
  };

  constructor(private readonly o: LaufVerwaltungOptionen = {}) {}

  private get db(): Db { return this.o.db ?? getPool(); }

  /** P22-T286/K1: Schreibvorgaenge je Identitaet seriell (eine Kette); K5: Abschluss nur im 'zeit'-Fall. */
  private readonly ketten = new Map<string, Promise<void>>();
  private readonly mainSchreiber = new Map<string, { schreiber: VerlaufsSchreiber; abschluss: boolean }>();

  setzeMainSchreiber(identity_id: string, schreiber: VerlaufsSchreiber | null, abschluss = false): void {
    if (schreiber) this.mainSchreiber.set(identity_id, { schreiber, abschluss }); else this.mainSchreiber.delete(identity_id);
  }

  /** P22-T286/K2: Schreibvorgaenge je Identitaet seriell (kein paralleles Schreiben). */
  private reihe(identity_id: string, aufgabe: () => Promise<void>): Promise<void> {
    const vor = this.ketten.get(identity_id) ?? Promise.resolve();
    const neu = vor.then(aufgabe).catch(() => undefined);
    this.ketten.set(identity_id, neu);
    void neu.finally(() => { if (this.ketten.get(identity_id) === neu) this.ketten.delete(identity_id); });
    return neu;
  }

  /** P22-T286/K2: auf alle Schreibvorgaenge dieser Identitaet warten (vor dem Nachtrag der Messwerte). */
  private async warteKette(identity_id: string): Promise<void> {
    await (this.ketten.get(identity_id) ?? Promise.resolve());
  }

  /** P22-T286: eine Nachricht live nach hauptagent_verlauf. Wirft nie und bricht nie den Turn. */
  private verlaufsNachricht(l: LaufZeile, ctx: TurnKontext, sitzung: string, nr: number, n: ApiNachricht): void {
    try {
      if (!ctx.verlaufAn) return;
      if (ctx.mainChat) { this.mainEvents(l, n); return; }
      const eintraege = eintraegeAusNachricht(sitzung, nr, n, l.modell);
      if (!eintraege.length) return;
      const antwort = eintraege.find(e => e.art === 'text');
      if (antwort) ctx.letzteTextRef = antwort.ref;
      void this.reihe(l.identity_id, () => this.schreibeHauptverlauf(l, eintraege));
    } catch { /* Verlauf darf den Turn nie brechen */ }
  }

  /** P22-T286/N2: Text-/Werkzeugbloecke als Stromereignisse in die BESTEHENDE Antwortzeile (keine zweite Zeile). */
  private mainEvents(l: LaufZeile, n: ApiNachricht): void {
    const eintrag = this.mainSchreiber.get(l.identity_id);
    if (!eintrag) { this.stat.hauptverlauf.main_schreiber_weg += 1; return; }
    const bloecke = (Array.isArray(n.inhalt) ? n.inhalt : []) as unknown as VerlaufsBlock[];
    for (const b of bloecke) {
      if (b.typ === 'text' && n.rolle === 'assistant' && typeof b.text === 'string' && b.text) eintrag.schreiber.ereignis('delta', { content: b.text });
      else if (b.typ === 'werkzeug_aufruf') eintrag.schreiber.ereignis('tool', { id: b.id, name: b.name, input: b.eingabe, phase: 'start' });
      else if (b.typ === 'werkzeug_ergebnis') eintrag.schreiber.ereignis('tool', { id: b.aufruf_id, output: b.inhalt, isError: b.fehler === true, phase: 'end' });
    }
  }

  /** P22-T286: Zeilen ueber die EINE Schreibstelle (importiereSitzungsEintraege, herkunft api). Wirft nie. */
  private async schreibeHauptverlauf(l: LaufZeile, eintraege: SitzungsEintragEingabe[]): Promise<void> {
    try {
      const r = await importiereSitzungsEintraege(l.identity_id, eintraege, { runtime: l.anbieter, herkunft: 'api' });
      this.stat.hauptverlauf.zeilen += r.aufgenommen;
      this.stat.hauptverlauf.uebersprungen += r.uebersprungen;
      if (r.grund) this.stat.hauptverlauf.letzter_grund = r.grund;
    } catch (error) {
      this.stat.hauptverlauf.letzter_fehler = String((error as Error)?.message ?? error).slice(0, 200);
    }
  }

  /** P22-T286/N1+K2: zugehoerige Verlaufszeilen entfernen (erst nach dem INSERT, gleiche Kette). */
  private loescheVerlauf(l: LaufZeile, sitzung: string, nr: number | null): void {
    if (nr === null) return;
    // P22-T286/N1: importiereSitzungsEintraege schreibt die Zeilen mit Herkunft api als 'api:<ref>' - der Praefix gehoert in den Vergleich.
    const praefix = 'api:' + sitzung + ':' + nr + ':';
    void this.reihe(l.identity_id, () => getPool().query('DELETE FROM hauptagent_verlauf WHERE identity_id = $1 AND LEFT(quelle_ref, $3::int) = $2',
      [l.identity_id, praefix, praefix.length]).then(() => undefined).catch(() => undefined));
  }

  /** P22-T286/N1+K6: eine einzelne Zeile exakt entfernen (z. B. Eingabe eines nicht begonnenen Turns). */
  private loescheRef(l: LaufZeile, ref: string): Promise<void> {
    return this.reihe(l.identity_id, () => getPool().query('DELETE FROM hauptagent_verlauf WHERE identity_id = $1 AND quelle_ref = $2', [l.identity_id, 'api:' + ref])
      .then(() => undefined).catch(() => undefined));
  }

  /** P22-T286/K5b: NUR im 'zeit'-Fall schliesst der Turn die Antwortzeile selbst (usage + fertig). */
  private schliesseMainZeile(l: LaufZeile, a: Ausfuehrung): void {
    try {
      const eintrag = this.mainSchreiber.get(l.identity_id);
      if (!eintrag || !eintrag.abschluss) return;
      eintrag.schreiber.ereignis('usage', { inputTokens: a.input, outputTokens: a.output, ...(a.kontext ? { kontextTokens: a.kontext } : {}) });
      void eintrag.schreiber.abschliessen('fertig').catch(() => undefined);
      this.mainSchreiber.delete(l.identity_id);
    } catch (error) {
      // P22-T286/R2: ein Schreibfehler am Stream darf den Turn nicht in 'interner_fehler' kippen.
      this.stat.hauptverlauf.letzter_fehler = String((error as Error)?.message ?? error).slice(0, 200);
    }
  }

  starte(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { if (!this.o.pausiert?.()) void this.takt(); }, this.o.takt_ms ?? TAKT_MS);
    this.timer.unref?.();
  }

  async beende(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const a of this.aktiv.values()) a.abbruch.abort();
    await this.warteAufTurns();
  }

  /** Tests und beende(): wartet, bis alle laufenden Turns beendet sind. */
  async warteAufTurns(): Promise<void> {
    await Promise.all([...this.aktiv.values()].map(a => a.fertig));
  }

  merkePreisabgleich(p: unknown): void { this.stat.preisabgleich = p; }

  /**
   * B7b (Main-Chat synchron wie heute): stoesst sofort einen Takt an und wartet, bis der Turn mit diesem Eingang beendet ist.
   * fertig: Antwort des Turns; nicht_begonnen: Fachfehler vor dem Anbieter (Status fehler, Code); zeit: Turn laeuft weiter.
   */
  async warteAufEingang(eingangId: number, warteMs: number): Promise<
    { art: 'fertig'; text: string; ende: string; kosten_usd: number; input_tokens: number; output_tokens: number; kontext_tokens: number }
    | { art: 'nicht_begonnen'; code: string } | { art: 'zeit' }> {
    const bis = Date.now() + warteMs;
    while (true) {
      await this.takt();
      const r = await this.db.query<{ identity_id: string; erledigt: boolean; ende: string | null; antwort: string | null; kosten: number | null; i: string | null; o: string | null;
        k: string | null; status: string | null; letzter_fehler: string | null; turn: string | null }>(
        `SELECT e.identity_id, e.erledigt_am IS NOT NULL AS erledigt, e.turn_id AS turn, t.ende, t.antwort, t.kosten_usd::float8 AS kosten, t.input_tokens AS i, t.output_tokens AS o, t.kontext_tokens AS k,
                l.status, l.letzter_fehler
           FROM api_agent_eingang e LEFT JOIN api_agent_turns t ON t.id = e.turn_id LEFT JOIN api_agent_laeufe l ON l.identity_id = e.identity_id
          WHERE e.id = $1`, [eingangId]);
      const z = r.rows[0];
      if (!z) return { art: 'nicht_begonnen', code: 'eingang_unbekannt' };
      // Rueckfall: der Eingang ging an den Container-Agenten (Main: der Aufrufer nimmt den Bestand-Weg). P22-T278 P2-1: erst wenn der
      // Rueckfall fertig ist (Turn beendet: Eingaenge erledigt, Modellwechsel-Auftrag angelegt), sonst startet der Aufrufer zu frueh.
      const imRueckfall = z.turn === null && (z.letzter_fehler ?? '').startsWith(RUECKFALL_MARKE);
      if (imRueckfall && !this.aktiv.has(z.identity_id)) return { art: 'nicht_begonnen', code: 'rueckfall_container' };
      if (imRueckfall) {
        if (Date.now() >= bis) return { art: 'zeit' };
        await new Promise(r2 => setTimeout(r2, 200));
        continue;
      }
      if (z.erledigt) {
        return { art: 'fertig', text: z.antwort ?? '', ende: z.ende ?? 'fertig', kosten_usd: z.kosten ?? 0, input_tokens: Number(z.i ?? 0), output_tokens: Number(z.o ?? 0), kontext_tokens: Number(z.k ?? 0) };
      }
      if (z.turn === null && (z.status === 'fehler' || z.status === 'gestoppt' || z.status === 'pausiert')) return { art: 'nicht_begonnen', code: z.letzter_fehler ?? 'lauf_' + z.status };
      if (Date.now() >= bis) return { art: 'zeit' };
      await new Promise(r2 => setTimeout(r2, 500));
    }
  }

  zustand(): Record<string, unknown> {
    const jetzt = Date.now();
    return {
      ...this.stat, takt_ms: this.o.takt_ms ?? TAKT_MS,
      aktive: [...this.aktiv.entries()].map(([identity_id, a]) => ({ identity_id, seit_ms: jetzt - a.start })),
      sitzungen_im_speicher: this.sitzungen.size,
    };
  }

  /** Ein Takt: Sperren laufender Turns verlaengern (gestoppte abbrechen), dann faellige Laeufe starten. */
  async takt(): Promise<{ gestartet: string[] }> {
    if (this.taktLaeuft) return { gestartet: [] };
    this.taktLaeuft = true;
    const gestartet: string[] = [];
    try {
      this.stat.takte += 1;
      this.stat.letzter_takt = new Date().toISOString();
      let einst: ApiLaufEinstellungen | null = null;
      const einstellungen = async () => (einst ??= await leseApiLaufEinstellungen(this.db));
      if (this.aktiv.size) await this.pruefeAktive((await einstellungen()).lease_sekunden.wert);
      const r = await this.db.query<{ identity_id: string; project: string }>(
        `SELECT l.identity_id, l.project FROM api_agent_laeufe l
          WHERE (l.status = 'bereit' OR (l.status = 'laeuft' AND (l.lease_bis IS NULL OR l.lease_bis < NOW())))
            AND EXISTS (SELECT 1 FROM api_agent_eingang e WHERE e.identity_id = l.identity_id AND e.erledigt_am IS NULL AND e.faellig_ab <= NOW())
          ORDER BY (SELECT min(e.faellig_ab) FROM api_agent_eingang e WHERE e.identity_id = l.identity_id AND e.erledigt_am IS NULL)
          LIMIT 50`);
      if (!r.rows.length) return { gestartet };
      const e = await einstellungen();
      const schalter = new Map<string, boolean>();
      for (const z of r.rows) {
        if (this.aktiv.size >= e.api_laeufe_max.wert) break;
        if (this.aktiv.has(z.identity_id)) continue;
        let an = schalter.get(z.project);
        if (an === undefined) {
          const s = await leseApiLaufSchalter(z.project);
          an = s.aktiv;
          schalter.set(z.project, an);
          if (an) delete this.stat.schalter_aus[z.project]; else this.stat.schalter_aus[z.project] = s.debug;
        }
        if (!an) continue;
        const lauf = await this.sperre(z.identity_id, e.lease_sekunden.wert);
        if (!lauf) continue;
        gestartet.push(z.identity_id);
        const abbruch = new AbortController();
        const eintrag: Aktiv = { abbruch, start: Date.now(), lease: lauf.lease_token, fertig: Promise.resolve() };
        this.aktiv.set(z.identity_id, eintrag);
        eintrag.fertig = this.turn(lauf, e, abbruch.signal)
          .catch(async (err: unknown) => {
            const meldung = (err instanceof Error ? err.message : String(err)).slice(0, 300);
            const ort = err instanceof Error ? (err.stack ?? '').split('\n').slice(1, 4).map(s => s.trim()).join(' | ') : null;
            this.merke({ identity_id: z.identity_id, ende: 'interner_fehler', meldung, ort });
            await this.gibFrei(lauf, { status: 'fehler', fehler: 'interner_fehler: ' + meldung }).catch(() => undefined);
          })
          .finally(() => { this.aktiv.delete(z.identity_id); });
      }
      this.stat.fehler_takt = null;
    } catch (err) {
      this.stat.fehler_takt = (err instanceof Error ? err.message : String(err)).slice(0, 300);
    } finally {
      this.taktLaeuft = false;
    }
    return { gestartet };
  }

  private merke(e: Record<string, unknown>): void {
    this.stat.letzte.unshift({ ...e, zeit: new Date().toISOString() });
    this.stat.letzte.length = Math.min(this.stat.letzte.length, LETZTE_MAX);
  }

  private async pruefeAktive(leaseSek: number): Promise<void> {
    for (const [identity_id, a] of this.aktiv) {
      const r = await this.db.query<{ status: string }>(
        'UPDATE api_agent_laeufe SET lease_bis = NOW() + make_interval(secs => $3) WHERE identity_id = $1 AND lease_token = $2 RETURNING status',
        [identity_id, a.lease, leaseSek]);
      const status = r.rows[0]?.status;
      if (!status || status === 'gestoppt') a.abbruch.abort();
    }
  }

  private async sperre(identity_id: string, leaseSek: number): Promise<LaufZeile | null> {
    const r = await this.db.query<LaufZeile>(
      `UPDATE api_agent_laeufe SET status = 'laeuft', lease_token = $2, lease_bis = NOW() + make_interval(secs => $3), aktualisiert_am = NOW()
        WHERE identity_id = $1 AND (status = 'bereit' OR (status = 'laeuft' AND (lease_bis IS NULL OR lease_bis < NOW())))
        RETURNING identity_id, project, agent_id, rolle, modell, anbieter, status, sitzung::text AS sitzung, system_prompt, lease_token::text AS lease_token`,
      [identity_id, randomUUID(), leaseSek]);
    return r.rows[0] ?? null;
  }

  /** Gibt die Sperre frei. status gilt nur, wenn der Lauf noch 'laeuft' (pausiert/gestoppt durch Steuerung bleibt). */
  private async gibFrei(l: LaufZeile, e: { status?: 'bereit' | 'fehler' | 'pausiert'; fehler?: string | null; turns?: number; kontext?: Ausfuehrung | null }): Promise<string | null> {
    const k = e.kontext ?? null;
    const anteil = k && k.anteil !== null ? Math.min(k.anteil, 99) : null;
    const r = await this.db.query<{ status: string }>(
      `UPDATE api_agent_laeufe SET status = CASE WHEN status = 'laeuft' THEN $3 ELSE status END, lease_token = NULL, lease_bis = NULL,
          turns = turns + $4, kontext_tokens = COALESCE($5, kontext_tokens), kontext_fenster = COALESCE($6, kontext_fenster),
          kontext_anteil = COALESCE($7, kontext_anteil), letzter_fehler = $8, letzte_aktivitaet = NOW(), aktualisiert_am = NOW()
        WHERE identity_id = $1 AND lease_token = $2 RETURNING status`,
      [l.identity_id, l.lease_token, e.status ?? 'bereit', e.turns ?? 0, k?.kontext ?? null, k?.fenster ?? null, anteil, e.fehler ?? null]);
    return r.rows[0]?.status ?? null;
  }

  /** System-Prompt (Basis + eigene Anmeldung) und Werkzeugliste je Sitzung; nach API-Neustart neu (neue Anmeldung). */
  private async sitzung(l: LaufZeile): Promise<Sitzung> {
    const vorh = this.sitzungen.get(l.identity_id);
    if (vorh && vorh.sitzung === l.sitzung) return vorh;
    const ausweis = this.o.ausweis ? await this.o.ausweis(l.project, l.identity_id)
      : (await ausweisFuerStart(l.project, l.identity_id, { art: 'daemon' })).token;
    const ausfuehrer = new WerkzeugeDirekt({ identity_id: l.identity_id, main: l.rolle === 'main', ausweis, liste: this.o.liste, aufruf: this.o.aufruf });
    // P22-T286/K3: Startkontext/ungekuerzte Anmeldung/Prompt-Wiederverwendung NUR bei Schalter EIN.
    const verlaufAn = (await leseApiVerlaufHauptverlaufSchalter(l.project)).aktiv;
    const gespeichert = verlaufAn ? await this.promptAusSitzung(l) : null;
    if (gespeichert) {
      // P22-T286/K4 (Entscheid Koordinator): Anmeldung laeuft trotzdem (neuer Lauf, lauf_id); ihr Text kommt NICHT in den Prompt.
      try { await ausfuehrer.rufe(WERKZEUG_PRAEFIX + 'chat', { action: 'anmelden', agent_kennung: ausweis }); } catch { /* Prompt bleibt gespeichert */ }
      const s0: Sitzung = { sitzung: l.sitzung, system: gespeichert, werkzeuge: await ausfuehrer.liste(), ausfuehrer };
      this.sitzungen.set(l.identity_id, s0);
      return s0;
    }
    const startBlock = verlaufAn && (await this.istNeueSitzung(l)) ? await baueStartkontext(l.identity_id).catch(() => null) : null;
    let system = l.system_prompt ?? '';
    try {
      const anm = await ausfuehrer.rufe(WERKZEUG_PRAEFIX + 'chat', { action: 'anmelden', agent_kennung: ausweis });
      const t = text(anm.inhalt);
      if (!anm.fehler && t) {
        // P22-T286/K3: AUS = Bestand mit Kappung; EIN = voll (Lauf-Nachweis verhindert Doppelzustellung).
        const anmeldetext = verlaufAn ? t : t.slice(0, ANMELDUNG_MAX_ZEICHEN);
        if (!verlaufAn && t.length > ANMELDUNG_MAX_ZEICHEN) this.stat.hauptverlauf.anmeldung_lang += 1;
        system += `\n\n# Synapse-Anmeldung (Ausweis bereits angemeldet)\n${verlaufAn && startBlock ? anmeldeKurz(t) : anmeldetext}`;
      }
    } catch { /* ohne Anmeldetext weiter; Werkzeuge pruefen den Ausweis selbst */ }
    if (startBlock?.text) system = `${startBlock.text}\n\n${system}`;
    system += `\n\nDu laeufst als API-Agent direkt in der synapse-api (Modell ${l.modell}). Deine Agenten-Kennung: ${ausweis} - bei jedem `
      + 'Synapse-Aufruf als agent_kennung mitgeben. Du arbeitest ausschliesslich mit den angebotenen Synapse-Werkzeugen (kein Bash, kein lokales Dateisystem).';
    const s: Sitzung = { sitzung: l.sitzung, system: system.trim(), werkzeuge: await ausfuehrer.liste(), ausfuehrer };
    this.sitzungen.set(l.identity_id, s);
    // P22-T286/K4: den gebauten Prompt an der Sitzung ablegen (einmaliges Onboarding, Wiederverwendung nach Prozessneustart).
    // P22-T286/R4: bei Schalter EIN IMMER speichern (auch ohne startBlock), sonst onboardet ein Neustart wieder voll.
    if (verlaufAn) await this.speicherePrompt(l, s.system);
    return s;
  }

  /**
   * P22-T286/Auflage 1: neue Sitzung = in api_agent_verlauf liegt fuer diese Sitzung KEINE Nachricht ausser den 2 markierten
   * Uebergabe-Nachrichten. Damit spielt ein API-Prozessneustart mit gleicher Sitzung (Map leer) NICHTS erneut ein.
   */
  private async istNeueSitzung(l: LaufZeile): Promise<boolean> {
    try {
      const r = await this.db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM api_agent_verlauf WHERE identity_id = $1 AND sitzung = $2
           AND NOT COALESCE((inhalt->'meta'->>'uebergabe')::boolean, false)`, [l.identity_id, l.sitzung]);
      return (r.rows[0]?.n ?? 0) === 0;
    } catch { return false; }
  }

  /** P22-T286/K4: einmal gebauten Sitzungs-Prompt ablegen (eigene, additive Tabelle; additiv/idempotent). */
  private async speicherePrompt(l: LaufZeile, system: string): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO api_agent_sitzung_prompt (identity_id, sitzung, system_prompt) VALUES ($1,$2,$3)
         ON CONFLICT (identity_id, sitzung) DO UPDATE SET system_prompt = EXCLUDED.system_prompt, aktualisiert_am = NOW()`,
        [l.identity_id, l.sitzung, system]);
    } catch { /* ohne Prompt-Wiederverwendung weiter */ }
  }

  /** P22-T286/K4: gebauten Sitzungs-Prompt nach einem Prozessneustart wiederfinden. */
  private async promptAusSitzung(l: LaufZeile): Promise<string | null> {
    try {
      const r = await this.db.query<{ system_prompt: string | null }>(
        'SELECT system_prompt FROM api_agent_sitzung_prompt WHERE identity_id = $1 AND sitzung = $2', [l.identity_id, l.sitzung]);
      return r.rows[0]?.system_prompt ?? null;
    } catch { return null; }
  }

  private async fuehreAus(l: LaufZeile, s: Sitzung, verlauf: VerlaufPg, signal: AbortSignal, toolrunden?: number): Promise<Ausfuehrung> {
    const [t8, modelle] = await Promise.all([leseApiEinstellungen(), leseApiModelle()]);
    const m = modelle.find(x => x.alias === l.modell);
    const direkt = new AnbieterDirekt({ kontext: { identity_id: l.identity_id, agent_id: l.agent_id, project: l.project, zugang: l.rolle === 'main' ? 'main' : 'agent' },
      modell: l.modell, anbieter: l.anbieter, transport: this.o.transport });
    let aufrufe = 0, input = 0, output = 0, code: string | null = null;
    const adapter: ApiAnbieterAdapter = { name: direkt.name, rufe: async (a) => { const r = await direkt.rufe(a); aufrufe += 1; return r; } };
    const ergebnis = await fuehreApiNachrichtAus({
      adapter, werkzeuge: s.werkzeuge, ausfuehrer: s.ausfuehrer, verlauf, system: s.system, signal,
      max_tokens: Math.min(MAX_TOKENS_WUNSCH, t8.max_tokens_obergrenze.wert, m?.output_limit ?? MAX_TOKENS_WUNSCH),
      grenzen: { toolrunden_max: toolrunden ?? t8.toolrunden_max.wert, laufzeit_ms: t8.laufzeit_minuten.wert * 60_000 },
      beiNutzung: (n) => { input += n.input + n.cache_read + n.cache_creation; output += n.output; },
      beiEreignis: (art, d) => { if (art === 'anbieter_fehler') code = typeof d.code === 'string' ? d.code : 'anbieter_fehler'; },
    });
    const fenster = m?.context_window ?? null;
    const kontext = direkt.letzterKontext;
    return { ergebnis, aufrufe, code, input, output, kontext, fenster, anteil: kontext !== null && fenster ? kontext / fenster : null };
  }

  /**
   * Rueckfall auf einen Container-Agenten bei erschoepftem Tageslimit (User-Korrektur 26.10.). Kein Anbieteraufruf mehr: die Uebergabe
   * entsteht aus Verlauf und offenen Eingaengen (Werkzeugaufruf thought als der Agent, kostet kein API-Budget).
   */
  private async rueckfallContainer(l: LaufZeile, s: Sitzung, code: string): Promise<void> {
    const offen = (await this.db.query<EingangZeile>(
      'SELECT id, text, quelle, absender, erstellt_am FROM api_agent_eingang WHERE identity_id = $1 AND erledigt_am IS NULL ORDER BY id', [l.identity_id])).rows;
    const ctx: TurnKontext = { verlaufAn: (await leseApiVerlaufHauptverlaufSchalter(l.project).catch(() => ({ aktiv: false }))).aktiv, mainChat: false, letzteTextRef: null };
    const verlauf = await VerlaufPg.oeffne(this.db, l.identity_id, l.sitzung, (n, nr) => this.verlaufsNachricht(l, ctx, l.sitzung, nr, n), (nr) => this.loescheVerlauf(l, l.sitzung, nr));
    // P22-T286: Uebergabe aus dem gemeinsamen Verlauf, Ziel = Rueckfall-KANDIDAT (nicht das bisherige Modell).
    let rueckfallZiel: { modell: string | null; runtime: string | null } = { modell: null, runtime: null };
    if (l.rolle !== 'main') {
      try {
        for (const kandidat of (await leseApiRueckfall()).modelle) {
          const p = await pruefeRueckfallModell(kandidat);
          if (p.verfuegbar) { rueckfallZiel = { modell: kandidat, runtime: p.runtime }; break; }
        }
      } catch { /* Auszug unten */ }
    }
    let stand = '';
    if (ctx.verlaufAn) {
      try {
        stand = (await baueUebergabeText(l.identity_id, { runtime: rueckfallZiel.runtime, modell: rueckfallZiel.modell }, 'api_rueckfall',
          { von_modell: l.modell, von_runtime: l.anbieter })).text;
      } catch { /* Auszug unten */ }
    }
    if (!stand) {
      stand = verlauf.nachrichten().slice(-6).map(n => {
        const t = text(n.inhalt as Array<{ typ: string; text?: string }>).trim();
        return t ? `${n.rolle}: ${t}` : '';
      }).filter(Boolean).join('\n').slice(-6000) || '(kein Verlauf)';
    }
    const offenText = offen.length ? eingangText(offen) : '(keine offenen Eingaenge)';
    // P22-T278 P3 c (Kanal 37424): Grenze nach Budget-Zeitraum (Tages-/Wochen-/Monatslimit) statt immer 'Tageslimit'.
    const limit = await rueckfallLimitName();
    // P22-T278 P2-1: Main-Chatnachrichten stellt der wartende Chat-Turn selbst dem Container-Main zu (genau einmal); die Uebergabe
    // nennt sie nur zur Information, sonst fuehrte der neue Main sie ein zweites Mal aus.
    const chatOffen = l.rolle === 'main' ? offen.filter(z => z.quelle === 'main_chat').length : 0;
    const offenKopf = chatOffen
      ? `Offene Eingaenge (gehen mit; ${chatOffen} Chatnachricht(en) [main_chat] stellt der Chat direkt zu - NICHT aus dieser Uebergabe ausfuehren)`
      : 'Offene Eingaenge (gehen mit)';
    let thoughtId: string | null = null;
    try {
      const r = await s.ausfuehrer.rufe(WERKZEUG_PRAEFIX + 'thought', {
        action: 'add', project: l.project, tags: ['session-uebergabe', 'api-lauf-rueckfall'],
        content: `UEBERGABE ${l.agent_id}: Rueckfall vom API-Lauf (${l.modell}) auf einen Container-Agenten, ${limit} erschoepft (${code}). `
          + `Sitzung ${l.sitzung}.\nLetzter Stand (Verlauf):\n${stand}\n\n${offenKopf}:\n${offenText}`,
      });
      thoughtId = /"id"\s*:\s*"([0-9a-f-]{36})"/.exec(text(r.inhalt))?.[1] ?? null;
    } catch { /* Uebergabe steht trotzdem im Auftrag des Container-Agenten */ }
    // P22-T286/N4: Wechsel-Zeile fuer Nicht-Main (meta thought_id/von/nach/anlass).
    if (ctx.verlaufAn && l.rolle !== 'main') {
      await schreibeWechselZeile(l.identity_id, { von: `${l.anbieter}/${l.modell}`,
        nach: `${rueckfallZiel.runtime ?? 'container'}/${rueckfallZiel.modell ?? '?'}`, anlass: 'api_rueckfall',
        thought_id: thoughtId, runtime: rueckfallZiel.runtime, modell: rueckfallZiel.modell });
    }
    // P22-T202 + P22-T278 P2-2: Anbieterturn ist beendet, Uebergabe vorbereitet. Erst die eigene Lease abgeben (und eine explizite
    // API-Wahl loesen), dann darf der vorhandene CLI-Start greifen. Jetzt fuer JEDEN Lauf: die CLI-Sperre (mitCliStartSperre) lehnt
    // CLI-Starts neben einem aktiven API-Lauf derselben Identitaet ab.
    const uebergabeMarke = RUECKFALL_MARKE + ' gesicherte Uebergabe an CLI (P22-T202)';
    const mitWahl = !!(await leseApiLaufWahl(l.identity_id));
    await mitApiWahlSperre([l.identity_id], async db => {
      const r = await db.query(
        "UPDATE api_agent_laeufe SET status='gestoppt',lease_token=NULL,lease_bis=NULL,letzter_fehler=$3 WHERE identity_id=$1 AND lease_token=$2",
        [l.identity_id, l.lease_token, uebergabeMarke]);
      if (!r.rowCount) throw new Error('api_lauf_lease_verloren');
      if (mitWahl) await schreibeApiLaufWahl(db, l.identity_id, null);
    });
    // P22-T278 C (User 08.11.2026, Kanal 37397/37398) + User ae449129: ALLE API-Anbieter (anthropic-api, openrouter-api, deepseek-api)
    // fallen auf die einstellbare Kette zurueck (Standard haiku -> codex/gpt-6.1-terra -> nur wenn terra nicht verfuegbar
    // codex/gpt-6.1-luna; Codex-Effort Standard low).
    const auftragText = `Du setzt die Arbeit deines API-Laufs fort (${limit} des API-Budgets erschoepft). Lies zuerst deine Uebergabe`
      + `${thoughtId ? ': thought(action:"get", id:"' + thoughtId + '")' : ' (thought mit Tag session-uebergabe)'}.\n\nOffene Eingaenge:\n${offenText}`;
    const spawne = (m: string, effort: string | null): Promise<Record<string, unknown>> => (this.o.rueckfall ?? spawneRueckfallImContainer)({
      project: l.project, name: l.agent_id, model: m, expertise: 'Fortsetzung des API-Laufs', task: auftragText, ...(effort ? { effort } : {}),
    }).catch((err: unknown) => ({ success: false, error: 'rueckfall_spawn_fehler', message: err instanceof Error ? err.message.slice(0, 300) : String(err) }));
    const versuche: Array<Record<string, unknown>> = [];
    let model: string | null = null;
    let spawn: Record<string, unknown> | null = null;
    if (l.rolle !== 'main') {
      const kette = await leseApiRueckfall();
      for (const kandidat of kette.modelle) {
        const p = await pruefeRueckfallModell(kandidat);
        if (!p.verfuegbar) { versuche.push({ modell: kandidat, ergebnis: 'nicht_verfuegbar', grund: p.grund }); continue; }
        const sp = await spawne(kandidat, p.runtime === 'codex' ? kette.effort : null);
        versuche.push({ modell: kandidat, ergebnis: sp.success === true ? 'gestartet' : 'fehlgeschlagen', fehler: sp.error ?? null });
        spawn = sp;
        if (sp.success === true) { model = kandidat; break; }
      }
      if (!spawn) spawn = { success: false, error: 'kein_rueckfall_modell_verfuegbar' };
    }
    const ok = l.rolle === 'main' || spawn?.success === true;
    if (ok && offen.length) await this.db.query('UPDATE api_agent_eingang SET erledigt_am = NOW() WHERE id = ANY($1::bigint[])', [offen.map(z => z.id)]);
    let hinweis = ok
      ? `${RUECKFALL_MARKE} ${l.rolle === 'main' ? 'Main laeuft im Container weiter' : 'Container-Agent gestartet (' + model + ')'}, ${limit} erschoepft (${code})`
        + `${thoughtId ? ', Uebergabe ' + thoughtId : ''}. Kein automatischer Rueckwechsel; der User entscheidet (fortsetzen).`
      : `rueckfall_container_fehlgeschlagen: ${String(spawn?.error ?? 'unbekannt')} (${limit} erschoepft, ${code}). Eingaenge bleiben offen.`;
    await this.db.query(
      `UPDATE api_agent_laeufe SET status = $3, letzter_fehler = $4, lease_token = NULL, lease_bis = NULL, letzte_aktivitaet = NOW(), aktualisiert_am = NOW()
        WHERE identity_id = $1 AND (lease_token = $2 OR ($5::text IS NOT NULL AND lease_token IS NULL AND letzter_fehler = $5))`, [l.identity_id, l.lease_token, ok ? 'gestoppt' : 'fehler', hinweis, uebergabeMarke]);
    this.sitzungen.delete(l.identity_id);
    // Main: nach Freigabe von Wahl und Lease (P1-Sperre) Modellwechsel-Auftrag auf das erste verfuegbare Rueckfallmodell seiner Runtime.
    const mainWechsel = ok && l.rolle === 'main' ? await this.mainRueckfallWechsel(l, code) : null;
    if (mainWechsel?.modell) {
      // Befund c (Sichtpruefung 710c8711): auch beim Main nennt die Marke das Rueckfallmodell.
      const neu = hinweis.replace('Main laeuft im Container weiter', `Main laeuft im Container weiter (Modellwechsel auf ${String(mainWechsel.modell)})`);
      await this.db.query("UPDATE api_agent_laeufe SET letzter_fehler = $2 WHERE identity_id = $1 AND letzter_fehler = $3", [l.identity_id, neu, hinweis]);
      hinweis = neu;
    }
    // Wechsel im Chat der Identitaet sichtbar (alle Anbieter).
    const chatZiel = l.rolle === 'main' ? (mainWechsel?.modell ? String(mainWechsel.modell) : 'dem Container-Main') : model;
    const chatText = ok ? `${limit} erreicht: API-Lauf ${l.modell} beendet, weiter mit ${chatZiel} (CLI-Abo).${thoughtId ? ' Uebergabe ' + thoughtId + '.' : ''}`
      : `${limit} erreicht: Rueckfall fehlgeschlagen (${String(spawn?.error ?? 'unbekannt')}). Offene Auftraege bleiben liegen.`;
    await importiereSitzungsEintraege(l.identity_id, [{ ref: 'rueckfall:' + l.sitzung + ':' + Date.now(), art: 'text', inhalt: chatText, modell: l.modell }],
      { runtime: l.anbieter, herkunft: 'api' }).catch(() => undefined);
    const eintrag = { identity_id: l.identity_id, rolle: l.rolle, ok, code, thought: thoughtId, eingaenge: offen.length, model,
      spawn: spawn ? { success: spawn.success === true, error: spawn.error ?? null, runtime: spawn.runtime ?? null } : null,
      versuche, main_wechsel: mainWechsel, zeit: new Date().toISOString() };
    this.stat.ruckfall_container.anzahl += 1;
    if (!ok) this.stat.ruckfall_container.fehlgeschlagen += 1;
    this.stat.ruckfall_container.letzter = eintrag;
    this.merke({ ...eintrag, ende: 'ruckfall_container', hinweis });
  }

  /**
   * P22-T278 C: Main nach erreichtem Tageslimit eines API-Laufs (alle Anbieter, User ae449129). Modellwechsel-Auftrag (Weg der
   * Ueberwachung, erstellt_von RUECKFALL_AUFTRAG_VON = keine User-Wahl) auf das erste verfuegbare Rueckfallmodell der Runtime des Main; der Runtime-Daemon fuehrt ihn aus.
   */
  private async mainRueckfallWechsel(l: LaufZeile, code: string): Promise<Record<string, unknown>> {
    const kette = await leseApiRueckfall();
    const rt = (await this.db.query<{ rt: string | null }>("SELECT startrezept->>'runtime' AS rt FROM agent_identitaeten WHERE id = $1", [l.identity_id])).rows[0]?.rt ?? 'claude';
    for (const kandidat of kette.modelle) {
      const p = await pruefeRueckfallModell(kandidat);
      if (!p.verfuegbar || p.runtime !== rt) continue;
      const gewuenscht = { modell: kandidat, ...(rt === 'codex' && kette.effort ? { effort: kette.effort } : {}) };
      try {
        await this.db.query(
          `INSERT INTO agent_runtime_auftraege (id, identity_id, art, status, gewuenscht, grund, erstellt_von)
           VALUES ($1,$2,'modellwechsel','pending',$3::jsonb,$4,$5)`,
          [randomUUID(), l.identity_id, JSON.stringify(gewuenscht), `Tageslimit erreicht (${code}): Rueckfall von ${l.modell} auf ${kandidat}`, RUECKFALL_AUFTRAG_VON]);
        return { modell: kandidat, runtime: rt, auftrag: 'modellwechsel' };
      } catch (err) {
        return { modell: kandidat, runtime: rt, fehler: (err as { code?: string }).code === '23505' ? 'auftrag_offen_vorhanden' : String((err as Error)?.message ?? err).slice(0, 200) };
      }
    }
    return { modell: null, runtime: rt, fehler: 'kein_rueckfall_modell_fuer_runtime' };
  }

  private async neuerTurn(l: LaufZeile): Promise<number> {
    const t = await this.db.query<{ id: string }>('INSERT INTO api_agent_turns (identity_id, sitzung, modell) VALUES ($1,$2,$3) RETURNING id',
      [l.identity_id, l.sitzung, l.modell]);
    return Number(t.rows[0].id);
  }

  private async schliesseTurn(id: number, a: Ausfuehrung, ende?: string): Promise<void> {
    await this.db.query(
      `UPDATE api_agent_turns SET beendet_am = NOW(), ende = $2, meldung = $3, runden = $4, kosten_usd = $5, input_tokens = $6, output_tokens = $7,
          kontext_tokens = $8, antwort = $9 WHERE id = $1`,
      [id, ende ?? a.ergebnis.ende, a.ergebnis.meldung, a.ergebnis.runden, a.ergebnis.kosten_usd, a.input, a.output, a.kontext, a.ergebnis.text.slice(0, ANTWORT_MAX_ZEICHEN)]);
  }

  private async turn(l: LaufZeile, e: ApiLaufEinstellungen, signal: AbortSignal): Promise<void> {
    const start = Date.now();
    const eing = await this.db.query<EingangZeile>(
      'SELECT id, text, quelle, absender, erstellt_am FROM api_agent_eingang WHERE identity_id = $1 AND erledigt_am IS NULL ORDER BY id', [l.identity_id]);
    if (!eing.rows.length) { await this.gibFrei(l, {}); return; }
    const ids = eing.rows.map(z => z.id);
    // P22-T286/K1: Turn-Kontext je Turn (kein Instanzfeld); K3: Schalter je Turn.
    const ctx: TurnKontext = { verlaufAn: (await leseApiVerlaufHauptverlaufSchalter(l.project)).aktiv,
      mainChat: eing.rows.some(z => z.quelle === 'main_chat'), letzteTextRef: null };
    const s = await this.sitzung(l);
    const verlauf = await VerlaufPg.oeffne(this.db, l.identity_id, l.sitzung, (n, nr) => this.verlaufsNachricht(l, ctx, l.sitzung, nr, n), (nr) => this.loescheVerlauf(l, l.sitzung, nr));
    const turnId = await this.neuerTurn(l);
    await this.db.query('UPDATE api_agent_eingang SET turn_id = $2 WHERE id = ANY($1::bigint[])', [ids, turnId]);
    // P22-T286/N1+K6: die Eingabe traegt die feste ref 'eingang:<sortierte ids>'; bei "nicht begonnen" wird sie wieder entfernt.
    const eingangRef = 'eingang:' + [...ids].sort((a, b) => Number(a) - Number(b)).join('-');
    await verlauf.fuegeHinzu({ rolle: 'user', inhalt: [{ typ: 'text', text: eingangText(eing.rows) }] }, { hauptverlauf: false });
    if (ctx.verlaufAn && !ctx.mainChat) {
      await this.schreibeHauptverlauf(l, [{ ref: eingangRef, art: 'eingabe', inhalt: eingangText(eing.rows), modell: l.modell }]);
    }
    const a = await this.fuehreAus(l, s, verlauf, signal);
    this.stat.turns += 1;

    if (a.ergebnis.ende === 'anbieter_fehler' && a.aufrufe === 0) {
      // Nicht begonnen (Fachfehler vor dem Anbieter, z. B. api_freigabe_fehlt, budget_erschoepft, funktion_aus): Eingaenge bleiben offen.
      const code = a.code ?? 'anbieter_fehler';
      const voruebergehend = VORUEBERGEHEND.has(code);
      await verlauf.entferneLetzte();
      // P22-T286/K6: die live geschriebene Eingabezeile eines nicht begonnenen Turns wieder entfernen.
      if (ctx.verlaufAn && !ctx.mainChat) await this.loescheRef(l, eingangRef);
      if (RUECKFALL_CODES.has(code)) {
        // Tageslimit erschoepft: Eingaenge gehen mit an den Container-Agenten.
        await this.db.query('UPDATE api_agent_eingang SET turn_id = NULL WHERE id = ANY($1::bigint[])', [ids]);
        await this.schliesseTurn(turnId, a, 'nicht_begonnen');
        await this.rueckfallContainer(l, s, code);
        return;
      }
      await this.db.query(
        `UPDATE api_agent_eingang SET turn_id = NULL, faellig_ab = CASE WHEN $2 THEN NOW() + make_interval(secs => $3) ELSE faellig_ab END
          WHERE id = ANY($1::bigint[])`, [ids, voruebergehend, WIEDERHOL_SEKUNDEN]);
      await this.schliesseTurn(turnId, a, 'nicht_begonnen');
      await this.gibFrei(l, { status: voruebergehend ? 'bereit' : 'fehler', fehler: code });
      this.merke({ identity_id: l.identity_id, ende: 'nicht_begonnen', code, meldung: a.ergebnis.meldung?.slice(0, 300) ?? null, eingaenge: ids.length, ms: Date.now() - start });
      return;
    }

    await this.db.query('UPDATE api_agent_eingang SET erledigt_am = NOW() WHERE id = ANY($1::bigint[])', [ids]);
    await this.schliesseTurn(turnId, a);
    // P22-T286/K1+K2: erst alle Schreibvorgaenge dieses Turns abwarten, dann die Messwerte nachtragen.
    if (ctx.verlaufAn && !ctx.mainChat) {
      await this.warteKette(l.identity_id);
      if (ctx.letzteTextRef) await setzeGemesseneTokens(l.identity_id, 'api:' + ctx.letzteTextRef, { input: a.input, output: a.output, kontext: a.kontext });
    }
    // P22-T286/K5b: nur im 'zeit'-Fall schliesst der Turn die Antwortzeile selbst.
    if (ctx.verlaufAn && ctx.mainChat) this.schliesseMainZeile(l, a);
    // P22-T202: Antwort im bestehenden Identitaetschat sichtbar, keine zweite Kostenbuchung.
    // Main-Chat hat bereits seinen SSE-Verlauf; Startauftrag und Plattform-Chat dagegen nicht.
    if (!ctx.verlaufAn && !eing.rows.some(z=>z.quelle==='main_chat') && (await leseApiLaufWahl(l.identity_id))?.phase==='aktiv') {
      const sichtbar=await importiereSitzungsEintraege(l.identity_id,[
        {ref:'turn:'+turnId+':eingabe',art:'eingabe',inhalt:eingangText(eing.rows),modell:l.modell},
        {ref:'turn:'+turnId+':antwort',art:'text',inhalt:a.ergebnis.text,modell:l.modell},
      ],{runtime:l.anbieter,herkunft:'api'});
      if(sichtbar.grund)this.merke({identity_id:l.identity_id,ende:'chat_verlauf_aus',grund:sichtbar.grund});
    }
    if (a.ergebnis.ende === 'anbieter_fehler' && a.code !== null && RUECKFALL_CODES.has(a.code)) {
      // Tageslimit mitten im Turn erschoepft: Stand steht im Verlauf, Rueckfall auf den Container-Agenten.
      this.merke({ identity_id: l.identity_id, ende: a.ergebnis.ende, code: a.code, kosten_usd: a.ergebnis.kosten_usd, eingaenge: ids.length, ms: Date.now() - start });
      await this.rueckfallContainer(l, s, a.code);
      return;
    }
    this.merke({ identity_id: l.identity_id, ende: a.ergebnis.ende, code: a.code, kosten_usd: a.ergebnis.kosten_usd, eingaenge: ids.length,
      kontext_anteil: a.anteil, ms: Date.now() - start });
    let turns = 1;
    let fehler: string | null = a.ergebnis.ende === 'anbieter_fehler' ? a.code : null;
    let kontext: Ausfuehrung | null = a;
    const schwelle = e.neustart_schwelle_prozent.wert / 100;
    if (a.anteil !== null && a.anteil >= schwelle && a.ergebnis.ende !== 'abgebrochen' && !signal.aborted) {
      turns += 1;
      // P22-T286/R3: der Uebergabe-Turn laeuft NICHT als Chat-Antwort des Users - Uebergabe gehoert als api-Zeilen in den Verlauf.
      ctx.mainChat = false;
      const f = await this.neustartMitUebergabe(l, s, verlauf, a, signal);
      // Erfolg: neue Sitzung, Kontext ist zurueckgesetzt und wird hier nicht wieder ueberschrieben.
      if (f) fehler = f; else kontext = null;
    }
    await this.gibFrei(l, { status: 'bereit', fehler, turns, kontext });
  }

  /**
   * Kontext ueber der Schwelle: Uebergabe-Turn, Uebergabe als thought, neue Sitzung (Verlauf beginnt mit der Uebergabe).
   * Liefert einen Fehlercode, wenn die Uebergabe scheitert (dann bleibt die Sitzung).
   */
  private async neustartMitUebergabe(l: LaufZeile, s: Sitzung, verlauf: VerlaufPg, vorher: Ausfuehrung, signal: AbortSignal): Promise<string | null> {
    const turnId = await this.neuerTurn(l);
    await verlauf.fuegeHinzu({ rolle: 'user', inhalt: [{ typ: 'text', text: UEBERGABE_AUFTRAG }] });
    const a = await this.fuehreAus(l, s, verlauf, signal, 1);
    await this.schliesseTurn(turnId, a, a.ergebnis.ende === 'fertig' ? 'uebergabe' : a.ergebnis.ende);
    const uebergabe = a.ergebnis.text.trim();
    if (a.ergebnis.ende !== 'fertig' || !uebergabe) {
      this.merke({ identity_id: l.identity_id, ende: 'uebergabe_fehlgeschlagen', code: a.code });
      return 'uebergabe_fehlgeschlagen';
    }
    const prozent = Math.round((vorher.anteil ?? 0) * 100);
    let thoughtId: string | null = null;
    try {
      const r = await s.ausfuehrer.rufe(WERKZEUG_PRAEFIX + 'thought', {
        action: 'add', project: l.project, tags: ['session-uebergabe', 'api-lauf-neustart'],
        content: `UEBERGABE ${l.agent_id} (API-Lauf ${l.modell}, Neustart bei Kontext ${prozent} %, Sitzung ${l.sitzung}):\n${uebergabe}`,
      });
      thoughtId = /"id"\s*:\s*"([0-9a-f-]{36})"/.exec(text(r.inhalt))?.[1] ?? null;
    } catch { /* Uebergabe steht trotzdem im neuen Verlauf */ }
    const neu = randomUUID();
    // P22-T286/K1: Kontext dieses Uebergabe-Turns.
    const ctx: TurnKontext = { verlaufAn: await leseApiVerlaufHauptverlaufSchalter(l.project).then(x => x.aktiv).catch(() => false), mainChat: false, letzteTextRef: null };
    const v2 = await VerlaufPg.oeffne(this.db, l.identity_id, neu, (n, nr) => this.verlaufsNachricht(l, ctx, neu, nr, n), (nr) => this.loescheVerlauf(l, neu, nr));
    await v2.fuegeHinzu({ rolle: 'user', inhalt: [{ typ: 'text', text: `[Neustart der Sitzung bei Kontext ${prozent} %. Deine Uebergabe`
      + `${thoughtId ? ' (thought ' + thoughtId + ')' : ''}:]\n${uebergabe}` }] }, { marke: 'uebergabe' });
    await v2.fuegeHinzu({ rolle: 'assistant', inhalt: [{ typ: 'text', text: 'Uebergabe gelesen. Ich setze mit der naechsten Nachricht fort.' }] }, { marke: 'uebergabe' });
    // P22-T286/N4: Nicht-Main bekommt eine generische Wechsel-Zeile (meta thought_id/von/nach/anlass).
    if (ctx.verlaufAn && l.rolle !== 'main') {
      await schreibeWechselZeile(l.identity_id, { von: `${l.anbieter}/${l.modell}`, nach: `${l.anbieter}/${l.modell}`,
        anlass: 'api_neustart', thought_id: thoughtId, runtime: l.anbieter, modell: l.modell });
    }
    await this.db.query(
      `UPDATE api_agent_laeufe SET sitzung = $3, neustarts = neustarts + 1, kontext_tokens = NULL, kontext_fenster = NULL, kontext_anteil = NULL,
          aktualisiert_am = NOW() WHERE identity_id = $1 AND lease_token = $2`, [l.identity_id, l.lease_token, neu]);
    this.sitzungen.delete(l.identity_id);
    this.merke({ identity_id: l.identity_id, ende: 'neustart', kontext_prozent: prozent, thought: thoughtId, sitzung: neu });
    return null;
  }
}

let instanz: LaufVerwaltung | null = null;

export function apiAgentLauf(): LaufVerwaltung | null { return instanz; }

/** Start im API-Prozess (server.ts). Idempotent. */
export function starteApiAgentLauf(o: LaufVerwaltungOptionen = {}): LaufVerwaltung {
  if (instanz) return instanz;
  const v = new LaufVerwaltung(o);
  instanz = v;
  v.starte();
  return v;
}
