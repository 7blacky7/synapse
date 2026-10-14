/**
 * P10-T72 B1 (14.10.2026): Geheimnisse in Tool-Argumenten, -Ergebnissen und -Fehlern schwaerzen, BEVOR sie
 * in tool_calls (Audit/Activity) landen. Gilt fuer ALLE Tools und unabhaengig vom Ergebnis (auch abgelehnte
 * Aufrufe). Anlass: project(projekt_db, uebernehmen:{passwort}) haette das Passwort im Klartext in
 * args_preview geschrieben, die Shell-Maske greift dort nur fuer tool==='shell'.
 *
 * REGELN (Pruefung Runde 2, ad49211a):
 * - Geheimer Schluessel = enthaelt ein Passwort-/Geheimwort als WORTTEIL, gross/klein egal:
 *   password/passwort/passwd/kennwort/pwd/secret/token/apikey/privatekey/accesskey/credential/
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
 * Nur Audit-Daten: die Antwort an den Aufrufer bleibt unveraendert.
 */
import { maskiereUrl } from './masken-katalog.js';

export const TOOL_LOG_PLATZHALTER = '[WERT]';

/** Verfahrenskennungen und Zaehler/Masse sind keine Zugangsdaten. */
const AUSNAHME = /^(?:wait_token|batch_token|stream_id|(?:max|input|output|total|cached|prompt|completion)_tokens)$|(?:^|_)(?:count|anzahl|length|len|laenge|size|limit|ttl|timeout|ms|gesetzt|vorhanden|ort|hinweis)$/;
/** Wortteile (im Namen ohne Trenner gesucht). */
const GEHEIM_TEIL = /passwor[dt]|passwd|kennwort|pwd|secret|token|apikey|privatekey|accesskey|credential|authorization|cookie|databaseurl|dburl|connectionstring|pincode/;
/** Nur als ganzes Segment (sonst zu viele Fehltreffer). */
const GEHEIM_SEGMENT = /^(?:pass|pw|pgpass|dsn|auth|pin)$/;
/** STARKE Schluessel: auch Zahlen und Booleans sind dort Geheimnisse (PINs, Ziffern-Passwoerter). */
const STARK_TEIL = /passwor[dt]|passwd|kennwort|pwd|secret|privatekey|pincode/;
const STARK_SEGMENT = /^(?:pw|pgpass|pin)$/;
/** pass am Namensende nur mit bekanntem Praefix. */
const PASS_ENDE = /(?:ssh|db|pg|mysql|sql|smtp|mail|user|admin|root|redis|ftp|ldap|proxy|api|app|svc|service)pass$/;

/** Container mit Zugangsdaten: nur diese Felder bleiben im Klartext. */
const ZUGANG_CONTAINER = new Map<string, Set<string>>([['uebernehmen', new Set(['database', 'user', 'host', 'port'])]]);

