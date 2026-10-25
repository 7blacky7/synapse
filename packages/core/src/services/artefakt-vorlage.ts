/**
 * P22-T154 (User 25.10.2026, Entwurf 689abb81, R2): Vorlagensprache fuer Artefakte als Datenvorlagen. Eigene kleine
 * Mustache-Teilmenge, REIN (kein PG, keine Abhaengigkeit), serverseitig gerendert; das Ergebnis geht danach unveraendert
 * durch sanitize.ts im Client (Skripte werden dort entfernt, Animation laeuft ueber CSS/SVG).
 *
 * SYNTAX
 *   {{ausdruck}}                         Ausgabe, IMMER HTML-escaped (es gibt kein Roh-Einsetzen, kein {{{ }}}).
 *   {{wert | filter:arg1,arg2 | f2}}     Filterkette; gleichwertig als Aufruf: {{filter(wert, arg1)}}.
 *   {{#each liste as p}}..{{else}}..{{/each}}   Schleife; else bei leerer Liste. Ohne 'as' heisst das Element 'eintrag'.
 *                                        Schleifenwerte: @index (ab 0), @nr (ab 1), @erster, @letzter, @anzahl.
 *   {{#if a}}..{{else if b}}..{{else}}..{{/if}}  Bedingungen: == != < > <= >=, and, or, not, Klammern, Literale.
 *   {{! Kommentar }}
 * Pfade: a.b.0.c; verbotene Schluessel (__proto__, constructor, prototype) ergeben leer.
 *
 * GRENZEN (Standard, je Aufruf aenderbar): 5000 Schleifendurchlaeufe gesamt, Verschachtelungstiefe 8, Ausgabe 2 MB,
 * Renderzeit 500 ms. Jeder Fehler steht als lesbarer Platzhalter im HTML UND in fehler[] (nie still leer).
 */

export interface VorlageOptionen {
  max_schleifen?: number;
  max_tiefe?: number;
  max_ausgabe?: number;
  max_ms?: number;
  /** Bezugszeit fuer den Filter relativ (Tests); Standard jetzt. */
  jetzt?: Date;
}

export interface VorlageErgebnis {
  html: string;
  fehler: string[];
  statistik: { schleifen: number; ausgaben: number; ms: number; gekappt: boolean };
}

export const VORLAGE_GRENZEN = { max_schleifen: 5000, max_tiefe: 8, max_ausgabe: 2_000_000, max_ms: 500 } as const;
export const VORLAGE_FILTER = [
  'anzahl', 'laenge', 'summe', 'wo', 'wo_nicht', 'sortiert', 'erste', 'letzte', 'feld', 'verbinde', 'prozent', 'zahl', 'runden',
  'datum', 'relativ', 'kuerzen', 'gross', 'klein', 'json', 'standard', 'min', 'max',
] as const;

const VERBOTEN = new Set(['__proto__', 'constructor', 'prototype']);

/** HTML-Escaping fuer Text und Attribute. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"'`]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c] as string));
}

class VorlageFehler extends Error {}

// ---------------------------------------------------------------------------------------------
// Ausdruecke
// ---------------------------------------------------------------------------------------------
type Ausdruck =
  | { art: 'wert'; wert: unknown }
  | { art: 'pfad'; teile: string[] }
  | { art: 'filter'; name: string; eingabe: Ausdruck; args: Ausdruck[] }
  | { art: 'vergleich'; op: string; a: Ausdruck; b: Ausdruck }
  | { art: 'und' | 'oder'; a: Ausdruck; b: Ausdruck }
  | { art: 'nicht'; a: Ausdruck };

interface Token { t: 'zahl' | 'text' | 'name' | 'op' | 'sym'; v: string }

function zerlegeAusdruck(q: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < q.length) {
    const c = q[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1, s = '';
      while (j < q.length && q[j] !== c) { if (q[j] === '\\' && j + 1 < q.length) { s += q[j + 1]; j += 2; continue; } s += q[j++]; }
      if (j >= q.length) throw new VorlageFehler('Text ohne Ende: ' + q);
      out.push({ t: 'text', v: s }); i = j + 1; continue;
    }
    const zahl = /^-?\d+(\.\d+)?/.exec(q.slice(i));
    if (zahl && (c !== '-' || !out.length || out[out.length - 1].t === 'op' || out[out.length - 1].t === 'sym')) {
      out.push({ t: 'zahl', v: zahl[0] }); i += zahl[0].length; continue;
    }
    const op = /^(==|!=|<=|>=|<|>)/.exec(q.slice(i));
    if (op) { out.push({ t: 'op', v: op[0] }); i += op[0].length; continue; }
    if ('|:,()'.includes(c)) { out.push({ t: 'sym', v: c }); i++; continue; }
    const name = /^[@A-Za-z_À-ɏ][\wÀ-ɏ]*(\.[\wÀ-ɏ]+)*/.exec(q.slice(i));
    if (name) { out.push({ t: 'name', v: name[0] }); i += name[0].length; continue; }
    throw new VorlageFehler('Unerwartetes Zeichen "' + c + '" in: ' + q);
  }
  return out;
}

