/**
 * P22-T263 (User-Vorgabe thought 9a3005ff): reine Logik des Editor-Plan-Stroms, ohne React/DOM/Importe
 * (testbar mit node --experimental-strip-types, Test web-ui/tests/plan-strom-p22-t263.test.mjs).
 * GRUNDSATZ: ein durchgehender Strom aus PG, keine Animation wird abgebrochen.
 * - Das Gedaechtnis haelt jeden gesehenen Plan selbst fest; ein Abruf, der ihn nicht mehr liefert, entfernt ihn NICHT.
 * - Ein beendeter Plan (committet, verworfen, ...) bekommt lokal seinen Abschlusszeitpunkt. Sichtbar bleibt er, bis
 *   (a) das Offen-Fenster (editor_plan_offen_sekunden, Standard 20 s) ab Abschluss bzw. ab dem letzten Wegklicken vorbei ist,
 *   (b) seine Abschlussanimation fertig ist (animationend oder spaetestens ABSCHLUSS_ANIMATION_MS + Reserve), und
 *   (c) er nicht gerade geoeffnet ist. Danach blendet er in AUSBLENDEN_MS aus (Phase 'geht') und wird erst dann entfernt.
 * - Ein offen gesehener Plan, den der Server (bei vollstaendiger Liste) nicht mehr liefert, gilt als verworfen (geloescht).
 * - Ein spaetes 'open' nach einem bereits gesehenen Abschluss wird ignoriert (Rennen zweier Abrufe).
 */
export type StromZustand = 'entsteht' | 'committet' | 'auto-committet' | 'verworfen' | 'abgelaufen' | 'veraltet' | 'konflikt';
export interface StromOp { i: number; action: string; file_path: string; new_path: string | null; reason: string | null; task_id: string | null; agent_id: string | null; zustand: string | null }
export interface StromPlan {
  id: string; owner_agent_id: string | null; status: string; zustand: StromZustand; auto_commit: boolean; open_for_coedit: boolean;
  reason: string | null; erstellt_am: string; ende_am: string | null; ops: StromOp[]; dateien: string[];
}
export interface StromEintrag {
  plan: StromPlan;
  /** lokale Zeit (ms), zu der der Editor den Plan zuerst sah */
  gesehen: number;
  /** lokale Zeit, zu der der Editor den Abschluss sah (null = entsteht noch) */
  ende: number | null;
  /** lokale Zeit, zu der die Abschlussanimation gemeldet hat, dass sie fertig ist */
  animation_fertig: number | null;
  /** letztes Wegklicken: das Offen-Fenster beginnt dann neu */
  geschlossen: number | null;
}
export type StromPhase = 'entsteht' | 'abgeschlossen' | 'geht' | 'weg';

/** Dauer der Abschlussanimation in editor-plan-strom-p22-t263.css (@keyframes ed-strom-abschluss / ed-strom-verworfen). */
export const ABSCHLUSS_ANIMATION_MS = 2400;
/** Reserve, falls animationend nicht kommt (reduzierte Bewegung, Tab im Hintergrund). */
export const ANIMATION_RESERVE_MS = 1200;
/** Ausblenden vor dem Entfernen (@keyframes ed-strom-raus). */
export const AUSBLENDEN_MS = 600;
export const OFFEN_STANDARD_SEKUNDEN = 20;

export const ZUSTAND_TEXT: Record<StromZustand, string> = {
  entsteht: 'entsteht', committet: 'committet', 'auto-committet': 'auto-committet', verworfen: 'verworfen',
  abgelaufen: 'abgelaufen', veraltet: 'veraltet', konflikt: 'Konflikt',
};
export const OP_ZEICHEN: Record<string, string> = {
  create: '+', update: '↻', delete: '−', move: '→', copy: '⎘', search_replace: '⇄', search_replace_batch: '⇄',
  replace_lines: '≡', insert_after: '↳', delete_lines: '⊖',
};

export function istBeendet(p: Pick<StromPlan, 'zustand'>): boolean { return p.zustand !== 'entsteht'; }

/** Beginn des Offen-Fensters: Abschluss bzw. letztes Wegklicken (was spaeter war). */
export function fristBeginn(e: StromEintrag): number | null {
  if (e.ende === null) return null;
  return Math.max(e.ende, e.geschlossen ?? 0);
}
/** Zeitpunkt, ab dem der Eintrag ausblenden darf (null = entsteht noch). */
export function gehtAb(e: StromEintrag, offenMs: number): number | null {
  const beginn = fristBeginn(e);
  if (beginn === null || e.ende === null) return null;
  const animationEnde = e.animation_fertig ?? e.ende + ABSCHLUSS_ANIMATION_MS + ANIMATION_RESERVE_MS;
  return Math.max(beginn + offenMs, animationEnde);
}
export function phase(e: StromEintrag, jetzt: number, offenMs: number, geoeffnet: string | null): StromPhase {
  if (e.ende === null) return 'entsteht';
  if (geoeffnet === e.plan.id) return 'abgeschlossen';
  const ab = gehtAb(e, offenMs)!;
  if (jetzt < ab) return 'abgeschlossen';
  return jetzt < ab + AUSBLENDEN_MS ? 'geht' : 'weg';
}

export class PlanStromGedaechtnis {
  private eintraege = new Map<string, StromEintrag>();

