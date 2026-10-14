/**
 * P10-T72 B1 (14.10.2026): Geheimnisse in Tool-Argumenten, -Ergebnissen und -Fehlern schwaerzen, BEVOR sie
 * in tool_calls (Audit/Activity) landen. Gilt fuer ALLE Tools und unabhaengig vom Ergebnis (auch abgelehnte
 * Aufrufe). Anlass: project(projekt_db, uebernehmen:{passwort}) haette das Passwort im Klartext in
 * args_preview geschrieben, die Shell-Maske greift dort nur fuer tool==='shell'.
 *
 * REGELN (Pruefung Runde 2, ad49211a):
 * - Geheimer Schluessel = enthaelt ein Passwort-/Geheimwort als WORTTEIL, gross/klein egal:
 *   password/passwort/passwd/kennwort/pwd/secret/apikey/privatekey/accesskey/credential/
 *   authorization/cookie/databaseurl/dburl/connectionstring (pgpassword, passWort, passwort_neu, DB_PASSWORT)
 *   sowie als ganzes Segment pass/pw/pgpass/dsn (db_pw, pass) — nicht passende_tasks, bypass, compass.
 * - Zahlen/Booleans: bei STARKEN Schluesseln (password/passwort/kennwort/passwd/pwd/pin/secret/private_key,
 *   pw/pgpass, …PASS/…PW mit bekanntem Praefix) geschwaerzt ("password": 123456, PASSWORT=4711); bei schwachen/
 *   mehrdeutigen (token(s), pass, count, api_key …) bleiben sie ("pass": 7, "tokens": 1234). null bleibt immer.
 * - project(projekt_db, uebernehmen): Positivliste — nur database, user, host, port bleiben, alles andere
 *   (auch Zahlen) wird [WERT]; ein uebernehmen, das kein Objekt ist, wird ganz geschwaerzt.
 * - Freitext (Runde 3, 466e660c): ZEILENREGEL fuer Konfigurations- und Prosazeilen — geheimer Schluessel
 *   (Wortteil, beliebiges Nicht-Wort-Zeichen davor), Trenner = oder :, Wert bis Zeilenende bzw. bis zum
 *   Anfuehrungszeichen (YAML/compose/ini/.env/Markdown/Prosa: "password: abc def", "PASSWORD = x",
 *   "Kennwort: x", "`PGPASSWORD=x`"). Ausgenommen: Quelltextzeilen (const/let/var/function/if/return/
 *   import/interface/type/... oder //) und Werte, die Code oder Typ sind (typeof/new/await/require, $var,
 *   a.b / f( / x[, ===, =>, reine Typangabe wie string;, Zeilenende ; , { } ( ), true/false/null/Zahl).
 *   Zusaetzlich gequotete Literale ueberall (auch in Codezeilen), URL-Zugangsdaten (auch ohne User:
 *   postgresql://:x@host), Bearer, sshpass -p, --password[= ]x und mysql/mariadb -px.
 * GRENZFAELLE (bewusst): reine Zahl/true/false bleibt nur bei schwachen Schluesseln sichtbar, null immer; Werte, die wie Code aussehen
 *   (abc.def, f(x), endet auf ; oder ,) bleiben sichtbar; "--password <wort>" und Prosa "Feld passwort: ..."
 *   werden geschwaerzt (im Zweifel schwaerzen); "das passwort ist x" (ohne Trenner) wird nicht erkannt.
 *
 * P10-T76 (14.10.2026, Stichprobe 4fef23d2 C1–C9) — Falsch-Positive bei Quelltext/Doku, KEINE Lockerung fuer
 * echte Schluessel/Passwoerter/Tokens:
 *  C1 token nur als Name-ENDE (token, access_token, accessToken, GITHUB_TOKEN, csrftoken) oder mit Wert-Suffix
 *     (token_value); NICHT tokenizer, token_type, token_count, kontext_tokens, page_token (tokens_in seit
 *     Nachbesserung 2 wieder geheim).
 *  C2 PWD/OLDPWD mit Pfadwert (/…, ~…, C:\…) ist kein Geheimnis (env-Ausgabe); DB_PWD=x bleibt geheim.
 *  C3 pin: Booleans nie, Zahlen ab 4 Ziffern schwaerzen (pin: true bleibt, pin: 4711 -> [WERT]); Koordinator-Entscheid
 *     14.10.2026 (Grenzfall 2fcbbcba): auch 9 und mehr Ziffern (pin: 123456789 -> [WERT]), keine Obergrenze.
 *  C4 Prosa in der Zeilenregel: Wert aus >= 3 Woertern, alle ohne Ziffern/Binnen-Grossbuchstaben, mit
 *     mindestens einem Fuellwort (der/aus/siehe/the/from …) bleibt ("Passwort: kommt aus der .env");
 *     Einzelwert, Passphrase ohne Fuellwort und ENV-Form GROSS_SNAKE=wert werden weiter geschwaerzt.
 *  C5 auth/credential(s)/cookie mit harmlosem Einzelwert (none, basic, oauth, include, same-origin, true …) bleibt.
 *  C6 Feldnamen-Literale ('x-synapse-token', "password", 'authToken') bleiben, wenn der Schluessel ein
 *     Namensfeld ist (…_FIELD/_HEADER/_NAME/_KEY …) oder die Zeile Quelltext ist und der Schluessel nicht stark.
 *  C7 Typangaben anderer Sprachen (Python str/Optional[str], Rust String/&str/Option<…>, Go []byte) bleiben.
 *  C8 Platzhalter (<dein-passwort>, ***, xxx, [WERT], {{ … }}, %VAR%) zaehlen nicht als Treffer.
 *  C9 Jede Ersetzung hat eine stabile REGEL-KENNUNG (SCHWAERZ_REGELN); schwaerzeToolLogTextMitRegeln liefert
 *     Treffer je Regel und je (normalisiertem) Schluesselnamen und kann auf eine Regel-Auswahl beschraenkt werden.
 *
 * NACHBESSERUNG 2 (Nachpruefung 61ca8b09, User-Grundsatz: KEINE Lockerung bei Schluesseln/Passwoertern/Tokens; alles,
 * was an der Basis 9f5b103a geschwaerzt wurde, bleibt geschwaerzt):
 *  N1 Quellverweis unter starkem Schluessel nur, wenn der GANZE Wert verankert ein reiner Verweis ist (istQuellVerweis);
 *     "hunter2 siehe .env", "Xk9#mQ2v $HOME", "correcthorse process.env.X" werden geschwaerzt.
 *  N2 TOKEN_META_SUFFIX nur type/count/len/length/size/limit/budget/usage/estimate/ttl/expiry/expires; token irgendwo im
 *     Segment (token2, tokenstore) ist geheim, ausser tokenizer.
 *  N3 Werte mit Geheimnis-Muster (ghp_/gho_/github_pat_/xox?-/sk-/sk_live_/Bearer/AKIA, hohe Entropie >= 20 Zeichen) sind
 *     nie harmlos; unter Namen mit Geheimwort-Anteil (token_count, page_token, cache_key) werden sie trotzdem
 *     geschwaerzt; im freien Text greift die Regel muster (lange Formen) unabhaengig vom Namen.
 *  N4 Koordinator-Entscheid zu 91fd264e: C3 (pin-Flag/kurze pin-Zahl) und C5 (auth/credentials/cookie-Verfahrensname)
 *     ZURUECKGENOMMEN — pin und auth-Werte werden wie an der Basis immer geschwaerzt (pin: 123, pin: true, auth: basic).
 *  N5 Go-Zuweisung ':=' (apiKey := "x") wird wie '=' behandelt (kv-Regel), Literal unter geheimem Namen -> [WERT].
 * Nur Audit-Daten: die Antwort an den Aufrufer bleibt unveraendert.
 */