function parseAusdruck(q: string): Ausdruck {
  const tok = zerlegeAusdruck(q);
  let p = 0;
  const sieh = () => tok[p];
  const ist = (t: Token['t'], v?: string) => !!tok[p] && tok[p].t === t && (v === undefined || tok[p].v === v);
  const nimm = (t: Token['t'], v?: string) => {
    if (!ist(t, v)) throw new VorlageFehler('Erwartet ' + (v ?? t) + ' in: ' + q);
    return tok[p++];
  };
  const oder = (): Ausdruck => { let a = und(); while (ist('name', 'or')) { p++; a = { art: 'oder', a, b: und() }; } return a; };
  const und = (): Ausdruck => { let a = nicht(); while (ist('name', 'and')) { p++; a = { art: 'und', a, b: nicht() }; } return a; };
  const nicht = (): Ausdruck => { if (ist('name', 'not')) { p++; return { art: 'nicht', a: nicht() }; } return vergleich(); };
  const vergleich = (): Ausdruck => {
    const a = kette();
    if (ist('op')) { const op = tok[p++].v; return { art: 'vergleich', op, a, b: kette() }; }
    return a;
  };
  const kette = (): Ausdruck => {
    let a = primaer();
    while (ist('sym', '|')) {
      p++;
      const name = nimm('name').v;
      const args: Ausdruck[] = [];
      if (ist('sym', ':')) { p++; args.push(primaer()); while (ist('sym', ',')) { p++; args.push(primaer()); } }
      a = { art: 'filter', name, eingabe: a, args };
    }
    return a;
  };
  const primaer = (): Ausdruck => {
    const t = sieh();
    if (!t) throw new VorlageFehler('Ausdruck endet zu frueh: ' + q);
    if (t.t === 'zahl') { p++; return { art: 'wert', wert: Number(t.v) }; }
    if (t.t === 'text') { p++; return { art: 'wert', wert: t.v }; }
    if (ist('sym', '(')) { p++; const a = oder(); nimm('sym', ')'); return a; }
    if (t.t === 'name') {
      p++;
      if (t.v === 'true') return { art: 'wert', wert: true };
      if (t.v === 'false') return { art: 'wert', wert: false };
      if (t.v === 'null') return { art: 'wert', wert: null };
      if (ist('sym', '(') && !t.v.includes('.')) {
        p++;
        const args: Ausdruck[] = [];
        if (!ist('sym', ')')) { args.push(oder()); while (ist('sym', ',')) { p++; args.push(oder()); } }
        nimm('sym', ')');
        if (!args.length) throw new VorlageFehler('Aufruf ' + t.v + '() ohne Wert');
        return { art: 'filter', name: t.v, eingabe: args[0], args: args.slice(1) };
      }
      return { art: 'pfad', teile: t.v.split('.') };
    }
    throw new VorlageFehler('Unerwartet "' + t.v + '" in: ' + q);
  };
  const a = oder();
  if (p < tok.length) throw new VorlageFehler('Ueberzaehlig "' + tok[p].v + '" in: ' + q);
  return a;
}

// ---------------------------------------------------------------------------------------------
// Vorlage -> Baum
// ---------------------------------------------------------------------------------------------
type Knoten =
  | { art: 'text'; text: string }
  | { art: 'aus'; q: string; a: Ausdruck | null; fehler?: string }
  | { art: 'each'; a: Ausdruck; name: string; koerper: Knoten[]; sonst: Knoten[] }
  | { art: 'if'; zweige: Array<{ a: Ausdruck; koerper: Knoten[] }>; sonst: Knoten[] };

