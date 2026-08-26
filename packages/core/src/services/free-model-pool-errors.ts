/**
 * Fehlerklassifikation fuer den Modell-Pool.
 *
 * Der Statuscode allein taugt nicht zur Entscheidung. Ein 403 kann eine
 * fehlende Berechtigung sein oder ein aufgebrauchtes Guthaben — im ersten Fall
 * hilft ein anderes Credential, im zweiten hilft gar nichts, und ein Wiederholen
 * im Minutentakt scheitert nur jedes Mal erneut. Deshalb bestimmt hier die
 * ERMITTELTE URSACHE, wie lange etwas pausiert und was als Naechstes versucht
 * wird.
 *
 * Die Regeln stammen aus der Auswertung von NousResearch/hermes-agent
 * (siehe Memory `credential-pool-konzept`), gekuerzt auf das, was fuer unsere
 * Anbieter tatsaechlich vorkommt.
 */

export type FailureReason =
  /** Anmeldung fehlgeschlagen, koennte voruebergehend sein. */
  | 'auth'
  /** Anmeldung endgueltig gescheitert — Credential ist ungueltig, kein Warten hilft. */
  | 'auth_permanent'
  /** Guthaben aufgebraucht oder Abrechnungsgrenze erreicht. */
  | 'billing'
  /** Unsere Ratengrenze bei diesem Anbieter. */
  | 'rate_limit'
  /**
   * Der Anbieter ist nur Vermittler und das MODELL dahinter ist gedrosselt.
   * Unser Zugang ist gesund — ein anderes Modell hilft, ein anderes Credential nicht.
   */
  | 'upstream_rate_limit'
  /** Anbieter ueberlastet (503/529). */
  | 'overloaded'
  /** Serverfehler beim Anbieter (500/502). */
  | 'server_error'
  /** Zeitueberschreitung oder Verbindungsabbruch. */
  | 'timeout'
  /** Modell gibt es dort nicht (mehr). */
  | 'model_not_found'
  /** Anfrage zu gross fuer das Kontextfenster. */
  | 'context_overflow'
  /** Inhaltsfilter des Anbieters — dieselbe Anfrage wird immer abgelehnt. */
  | 'content_policy'
  /** Fehlerhafte Anfrage. */
  | 'format_error'
  /** Nicht einzuordnen. */
  | 'unknown';

export interface ClassifiedFailure {
  reason: FailureReason;
  statusCode: number | null;
  message: string;
  /** Derselbe Kandidat darf es gleich noch einmal versuchen. */
  retryable: boolean;
  /** Ein anderes Modell versuchen. */
  tryOtherModel: boolean;
  /** Ein anderes Credential desselben Anbieters versuchen. */
  tryOtherCredential: boolean;
  /** Wie lange dieser Kandidat pausiert, in Millisekunden. */
  cooldownMs: number;
  /** Vom Anbieter genannte Wartezeit, falls vorhanden. */
  retryAfterMs: number | null;
}

// Sperrdauern. Kurz bei allem, was sich von selbst erholt; lang nur da, wo
// Warten der einzige Weg ist.
const COOLDOWN_AUTH_MS = 60_000;
const COOLDOWN_RATE_LIMIT_MS = 5 * 60_000;
const COOLDOWN_UPSTREAM_MS = 2 * 60_000;
const COOLDOWN_SERVER_MS = 60_000;
const COOLDOWN_MODELL_WEG_MS = 6 * 60 * 60_000;
const COOLDOWN_BILLING_MS = 6 * 60 * 60_000;
const COOLDOWN_TERMINAL_MS = 24 * 60 * 60_000;
const COOLDOWN_STANDARD_MS = 2 * 60_000;

/** Gruende, bei denen ein 401 nicht mehr von selbst besser wird. */
const TERMINALE_AUTH_GRUENDE = [
  'token_invalidated',
  'token_revoked',
  'invalid_grant',
  'invalid_api_key',
  'account_deactivated',
];

const ABRECHNUNGS_MUSTER = [
  'insufficient',
  'credit',
  'balance',
  'quota exceeded',
  'billing',
  'payment',
  'spending limit',
  'key limit exceeded',
  'out of available resources',
];

const KONTEXT_MUSTER = [
  'context length',
  'context_length',
  'too many tokens',
  'maximum context',
  'reduce the length',
  'input is too long',
];

const INHALTS_MUSTER = ['content policy', 'safety', 'content_filter', 'blocked by'];

// 'is not a valid model id': echter OpenRouter-Wortlaut (gemessen 26.08.2026).
// Fiel vorher in den generischen 4xx-Topf: format_error brach als Folge die
// komplette Fallback-Kette ab, obwohl nur der Katalogeintrag veraltet war
// (Befund M). Die letzten beiden sind der Gemini- bzw. Mistral-Wortlaut fuer
// dieselbe Sache (dokumentiert, nicht gemessen — Schluessel liegen nicht vor).
const MODELL_MUSTER = [
  'model not found',
  'unknown model',
  'does not exist',
  'no endpoints found',
  'is not a valid model id',
  'is not found for api version',
  'invalid model:',
];