import { maskiereAnsichtLinks, maskiereUrl, URL_ZUGANGSDATEN } from './masken-katalog.js';

export const TOOL_LOG_PLATZHALTER = '[WERT]';

/**
 * P10-T76 C9: stabile Regel-Kennungen (nicht umbenennen, nur ergaenzen).
 * struktur = geheimer Schluessel im geparsten JSON/Objekt; zugang_container = project(projekt_db, uebernehmen);
 * json_feld/json_skalar = "schluessel": "wert" bzw. Zahl/Boolean im JSON-Text (auch abgeschnitten);
 * env = GROSS_SNAKE=wert (Zeilen- oder Paarregel); zeile = Konfigurations-/Prosazeile; kv = schluessel=wert-Paar
 * (gequotete Literale, auch in Codezeilen); url = Userinfo in URLs (Katalogregel shell.url); url_ohne_user =
 * scheme://:pw@; bearer; cli_lang = --password x; cli_mysql = mysql -px; sshpass = sshpass -p x.
 */
export const SCHWAERZ_REGELN = [
  'struktur', 'zugang_container', 'json_feld', 'json_skalar', 'env', 'zeile', 'kv',
  'url', 'url_ohne_user', 'bearer', 'cli_lang', 'cli_mysql', 'sshpass',
  // Nachbesserung 2 (N3): bekannte Geheimnis-Muster im freien Text (ghp_, github_pat_, xox?-, sk-, sk_live_, AKIA …)
  'muster',
  // P13-T33/A15: Token in Ansicht-Link-URLs (/api/assets/ansicht/<token>).
  'ansicht_link',
] as const;
export type SchwaerzRegel = (typeof SCHWAERZ_REGELN)[number];

/** Laufender Bericht (synchron, nur innerhalb von schwaerzeToolLogTextMitRegeln gesetzt). */
interface SchwaerzLauf { regeln: Set<string> | null; treffer: Partial<Record<SchwaerzRegel, number>>; schluessel: Record<string, number> }
let lauf: SchwaerzLauf | null = null;

function aktiv(regel: SchwaerzRegel): boolean {
  return !lauf || !lauf.regeln || lauf.regeln.has(regel);
}

function zaehle(regel: SchwaerzRegel, name?: string, anzahl = 1): void {
  if (!lauf) return;
  lauf.treffer[regel] = (lauf.treffer[regel] ?? 0) + anzahl;
  if (name) {
    const k = normiere(name).slice(0, 60);
    lauf.schluessel[k] = (lauf.schluessel[k] ?? 0) + anzahl;
  }
}

function normiere(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().replace(/[.\-\s]/g, '_');
}

/** Verfahrenskennungen und Zaehler/Masse sind keine Zugangsdaten. */
const AUSNAHME = /^(?:wait_token|batch_token|stream_id|(?:next_)?page_token|continuation_token|resume_token|(?:max|input|output|total|cached|prompt|completion)_tokens)$|(?:^|_)(?:count|anzahl|length|len|laenge|size|limit|ttl|timeout|ms|gesetzt|vorhanden|ort|hinweis)$/;
/** Wortteile (im Namen ohne Trenner gesucht). token separat (P10-T76 C1, istTokenName). */
const GEHEIM_TEIL = /passwor[dt]|passwd|passphrase|kennwort|pwd|secret|apikey|privatekey|accesskey|credential|authorization|cookie|databaseurl|dburl|connectionstring|pincode/;
/** Nur als ganzes Segment (sonst zu viele Fehltreffer). */
const GEHEIM_SEGMENT = /^(?:pass|pw|pgpass|dsn|auth|pin)$/;
/** STARKE Schluessel: auch Zahlen und Booleans sind dort Geheimnisse (PINs, Ziffern-Passwoerter). */
const STARK_TEIL = /passwor[dt]|passwd|passphrase|kennwort|pwd|secret|privatekey|pincode/;
const STARK_SEGMENT = /^(?:pw|pgpass|pin)$/;
/** pass am Namensende nur mit bekanntem Praefix. */
const PASS_ENDE = /(?:ssh|db|pg|mysql|sql|smtp|mail|user|admin|root|redis|ftp|ldap|proxy|api|app|svc|service)pass$/;
/**
 * P10-T76 C1 (Nachbesserung Abnahme d996c097): token(s)-Segment gefolgt von diesen Segmenten ist eine Angabe UEBER
 * Tokens (token_type, token_count, tokens_in, TOKEN_HEADER, token_budget), kein Geheimnis. Alle anderen Folgesegmente
 * (Umgebung/Variante: _prod, _ci, _live, _staging, _value, _2 …) bleiben geheim — keine Lockerung.
 */
// Nachbesserung 2 (N2, 61ca8b09): NUR diese Meta-Angaben. id/name/header/in/out/url/path/status … sind KEINE Meta-Angabe
// mehr (DEPLOY_TOKEN_ID, TOKEN_NAME, GH_TOKEN_HEADER, session_token_in, GITHUB_TOKEN_URL bleiben geheim wie an der Basis).
const TOKEN_META_SUFFIX = /^(?:type|count|len|length|size|limit|budget|usage|estimate|ttl|expiry|expires)$/;
/** …_tokens mit diesen Praefixen ist ein Zaehler (kontext_tokens, prompt_tokens); sonst geheim (bot_tokens, refresh_tokens). */
const TOKENS_ZAEHLER_PRAEFIX = /^(?:kontext|context|max|min|input|output|total|cached|cache|prompt|completion|reasoning|thinking|used|verbraucht|rest|remaining|anzahl|num|n|estimated|geschaetzt|budget|limit|frei|free|gesamt|summe|neue|new|eingabe|ausgabe)$/;

/** P10-T76 C1: token(s) als Segment bzw. Name-Ende ist geheim, ausser es folgt eine Meta-Angabe (token_type) oder
 * …_tokens ist ein Zaehler (kontext_tokens); token als Wortanfang (tokenizer) ist kein Treffer. */
