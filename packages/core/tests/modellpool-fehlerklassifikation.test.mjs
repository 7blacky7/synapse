/**
 * PRUEFT DIE FEHLERKLASSIFIKATION DES MODELL-POOLS GEGEN ECHTE ANBIETER-ANTWORTEN.
 *
 * WOZU: classifyFailure entscheidet, wie lange ein Kandidat pausiert und was als
 * Naechstes versucht wird (anderes Modell, anderes Credential, gar nichts).
 * Bis zu dieser Datei war jede dieser Zusagen nur von Hand gegen echte Anbieter
 * geprueft — reproduzierbar war davon nichts (handoff-modell-pool-2026-08-24,
 * Punkt 11). Mit ihr faellt eine Regression auf, ohne dass jemand hinsieht.
 *
 * SOLLWERTE: Faelle mit Quelle "gemessen 26.08.2026" sind ECHTE Antworten der
 * Anbieter (OpenRouter 401/400, Groq 401), an diesem Tag live abgeholt. Faelle,
 * die sich ohne gueltigen Schluessel nicht ausloesen lassen (429,
 * Vermittler-Wrapper), folgen den in free-model-pool-errors.ts dokumentierten
 * realen Formaten und tragen die Quelle "dokumentiert".
 *
 * AUFRUF:
 *   node packages/core/tests/modellpool-fehlerklassifikation.test.mjs
 * Exit 0 = keine Zusage unerwartet verletzt. Exit 1 = mindestens eine doch.
 * Braucht ein gebautes packages/core/dist, baut NICHT selbst. Keine DB, kein Netz.
 *
 * ERWARTET-ROT: beschreibt den SOLLZUSTAND, den der heutige Code bekanntermassen
 * NICHT erfuellt. Solche Faelle werden einzeln benannt und gezaehlt, brechen den
 * Lauf aber nicht (Exit bleibt 0). Schlaegt einer GRUEN um, meldet der Lauf das
 * laut — dann ist die Luecke geschlossen und die Kennzeichnung zu entfernen.
 * Ein Test, der bei kaputtem Verhalten kommentarlos gruen meldet, waere selbst
 * der Fehler aus muster-stille-teilantwort.
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const hier = dirname(fileURLToPath(import.meta.url));
const { classifyFailure, leseWartezeit, lohntWeiterenVersuch } = await import(
  join(hier, '..', 'dist', 'services', 'free-model-pool-errors.js')
);
// einordnen liegt in einem anderen Modul. Der Import ist fuer diesen Test
// nebenwirkungsfrei: die Funktion ist rein, DB und Netz beruehrt das Modul
// erst bei Katalog-Aufrufen.
const { einordnen } = await import(join(hier, '..', 'dist', 'services', 'free-model-pool.js'));

// ── Prueflogik: soll = Feld -> exakter Wert ODER Bedingungsfunktion ─────────
function abweichungen(ist, soll) {
  const saetze = [];
  for (const [feld, erwartung] of Object.entries(soll)) {
    const wert = ist == null ? undefined : ist[feld];
    if (typeof erwartung === 'function') {
      if (!erwartung(wert)) saetze.push(feld + ': Bedingung verletzt, ist ' + JSON.stringify(wert));
    } else if (wert !== erwartung) {
      saetze.push(feld + ': soll ' + JSON.stringify(erwartung) + ', ist ' + JSON.stringify(wert));
    }
  }
  return saetze;
}

// Selbsttest bei JEDEM Lauf: ein Pruefer, der nie rot werden kann, ist keiner.
{
  if (abweichungen({ a: 1 }, { a: 2 }).length !== 1) {
    console.error('FEHLER  Selbsttest: eine echte Abweichung wurde nicht erkannt');
    process.exit(1);
  }
  if (abweichungen({ a: 1 }, { a: 1 }).length !== 0) {
    console.error('FEHLER  Selbsttest: eine erfuellte Zusage wurde als Abweichung gemeldet');
    process.exit(1);
  }
  if (abweichungen({ a: 5 }, { a: (w) => w > 10 }).length !== 1) {
    console.error('FEHLER  Selbsttest: eine verletzte Bedingung wurde nicht erkannt');
    process.exit(1);
  }
}

const H = 3_600_000;

// ── Faelle: classifyFailure ───────────────────────────────────────
const faelle = [
  {
    label: 'OpenRouter 401 ohne Anmeldung (gemessen 26.08.2026)',
    input: { statusCode: 401, body: { error: { message: 'No cookie auth credentials found', code: 401 } } },
    soll: { reason: 'auth', tryOtherCredential: true, tryOtherModel: false, retryable: false, cooldownMs: 60_000 },
  },
  {
    label: 'Groq 401 mit code invalid_api_key (gemessen 26.08.2026) — terminal, kein Warten hilft',
    input: { statusCode: 401, body: { error: { message: 'Invalid API Key', type: 'invalid_request_error', code: 'invalid_api_key' } } },
    soll: { reason: 'auth_permanent', tryOtherCredential: true, tryOtherModel: false, cooldownMs: 24 * H },
  },
  {
    // Befund M: war erwartet-rot, bis MODELL_MUSTER den Wortlaut kannte.
    // Umschlag nachgewiesen am 26.08. abends, dann erst die Kennzeichnung entfernt.
    label: 'OpenRouter 400 fuer unbekannte Modell-ID (gemessen 26.08.2026; Befund M, gezogen)',
    input: { statusCode: 400, body: { error: { message: 'gibtsnicht/quatsch-9000 is not a valid model ID', code: 400 } } },
    soll: { reason: 'model_not_found', tryOtherModel: true },
  },
  {
    label: 'Gemini-Wortlaut fuer unbekanntes Modell (dokumentiert; realer Status dort ist 404)',
    input: { statusCode: 404, body: { error: { message: 'models/gibtsnicht is not found for API version v1beta, or is not supported for generateContent.' } } },
    soll: { reason: 'model_not_found', tryOtherModel: true },
  },
  {
    label: 'Mistral-Wortlaut fuer unbekanntes Modell (dokumentiert; prueft das Textmuster bei 400)',
    input: { statusCode: 400, body: { error: { message: 'Invalid model: gibtsnicht' } } },
    soll: { reason: 'model_not_found', tryOtherModel: true },
  },
  {
    label: 'Vermittler-429: Modell dahinter gedrosselt, unser Zugang gesund (dokumentiert, istVermittlerFehler)',
    input: { statusCode: 429, body: { error: { message: 'Provider returned error', code: 429, metadata: { raw: 'rate limited', provider_name: 'chutes' } } } },
    soll: { reason: 'upstream_rate_limit', tryOtherModel: true, tryOtherCredential: false },
  },
  {
    label: 'Direkter 429 mit Retry-After-Header 7s: Anbieter-Wartezeit schlaegt die Schaetzung (dokumentiert)',
    input: { statusCode: 429, headers: new Headers({ 'retry-after': '7' }), body: { error: { message: 'Rate limit reached' } } },
    soll: { reason: 'rate_limit', tryOtherCredential: true, retryAfterMs: 7000, cooldownMs: 7000 },
  },
  {
    label: '402 Guthaben aufgebraucht (dokumentiert)',
    input: { statusCode: 402, body: { error: { message: 'Insufficient credits' } } },
    soll: { reason: 'billing', tryOtherCredential: true, cooldownMs: 6 * H },
  },
  {
    label: 'Gegenprobe: "quota exceeded" MIT kurzer Wartezeit ist Ratengrenze, keine Erschoepfung (dokumentiert)',
    input: { statusCode: 429, body: { error: { message: 'Quota exceeded, please try again in 30 seconds' } } },
    soll: { reason: 'rate_limit', retryAfterMs: 30_000 },
  },
  {
    label: '404: Modell gibt es dort nicht (dokumentiert)',
    input: { statusCode: 404, body: { error: { message: 'Not Found' } } },
    soll: { reason: 'model_not_found', tryOtherModel: true },
  },
  {
    label: '408 ist retry-sicher (RFC 9110), kein generischer 4xx-Abbruch',
    input: { statusCode: 408, body: { error: { message: 'Request Timeout' } } },
    soll: { reason: 'timeout', retryable: true },
  },
  {
    label: '413: Kontext zu gross — anderes Credential aendert nichts',
    input: { statusCode: 413, body: { error: { message: 'Payload too large' } } },
    soll: { reason: 'context_overflow', tryOtherModel: true, tryOtherCredential: false, cooldownMs: 0 },
  },
  {
    label: 'Inhaltsfilter: die Anfrage ist das Problem, nicht das Ziel',
    input: { statusCode: 400, body: { error: { message: 'Your request was blocked by our content policy' } } },
    soll: { reason: 'content_policy', tryOtherModel: false, tryOtherCredential: false },
  },
  {
    label: '503 ueberlastet',
    input: { statusCode: 503, body: { error: { message: 'Service Unavailable' } } },
    soll: { reason: 'overloaded', retryable: true, tryOtherModel: true },
  },
  {
    label: '500 Serverfehler',
    input: { statusCode: 500, body: { error: { message: 'Internal Server Error' } } },
    soll: { reason: 'server_error', retryable: true },
  },
  {
    label: 'Fehler mitten im Stream: statusCode null, nur der Text traegt die Information',
    input: { statusCode: null, message: 'Verbindung abgebrochen' },
    soll: { reason: 'timeout', retryable: true },
  },
];

// ── Faelle: leseWartezeit ────────────────────────────────────────
const wartezeitFaelle = [
  { label: 'Retry-After-Header in Sekunden', headers: new Headers({ 'retry-after': '7' }), text: '', soll: (w) => w === 7000 },
  {
    label: 'Retry-After-Header als HTTP-Datum (+60s)',
    headers: new Headers({ 'retry-after': new Date(Date.now() + 60_000).toUTCString() }),
    text: '',
    soll: (w) => typeof w === 'number' && w > 50_000 && w <= 61_000,
  },
  {
    label: 'Text "please try again in 7.66s" (realer Groq-Wortlaut)',
    headers: null,
    text: 'Rate limit reached. Please try again in 7.66s.',
    soll: (w) => typeof w === 'number' && Math.abs(w - 7660) < 0.01,
  },
  { label: 'Text "retry after 3 minutes"', headers: null, text: 'Too many requests, retry after 3 minutes', soll: (w) => w === 180_000 },
  { label: 'Text "wait 1500ms"', headers: null, text: 'please wait 1500ms', soll: (w) => w === 1500 },
  {
    label: 'Absoluter Zeitpunkt (+1h)',
    headers: null,
    text: 'quota resets at ' + new Date(Date.now() + H).toISOString(),
    soll: (w) => typeof w === 'number' && w > H - 10_000 && w <= H + 1000,
  },
  { label: 'Keine Zeitangabe -> null, nicht geraten', headers: null, text: 'irgendein Fehler ohne Zeit', soll: (w) => w === null },
];

// ── Lauf ──────────────────────────────────────────────────────
let gruen = 0;
let rot = 0;
let erwartetRot = 0;
let umgeschlagen = 0;

for (const fall of faelle) {
  const ist = classifyFailure(fall.input);
  const saetze = abweichungen(ist, fall.soll);
  if (fall.erwartetRot) {
    if (saetze.length === 0) {
      umgeschlagen += 1;
      console.log('UMGESCHLAGEN  ' + fall.label + ' — war als bekannte Luecke gekennzeichnet und ist jetzt GRUEN. Kennzeichnung entfernen!');
    } else {
      erwartetRot += 1;
      console.log('ERWARTET-ROT  ' + fall.label + '\n              ' + saetze.join('; ') + '\n              Grund: ' + fall.erwartetRot);
    }
    continue;
  }
  if (saetze.length === 0) {
    gruen += 1;
    console.log('OK      ' + fall.label);
  } else {
    rot += 1;
    console.error('FEHLER  ' + fall.label + '\n        ' + saetze.join('; '));
  }
}

// lohntWeiterenVersuch: bei Inhaltsfilter und Formatfehler ist die ANFRAGE das
// Problem — ein weiterer Kandidat waere sinnlos. Bei einer Ratengrenze nicht.
const versuchsFaelle = [
  { label: 'lohntWeiterenVersuch(content_policy) = false', ist: lohntWeiterenVersuch(classifyFailure({ statusCode: 400, body: { error: { message: 'blocked by content policy' } } })), soll: false },
  { label: 'lohntWeiterenVersuch(format_error) = false', ist: lohntWeiterenVersuch(classifyFailure({ statusCode: 422, body: { error: { message: 'invalid parameter' } } })), soll: false },
  { label: 'lohntWeiterenVersuch(rate_limit) = true', ist: lohntWeiterenVersuch(classifyFailure({ statusCode: 429, body: { error: { message: 'slow down' } } })), soll: true },
];
for (const fall of versuchsFaelle) {
  if (fall.ist === fall.soll) {
    gruen += 1;
    console.log('OK      ' + fall.label);
  } else {
    rot += 1;
    console.error('FEHLER  ' + fall.label + ' — ist ' + fall.ist);
  }
}

for (const fall of wartezeitFaelle) {
  const w = leseWartezeit(fall.headers, fall.text);
  if (fall.soll(w)) {
    gruen += 1;
    console.log('OK      leseWartezeit: ' + fall.label);
  } else {
    rot += 1;
    console.error('FEHLER  leseWartezeit: ' + fall.label + ' — ist ' + JSON.stringify(w));
  }
}

// ── Faelle: einordnen (Kostenklasse) ────────────────────────────────
// Eingaben sind ECHTE Katalogzeilen aus free_pool_models (PG, Stand 26.08.2026),
// hier eingefroren — der Test selbst braucht weiterhin keine DB.
const OPENROUTER = { freeSuffixes: [':free'] };
const NVIDIA = {};
const einordnenFaelle = [
  { label: "einordnen: ':free'-Suffix schlaegt den Preis (openrouter/cohere/north-mini-code:free)", ist: einordnen(OPENROUTER, 'cohere/north-mini-code:free', 0, 0), soll: 'free' },
  { label: "einordnen: Suffix gewinnt auch ohne Preisangaben", ist: einordnen(OPENROUTER, 'dots-studio/dots-3-note-preview:free', null, null), soll: 'free' },
  { label: 'einordnen: beide Preise 0 -> free (nvidia/nemotron-mini-4b-instruct)', ist: einordnen(NVIDIA, 'nvidia/nemotron-mini-4b-instruct', 0, 0), soll: 'free' },
  { label: 'einordnen: echte Preise -> paid (openrouter/openai/gpt-5-nano, 0.05/0.40)', ist: einordnen(OPENROUTER, 'openai/gpt-5-nano', 0.05, 0.4), soll: 'paid' },
  { label: 'einordnen: keine Preisangaben -> unknown, nicht free (nvidia/01-ai/yi-large)', ist: einordnen(NVIDIA, '01-ai/yi-large', null, null), soll: 'unknown' },
  // Randfall ohne realen Vertreter (0 Zeilen in free_pool_models, gemessen
  // 26.08.): ein Preis 0, der andere unbekannt -> heute 'free'. Das ist
  // FESTGESCHRIEBENES IST-VERHALTEN, keine Design-Zusage — wer es aendert,
  // aendert bewusst diese Zeile mit.
  { label: 'einordnen: (0, null) -> free (Ist-Verhalten, Randfall ohne realen Vertreter)', ist: einordnen(NVIDIA, 'randfall/nur-eingabepreis', 0, null), soll: 'free' },
];
for (const fall of einordnenFaelle) {
  if (fall.ist === fall.soll) {
    gruen += 1;
    console.log('OK      ' + fall.label);
  } else {
    rot += 1;
    console.error('FEHLER  ' + fall.label + ' — ist ' + JSON.stringify(fall.ist));
  }
}

const gesamt = gruen + rot + erwartetRot + umgeschlagen;
console.log('\nERGEBNIS  ' + gesamt + ' Zusagen: ' + gruen + ' gruen, ' + rot + ' unerwartet rot, ' + erwartetRot + ' erwartet-rot (bekannte Luecken), ' + umgeschlagen + ' umgeschlagen');
process.exit(rot > 0 ? 1 : 0);