function enthaelt(text: string, muster: string[]): boolean {
  return muster.some((m) => text.includes(m));
}

/**
 * Liest den Antwortkoerper, egal in welcher Form der Anbieter ihn schickt.
 * Manche verpacken die Meldung in `error.message`, manche in `message`,
 * Bedrock-artige Vermittler in `errorMessage`.
 */
function meldungAus(body: unknown, fallback: string): string {
  if (typeof body === 'string' && body.trim()) return body.trim();
  if (body && typeof body === 'object') {
    const o = body as Record<string, unknown>;
    const fehler = o.error;
    if (fehler && typeof fehler === 'object') {
      const m = (fehler as Record<string, unknown>).message;
      if (typeof m === 'string' && m.trim()) return m.trim();
    }
    if (typeof fehler === 'string' && fehler.trim()) return fehler.trim();
    for (const key of ['message', 'detail', 'errorMessage', 'title']) {
      const wert = o[key];
      if (typeof wert === 'string' && wert.trim()) return wert.trim();
    }
  }
  return fallback;
}

function grundAus(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const fehler = (body as Record<string, unknown>).error;
  const quelle = (fehler && typeof fehler === 'object' ? fehler : body) as Record<string, unknown>;
  for (const key of ['code', 'reason', 'type', 'status']) {
    const wert = quelle[key];
    if (typeof wert === 'string' && wert.trim()) return wert.trim().toLowerCase();
  }
  return '';
}

/**
 * Erkennt Fehler, die ein Vermittler von einem dahinterliegenden Anbieter
 * durchreicht. OpenRouter verpackt sie mit der aeusseren Meldung
 * "Provider returned error" und dem echten Fehler in `metadata.raw`.
 *
 * Das ist die Aussage: unser Zugang ist gesund, das Modell dahinter nicht.
 * Ein anderes Credential zu nehmen waere die falsche Reaktion.
 */
export function istVermittlerFehler(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const fehler = (body as Record<string, unknown>).error;
  if (!fehler || typeof fehler !== 'object') return false;
  const aussen = String((fehler as Record<string, unknown>).message ?? '').trim().toLowerCase();
  if (aussen !== 'provider returned error') return false;
  const metadaten = (fehler as Record<string, unknown>).metadata;
  return typeof metadaten === 'object' && metadaten !== null;
}

/**
 * Vom Anbieter genannte Wartezeit. Zuerst der Header, dann der Meldungstext —
 * viele Anbieter schreiben die Zeit nur in den Text.
 */