function istTokenName(norm: string): boolean {
  const segs = norm.split('_').filter(Boolean);
  for (let i = segs.length - 1; i >= 0; i--) {
    const s = segs[i];
    // N2: token irgendwo im Segment bleibt geheim wie an der Basis (token2, tokenstore, apitokenv2); nur tokenizer nicht.
    if (!s.includes('token') || /tokeni[sz]/.test(s)) continue;
    const nach = segs[i + 1];
    if (nach !== undefined && /tokens?$/.test(s) && TOKEN_META_SUFFIX.test(nach)) return false; // token_type, token_count
    if (s === 'tokens' && i > 0 && TOKENS_ZAEHLER_PRAEFIX.test(segs[i - 1])) return false; // kontext_tokens
    return true;                                                  // SLACK_TOKEN_PROD, token_live, bot_tokens, TOKEN_NAME
  }
  return false;
}

/** Container mit Zugangsdaten: nur diese Felder bleiben im Klartext. */
const ZUGANG_CONTAINER = new Map<string, Set<string>>([['uebernehmen', new Set(['database', 'user', 'host', 'port'])]]);

/** true, wenn unter diesem Schluessel ein Geheimnis steht. */
export function istToolLogGeheimSchluessel(name: string): boolean {
  const norm = normiere(name);
  if (AUSNAHME.test(norm)) return false;
  const kompakt = norm.replace(/_/g, '');
  // P10-T73 H3: Rueckfrage-IDs sind Einmal-Berechtigungen und duerfen nicht dauerhaft lesbar sein.
  if (kompakt === 'bestaetigungid' || kompakt === 'bestaetigung') return true;
  if (GEHEIM_TEIL.test(kompakt)) return true;
  if (istTokenName(norm)) return true;
  if (PASS_ENDE.test(kompakt)) return true; // SSHPASS, DB_PASS, MYSQL_PASS — nicht bypass/compass
  if (/^(?:ssh|db|pg|mysql|sql|smtp|mail|user|admin|root|redis|ftp|ldap|proxy|api)pw$/.test(kompakt)) return true;
  return norm.split('_').some((s) => GEHEIM_SEGMENT.test(s));
}

/**
 * Starker Schluessel (Koordinator 14.10.2026): password/passwort/kennwort/passwd/pwd/pin/secret/private_key,
 * pw/pgpass als Segment, …PASS bzw. …PW mit bekanntem Praefix. Schwach/mehrdeutig bleiben token(s), pass,
 * api_key usw.: dort bleiben Zahlen/Booleans stehen (Zaehler, Flags).
 */
export function istStarkerGeheimSchluessel(name: string): boolean {
  if (!istToolLogGeheimSchluessel(name)) return false;
  const norm = normiere(name);
  const kompakt = norm.replace(/_/g, '');
  if (STARK_TEIL.test(kompakt) || PASS_ENDE.test(kompakt)) return true;
  if (/^(?:ssh|db|pg|mysql|sql|smtp|mail|user|admin|root|redis|ftp|ldap|proxy|api)pw$/.test(kompakt)) return true;
  return norm.split('_').some((s) => STARK_SEGMENT.test(s));
}

// ── P10-T76: harmlose Werte unter geheimen Schluesseln ──
/** C8: Platzhalter sind keine Geheimnisse. Bewusst NICHT: changeme/example/test (koennen echte Werte sein). */
const PLATZHALTER_WERT = /^(?:<[^<>\n]{1,60}>|\*{3,}|[xX]{3,}|\.{3}|…|\[(?:WERT|REDACTED|MASKED|HIDDEN|GEHEIM|MASKIERT)\]|\{\{[^{}\n]{1,60}\}\}|%[A-Za-z_][A-Za-z0-9_]{1,40}%)$/;
// C5 (harmlose Verfahrensnamen unter auth/credentials/cookie) zurueckgenommen (N4, Koordinator-Entscheid zu 91fd264e).
/** C6: Schluessel, unter denen ein Feld-/Headername steht (PASSWORD_FIELD, TOKEN_HEADER_NAME, tokenKey). */
const NAMENS_SUFFIX = /(?:name|field|feld|header|key|param|parameter|spalte|column|prefix|praefix|schluessel|variable|var|env|attr|attribut|label)$/;
/** Nachbesserung d996c097: bei starken Schluesseln und Schluessel-Komposita nur eindeutige Namens-Suffixe (nicht
 * key/env/var/schluessel — SECRET_KEY, apiKey, PASSWORD_VAR tragen dort das Geheimnis selbst). */
const NAMENS_SUFFIX_EINDEUTIG = /(?:name|field|feld|header|param|parameter|spalte|column|prefix|praefix|attr|attribut|label)$/;
/** Schluessel-Komposita: der Wert IST der Schluessel (apiKey, SECRET_KEY, accessKey, private_key, signing_key). */
const SCHLUESSEL_KOMPOSITUM = /(?:api|secret|private|access|signing|sign|encryption|enc|master|client|license|lizenz|crypto|aes|hmac|jwt|session|ssh|gpg|pgp|app|service|auth)key$/;
/** C6: Wert ist selbst genau ein Geheimwort ("password", 'token'). */
const GEHEIMWORT_GANZ = /^(?:password|passwort|passwd|kennwort|pwd|secret|token|apikey|api_key|credentials?|cookie|authorization)$/i;

/**
 * Nachbesserung 2 (N3, 61ca8b09): bekannte Geheimnis-Muster. Ein Wert, der so aussieht, ist NIE harmlos — egal unter
 * welchem Schluessel (Meta-Suffix, Feldnamen-Literal, Prosa, Quellverweis zaehlen dann nicht).
 */