  /** Abruf einarbeiten. vollstaendig=false (Liste an der Notbremse gekappt): fehlende offene Plaene NICHT als verworfen werten. */
  aktualisiere(plaene: StromPlan[], jetzt: number, opt: { vollstaendig?: boolean } = {}): void {
    const geliefert = new Set<string>();
    for (const p of plaene) {
      geliefert.add(p.id);
      const alt = this.eintraege.get(p.id);
      if (!alt) { this.eintraege.set(p.id, { plan: p, gesehen: jetzt, ende: istBeendet(p) ? jetzt : null, animation_fertig: null, geschlossen: null }); continue; }
      if (alt.ende !== null && !istBeendet(p)) continue;
      alt.plan = p;
      if (alt.ende === null && istBeendet(p)) { alt.ende = jetzt; alt.animation_fertig = null; }
    }
    if (opt.vollstaendig === false) return;
    for (const e of this.eintraege.values()) {
      if (e.ende === null && !geliefert.has(e.plan.id)) { e.plan = { ...e.plan, status: 'cancelled', zustand: 'verworfen' }; e.ende = jetzt; }
    }
  }
  /** Abschlussanimation fertig (animationend der Karte). Nur fuer beendete Plaene wirksam. */
  animationFertig(id: string, jetzt: number): void {
    const e = this.eintraege.get(id);
    if (e && e.ende !== null && e.animation_fertig === null) e.animation_fertig = jetzt;
  }
  /** Wegklicken: der Plan bleibt danach noch einmal das Offen-Fenster lang sichtbar (nur der Plan, ohne Inhalte). */
  geschlossen(id: string, jetzt: number): void {
    const e = this.eintraege.get(id);
    if (e && e.ende !== null) e.geschlossen = jetzt;
  }
  hole(id: string): StromEintrag | undefined { return this.eintraege.get(id); }
  /** Sichtbare Eintraege, neueste zuerst, mit Phase; 'weg' wird ausgelassen (aufraeumen entfernt sie). */
  sichtbar(jetzt: number, offenMs: number, geoeffnet: string | null): Array<StromEintrag & { phase: StromPhase }> {
    return [...this.eintraege.values()]
      .map(e => ({ ...e, phase: phase(e, jetzt, offenMs, geoeffnet) }))
      .filter(e => e.phase !== 'weg')
      .sort((a, b) => Number(b.plan.id) - Number(a.plan.id));
  }
  /** Entfernt Eintraege in Phase 'weg'; liefert die entfernten IDs. */
  aufraeumen(jetzt: number, offenMs: number, geoeffnet: string | null): string[] {
    const weg: string[] = [];
    for (const [id, e] of this.eintraege) if (phase(e, jetzt, offenMs, geoeffnet) === 'weg') { this.eintraege.delete(id); weg.push(id); }
    return weg;
  }
  /** Naechster Zeitpunkt, zu dem sich eine Phase aendert (fuer genau einen Timer), sonst null. */
  naechsteAenderung(jetzt: number, offenMs: number, geoeffnet: string | null): number | null {
    let min: number | null = null;
    for (const e of this.eintraege.values()) {
      if (e.ende === null || geoeffnet === e.plan.id) continue;
      const ab = gehtAb(e, offenMs)!;
      for (const t of [ab, ab + AUSBLENDEN_MS]) if (t > jetzt && (min === null || t < min)) min = t;
    }
    return min;
  }
  anzahlEntstehend(): number { let n = 0; for (const e of this.eintraege.values()) if (e.ende === null) n++; return n; }
  leeren(): void { this.eintraege.clear(); }
}

/** Zeilen von 'neu', die in 'alt' nicht vorkommen (fuer die Markierung geaenderter Zeilen im Commit-Ergebnis). */
export function geaenderteZeilen(alt: string, neu: string): boolean[] {
  const vorher = new Set(alt.split('\n'));
  return neu.split('\n').map(z => !vorher.has(z));
}
export const dateiname = (p: string) => p.slice(p.lastIndexOf('/') + 1);

/*
 * P22-T263 H2 (Abnahme 6d46d12a, Koordinator vor Deploy t232; Pool-Engpass 3c89b7a2): Schatten des geoeffneten, entstehenden Plans
 * NUR fuer Dateien neu laden, deren Ops sich geaendert haben, hoechstens 1 Abruf je Datei und SCHATTEN_TAKT_MS. Ohne Aenderung frischt
 * ein Schatten hoechstens alle SCHATTEN_AUFFRISCHEN_MS auf (Ops koennen per plan_update inhaltlich wechseln, ohne die Metadaten zu aendern).
 */
export const SCHATTEN_TAKT_MS = 1000;
export const SCHATTEN_AUFFRISCHEN_MS = 10000;
export type SchattenStand = ReadonlyMap<string, { sig: string; zeit: number }>;
/** Signatur der Ops einer Datei (Index, Art, Zustand); aendert sie sich, ist der Schatten der Datei neu zu laden. */
export function dateiSignatur(p: Pick<StromPlan, 'ops'>, datei: string): string {
  return p.ops.filter(o => o.file_path === datei || o.new_path === datei).map(o => o.i + ':' + o.action + ':' + (o.zustand ?? '')).join(',');
}
/** Welche Schatten jetzt zu laden sind und wann der naechste Blick faellig ist (null = nichts weiter vorgemerkt). */
export function schattenFaellig(dateien: string[], sig: (datei: string) => string, stand: SchattenStand, jetzt: number): { jetzt: string[]; naechste: number | null } {
  const faellig: string[] = [];
  let naechste: number | null = null;
  for (const f of dateien) {
    const alt = stand.get(f);
    if (!alt) { faellig.push(f); continue; }
    const ab = alt.zeit + (alt.sig !== sig(f) ? SCHATTEN_TAKT_MS : SCHATTEN_AUFFRISCHEN_MS);
    if (jetzt >= ab) faellig.push(f);
    else if (naechste === null || ab < naechste) naechste = ab;
  }
  return { jetzt: faellig, naechste };
}