interface Rahmen { art: 'wurzel' | 'each' | 'if'; knoten: Knoten | null; ziel: Knoten[] }

function parseVorlage(vorlage: string, maxTiefe: number): Knoten[] {
  const wurzel: Knoten[] = [];
  const stapel: Rahmen[] = [{ art: 'wurzel', knoten: null, ziel: wurzel }];
  const re = /\{\{([\s\S]*?)\}\}/g;
  let pos = 0;
  let m: RegExpExecArray | null;
  const oben = () => stapel[stapel.length - 1];
  while ((m = re.exec(vorlage))) {
    if (m.index > pos) oben().ziel.push({ art: 'text', text: vorlage.slice(pos, m.index) });
    pos = m.index + m[0].length;
    const inhalt = m[1].trim();
    if (inhalt.startsWith('!')) continue;
    if (inhalt.startsWith('#each ') || inhalt === '#each') {
      const rest = inhalt.slice(5).trim();
      const as = /^(.*)\s+as\s+([A-Za-z_][\w]*)$/.exec(rest);
      const k: Knoten = { art: 'each', a: parseAusdruck(as ? as[1] : rest), name: as ? as[2] : 'eintrag', koerper: [], sonst: [] };
      oben().ziel.push(k);
      stapel.push({ art: 'each', knoten: k, ziel: k.koerper });
    } else if (inhalt.startsWith('#if ')) {
      const k: Knoten = { art: 'if', zweige: [{ a: parseAusdruck(inhalt.slice(4)), koerper: [] }], sonst: [] };
      oben().ziel.push(k);
      stapel.push({ art: 'if', knoten: k, ziel: k.zweige[0].koerper });
    } else if (inhalt.startsWith('else if ')) {
      const r = oben();
      if (r.art !== 'if' || !r.knoten || r.knoten.art !== 'if') throw new VorlageFehler('{{else if}} ausserhalb von {{#if}}');
      const zweig = { a: parseAusdruck(inhalt.slice(8)), koerper: [] as Knoten[] };
      r.knoten.zweige.push(zweig);
      r.ziel = zweig.koerper;
    } else if (inhalt === 'else') {
      const r = oben();
      if (!r.knoten || (r.knoten.art !== 'if' && r.knoten.art !== 'each')) throw new VorlageFehler('{{else}} ausserhalb von {{#if}}/{{#each}}');
      r.ziel = r.knoten.sonst;
    } else if (inhalt === '/each' || inhalt === '/if') {
      const r = oben();
      if (r.art !== inhalt.slice(1)) throw new VorlageFehler('{{' + inhalt + '}} ohne passendes {{#' + inhalt.slice(1) + '}}');
      stapel.pop();
    } else if (inhalt.startsWith('#') || inhalt.startsWith('/')) {
      throw new VorlageFehler('Unbekannter Block {{' + inhalt + '}}');
    } else {
      try { oben().ziel.push({ art: 'aus', q: inhalt, a: parseAusdruck(inhalt) }); }
      catch (error) { oben().ziel.push({ art: 'aus', q: inhalt, a: null, fehler: (error as Error).message }); }
    }
    if (stapel.length - 1 > maxTiefe) throw new VorlageFehler('Verschachtelung tiefer als ' + maxTiefe);
  }
  if (pos < vorlage.length) oben().ziel.push({ art: 'text', text: vorlage.slice(pos) });
  if (stapel.length > 1) throw new VorlageFehler('{{#' + oben().art + '}} ohne {{/' + oben().art + '}}');
  return wurzel;
}

// ---------------------------------------------------------------------------------------------
// Auswerten
// ---------------------------------------------------------------------------------------------
type Bereich = Array<Record<string, unknown>>;

function feldVon(obj: unknown, schluessel: string): unknown {
  if (VERBOTEN.has(schluessel) || obj === null || obj === undefined) return undefined;
  if (Array.isArray(obj)) {
    if (schluessel === 'length') return obj.length;
    return /^\d+$/.test(schluessel) ? obj[Number(schluessel)] : undefined;
  }
  if (typeof obj === 'object') return Object.prototype.hasOwnProperty.call(obj, schluessel) ? (obj as Record<string, unknown>)[schluessel] : undefined;
  if (typeof obj === 'string' && schluessel === 'length') return obj.length;
  return undefined;
}

