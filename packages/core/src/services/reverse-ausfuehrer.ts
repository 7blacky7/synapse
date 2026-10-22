/**
 * P18-T64: wer führt welche Reverse-Container-Kinds aus?
 * Der Reverse-Executor (rest-api) meldet sich hier mit seinen Kinds an. Pipeline, Diagnose und
 * Entstörer fragen nur diese Registry: Aufträge für Kinds ohne Ausführer werden nicht mehr
 * eingereiht bzw. sichtbar als 'kein_ausfuehrer' markiert, statt ewig pending zu bleiben.
 * Alles prozesslokal (API-Prozess); der stdio-Weg ruft die API.
 */

/** Kinds, die der Reverse-Executor überhaupt beherrscht. P18-T69: reverse-S3 = Ghidra, liefert S2 und S3 aus einem Lauf. */
export const REVERSE_EXECUTOR_UNTERSTUETZT = ['reverse-E', 'reverse-S3'] as const;

/** P18-T69: Ghidra-Budget je S3-Lauf (User da83be67): 4 GB RAM, 2 CPU. */
export const REVERSE_S3_RESOURCE_NEED_STANDARD = { cpu: 2, ram: 4096, vram: 0, gpu: false } as const;
/**
 * Roher Ressourcenbedarf (JSON) je Container-Kind. Work-Job (Pipeline) und Container-Budget (Executor) lesen dieselbe
 * Stelle: reverse-S3 aus SYNAPSE_REVERSE_S3_RESOURCE_NEED (Standard 4 GB/2 CPU), alle anderen aus SYNAPSE_REVERSE_RESOURCE_NEED.
 */
export function reverseResourceNeedRoh(kind: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (kind === 'reverse-S3') return env.SYNAPSE_REVERSE_S3_RESOURCE_NEED?.trim() || JSON.stringify(REVERSE_S3_RESOURCE_NEED_STANDARD);
  return env.SYNAPSE_REVERSE_RESOURCE_NEED;
}

export interface ReverseAusfuehrerInfo {
  kinds: string[];
  parallel: number;
  /** Lesend: belegte/maximale Plätze des Tool-Lebenszyklus (alle Tools). */
  kapazitaet?: () => Promise<{ belegt: number; max: number }>;
  /** Koordinator/Entstörer: festsitzenden Reverse-Container über den Lebenszyklus anhalten (nächster Tick startet neu). */
  containerNeustart?: (jobId?: string | null) => Promise<{ neu_gestartet: boolean; zustand: string | null }>;
  /** P18-T87: Zeitlimit je Kind in Sekunden; harte Frist = Zeitlimit + Einstellwert hart_puffer_s (diagnose: ueber_zeitlimit). */
  zeitlimits?: Record<string, number>;
}

/**
 * P18-T87: Storno-Wunsch fuer LAUFENDE Containerarbeit (reverse abbrechen). Dauerhaft als work_job_audit-Ereignis, ohne neues
 * Schema; der Executor sieht ihn im naechsten Takt, beendet den Lauf und setzt Work-Job cancelled / Auftrag abgebrochen.
 */
export const REVERSE_STORNO_EVENT = 'storno_angefordert';
type AuditDb = { query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number | null }> };
/** Idempotent: true, wenn der Wunsch jetzt neu eingetragen wurde. */
export async function reverseStornoAnfordern(db: AuditDb, jobId: string, detail: Record<string, unknown>): Promise<boolean> {
  const r = await db.query(`INSERT INTO work_job_audit(id,job_id,event,detail) SELECT gen_random_uuid(),$1,$2,$3::jsonb
    WHERE NOT EXISTS(SELECT 1 FROM work_job_audit WHERE job_id=$1 AND event=$2)`, [jobId, REVERSE_STORNO_EVENT, JSON.stringify(detail)]);
  return (r.rowCount ?? 0) > 0;
}
export async function reverseStornoAngefordert(db: AuditDb, jobId: string): Promise<boolean> {
  return (await db.query('SELECT 1 FROM work_job_audit WHERE job_id=$1 AND event=$2 LIMIT 1', [jobId, REVERSE_STORNO_EVENT])).rows.length > 0;
}

/** P18-T87: Obergrenze des Puffers; die Transportfrist des Descriptors liegt 60 s ueber dem Zeitlimit. */
export const REVERSE_HART_PUFFER_MAX_S = 55;
export interface ReverseAufsichtWert { wert: number; quelle: string }
/**
 * P18-T87: Puffer der harten Frist und Nachlauf fuer das Manifest (beide s) sind Reverse-Einstellwerte (reverse_einstellungen,
 * global; Code-Wert nur Standard). Eine Lesestelle fuer Executor und diagnose. Dynamischer Import: reverse-einstellungen zieht
 * intern-tool nach; statisch entstuende ein Importzyklus ueber intern-schalter.
 */
export async function leseReverseAufsicht(): Promise<{ hart_puffer_s: ReverseAufsichtWert; nachlauf_s: ReverseAufsichtWert; letzter_fehler: string | null }> {
  const { leseReverseEinstellungen } = await import('./reverse-einstellungen.js');
  const s = await leseReverseEinstellungen(null);
  const wert = (n: 'hart_puffer_s' | 'nachlauf_s'): ReverseAufsichtWert => ({ wert: s.werte[n].wert, quelle: String(s.werte[n].quelle) });
  const puffer = wert('hart_puffer_s');
  return { hart_puffer_s: { ...puffer, wert: Math.min(puffer.wert, REVERSE_HART_PUFFER_MAX_S) }, nachlauf_s: wert('nachlauf_s'), letzter_fehler: s.letzter_fehler };
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
  'keine_berechtigung',
  // P18-T87: Frist erreicht (Runner bzw. harte Executor-Frist): ein automatischer Neuversuch liefe wieder bis zum Limit.
  'zeitlimit','policy_pin_fehlt','policy_geaendert','policy_grenze','policy_nicht_lesbar']);

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
