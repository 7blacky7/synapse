/**
 * MODUL: Worker-Steuerung (P15-T12, Etappe 1, 11.10.2026)
 * ZWECK: Hintergrund-Worker eines Prozesses einzeln anhalten, fortsetzen und gezielt einen
 *        Durchlauf ausloesen — fuer das Tool 'intern' (nur bei SYNAPSE_INTERN_TOOL=1).
 *
 * ZUSTAND: NUR im Speicher dieses Prozesses (User-Vorgabe 11.10.2026: keine PG-Tabelle). Ein Neustart
 *   beendet jede Pause. Die PG-Schalter aus P14 (intern-schalter.ts) bleiben davon unberuehrt.
 * ZEIT: Jede Pause braucht dauer_min oder bis und endet von selbst; Obergrenze
 *   SYNAPSE_WORKER_PAUSE_MAX_MIN (Standard 120), laengere Angaben werden gekappt (hinweis).
 *   Der Ablauf wird bei jeder Pruefung gegen die Uhr geprueft — kein Timer noetig.
 * LAUFENDE ARBEIT: Worker fragen workerPausiert() VOR dem Holen neuer Arbeit. Was schon laeuft
 *   (Stapel, Lauf, Claim), wird fertig.
 * SICHTBARKEIT: Pausieren, erstes Ueberspringen, Ablauf und Fortsetzen stehen je einmal im Log mit
 *   Praefix "[worker]", damit niemand eine Pause fuer einen Fehler haelt.
 * DURCHLAUF: worker_durchlauf ruft die registrierte Funktion auch waehrend einer Pause auf (gezieltes
 *   Testen Schritt fuer Schritt); waehrend dieses Aufrufs meldet workerPausiert() fuer den Worker null.
 * NEBENEFFEKTE: keine ausser Log.
 */

export interface WorkerDefinition {
  /** eindeutiger Name, z. B. 'parser' */
  name: string;
  beschreibung: string;
  /** In worker_pausieren('alle') enthalten? Standard true. */
  inAlle?: boolean;
  /** Ein Durchlauf jetzt (optional). Ergebnis geht unveraendert in die Antwort. */
  durchlauf?: () => Promise<unknown>;
  /** P27-T4: Betriebsart fuer den Stau-Waechter; nur 'periodisch' mit takt_s wird auf ausbleibenden Takt geprueft. */
  betriebsart?: 'periodisch' | 'ereignisgetrieben' | 'dauerlauf';
  /** P27-T4: erwarteter Takt in s (nur periodisch) */
  takt_s?: number;
}

export interface WorkerPause {
  seit: string;
  bis: string;
  grund: string;
  von: string | null;
}

export interface WorkerStand {
  name: string;
  beschreibung: string;
  in_alle: boolean;
  zustand: 'laeuft' | 'pausiert';
  pause: WorkerPause | null;
  /** Restdauer der Pause in Minuten (gerundet), sonst null */
  rest_min: number | null;
  zuletzt_aktiv: string | null;
  zuletzt_arbeit: string | null;
  uebersprungen_seit_pause: number;
  durchlauf_moeglich: boolean;
  durchlauf_laeuft: boolean;
  durchlaeufe: number;
  letzter_durchlauf: { am: string; dauer_ms: number; ok: boolean; fehler?: string } | null;
}

export class WorkerSteuerungFehler extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

interface InternePause {
  seit: number;
  bis: number;
  grund: string;
  von: string | null;
  gemeldet: boolean;
}

interface Eintrag {
  def: WorkerDefinition;
  pause: InternePause | null;
  zuletztAktiv: number | null;
  zuletztArbeit: number | null;
  uebersprungen: number;
  durchlaufLaeuft: boolean;
  durchlaeufe: number;
  letzterDurchlauf: WorkerStand['letzter_durchlauf'];
}

const register = new Map<string, Eintrag>();

/** Hoechstdauer einer Pause in Minuten (SYNAPSE_WORKER_PAUSE_MAX_MIN, Standard 120). */
export function workerPauseMaxMin(): number {
  const wert = Number(process.env.SYNAPSE_WORKER_PAUSE_MAX_MIN);
  return Number.isFinite(wert) && wert > 0 ? wert : 120;
}

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