function loesePfad(teile: string[], bereich: Bereich): unknown {
  const [kopf, ...rest] = teile;
  let wert: unknown;
  let gefunden = false;
  for (let i = bereich.length - 1; i >= 0; i--) {
    if (Object.prototype.hasOwnProperty.call(bereich[i], kopf) && !VERBOTEN.has(kopf)) { wert = bereich[i][kopf]; gefunden = true; break; }
  }
  if (!gefunden) return undefined;
  for (const t of rest) wert = feldVon(wert, t);
  return wert;
}

function wahr(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  return !!v;
}

function zahlAus(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  if (typeof v === 'boolean') return v ? 1 : 0;
  return null;
}

function gleich(a: unknown, b: unknown): boolean {
  const na = zahlAus(a), nb = zahlAus(b);
  if (na !== null && nb !== null && typeof a !== 'boolean' && typeof b !== 'boolean') return na === nb;
  if (a === null || a === undefined || b === null || b === undefined) return (a ?? null) === (b ?? null);
  return String(a) === String(b);
}

function vergleiche(op: string, a: unknown, b: unknown): boolean {
  if (op === '==') return gleich(a, b);
  if (op === '!=') return !gleich(a, b);
  const na = zahlAus(a), nb = zahlAus(b);
  const c = na !== null && nb !== null ? na - nb : String(a ?? '').localeCompare(String(b ?? ''));
  return op === '<' ? c < 0 : op === '>' ? c > 0 : op === '<=' ? c <= 0 : c >= 0;
}

function datumAus(v: unknown): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === 'string' || typeof v === 'number') { const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d; }
  return null;
}

function filter(name: string, wert: unknown, args: unknown[], jetzt: Date): unknown {
  const liste = Array.isArray(wert) ? wert : [];
  switch (name) {
    case 'anzahl': case 'laenge':
      return Array.isArray(wert) ? wert.length : typeof wert === 'string' ? wert.length
        : wert && typeof wert === 'object' ? Object.keys(wert).length : 0;
    case 'summe': {
      const f = args[0] === undefined ? null : String(args[0]);
      return liste.reduce((s: number, x) => s + (zahlAus(f ? feldVon(x, f) : x) ?? 0), 0);
    }
    case 'min': case 'max': {
      const f = args[0] === undefined ? null : String(args[0]);
      const zahlen = liste.map((x) => zahlAus(f ? feldVon(x, f) : x)).filter((n): n is number => n !== null);
      return zahlen.length ? (name === 'min' ? Math.min(...zahlen) : Math.max(...zahlen)) : null;
    }
    case 'wo': case 'wo_nicht': {
      const f = String(args[0] ?? '');
      const ziel = args.length > 1 ? args[1] : true;
      return liste.filter((x) => (args.length > 1 ? gleich(feldVon(x, f), ziel) : wahr(feldVon(x, f))) === (name === 'wo'));
    }
    case 'sortiert': {
      const f = args[0] === undefined ? null : String(args[0]);
      const ab = String(args[1] ?? 'auf') === 'ab';
      return [...liste].sort((a, b) => { const x = f ? feldVon(a, f) : a, y = f ? feldVon(b, f) : b; const c = vergleiche('<', x, y) ? -1 : vergleiche('>', x, y) ? 1 : 0; return ab ? -c : c; });
    }
    case 'erste': return liste.slice(0, Math.max(0, zahlAus(args[0]) ?? 1));
    case 'letzte': { const n = Math.max(0, zahlAus(args[0]) ?? 1); return n ? liste.slice(-n) : []; }
    case 'feld': { const f = String(args[0] ?? ''); return liste.map((x) => feldVon(x, f)); }
    case 'verbinde': return liste.map((x) => (x === null || x === undefined ? '' : typeof x === 'object' ? JSON.stringify(x) : String(x))).join(args[0] === undefined ? ', ' : String(args[0]));
    case 'prozent': {
      const teil = zahlAus(wert) ?? 0, gesamt = zahlAus(args[0]) ?? 0;
      return gesamt > 0 ? Math.round((teil / gesamt) * 100) : 0;
    }
    case 'runden': { const n = zahlAus(wert); const st = Math.max(0, Math.min(6, zahlAus(args[0]) ?? 0)); return n === null ? null : Number(n.toFixed(st)); }
    case 'zahl': {
      const n = zahlAus(wert);
      if (n === null) return '';
      const st = Math.max(0, Math.min(6, zahlAus(args[0]) ?? 0));
      return n.toLocaleString('de-DE', { minimumFractionDigits: st, maximumFractionDigits: st });
    }
    case 'datum': {
      const d = datumAus(wert);
      if (!d) return '';
      const nurTag = String(args[0] ?? '') === 'tag';
      return d.toLocaleString('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', year: 'numeric', ...(nurTag ? {} : { hour: '2-digit', minute: '2-digit' }) });
    }
    case 'relativ': {
      const d = datumAus(wert);
      if (!d) return '';
      const s = Math.round((jetzt.getTime() - d.getTime()) / 1000);
      const betrag = Math.abs(s);
      const text = betrag < 45 ? 'gerade eben' : betrag < 3600 ? Math.round(betrag / 60) + ' Min' : betrag < 86400 ? Math.round(betrag / 3600) + ' Std' : Math.round(betrag / 86400) + ' Tagen';
      return text === 'gerade eben' ? text : s >= 0 ? 'vor ' + text : 'in ' + text;
    }
    case 'kuerzen': {
      const t = wert === null || wert === undefined ? '' : String(wert);
      const n = Math.max(1, zahlAus(args[0]) ?? 80);
      return t.length > n ? t.slice(0, n - 1) + '…' : t;
    }
    case 'gross': return wert === null || wert === undefined ? '' : String(wert).toUpperCase();
    case 'klein': return wert === null || wert === undefined ? '' : String(wert).toLowerCase();
    case 'json': return JSON.stringify(wert ?? null);
    case 'standard': return wert === null || wert === undefined || wert === '' || (Array.isArray(wert) && !wert.length) ? args[0] : wert;
    default: throw new VorlageFehler('Unbekannter Filter "' + name + '" (erlaubt: ' + VORLAGE_FILTER.join(', ') + ')');
  }
}