export function leseWartezeit(headers: Headers | null, text: string): number | null {
  const kopf = headers?.get('retry-after');
  if (kopf) {
    const sekunden = Number(kopf);
    if (Number.isFinite(sekunden) && sekunden >= 0) return sekunden * 1000;
    const zeitpunkt = Date.parse(kopf);
    if (Number.isFinite(zeitpunkt)) return Math.max(0, zeitpunkt - Date.now());
  }

  const kleingeschrieben = text.toLowerCase();
  // "try again in 42s", "retry after 3 minutes", "wait 1500ms"
  const relativ = /(?:retry|try again|wait)[^0-9]{0,20}(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|sec|seconds?|m|min|minutes?|h|hours?)/.exec(
    kleingeschrieben,
  );
  if (relativ) {
    const wert = Number(relativ[1]);
    const einheit = relativ[2];
    if (Number.isFinite(wert)) {
      if (einheit.startsWith('ms') || einheit.startsWith('milli')) return wert;
      if (einheit.startsWith('h')) return wert * 3_600_000;
      if (einheit.startsWith('m') && !einheit.startsWith('ms')) return wert * 60_000;
      return wert * 1000;
    }
  }

  // Absoluter Zeitpunkt, z.B. "resets at 2026-08-24T21:00:00Z"
  const absolut = /(\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}[^\s"]*)/.exec(kleingeschrieben);
  if (absolut) {
    const zeitpunkt = Date.parse(absolut[1]);
    if (Number.isFinite(zeitpunkt)) {
      const abstand = zeitpunkt - Date.now();
      if (abstand > 0 && abstand < 7 * 24 * 3_600_000) return abstand;
    }
  }
  return null;
}

export interface FailureInput {
  statusCode: number | null;
  body?: unknown;
  headers?: Headers | null;
  /** Fallback, wenn der Koerper keine Meldung enthaelt (z.B. Netzfehler). */
  message?: string;
}

/**
 * Ordnet einen fehlgeschlagenen Aufruf ein.
 *
 * Wichtig fuer den Aufrufer: `statusCode: null` gilt auch fuer Fehler, die
 * MITTEN IM STREAM kommen. Ein Anbieter kann mit HTTP 200 antworten und den
 * Fehler als Ereignis nachschieben — dann ist der Statuscode nutzlos und nur
 * der Text traegt die Information.
 */
export function classifyFailure(input: FailureInput): ClassifiedFailure {
  const status = input.statusCode;
  const rohMeldung = meldungAus(input.body, input.message ?? (status ? 'HTTP ' + status : 'Unbekannter Fehler'));
  const meldung = rohMeldung.toLowerCase();
  const grund = grundAus(input.body);
  const wartezeit = leseWartezeit(input.headers ?? null, rohMeldung);

  const bauen = (
    reason: FailureReason,
    cooldownMs: number,
    optionen: Partial<Pick<ClassifiedFailure, 'retryable' | 'tryOtherModel' | 'tryOtherCredential'>> = {},
  ): ClassifiedFailure => ({
    reason,
    statusCode: status,
    message: rohMeldung.slice(0, 400),
    retryable: optionen.retryable ?? false,
    tryOtherModel: optionen.tryOtherModel ?? true,
    tryOtherCredential: optionen.tryOtherCredential ?? false,
    // Eine vom Anbieter genannte Wartezeit schlaegt unsere Schaetzung, wird
    // aber gedeckelt: manche nennen Stunden fuer eine Minutensperre.
    cooldownMs: wartezeit !== null ? Math.min(Math.max(wartezeit, 1000), cooldownMs * 4) : cooldownMs,
    retryAfterMs: wartezeit,
  });

  // Abrechnung zuerst: sie versteckt sich hinter 402, 403 und sogar 429.
  // Ein schnelles Wiederholen auf einem leeren Konto scheitert jedes Mal neu.
  if (status === 402 || enthaelt(meldung, ABRECHNUNGS_MUSTER)) {
    // Gegenprobe: manche Anbieter schreiben "quota" auch in reine
    // Ratengrenzen. Steht eine kurze Wartezeit dabei, ist es keine Erschoepfung.
    const wirktVoruebergehend = wartezeit !== null && wartezeit < 10 * 60_000;
    if (!wirktVoruebergehend) {
      return bauen('billing', COOLDOWN_BILLING_MS, { tryOtherCredential: true });
    }
  }

  if (status === 401 || status === 403) {
    if (TERMINALE_AUTH_GRUENDE.some((g) => grund.includes(g) || meldung.includes(g.replace(/_/g, ' ')))) {
      return bauen('auth_permanent', COOLDOWN_TERMINAL_MS, { tryOtherCredential: true, tryOtherModel: false });
    }
    return bauen('auth', COOLDOWN_AUTH_MS, { tryOtherCredential: true, tryOtherModel: false });
  }

  if (status === 429) {
    // Beim Vermittler ist die Drosselung eine Aussage ueber das Modell, nicht
    // ueber unseren Zugang — dann bringt ein anderes Credential nichts.
    if (istVermittlerFehler(input.body)) {
      return bauen('upstream_rate_limit', COOLDOWN_UPSTREAM_MS, { tryOtherModel: true });
    }
    return bauen('rate_limit', COOLDOWN_RATE_LIMIT_MS, { tryOtherCredential: true });
  }

  if (status === 404 || enthaelt(meldung, MODELL_MUSTER)) {
    return bauen('model_not_found', COOLDOWN_MODELL_WEG_MS, { tryOtherModel: true });
  }

  if (status === 408) {
    // Vom Server selbst als wiederholbar gekennzeichnet (RFC 9110).
    return bauen('timeout', COOLDOWN_SERVER_MS, { retryable: true });
  }

  if (status === 413 || enthaelt(meldung, KONTEXT_MUSTER)) {
    // Ein anderes Credential aendert nichts; entweder kuerzen oder ein Modell
    // mit groesserem Fenster nehmen.
    return bauen('context_overflow', 0, { tryOtherModel: true });
  }

  if (enthaelt(meldung, INHALTS_MUSTER)) {
    // Dieselbe Anfrage wird ueberall abgelehnt — der Kandidat ist gesund.
    return bauen('content_policy', 0, { tryOtherModel: false, tryOtherCredential: false });
  }

  if (status === 503 || status === 529) {
    return bauen('overloaded', COOLDOWN_SERVER_MS, { retryable: true, tryOtherModel: true });
  }

  if (status !== null && status >= 500) {
    return bauen('server_error', COOLDOWN_SERVER_MS, { retryable: true, tryOtherModel: true });
  }

  if (status !== null && status >= 400) {
    // Uebrige 4xx: unsere Anfrage stimmt nicht. Ein anderes Modell kann helfen
    // (abweichende Parameteranforderungen), ein anderes Credential nicht.
    return bauen('format_error', COOLDOWN_STANDARD_MS, { tryOtherModel: true });
  }

  if (status === null) {
    // Netzfehler oder abgebrochener Stream.
    return bauen('timeout', COOLDOWN_SERVER_MS, { retryable: true, tryOtherModel: true });
  }

  return bauen('unknown', COOLDOWN_STANDARD_MS, { retryable: true, tryOtherModel: true });
}

/**
 * Ob nach diesem Fehler ueberhaupt ein weiterer Kandidat versucht werden soll.
 * Bei einem Inhaltsfilter oder zu grossem Kontext waere das sinnlos: die
 * Anfrage selbst ist das Problem, nicht das Ziel.
 */
export function lohntWeiterenVersuch(fehler: ClassifiedFailure): boolean {
  if (fehler.reason === 'content_policy') return false;
  if (fehler.reason === 'format_error') return false;
  return true;
}