/** Meldet einen Worker an (idempotent: eine zweite Anmeldung ersetzt die Definition, der Zustand bleibt). */
export function registriereWorker(def: WorkerDefinition): void {
  const alt = register.get(def.name);
  if (alt) {
    alt.def = def;
    return;
  }
  register.set(def.name, {
    def,
    pause: null,
    zuletztAktiv: null,
    zuletztArbeit: null,
    uebersprungen: 0,
    durchlaufLaeuft: false,
    durchlaeufe: 0,
    letzterDurchlauf: null,
  });
}

/** Nur fuer Tests: alle Worker vergessen. */
export function vergissAlleWorker(): void {
  register.clear();
}

/** Liste der angemeldeten Worker-Namen. */
export function workerNamen(): string[] {
  return [...register.keys()].sort();
}

/** Abgelaufene Pause aufheben (mit Log). true = Pause wirkt noch. */
function pauseWirkt(e: Eintrag, jetzt = Date.now()): boolean {
  if (!e.pause) return false;
  if (e.pause.bis > jetzt) return true;
  console.error(`[worker] ${e.def.name} laeuft wieder (Pause abgelaufen um ${new Date(e.pause.bis).toISOString()}, ${e.uebersprungen}x uebersprungen)`);
  e.pause = null;
  e.uebersprungen = 0;
  return false;
}

/**
 * Fuer Worker, VOR dem Holen neuer Arbeit: ist der Worker gerade pausiert? Liefert dann die Pause,
 * sonst null. Unbekannte Namen sind nie pausiert. Waehrend eines ausgeloesten Durchlaufs immer null.
 * Zaehlt zugleich als Lebenszeichen (zuletzt_aktiv).
 */
export function workerPausiert(name: string): WorkerPause | null {
  const e = register.get(name);
  if (!e) return null;
  e.zuletztAktiv = Date.now();
  if (e.durchlaufLaeuft) return null;
  if (!pauseWirkt(e)) return null;
  const p = e.pause!;
  e.uebersprungen++;
  if (!p.gemeldet) {
    p.gemeldet = true;
    console.error(`[worker] ${name} PAUSIERT — holt keine neue Arbeit bis ${new Date(p.bis).toISOString()} (Grund: ${p.grund}${p.von ? `, von ${p.von}` : ''}). Kein Fehler.`);
  }
  return { seit: new Date(p.seit).toISOString(), bis: new Date(p.bis).toISOString(), grund: p.grund, von: p.von };
}

/** Fuer Worker: es wurde gerade echte Arbeit erledigt (zuletzt_arbeit). */
export function meldeWorkerArbeit(name: string): void {
  const e = register.get(name);
  if (!e) return;
  const jetzt = Date.now();
  e.zuletztAktiv = jetzt;
  e.zuletztArbeit = jetzt;
}

function waehle(namen: string | string[] | undefined, fuerPause: boolean): Eintrag[] {
  if (namen === undefined || (Array.isArray(namen) && namen.length === 0)) {
    throw new WorkerSteuerungFehler('parameter_fehlt', `worker fehlt (Name, Liste oder 'alle'). Bekannt: ${workerNamen().join(', ')}.`);
  }
  const liste = Array.isArray(namen) ? namen : [namen];
  if (liste.length === 1 && liste[0] === 'alle') {
    const alle = [...register.values()];
    return fuerPause ? alle.filter((e) => e.def.inAlle !== false) : alle;
  }
  const unbekannt = liste.filter((n) => !register.has(n));
  if (unbekannt.length > 0) {
    throw new WorkerSteuerungFehler('unbekannter_worker', `Unbekannt in diesem Prozess: ${unbekannt.join(', ')}. Bekannt: ${workerNamen().join(', ')}.`);
  }
  return [...new Set(liste)].map((n) => register.get(n)!);
}

export interface PausiereOptionen {
  dauer_min?: number;
  /** ISO-Zeitpunkt */
  bis?: string;
  grund?: string;
  von?: string;
}