const GEHEIM_MUSTER_TEIL = /(?:^|[^A-Za-z0-9_-])(?:gh[pousr]_[A-Za-z0-9]{6,}|github_pat_[A-Za-z0-9_]{6,}|xox[abprs]-[A-Za-z0-9-]{3,}|sk-[A-Za-z0-9_-]{6,}|[sr]k_(?:live|test)_[A-Za-z0-9]{6,}|(?:AKIA|ASIA)[0-9A-Z]{12,})|\b[Bb]earer\s+[A-Za-z0-9._~+/=-]{8,}/;
/** N3: Inhalt eines PEM-Privatschluessels im freien Text (Kopf/Fuss bleiben, Regel muster). */
const PEM_PRIVAT = /(-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----)(?!\[WERT\])[\s\S]*?(-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g;
/** Im freien Text (Regel muster): nur eindeutig lange Formen, damit Bezeichner wie risk-assessment nicht treffen. */
const GEHEIM_MUSTER_FREI = /(?<![A-Za-z0-9_-])(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9_-]{20,}|[sr]k_(?:live|test)_[A-Za-z0-9]{16,}|(?:AKIA|ASIA)[0-9A-Z]{16})(?![A-Za-z0-9_])/g;
/** Hohe Entropie: >= 20 Zeichen ohne Leerraum, Buchstaben UND Ziffern, Shannon >= 3.5 Bit/Zeichen. */
function hoheEntropie(w: string): boolean {
  if (w.length < 20 || !/^[A-Za-z0-9+/=_.~:-]+$/.test(w) || !/\d/.test(w) || !/[A-Za-z]/.test(w)) return false;
  const h = new Map<string, number>();
  for (const z of w) h.set(z, (h.get(z) ?? 0) + 1);
  let e = 0;
  for (const n of h.values()) { const p = n / w.length; e -= p * Math.log2(p); }
  return e >= 3.5;
}
/** N3: true, wenn der Wert ein bekanntes Geheimnis-Muster enthaelt oder ein Teil davon hohe Entropie hat. */
export function istGeheimMusterWert(wert: unknown): boolean {
  if (typeof wert !== 'string' || wert === '') return false;
  if (GEHEIM_MUSTER_TEIL.test(wert)) return true;
  return wert.split(/[\s"'`,;=]+/).some((t) => hoheEntropie(t.replace(/^[(\[{<]+/, '').replace(/[)\]}>.:!?]+$/, '')));
}
/** N3: Namen mit Geheimwort-Anteil, die durch C1/Ausnahmen nicht als geheim gelten (token_count, page_token, cache_key). */
const GEHEIM_HINWEIS_NAME = /token|secret|passw|kennwort|pwd|apikey|privatekey|accesskey|credential|auth|cookie|key|pass|dsn|pin/;
/** Verfahrenskennungen, die schon an der Basis 9f5b103a ausgenommen waren, bleiben sichtbar. */
const BASIS_AUSNAHME = /^(?:wait_token|batch_token|stream_id)$/;
/** N3: Schluessel ist geheim ODER deutet auf ein Geheimnis hin und der Wert hat ein Geheimnis-Muster. */
function geheimFuerWert(name: string, wert: unknown): boolean {
  if (istToolLogGeheimSchluessel(name)) return true;
  const norm = normiere(name);
  return !BASIS_AUSNAHME.test(norm) && GEHEIM_HINWEIS_NAME.test(norm.replace(/_/g, '')) && istGeheimMusterWert(wert);
}

/**
 * P10-T76: true, wenn der Wert unter diesem (geheimen) Schluessel trotzdem kein Geheimnis ist — Platzhalter (C8),
 * pin-Flag/-Position (C3), PWD-Pfad (C2), Verfahrensname unter auth/credentials/cookie (C5), Mengenangabe unter
 * schwachem Schluessel ("tokens: 12k"), Feldnamen-Literal (C6, zeile = umgebende Zeile fuer die Codezeilen-Pruefung).
 */
export function istHarmloserToolLogWert(name: string, wert: unknown, zeile = ''): boolean {
  if (wert === null || wert === undefined) return true;
  if (typeof wert !== 'string' && typeof wert !== 'number' && typeof wert !== 'boolean') return false;
  const norm = normiere(name);
  const segs = norm.split('_').filter(Boolean);
  const kompakt = segs.join('');
  const w = typeof wert === 'string' ? wert.trim().replace(/^(["'`])([\s\S]*)\1$/, '$2') : String(wert);
  if (w === '') return true;
  if (istGeheimMusterWert(w)) return false; // N3: Geheimnis-Muster ist nie harmlos
  if (PLATZHALTER_WERT.test(w)) return true;
  const stark = istStarkerGeheimSchluessel(name);
  // C3 (pin-Flag/kurze pin-Zahl sichtbar) zurueckgenommen (N4): pin ist starker Schluessel, jeder Wert wird geschwaerzt.
  // C2: env-Ausgabe PWD=/pfad, OLDPWD=~/x
  if ((kompakt === 'pwd' || kompakt === 'oldpwd') && /^(?:~|\/|[A-Za-z]:[\\/])/.test(w)) return true;
  // C5 (auth: none, credentials: 'include', cookie: httponly sichtbar) zurueckgenommen (N4).
  // Mengenangabe unter schwachem Schluessel (tokens: 12k, token: 80%, Token: 3 von 5, tokens: 12k/200k)
  if (!stark && /^-?\d+(?:[.,]\d+)?\s?(?:[kKmMgG]|%|\s*(?:von|of|aus|\/)\s*\d+(?:[.,]\d+)?\s?(?:[kKmMgG]|%)?)$/.test(w)) return true;
  // C6: Feldnamen-Literal ('x-synapse-token', "authToken", "password") — nie mit Ziffern
  if (/^[A-Za-z][A-Za-z0-9_.-]{0,40}$/.test(w) && !/\d/.test(w)
    && (/[-_.]/.test(w) || /[a-z][A-Z]/.test(w) || GEHEIMWORT_GANZ.test(w)) && istToolLogGeheimSchluessel(w)) {
    const streng = stark || SCHLUESSEL_KOMPOSITUM.test(kompakt);
    if ((streng ? NAMENS_SUFFIX_EINDEUTIG : NAMENS_SUFFIX).test(kompakt) || (!streng && CODE_ZEILE.test(zeile))) return true;
  }
  return false;
}

/** C4: Prosa-Wert ("kommt aus der .env") — mind. 3 Woerter, ohne Ziffern/Binnen-Grossbuchstaben, mit Fuellwort. */
const PROSA_FUELLWORT = new Set([
  'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einen', 'einer', 'aus', 'im', 'in', 'ist', 'sind', 'wird',
  'werden', 'kommt', 'siehe', 'steht', 'liegt', 'ueber', 'über', 'per', 'mit', 'von', 'vom', 'zum', 'zur', 'und', 'oder',
  'nicht', 'kein', 'keine', 'nur', 'auch', 'noch', 'bei', 'fuer', 'für', 'auf', 'wie', 'als', 'wenn', 'dann',
  'the', 'a', 'an', 'is', 'are', 'from', 'see', 'via', 'of', 'for', 'with', 'and', 'or', 'not', 'no', 'only', 'comes',
  'stored', 'lives', 'uses', 'use', 'set', 'by', 'to', 'at', 'on', 'be', 'will', 'must', 'should',
]);
/**
 * Nachbesserung d996c097 + Koordinator-Entscheid 14.10.2026 (Grenzfall 2fcbbcba): unter STARKEN Schluesseln reicht
 * weder ein Fuellwort noch ein Verweis-Wort ("password: open the gate now", "password: comes from the moon" sind
 * Passphrasen). Der Text bleibt dort nur sichtbar, wenn er EINDEUTIG auf eine Quelle verweist:
 *  - .env-Datei ("kommt aus der .env", ".env.local"),
 *  - "siehe …"/"see …" mit Datei (Pfad oder Dateiname mit Endung) oder Variable (GROSS_SNAKE, $VAR, ${VAR}),
 *  - ${VAR}, $VAR (GROSS_SNAKE) oder process.env.X.
 * Seit Nachbesserung 2 (N1) nur VERANKERT: der ganze Wert muss ein reiner Verweis sein (istQuellVerweis), kein
 * Teiltreffer irgendwo im Text. Alles andere ("is stored in the vault", "siehe Doku", "hunter2 siehe .env") wird geschwaerzt.
 */
// Nachbesserung 2 (N1, 61ca8b09): Ziele werden nur noch VERANKERT geprueft (ganzes Wort), nie irgendwo im Wert.
const QUELLE_ENV_DATEI = /^(?:[~\w.-]*\/)*\.env(?:\.[A-Za-z0-9_-]+)?$/;
const QUELLE_ENV_VARIABLE = /^(?:\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$[A-Z_][A-Z0-9_]+|process\.env(?:\.[A-Za-z_$][\w$]*|\[\s*['"][A-Za-z_]\w*['"]\s*\]))$/;
/** N1: feste Liste der Verweiswoerter vor dem Ziel (jedes andere Wort -> kein reiner Verweis). */
const VERWEIS_WORT = new Set([
  'kommt', 'kommen', 'steht', 'stehen', 'liegt', 'liegen', 'ist', 'sind', 'wird', 'werden', 'gelesen', 'geladen', 'gesetzt',
  'aus', 'in', 'im', 'der', 'die', 'das', 'dem', 'den', 'datei', 'variable', 'umgebungsvariable', 'env', 'siehe', 'via',
  'ueber', 'über', 'von', 'vom', 'see', 'from', 'the', 'a', 'an', 'file', 'var', 'environment', 'is', 'are', 'read',
  'loaded', 'comes', 'come', 'stored', 'lives', 'taken', 'set', 'by',
]);
/** N1: mindestens eines dieser Woerter muss vor einem Datei-/Variablen-Ziel stehen. */
const VERWEIS_PRAEP = new Set(['aus', 'in', 'im', 'siehe', 'see', 'from', 'via', 'ueber', 'über', 'von', 'vom']);
const QUELLE_DATEI = /^(?:~|\.{1,2})?\/?(?:[\w.-]+\/)*\.?[\w-]+\.(?:env|ya?ml|json|jsonc|toml|ini|conf|cfg|config|properties|txt|md|pgpass|netrc|pem|key|crt|secret|secrets|kdbx|sh|ps1|ts|js|mjs|py)$|^(?:~|\.{1,2})?\/(?:[\w.-]+\/)*[\w.-]+$|^~\/\.[\w.-]+$|^\.(?:pgpass|netrc|npmrc|pypirc|env)$/;
const QUELLE_VARIABLE = /^(?:\$?\{?[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\}?|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?)$/;
/**
 * N1: true NUR, wenn der GANZE Wert ein reiner Verweis ist: allein ${VAR}/$VAR/process.env.X/.env, oder Verweiswoerter
 * (VERWEIS_WORT, mind. eine Praeposition) plus genau EIN Ziel am Ende (.env, Datei, Variable). Kein Teiltreffer:
 * "hunter2 siehe .env", "Xk9#mQ2v $HOME", "correcthorse process.env.X" sind KEIN Verweis.
 */
function istQuellVerweis(wert: string): boolean {
  const woerter = wert.trim().split(/\s+/).filter(Boolean);
  if (woerter.length === 0 || woerter.length > 8) return false;
  const ziel = woerter[woerter.length - 1].replace(/^["'`(]+/, '').replace(/["'`)]*[.!?:;,]*["'`)]*$/, '');
  if (ziel === '' || istGeheimMusterWert(ziel)) return false;
  const vor = woerter.slice(0, -1).map((w) => w.toLowerCase());
  if (!vor.every((w) => VERWEIS_WORT.has(w))) return false;
  const variable = QUELLE_ENV_VARIABLE.test(ziel);
  const envDatei = QUELLE_ENV_DATEI.test(ziel);
  if (vor.length === 0) return variable || envDatei;
  if (!vor.some((w) => VERWEIS_PRAEP.has(w))) return false;
  return variable || envDatei || QUELLE_DATEI.test(ziel) || QUELLE_VARIABLE.test(ziel);
}
function istProsa(wert: string, stark = false): boolean {
  // Starker Schluessel: nur eindeutiger Quellverweis bleibt sichtbar (auch kurz: "siehe .env"), sonst schwaerzen.
  if (stark) return istQuellVerweis(wert);
  const woerter = wert.trim().split(/\s+/).filter(Boolean);
  if (woerter.length < 3) return false;
  let fuell = 0;
  for (const roh of woerter) {
    if (/\d/.test(roh)) return false;
    const w = roh.replace(/^[^\p{L}]+/u, '').replace(/[^\p{L}]+$/u, '');
    if (w === '') continue; // reine Satzzeichen (-, :, …)
    if (w.length > 30 || !/^\p{L}[\p{L}_.()/-]*$/u.test(w) || /\p{Lu}/u.test(w.slice(1))) return false;
    if (PROSA_FUELLWORT.has(w.toLowerCase())) fuell++;
  }
  return fuell > 0;
}

/** ENV-Form GROSS_SNAKE=wert (Regel-Kennung env, C4: immer schwaerzen, nie Prosa). */
function istEnvForm(name: string, trenner: string): boolean {
  return /^[A-Z][A-Z0-9_]*$/.test(name) && trenner.trim() === '=';
}

/** Unter geheimem Schluessel: Strings -> [WERT]; Zahlen/Booleans nur bei auchSkalare (starker Schluessel,
 * Zugangs-Container), null/undefined bleiben immer. */
function alles(wert: unknown, auchZahlen = false): unknown {
  if (wert === null || wert === undefined) return wert;
  if (typeof wert === 'boolean') return auchZahlen ? TOOL_LOG_PLATZHALTER : wert;
  if (typeof wert === 'number' || typeof wert === 'bigint') return auchZahlen ? TOOL_LOG_PLATZHALTER : wert;
  if (typeof wert === 'string') return wert === '' ? wert : TOOL_LOG_PLATZHALTER;
  if (Array.isArray(wert)) return wert.map((w) => alles(w, auchZahlen));
  if (typeof wert === 'object') return Object.fromEntries(Object.entries(wert as Record<string, unknown>).map(([k, v]) => [k, alles(v, auchZahlen)]));
  return TOOL_LOG_PLATZHALTER;
}

// "schluessel": "wert" (auch abgeschnitten, ohne schliessendes Anfuehrungszeichen). Zahlen bleiben.
const JSON_FELD = /("([^"\\\n]{1,80})"\s*:\s*)("(?:\\.|[^"\\])*(?:"|$))/g;
// schluessel=wert / schluessel: wert — Wert nur per Lookahead, damit "Fehler: passwort=X" nicht als ein Paar
// Fehler -> "passwort=X" verschluckt wird; die naechste Suche beginnt im Wert.
const KV_FELD = /(?<=^|[\s,;&?{(\[`"'|<>=*])([A-Za-z_][A-Za-z0-9_.-]*)(\s*(?::=|[=:])\s*)(?=("(?:\\.|[^"\\])*"|'[^']*'|`[^`]*`|[^\s,;&'"`(){}\[\]<>]+))/g;
const LITERAL_WORT = /^(?:true|false|null|undefined|NaN|-?\d+(?:\.\d+)?)$/;
/** Bei starken Schluesseln ist auch eine Zahl/ein Boolean ein Geheimnis (PIN, 4711). */
const STARK_SKALAR = /^(?:true|false|-?\d+(?:\.\d+)?)$/;
// "schluessel": 123456 / true (JSON-Text, auch abgeschnitten) — nur bei starken Schluesseln.
const JSON_SKALAR = /("([^"\\\n]{1,80})"\s*:\s*)(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false)(?=\s*(?:[,}\]\n]|$))/g;
const BEARER = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi;
const URL_OHNE_USER = /([a-z][a-z0-9+.-]*:\/\/)[^/@?#\s:]*:[^/@?#\s]+@/gi;
const CLI_LANG = /(--(?:password|passwort|passwd|pass|pwd)(?:=|\s+))("[^"]*"|'[^']*'|[^\s"']+)/gi;
const CLI_MYSQL = /(\b(?:mysql|mariadb|mysqldump|mysqladmin|mariadb-dump)\b[^\n|;&]*?\s-p)("[^"]*"|'[^']*'|[^\s"']+)/g;
const SSHPASS = /(\bsshpass\s+-p\s*)("[^"]*"|'[^']*'|[^\s"']+)/g;

function istLiteral(wert: string, trenner: string, danach: string, stark = false): boolean {
  if (/^["'`]/.test(wert)) return wert.length > 2 && !wert.includes('${');
  if (stark && STARK_SKALAR.test(wert)) return true; // PASSWORT=4711
  if (/\n/.test(trenner)) return !istCodeWert(wert, stark); // YAML: "password:\n  wert"
  if (/\s$/.test(trenner)) return false;           // Leerraum-Faelle deckt die Zeilenregel ab
  if (/^[=>]/.test(wert)) return false;            // ===, =>
  if (danach === '(' || danach === '.') return false; // Funktionsaufruf / Ausdruck
  if (LITERAL_WORT.test(wert)) return false;        // Zahl, true/false/null
  return !istCodeWert(wert);                        // $VAR, a.b, f( ...
}

// ── Zeilenregel (Konfiguration/Prosa) ──
// P10-T76 C7: auch def/fn/func/pub/impl/struct/trait/elif/except/raise/lambda (mit Leerzeichen danach).
const CODE_ZEILE = /^\s*(?:(?:export\s+(?:default\s+)?)?(?:const|let|var|function|class|interface|type|enum|declare|namespace|abstract)\b|(?:import|return|if|else|for|while|do|switch|case|throw|try|catch|finally|await|yield|public|private|protected|readonly|static|async)\b|(?:def|fn|func|pub|impl|struct|trait|elif|except|raise|lambda)\s|\/\/|\/\*)/;
/** Nachbesserung d996c097: Zeilen, die erst durch C7 als Quelltext gelten (def/fn/…). Dort ist nur die Parameterliste
 * Quelltext; Zuweisungen nach der Signatur ("def login(): password = x") laufen weiter durch die Zeilenregel. */
const CODE_ZEILE_C7 = /^\s*(?:def|fn|func|pub|impl|struct|trait|elif|except|raise|lambda)\s/;
const CODE_ZEILE_ALT = /^\s*(?:(?:export\s+(?:default\s+)?)?(?:const|let|var|function|class|interface|type|enum|declare|namespace|abstract)\b|(?:import|return|if|else|for|while|do|switch|case|throw|try|catch|finally|await|yield|public|private|protected|readonly|static|async)\b|\/\/|\/\*)/;
/** Klammertiefe ( [ < vor pos (nur grob, fuer Parameterlisten). */
function klammerTiefe(zeile: string, pos: number): number {
  let t = 0;
  for (let i = 0; i < pos; i++) { const z = zeile[i]; if (z === '(' || z === '[') t++; else if ((z === ')' || z === ']') && t > 0) t--; }
  return t;
}
const ZEILEN_PAAR = /(?<![A-Za-z0-9_$])([A-Za-z_][A-Za-z0-9_.-]*)(\s*[=:]\s*)/g;
const TYP_ANGABE = /^(?:readonly\s+)?(?:string|number|boolean|bigint|symbol|unknown|any|never|void|object|null|undefined|Date|Buffer|Record<.*>|Array<.*>|Promise<.*>|Map<.*>|Set<.*>)(?:\[\])?(?:\s*\|\s*[\w<>\[\]]+)*\s*[;,)]?$/;
/** P10-T76 C7: Typangaben aus Python/Rust/Go/Java/C (password: str, token: Option<String>, Password []byte). */
const TYP_ANGABE_WEITERE = /^(?:str|int|float|bytes|bool|dict|list|tuple|Any|None|String|SecretStr|SecretString|SecureString|char\s*\*|const\s+char\s*\*|&(?:'\w+\s+)?(?:mut\s+)?(?:str|\[u8\])|\*?\[\]byte|\*string|(?:Optional|Union|List|Dict|Tuple|Sequence|Mapping|Annotated)\[.*\]|(?:Option|Vec|Box|Arc|Rc|Result|HashMap|BTreeMap|Secret)<.*>)(?:\s*\|\s*[\w\[\]<>]+)*(?:\s*=\s*(?:None|null|nil|undefined|""|''|\.\.\.|Default::default\(\)))?\s*[;,)]?$/;

/** true, wenn der Wert Quelltext oder eine Typangabe ist (dann nicht schwaerzen). */
function istCodeWert(roh: string, stark = false): boolean {
  const w = roh.trim();
  if (w === '') return true;
  if (stark && STARK_SKALAR.test(w)) return false;                    // PIN/Ziffern-Passwort
  if (LITERAL_WORT.test(w.replace(/[;,]$/, ''))) return true;
  if (/^[=>]/.test(w)) return true;                                      // ===, =>
  if (/^(?:typeof|new|await|require|import|function|async|yield|this|process)\b/.test(w)) return true;
  if (/^\$/.test(w)) return true;                                        // $VAR, $1, ${...}
  if (TYP_ANGABE.test(w) || TYP_ANGABE_WEITERE.test(w)) return true;     // password: string; / token: str
  // Nachbesserung 2: ohne Leerraum vor . ( [ — "siehe .env hunter2" / "abc .def" sind kein Ausdruck (Altleck der Basis)
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$]|\(|\[)/.test(w)) return true;   // a.b, f(, x[
  if (/^[{[(]/.test(w)) return true;                                     // Objekt-/Array-Literal, Destrukturierung
  // Nachbesserung 2: ein ${VAR} am Ende ist kein Quelltextende ("geheim123 ${DB_PASSWORD}", Altleck der Basis)
  if (/[;,{}()]$/.test(w) && !/\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(w)) return true; // Quelltextende
  return false;
}

function schwaerzeZeilen(text: string): string {
  if (!aktiv('zeile') && !aktiv('env')) return text;
  return text.split('\n').map((zeile) => {
    const nurSignatur = !CODE_ZEILE_ALT.test(zeile) && CODE_ZEILE_C7.test(zeile);
    if ((CODE_ZEILE.test(zeile) && !nurSignatur) || !/[=:]/.test(zeile)) return zeile;
    const bereiche: Array<[number, number]> = [];
    let bis = 0;
    for (const m of zeile.matchAll(ZEILEN_PAAR)) {
      const [ganz, name, trenner] = m;
      const idx = m.index ?? 0;
      if (idx < bis) continue;
      const geheimName = istToolLogGeheimSchluessel(name);
      if (!geheimName && !GEHEIM_HINWEIS_NAME.test(normiere(name).replace(/_/g, ''))) continue; // N3
      if (nurSignatur && klammerTiefe(zeile, idx) > 0) continue; // def f(token: str): Parameterliste
      const regel: SchwaerzRegel = istEnvForm(name, trenner) ? 'env' : 'zeile';
      if (!aktiv(regel)) continue;
      const start = idx + ganz.length;
      const rest = zeile.slice(start);
      const q = rest[0];
      if (q === '"' || q === "'" || q === '`') {
        const zu = rest.indexOf(q, 1);
        const inhalt = zu < 0 ? rest.slice(1).replace(/\s+$/, '') : rest.slice(1, zu);
        if (inhalt === '' || inhalt.includes(TOOL_LOG_PLATZHALTER) || inhalt.includes('${')) continue;
        if (!geheimName && !geheimFuerWert(name, inhalt)) continue; // N3
        if (istHarmloserToolLogWert(name, inhalt, zeile)) continue;
        bereiche.push([start + 1, start + 1 + inhalt.length]);
        bis = start + 1 + inhalt.length + 1;
        zaehle(regel, name);
        continue;
      }
      // Bis Zeilenende — ausser das Paar selbst steht in Anfuehrungszeichen (`PGPASSWORD=x`, "PGPASSWORD=x"):
      // dann bis zum schliessenden Zeichen. So bleibt nichts Gequotetes hinter dem Wert stehen.
      const vor = idx > 0 ? zeile[idx - 1] : '';
      const ende = vor === '"' || vor === "'" || vor === '`' ? rest.indexOf(vor) : -1;
      const roh = ende < 0 ? rest : rest.slice(0, ende);
      const wert = roh.replace(/\s+$/, '');
      if (wert === '' || wert.includes(TOOL_LOG_PLATZHALTER)) continue;
      if (!geheimName && !geheimFuerWert(name, wert)) continue; // N3
      const muster = istGeheimMusterWert(wert);                  // N3: Muster schlaegt Code-/Prosa-Ausnahme
      if (!muster && istCodeWert(wert, istStarkerGeheimSchluessel(name))) continue;
      if (!muster && regel === 'zeile' && istProsa(wert, istStarkerGeheimSchluessel(name))) continue; // C4
      if (istHarmloserToolLogWert(name, wert, zeile)) continue;       // C2/C3/C5/C6/C8
      bereiche.push([start, start + wert.length]);
      bis = start + wert.length;
      zaehle(regel, name);
    }
    let aus = zeile;
    for (let i = bereiche.length - 1; i >= 0; i--) aus = aus.slice(0, bereiche[i][0]) + TOOL_LOG_PLATZHALTER + aus.slice(bereiche[i][1]);
    return aus;
  }).join('\n');
}

function zeileUm(text: string, pos: number): string {
  const von = text.lastIndexOf('\n', pos - 1) + 1;
  const bisNl = text.indexOf('\n', pos);
  return text.slice(von, bisNl < 0 ? undefined : bisNl);
}

function schwaerzeKv(text: string): string {
  if (!aktiv('kv') && !aktiv('env')) return text;
  const bereiche: Array<[number, number]> = [];
  for (const m of text.matchAll(KV_FELD)) {
    const [, name, trenner, wert] = m;
    if (wert.includes(TOOL_LOG_PLATZHALTER) || !geheimFuerWert(name, wert.replace(/^(["'`])([\s\S]*)\1$/, '$2'))) continue;
    const regel: SchwaerzRegel = istEnvForm(name, trenner) ? 'env' : 'kv';
    if (!aktiv(regel)) continue;
    const start = (m.index ?? 0) + name.length + trenner.length;
    if (!istLiteral(wert, trenner, text[start + wert.length] ?? '', istStarkerGeheimSchluessel(name))) continue;
    const letzter = bereiche[bereiche.length - 1];
    if (letzter && start < letzter[1]) continue; // liegt im schon geschwaerzten Wert
    if (istHarmloserToolLogWert(name, wert, zeileUm(text, start))) continue;
    bereiche.push([start, start + wert.length]);
    zaehle(regel, name);
  }
  let aus = text;
  for (let i = bereiche.length - 1; i >= 0; i--) aus = aus.slice(0, bereiche[i][0]) + TOOL_LOG_PLATZHALTER + aus.slice(bereiche[i][1]);
  return aus;
}

const ersetzeWert = (regel: SchwaerzRegel) => (_t: string, vor: string, wert: string): string => {
  if (wert.includes(TOOL_LOG_PLATZHALTER) || PLATZHALTER_WERT.test(wert.replace(/^(["'])([\s\S]*)\1$/, '$2'))) return vor + wert;
  const q = /^["']/.test(wert) ? wert[0] : '';
  zaehle(regel);
  return vor + q + TOOL_LOG_PLATZHALTER + q;
};

/** Textweg (auch fuer abgeschnittene JSON-Vorschauen und freie Fehlertexte). */
export function schwaerzeToolText(text: string): string {
  if (typeof text !== 'string' || text === '') return text;
  let aus = text;
  if (aktiv('json_feld')) {
    aus = aus.replace(JSON_FELD, (t, vor: string, name: string, wert: string) => {
      if (wert === '""' || wert.includes(TOOL_LOG_PLATZHALTER)) return t;
      const innen = wert.replace(/^"/, '').replace(/"$/, '');
      if (!geheimFuerWert(name, innen) || istHarmloserToolLogWert(name, innen)) return t; // N3
      zaehle('json_feld', name);
      return vor + JSON.stringify(TOOL_LOG_PLATZHALTER);
    });
  }
  if (aktiv('json_skalar')) {
    aus = aus.replace(JSON_SKALAR, (t, vor: string, name: string, wert: string) => {
      if (!istStarkerGeheimSchluessel(name) || istHarmloserToolLogWert(name, wert)) return t;
      zaehle('json_skalar', name);
      return vor + JSON.stringify(TOOL_LOG_PLATZHALTER);
    });
  }
  aus = schwaerzeZeilen(aus);
  aus = schwaerzeKv(aus);
  if (aktiv('url') && aus.includes('://')) {
    const neu = maskiereUrl(aus);
    if (neu !== aus) { zaehle('url', undefined, Math.max(1, (aus.match(URL_ZUGANGSDATEN) ?? []).length)); aus = neu; }
  }
  if (aktiv('url_ohne_user')) aus = aus.replace(URL_OHNE_USER, (_t, vor: string) => { zaehle('url_ohne_user'); return vor + TOOL_LOG_PLATZHALTER + '@'; });
  if (aktiv('bearer')) aus = aus.replace(BEARER, (_t, vor: string) => { zaehle('bearer'); return vor + TOOL_LOG_PLATZHALTER; });
  if (aktiv('cli_lang')) aus = aus.replace(CLI_LANG, ersetzeWert('cli_lang'));
  if (aktiv('cli_mysql')) aus = aus.replace(CLI_MYSQL, ersetzeWert('cli_mysql'));
  if (aktiv('sshpass')) aus = aus.replace(SSHPASS, ersetzeWert('sshpass'));
  if (aktiv('ansicht_link') && aus.includes('/api/assets/ansicht/')) {
    const neu = maskiereAnsichtLinks(aus);
    if (neu !== aus) { zaehle('ansicht_link'); aus = neu; }
  }
  if (aktiv('muster')) {
    aus = aus.replace(PEM_PRIVAT, (_t, kopf: string, fuss: string) => { zaehle('muster'); return kopf + TOOL_LOG_PLATZHALTER + fuss; });
    aus = aus.replace(GEHEIM_MUSTER_FREI, () => { zaehle('muster'); return TOOL_LOG_PLATZHALTER; }); // N3
  }
  return aus;
}

/** Bis zu dieser Groesse wird ein JSON-String geparst und strukturiert geschwaerzt. */
const PARSE_MAX = 2_000_000;

function schwaerzeString(s: string, tiefe: number): string {
  if (s.length <= PARSE_MAX && /^\s*[[{]/.test(s)) {
    try {
      const roh = JSON.parse(s) as unknown;
      const neu = schwaerzeToolDaten(roh, tiefe + 1);
      const vorher = JSON.stringify(roh), nachher = JSON.stringify(neu);
      return vorher === nachher ? s : nachher;
    } catch { /* abgeschnitten oder freier Text -> Textweg */ }
  }
  return schwaerzeToolText(s);
}

function schwaerzeContainer(v: unknown, erlaubt: Set<string>, tiefe: number): unknown {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return alles(v, true);
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, w]) =>
    [k, erlaubt.has(k) && !istToolLogGeheimSchluessel(k) ? schwaerzeToolDaten(w, tiefe + 1) : alles(w, true)]));
}

/** Nur im Bericht-Lauf: hat die Schwaerzung den Wert veraendert? (sonst kein Treffer zaehlen) */
function veraendert(a: unknown, b: unknown): boolean {
  if (!lauf) return false;
  try { return JSON.stringify(a) !== JSON.stringify(b); } catch { return true; }
}

const istSkalar = (v: unknown): boolean => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

/** Rekursiv: geheime Schluessel -> [WERT], alle Strings zusaetzlich ueber den Textweg. */
export function schwaerzeToolDaten<T>(wert: T, tiefe = 0): T {
  if (tiefe > 40) return wert;
  if (typeof wert === 'string') return schwaerzeString(wert, tiefe) as unknown as T;
  if (Array.isArray(wert)) return wert.map((w) => schwaerzeToolDaten(w, tiefe + 1)) as unknown as T;
  if (wert && typeof wert === 'object' && !(wert instanceof Date)) {
    return Object.fromEntries(Object.entries(wert as Record<string, unknown>).map(([k, v]) => {
      const container = ZUGANG_CONTAINER.get(k);
      if (container && aktiv('zugang_container')) {
        const neu = schwaerzeContainer(v, container, tiefe);
        if (veraendert(v, neu)) zaehle('zugang_container', k);
        return [k, neu];
      }
      if (geheimFuerWert(k, v) && aktiv('struktur') && !(istSkalar(v) && istHarmloserToolLogWert(k, v))) { // N3
        const neu = alles(v, istStarkerGeheimSchluessel(k));
        if (veraendert(v, neu)) zaehle('struktur', k);
        return [k, neu];
      }
      return [k, schwaerzeToolDaten(v, tiefe + 1)];
    })) as T;
  }
  return wert;
}

/** Kurzform fuer die Aufrufer von logToolCall: Args schwaerzen, dann serialisieren und kuerzen. */
export function toolArgsVorschau(args: unknown, max = 500): string {
  return JSON.stringify(schwaerzeToolDaten(args ?? {})).slice(0, max);
}

/** Fuer gespeicherte Strings (args_preview, result, error): JSON strukturiert, sonst Textweg. */
export function schwaerzeToolLogText(text: string | null | undefined): string | null | undefined {
  return typeof text === 'string' ? schwaerzeString(text, 0) : text;
}

export interface SchwaerzBericht {
  text: string | null | undefined;
  /** Ersetzungen je Regel-Kennung (nur Regeln mit Treffern). */
  treffer: Partial<Record<SchwaerzRegel, number>>;
  /** Ersetzungen je normalisiertem Schluesselnamen (snake_case, nie Werte). */
  schluessel: Record<string, number>;
}

/** P10-T76 C9: wie schwaerzeToolLogText, dazu Treffer je Regel/Schluessel; regeln = nur diese Regeln anwenden
 * (unbekannte Kennungen pruefen die Aufrufer, siehe SCHWAERZ_REGELN). Ohne regeln identisch zum Schreibweg. */
export function schwaerzeToolLogTextMitRegeln(text: string | null | undefined, opt: { regeln?: readonly string[] } = {}): SchwaerzBericht {
  const vorher = lauf;
  const eigener: SchwaerzLauf = { regeln: opt.regeln && opt.regeln.length ? new Set(opt.regeln) : null, treffer: {}, schluessel: {} };
  lauf = eigener;
  try {
    const neu = schwaerzeToolLogText(text);
    return { text: neu, treffer: eigener.treffer, schluessel: eigener.schluessel };
  } finally {
    lauf = vorher;
  }
}