function werte(a: Ausdruck, bereich: Bereich, jetzt: Date): unknown {
  switch (a.art) {
    case 'wert': return a.wert;
    case 'pfad': return loesePfad(a.teile, bereich);
    case 'filter': return filter(a.name, werte(a.eingabe, bereich, jetzt), a.args.map((x) => werte(x, bereich, jetzt)), jetzt);
    case 'vergleich': return vergleiche(a.op, werte(a.a, bereich, jetzt), werte(a.b, bereich, jetzt));
    case 'und': return wahr(werte(a.a, bereich, jetzt)) && wahr(werte(a.b, bereich, jetzt));
    case 'oder': return wahr(werte(a.a, bereich, jetzt)) || wahr(werte(a.b, bereich, jetzt));
    case 'nicht': return !wahr(werte(a.a, bereich, jetzt));
  }
}

function textVon(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function platzhalter(meldung: string): string {
  return '<span class="vorlage-fehler" style="color:#b00;font:12px monospace">[Vorlage: ' + escapeHtml(meldung) + ']</span>';
}

/** Rendert eine Vorlage mit Daten. Wirft nie; Fehler stehen als Platzhalter im HTML und in fehler[]. */
export function renderVorlage(vorlage: string, daten: Record<string, unknown>, o: VorlageOptionen = {}): VorlageErgebnis {
  const grenzen = {
    max_schleifen: o.max_schleifen ?? VORLAGE_GRENZEN.max_schleifen,
    max_tiefe: o.max_tiefe ?? VORLAGE_GRENZEN.max_tiefe,
    max_ausgabe: o.max_ausgabe ?? VORLAGE_GRENZEN.max_ausgabe,
    max_ms: o.max_ms ?? VORLAGE_GRENZEN.max_ms,
  };
  const jetzt = o.jetzt ?? new Date();
  const start = Date.now();
  const fehler: string[] = [];
  const stat = { schleifen: 0, ausgaben: 0, ms: 0, gekappt: false };
  let baum: Knoten[];
  try {
    baum = parseVorlage(typeof vorlage === 'string' ? vorlage : '', grenzen.max_tiefe);
  } catch (error) {
    const m = (error as Error).message;
    return { html: platzhalter(m), fehler: [m], statistik: { ...stat, ms: Date.now() - start } };
  }
  const teile: string[] = [];
  let laenge = 0;
  const schreibe = (s: string) => {
    if (stat.gekappt) return;
    if (laenge + s.length > grenzen.max_ausgabe) { stat.gekappt = true; throw new VorlageFehler('Ausgabe groesser als ' + grenzen.max_ausgabe + ' Zeichen'); }
    teile.push(s); laenge += s.length;
  };
  const meldeFehler = (m: string) => { if (fehler.length < 50) fehler.push(m); schreibe(platzhalter(m)); };
  const uhr = () => { if (Date.now() - start > grenzen.max_ms) { stat.gekappt = true; throw new VorlageFehler('Renderzeit ueber ' + grenzen.max_ms + ' ms'); } };
  const lauf = (knoten: Knoten[], bereich: Bereich): void => {
    for (const k of knoten) {
      if (k.art === 'text') { schreibe(k.text); continue; }
      if (k.art === 'aus') {
        if (!k.a) { meldeFehler(k.fehler ?? 'Ausdruck ungueltig: ' + k.q); continue; }
        try { schreibe(escapeHtml(textVon(werte(k.a, bereich, jetzt)))); stat.ausgaben++; }
        catch (error) { if (stat.gekappt) throw error; meldeFehler((error as Error).message); }
        continue;
      }
      if (k.art === 'if') {
        let getroffen = false;
        for (const z of k.zweige) {
          let ok = false;
          try { ok = wahr(werte(z.a, bereich, jetzt)); } catch (error) { meldeFehler((error as Error).message); getroffen = true; break; }
          if (ok) { lauf(z.koerper, bereich); getroffen = true; break; }
        }
        if (!getroffen) lauf(k.sonst, bereich);
        continue;
      }
      let liste: unknown;
      try { liste = werte(k.a, bereich, jetzt); } catch (error) { meldeFehler((error as Error).message); continue; }
      const eintraege = Array.isArray(liste) ? liste
        : liste && typeof liste === 'object' ? Object.entries(liste as Record<string, unknown>).map(([schluessel, wert]) => ({ schluessel, wert })) : [];
      if (!eintraege.length) { lauf(k.sonst, bereich); continue; }
      for (let i = 0; i < eintraege.length; i++) {
        if (++stat.schleifen > grenzen.max_schleifen) { stat.gekappt = true; throw new VorlageFehler('Mehr als ' + grenzen.max_schleifen + ' Schleifendurchlaeufe'); }
        if (i % 50 === 0) uhr();
        lauf(k.koerper, [...bereich, { [k.name]: eintraege[i], '@index': i, '@nr': i + 1, '@erster': i === 0, '@letzter': i === eintraege.length - 1, '@anzahl': eintraege.length }]);
      }
    }
  };
  try {
    lauf(baum, [daten && typeof daten === 'object' ? daten : {}]);
  } catch (error) {
    const m = (error as Error).message;
    fehler.push(m);
    teile.push(platzhalter(m));
  }
  stat.ms = Date.now() - start;
  return { html: teile.join(''), fehler, statistik: stat };
}

/** Nur pruefen (beim Speichern): Syntaxfehler der Vorlage oder null. */
export function pruefeVorlage(vorlage: string, maxTiefe: number = VORLAGE_GRENZEN.max_tiefe): string | null {
  try {
    const baum = parseVorlage(vorlage, maxTiefe);
    const offen: string[] = [];
    const sammle = (k: Knoten[]) => { for (const x of k) { if (x.art === 'aus' && !x.a) offen.push(x.fehler ?? x.q); if (x.art === 'each') { sammle(x.koerper); sammle(x.sonst); } if (x.art === 'if') { x.zweige.forEach((z) => sammle(z.koerper)); sammle(x.sonst); } } };
    sammle(baum);
    return offen.length ? offen[0] : null;
  } catch (error) {
    return (error as Error).message;
  }
}