/** Pausiert einen, mehrere oder 'alle' Worker (ohne die mit inAlle:false). Dauer ist Pflicht. */
export function pausiereWorker(
  namen: string | string[] | undefined,
  opt: PausiereOptionen,
): { pausiert: WorkerStand[]; bis: string; hinweis?: string } {
  const grund = opt.grund?.trim();
  if (!grund) throw new WorkerSteuerungFehler('parameter_fehlt', 'grund fehlt (steht im Log und in worker_status).');
  const jetzt = Date.now();
  const maxMs = workerPauseMaxMin() * 60_000;
  let ziel: number;
  if (opt.bis !== undefined && opt.dauer_min !== undefined) {
    throw new WorkerSteuerungFehler('dauer_mehrdeutig', 'Entweder dauer_min oder bis angeben, nicht beides.');
  } else if (opt.bis !== undefined) {
    ziel = Date.parse(opt.bis);
    if (!Number.isFinite(ziel)) throw new WorkerSteuerungFehler('bis_ungueltig', `bis "${opt.bis}" ist kein Zeitpunkt (ISO, z. B. 2026-10-11T18:00:00+02:00).`);
    if (ziel <= jetzt) throw new WorkerSteuerungFehler('bis_vergangen', `bis "${opt.bis}" liegt nicht in der Zukunft.`);
  } else if (opt.dauer_min !== undefined) {
    if (!Number.isFinite(opt.dauer_min) || opt.dauer_min <= 0) throw new WorkerSteuerungFehler('dauer_ungueltig', 'dauer_min muss eine Zahl > 0 sein.');
    ziel = jetzt + opt.dauer_min * 60_000;
  } else {
    throw new WorkerSteuerungFehler('dauer_fehlt', `dauer_min oder bis ist Pflicht (hoechstens ${workerPauseMaxMin()} min, SYNAPSE_WORKER_PAUSE_MAX_MIN).`);
  }
  let hinweis: string | undefined;
  if (ziel - jetzt > maxMs) {
    ziel = jetzt + maxMs;
    hinweis = `Auf die Hoechstdauer gekappt (${workerPauseMaxMin()} min, SYNAPSE_WORKER_PAUSE_MAX_MIN).`;
  }
  const eintraege = waehle(namen, true);
  for (const e of eintraege) {
    e.pause = { seit: jetzt, bis: ziel, grund, von: opt.von ?? null, gemeldet: false };
    e.uebersprungen = 0;
    console.error(`[worker] ${e.def.name} wird pausiert bis ${new Date(ziel).toISOString()} (Grund: ${grund}${opt.von ? `, von ${opt.von}` : ''}); laufende Arbeit wird fertig.`);
  }
  return { pausiert: eintraege.map((e) => stand(e)), bis: new Date(ziel).toISOString(), ...(hinweis ? { hinweis } : {}) };
}

/** Hebt die Pause eines, mehrerer oder aller Worker auf. */
export function setzeWorkerFort(namen: string | string[] | undefined, von?: string): { fortgesetzt: string[]; liefen_schon: string[] } {
  const eintraege = waehle(namen, false);
  const fortgesetzt: string[] = [];
  const liefenSchon: string[] = [];
  for (const e of eintraege) {
    if (e.pause && pauseWirkt(e)) {
      console.error(`[worker] ${e.def.name} laeuft wieder (fortgesetzt${von ? ` von ${von}` : ''}, ${e.uebersprungen}x uebersprungen)`);
      e.pause = null;
      e.uebersprungen = 0;
      fortgesetzt.push(e.def.name);
    } else {
      liefenSchon.push(e.def.name);
    }
  }
  return { fortgesetzt, liefen_schon: liefenSchon };
}