/** true, wenn unter diesem Schluessel ein Geheimnis steht. */
export function istToolLogGeheimSchluessel(name: string): boolean {
  const norm = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().replace(/[.\-\s]/g, '_');
  if (AUSNAHME.test(norm)) return false;
  const kompakt = norm.replace(/_/g, '');
  if (GEHEIM_TEIL.test(kompakt)) return true;
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
  const norm = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().replace(/[.\-\s]/g, '_');
  const kompakt = norm.replace(/_/g, '');
  if (STARK_TEIL.test(kompakt) || PASS_ENDE.test(kompakt)) return true;
  if (/^(?:ssh|db|pg|mysql|sql|smtp|mail|user|admin|root|redis|ftp|ldap|proxy|api)pw$/.test(kompakt)) return true;
  return norm.split('_').some((s) => STARK_SEGMENT.test(s));
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
const KV_FELD = /(?<=^|[\s,;&?{(\[`"'|<>=*])([A-Za-z_][A-Za-z0-9_.-]*)(\s*[=:]\s*)(?=("(?:\\.|[^"\\])*"|'[^']*'|`[^`]*`|[^\s,;&'"`(){}\[\]<>]+))/g;
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
const CODE_ZEILE = /^\s*(?:(?:export\s+(?:default\s+)?)?(?:const|let|var|function|class|interface|type|enum|declare|namespace|abstract)\b|(?:import|return|if|else|for|while|do|switch|case|throw|try|catch|finally|await|yield|public|private|protected|readonly|static|async)\b|\/\/|\/\*)/;
const ZEILEN_PAAR = /(?<![A-Za-z0-9_$])([A-Za-z_][A-Za-z0-9_.-]*)(\s*[=:]\s*)/g;
const TYP_ANGABE = /^(?:readonly\s+)?(?:string|number|boolean|bigint|symbol|unknown|any|never|void|object|null|undefined|Date|Buffer|Record<.*>|Array<.*>|Promise<.*>|Map<.*>|Set<.*>)(?:\[\])?(?:\s*\|\s*[\w<>\[\]]+)*\s*[;,)]?$/;

/** true, wenn der Wert Quelltext oder eine Typangabe ist (dann nicht schwaerzen). */
function istCodeWert(roh: string, stark = false): boolean {
  const w = roh.trim();
  if (w === '') return true;
  if (stark && STARK_SKALAR.test(w)) return false;                    // PIN/Ziffern-Passwort
  if (LITERAL_WORT.test(w.replace(/[;,]$/, ''))) return true;
  if (/^[=>]/.test(w)) return true;                                      // ===, =>
  if (/^(?:typeof|new|await|require|import|function|async|yield|this|process)\b/.test(w)) return true;
  if (/^\$/.test(w)) return true;                                        // $VAR, $1, ${...}
  if (TYP_ANGABE.test(w)) return true;                                   // password: string;
  if (/^[A-Za-z_$][\w$]*\s*(?:\.[A-Za-z_$]|\(|\[)/.test(w)) return true;   // a.b, f(, x[
  if (/^[{[(]/.test(w)) return true;                                     // Objekt-/Array-Literal, Destrukturierung
  if (/[;,{}()]$/.test(w)) return true;                                  // Quelltextende
  return false;
}

function schwaerzeZeilen(text: string): string {
  return text.split('\n').map((zeile) => {
    if (CODE_ZEILE.test(zeile) || !/[=:]/.test(zeile)) return zeile;
    const bereiche: Array<[number, number]> = [];
    let bis = 0;
    for (const m of zeile.matchAll(ZEILEN_PAAR)) {
      const [ganz, name] = m;
      const idx = m.index ?? 0;
      if (idx < bis || !istToolLogGeheimSchluessel(name)) continue;
      const start = idx + ganz.length;
      const rest = zeile.slice(start);
      const q = rest[0];
      if (q === '"' || q === "'" || q === '`') {
        const zu = rest.indexOf(q, 1);
        const inhalt = zu < 0 ? rest.slice(1).replace(/\s+$/, '') : rest.slice(1, zu);
        if (inhalt === '' || inhalt.includes(TOOL_LOG_PLATZHALTER) || inhalt.includes('${')) continue;
        bereiche.push([start + 1, start + 1 + inhalt.length]);
        bis = start + 1 + inhalt.length + 1;
        continue;
      }
      // Bis Zeilenende — ausser das Paar selbst steht in Anfuehrungszeichen (`PGPASSWORD=x`, "PGPASSWORD=x"):
      // dann bis zum schliessenden Zeichen. So bleibt nichts Gequotetes hinter dem Wert stehen.
      const vor = idx > 0 ? zeile[idx - 1] : '';
      const ende = vor === '"' || vor === "'" || vor === '`' ? rest.indexOf(vor) : -1;
      const roh = ende < 0 ? rest : rest.slice(0, ende);
      const wert = roh.replace(/\s+$/, '');
      if (wert === '' || wert.includes(TOOL_LOG_PLATZHALTER) || istCodeWert(wert, istStarkerGeheimSchluessel(name))) continue;
      bereiche.push([start, start + wert.length]);
      bis = start + wert.length;
    }
    let aus = zeile;
    for (let i = bereiche.length - 1; i >= 0; i--) aus = aus.slice(0, bereiche[i][0]) + TOOL_LOG_PLATZHALTER + aus.slice(bereiche[i][1]);
    return aus;
  }).join('\n');
}

function schwaerzeKv(text: string): string {
  const bereiche: Array<[number, number]> = [];
  for (const m of text.matchAll(KV_FELD)) {
    const [, name, trenner, wert] = m;
    if (!istToolLogGeheimSchluessel(name) || wert.includes(TOOL_LOG_PLATZHALTER)) continue;
    const start = (m.index ?? 0) + name.length + trenner.length;
    if (!istLiteral(wert, trenner, text[start + wert.length] ?? '', istStarkerGeheimSchluessel(name))) continue;
    const letzter = bereiche[bereiche.length - 1];
    if (letzter && start < letzter[1]) continue; // liegt im schon geschwaerzten Wert
    bereiche.push([start, start + wert.length]);
  }
  let aus = text;
  for (let i = bereiche.length - 1; i >= 0; i--) aus = aus.slice(0, bereiche[i][0]) + TOOL_LOG_PLATZHALTER + aus.slice(bereiche[i][1]);
  return aus;
}

const ersetzeWert = (_t: string, vor: string, wert: string): string => {
  const q = /^["']/.test(wert) ? wert[0] : '';
  return wert.includes(TOOL_LOG_PLATZHALTER) ? vor + wert : vor + q + TOOL_LOG_PLATZHALTER + q;
};

/** Textweg (auch fuer abgeschnittene JSON-Vorschauen und freie Fehlertexte). */
export function schwaerzeToolText(text: string): string {
  if (typeof text !== 'string' || text === '') return text;
  let aus = text.replace(JSON_FELD, (t, vor: string, name: string, wert: string) =>
    istToolLogGeheimSchluessel(name) && wert !== '""' && !wert.includes(TOOL_LOG_PLATZHALTER) ? vor + JSON.stringify(TOOL_LOG_PLATZHALTER) : t);
  aus = aus.replace(JSON_SKALAR, (t, vor: string, name: string) =>
    istStarkerGeheimSchluessel(name) ? vor + JSON.stringify(TOOL_LOG_PLATZHALTER) : t);
  aus = schwaerzeZeilen(aus);
  aus = schwaerzeKv(aus);
  aus = maskiereUrl(aus);
  aus = aus.replace(URL_OHNE_USER, (_t, vor: string) => vor + TOOL_LOG_PLATZHALTER + '@');
  aus = aus.replace(BEARER, (_t, vor: string) => vor + TOOL_LOG_PLATZHALTER);
  aus = aus.replace(CLI_LANG, ersetzeWert).replace(CLI_MYSQL, ersetzeWert).replace(SSHPASS, ersetzeWert);
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

/** Rekursiv: geheime Schluessel -> [WERT], alle Strings zusaetzlich ueber den Textweg. */
export function schwaerzeToolDaten<T>(wert: T, tiefe = 0): T {
  if (tiefe > 40) return wert;
  if (typeof wert === 'string') return schwaerzeString(wert, tiefe) as unknown as T;
  if (Array.isArray(wert)) return wert.map((w) => schwaerzeToolDaten(w, tiefe + 1)) as unknown as T;
  if (wert && typeof wert === 'object' && !(wert instanceof Date)) {
    return Object.fromEntries(Object.entries(wert as Record<string, unknown>).map(([k, v]) => {
      const container = ZUGANG_CONTAINER.get(k);
      if (container) return [k, schwaerzeContainer(v, container, tiefe)];
      return [k, istToolLogGeheimSchluessel(k) ? alles(v, istStarkerGeheimSchluessel(k)) : schwaerzeToolDaten(v, tiefe + 1)];
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
