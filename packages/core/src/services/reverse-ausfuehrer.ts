/**
 * P18-T64: wer führt welche Reverse-Container-Kinds aus?
 * Der Reverse-Executor (rest-api) meldet sich hier mit seinen Kinds an. Pipeline, Diagnose und
 * Entstörer fragen nur diese Registry: Aufträge für Kinds ohne Ausführer werden nicht mehr
 * eingereiht bzw. sichtbar als 'kein_ausfuehrer' markiert, statt ewig pending zu bleiben.
 * Alles prozesslokal (API-Prozess); der stdio-Weg ruft die API.
 */

/** Kinds, die der Reverse-Executor überhaupt beherrscht. S1..S3-Container folgen mit eigenen Tasks. */
export const REVERSE_EXECUTOR_UNTERSTUETZT = ['reverse-E'] as const;

export interface ReverseAusfuehrerInfo {
  kinds: string[];
  parallel: number;
  /** Lesend: belegte/maximale Plätze des Tool-Lebenszyklus (alle Tools). */
  kapazitaet?: () => Promise<{ belegt: number; max: number }>;
  /** Koordinator/Entstörer: festsitzenden Reverse-Container über den Lebenszyklus anhalten (nächster Tick startet neu). */
  containerNeustart?: (jobId?: string | null) => Promise<{ neu_gestartet: boolean; zustand: string | null }>;
}

let aktiv: ReverseAusfuehrerInfo | null = null;

/** Vom Executor beim Start; Rückgabe meldet genau diese Anmeldung wieder ab. */
export function meldeReverseAusfuehrer(info: ReverseAusfuehrerInfo): () => void {
  const eintrag = { ...info, kinds: [...info.kinds] };
  aktiv = eintrag;
  return () => { if (aktiv === eintrag) aktiv = null; };
}

export function reverseAusfuehrer(): ReverseAusfuehrerInfo | null { return aktiv; }

/** true, wenn ein angemeldeter Ausführer diesen Work-Job-Kind annimmt. */
export function reverseKindAusfuehrbar(kind: string, kinds?: readonly string[]): boolean {
  return (kinds ?? aktiv?.kinds ?? []).includes(kind);
}

/**
 * Fehlercodes, die bei unveränderter Eingabe wieder genauso scheitern. Diese Aufträge werden
 * nicht automatisch wiederholt; ein manuelles reverse(analysieren) bleibt möglich.
 */
const DETERMINISTISCH = new Set(['nicht_unterstuetzt', 'format_nicht_unterstuetzt', 'nicht_gefunden', 'gepackt',
  'verschluesselt', 'beschaedigt', 'zu_gross', 'bombe_verdacht', 'pfad_gefahr', 'kein_ausfuehrer',
  // P18-T66: z. B. keine_berechtigung:eingabe_rechte (API darf Eingaberechte nicht setzen) scheitert bis zur Korrektur identisch.
  'keine_berechtigung']);

/** 'format_nicht_unterstuetzt:clonecd' -> {code:'format_nicht_unterstuetzt', detail:'clonecd'}. */
export function zerlegeReverseFehlercode(roh: unknown): { code: string | null; detail: string | null } {
  if (typeof roh !== 'string' || !roh) return { code: null, detail: null };
  const i = roh.indexOf(':');
  if (i < 0) return { code: roh, detail: null };
  const detail = roh.slice(i + 1).trim().replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 64);
  return { code: roh.slice(0, i), detail: detail || null };
}

export function reverseFehlerDeterministisch(roh: unknown): boolean {
  const { code } = zerlegeReverseFehlercode(roh);
  return !!code && DETERMINISTISCH.has(code);
}