/** Loest genau einen Durchlauf aus — auch waehrend einer Pause. Zwei gleichzeitige gibt es nicht. */
export async function loeseWorkerDurchlaufAus(name: string | undefined): Promise<Record<string, unknown>> {
  if (!name) throw new WorkerSteuerungFehler('parameter_fehlt', `worker fehlt. Bekannt: ${workerNamen().join(', ')}.`);
  const e = register.get(name);
  if (!e) throw new WorkerSteuerungFehler('unbekannter_worker', `Unbekannt in diesem Prozess: ${name}. Bekannt: ${workerNamen().join(', ')}.`);
  if (!e.def.durchlauf) throw new WorkerSteuerungFehler('kein_durchlauf', `${name} kennt keinen einzelnen Durchlauf.`);
  if (e.durchlaufLaeuft) throw new WorkerSteuerungFehler('durchlauf_laeuft', `Fuer ${name} laeuft schon ein ausgeloester Durchlauf.`);
  const warPausiert = pauseWirkt(e);
  e.durchlaufLaeuft = true;
  const t0 = Date.now();
  console.error(`[worker] ${name}: Durchlauf ausgeloest${warPausiert ? ' (trotz Pause, einmalig)' : ''}`);
  try {
    const ergebnis = await e.def.durchlauf();
    e.letzterDurchlauf = { am: new Date(t0).toISOString(), dauer_ms: Date.now() - t0, ok: true };
    return { worker: name, ok: true, dauer_ms: Date.now() - t0, trotz_pause: warPausiert, ergebnis: ergebnis ?? null };
  } catch (err) {
    const fehler = err instanceof Error ? err.message : String(err);
    e.letzterDurchlauf = { am: new Date(t0).toISOString(), dauer_ms: Date.now() - t0, ok: false, fehler };
    return { worker: name, ok: false, dauer_ms: Date.now() - t0, trotz_pause: warPausiert, fehler };
  } finally {
    e.durchlaufLaeuft = false;
    e.durchlaeufe++;
    meldeWorkerArbeit(name);
  }
}

function stand(e: Eintrag, jetzt = Date.now()): WorkerStand {
  const wirkt = pauseWirkt(e, jetzt);
  const p = wirkt ? e.pause! : null;
  return {
    name: e.def.name,
    beschreibung: e.def.beschreibung,
    in_alle: e.def.inAlle !== false,
    zustand: p ? 'pausiert' : 'laeuft',
    pause: p ? { seit: new Date(p.seit).toISOString(), bis: new Date(p.bis).toISOString(), grund: p.grund, von: p.von } : null,
    rest_min: p ? Math.ceil((p.bis - jetzt) / 60_000) : null,
    zuletzt_aktiv: iso(e.zuletztAktiv),
    zuletzt_arbeit: iso(e.zuletztArbeit),
    uebersprungen_seit_pause: p ? e.uebersprungen : 0,
    durchlauf_moeglich: Boolean(e.def.durchlauf),
    durchlauf_laeuft: e.durchlaufLaeuft,
    durchlaeufe: e.durchlaeufe,
    letzter_durchlauf: e.letzterDurchlauf,
  };
}

/** P27-T4: Lebenszeichen je Worker fuer den Stau-Waechter (nur lesend, aendert keinen Zustand). */
export function workerLebenszeichen(): Array<{
  name: string; betriebsart: string | null; takt_s: number | null; pausiert: boolean; durchlauf_laeuft: boolean;
  zuletzt_aktiv_ms: number | null; zuletzt_arbeit_ms: number | null;
}> {
  const jetzt = Date.now();
  return [...register.values()].sort((x, y) => x.def.name.localeCompare(y.def.name)).map((e) => ({
    name: e.def.name,
    betriebsart: e.def.betriebsart ?? null,
    takt_s: typeof e.def.takt_s === 'number' && e.def.takt_s > 0 ? e.def.takt_s : null,
    pausiert: !!e.pause && e.pause.bis > jetzt,
    durchlauf_laeuft: e.durchlaufLaeuft,
    zuletzt_aktiv_ms: e.zuletztAktiv,
    zuletzt_arbeit_ms: e.zuletztArbeit,
  }));
}

/** Stand aller angemeldeten Worker dieses Prozesses. */
export function workerStatus(): WorkerStand[] {
  const jetzt = Date.now();
  return [...register.values()].sort((x, y) => x.def.name.localeCompare(y.def.name)).map((e) => stand(e, jetzt));
}
