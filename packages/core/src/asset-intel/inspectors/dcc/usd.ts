/**
 * MODUL: DCC USD-Inspektor (usda + usdc)
 * ZWECK:
 *  - .usda (Text): '#usda 1.0'-Kopf, Layer-Metadaten (upAxis, metersPerUnit, defaultPrim,
 *    Zeitcodes, subLayers), Prim-Hierarchie (def/over/class + Typ + Name -> Pfad, Tiefe),
 *    apiSchemas, variantSets/variants, references/payload/subLayers -> references,
 *    inherits/specializes (Prim-Pfade), rel-Zuweisungen (material:binding), asset-Attribute.
 *    Grosse Arrays (point3f[] points = [...]) werden NUR GEZAEHLT, nie gespeichert.
 *    Der Lexer streamt die Datei in Bloecken; Zeichenketten, Kommentare, @asset@ und </pfad>
 *    werden beachtet, damit Klammern darin die Struktur nicht verfaelschen.
 *  - .usdc (Crate, binaer): Magic 'PXR-USDC', Version, Inhaltsverzeichnis (TOC) mit Abschnitten,
 *    jeweils gegen die Dateigroesse geprueft. Der Crate-Inhalt wird NICHT dekodiert
 *    (status 'teilweise', Warnung 'usdc_nicht_dekodiert').
 *
 * KAPPEN: Prim-Tiefe (MAX_TIEFE, darueber wird iterativ uebersprungen), Zeichenkettenlaenge,
 * Listenelemente, Objektzahl (maxObjects), Pfadpruefungen (Budget).
 */

import * as path from 'path';
import { erzeugeAssetResult } from '../../types.js';
import type { AssetContext, AssetInspector, AssetObject, AssetResult, AssetSource } from '../../types.js';
import { FensterLeser, Sammler, istBildPfad, kurz, pruefeReferenz } from './hilfen.js';
import type { AufloeseBudget } from './hilfen.js';

const VERSION = 1;
const ASCII = (s: string): number[] => [...s].map(c => c.charCodeAt(0));

/** Tiefste Prim-Verschachtelung, die ausgewertet wird. */
const MAX_TIEFE = 128;
/** Laengste gespeicherte Zeichenkette. */
const MAX_STRING = 2048;
/** Gespeicherte Elemente je Metadaten-Liste. */
const MAX_LISTE = 256;
/** Leseblock des Lexers. */
const BLOCK = 256 * 1024;
/** Mindestvorrat an Zeichen vor jedem Token. */
const VORRAT = 1024;

const LISTEN_OPS = new Set(['prepend', 'append', 'add', 'delete', 'reorder']);
const MODIFIKATOREN = new Set(['custom', 'uniform', 'varying', 'config']);
const SPEZIFIZIERER = new Set(['def', 'over', 'class']);

type TokTyp = 'string' | 'asset' | 'pfad' | 'wort' | '(' | ')' | '[' | ']' | '{' | '}' | '=' | ',' | ';' | '?';
interface Tok {
  typ: TokTyp;
  wert: string;
  zeile: number;
  /** Zeichenkette/Pfad nicht abgeschlossen (Dateiende oder Zeilenende). */
  offen?: boolean;
}

/** Dateiende innerhalb einer offenen Klammer. */
class UsdaEnde extends Error {}

/** Streamender Lexer ueber einer AssetSource. */
class UsdaLexer {
  private t = '';
  private i = 0;
  private eof = false;
  private gelesen = 0;
  private gepeekt: Tok | null | undefined = undefined;
  private readonly dec = new TextDecoder('utf-8');
  zeile = 1;
  /** Zeile des zuletzt gelieferten Tokens. */
  letzteZeile = 1;

  constructor(
    private readonly src: AssetSource,
    private readonly ctx: AssetContext
  ) {}

  private async laden(): Promise<boolean> {
    if (this.eof) return false;
    this.ctx.pruefeAbbruch();
    const b = await this.src.readRange(this.gelesen, BLOCK);
    this.gelesen += b.length;
    if (b.length === 0 || this.gelesen >= this.src.size) this.eof = true;
    const neu = this.dec.decode(b, { stream: !this.eof });
    this.t = this.t.slice(this.i) + neu;
    this.i = 0;
    return true;
  }

  private async vorrat(n: number): Promise<void> {
    while (!this.eof && this.t.length - this.i < n) await this.laden();
  }

  async peek(): Promise<Tok | null> {
    if (this.gepeekt === undefined) this.gepeekt = await this.lies();
    return this.gepeekt;
  }

  async next(): Promise<Tok | null> {
    const p = await this.peek();
    this.gepeekt = undefined;
    if (p) this.letzteZeile = p.zeile;
    return p;
  }

  /** Naechstes Token muss vom Typ sein; sonst null (Token bleibt verbraucht). */
  async erwarte(typ: TokTyp): Promise<Tok | null> {
    const t = await this.next();
    if (!t) throw new UsdaEnde();
    return t.typ === typ ? t : null;
  }

  private async lies(): Promise<Tok | null> {
    for (;;) {
      await this.vorrat(VORRAT);
      if (this.i >= this.t.length) return null;
      const c = this.t.charCodeAt(this.i);
      if (c === 10) {
        this.zeile++;
        this.i++;
        continue;
      }
      if (c === 32 || c === 9 || c === 13 || c === 0xfeff) {
        this.i++;
        continue;
      }
      if (c === 35) {
        if (!(await this.kommentar())) return null;
        continue;
      }
      break;
    }
    const zeile = this.zeile;
    const ch = this.t[this.i];
    if (ch === '"' || ch === "'") return this.zeichenkette(ch, zeile);
    if (ch === '@') return this.asset(zeile);
    if (ch === '<') return this.pfad(zeile);
    if ('()[]{}=,;'.includes(ch)) {
      this.i++;
      return { typ: ch as TokTyp, wert: ch, zeile };
    }
    const start = this.i;
    while (this.i < this.t.length && /[A-Za-z0-9_:.+\-|]/.test(this.t[this.i])) this.i++;
    if (this.i === start) {
      this.i++;
      return { typ: '?', wert: ch, zeile };
    }
    return { typ: 'wort', wert: this.t.slice(start, this.i), zeile };
  }

  /** '#' Kommentar bis vor das Zeilenende (auch ueber Blockgrenzen). false = Dateiende. */
  private async kommentar(): Promise<boolean> {
    for (;;) {
      const nl = this.t.indexOf('\n', this.i);
      if (nl >= 0) {
        this.i = nl;
        return true;
      }
      this.i = this.t.length;
      if (!(await this.laden())) return false;
    }
  }

  private async zeichenkette(q: string, zeile: number): Promise<Tok> {
    await this.vorrat(3);
    const dreifach = this.t.startsWith(q + q + q, this.i);
    this.i += dreifach ? 3 : 1;
    let wert = '';
    for (;;) {
      if (this.i + 3 > this.t.length && !this.eof) await this.vorrat(3);
      if (this.i >= this.t.length) return { typ: 'string', wert, zeile, offen: true };
      const ch = this.t[this.i];
      if (ch === '\\') {
        if (this.i + 1 < this.t.length) {
          if (wert.length < MAX_STRING) wert += this.t[this.i + 1];
          if (this.t[this.i + 1] === '\n') this.zeile++;
          this.i += 2;
        } else this.i++;
        continue;
      }
      if (dreifach) {
        if (this.t.startsWith(q + q + q, this.i)) {
          this.i += 3;
          return { typ: 'string', wert, zeile };
        }
      } else if (ch === q) {
        this.i++;
        return { typ: 'string', wert, zeile };
      }
      if (ch === '\n') {
        this.zeile++;
        if (!dreifach) {
          this.i++;
          return { typ: 'string', wert, zeile, offen: true };
        }
      }
      if (wert.length < MAX_STRING) wert += ch;
      this.i++;
    }
  }

  private async asset(zeile: number): Promise<Tok> {
    await this.vorrat(3);
    const dreifach = this.t.startsWith('@@@', this.i);
    this.i += dreifach ? 3 : 1;
    let wert = '';
    for (;;) {
      if (this.i + 3 > this.t.length && !this.eof) await this.vorrat(3);
      if (this.i >= this.t.length) return { typ: 'asset', wert, zeile, offen: true };
      const ch = this.t[this.i];
      if (dreifach) {
        if (ch === '\\' && this.t.startsWith('@@@', this.i + 1)) {
          wert += '@@@';
          this.i += 4;
          continue;
        }
        if (this.t.startsWith('@@@', this.i)) {
          this.i += 3;
          return { typ: 'asset', wert, zeile };
        }
      } else if (ch === '@') {
        this.i++;
        return { typ: 'asset', wert, zeile };
      }
      if (ch === '\n') return { typ: 'asset', wert, zeile, offen: true };
      if (wert.length < MAX_STRING) wert += ch;
      this.i++;
    }
  }

  private async pfad(zeile: number): Promise<Tok> {
    this.i++;
    let wert = '';
    for (;;) {
      if (this.i >= this.t.length && !(await this.laden())) return { typ: 'pfad', wert, zeile, offen: true };
      const ch = this.t[this.i];
      if (ch === '>') {
        this.i++;
        return { typ: 'pfad', wert, zeile };
      }
      if (ch === '\n') return { typ: 'pfad', wert, zeile, offen: true };
      if (wert.length < MAX_STRING) wert += ch;
      this.i++;
    }
  }

  /**
   * Ueberspringt den Rest einer Klammer, deren Oeffner schon verbraucht ist, ohne Inhalt zu
   * speichern. Liefert die Zahl der Elemente auf oberster Ebene (Kommazaehlung).
   * Iterativ — beliebig tiefe Verschachtelung kostet keinen Stack.
   */
  async ueberspringe(): Promise<number> {
    if (this.gepeekt !== undefined) throw new Error('Lexer: ueberspringe mit vorgemerktem Token');
    let tiefe = 1;
    let anzahl = 0;
    let inhalt = false;
    for (;;) {
      if (this.i >= this.t.length && !(await this.laden())) throw new UsdaEnde();
      const c = this.t.charCodeAt(this.i);
      switch (c) {
        case 10:
          this.zeile++;
          this.i++;
          break;
        case 32:
        case 9:
        case 13:
          this.i++;
          break;
        case 35:
          if (!(await this.kommentar())) throw new UsdaEnde();
          break;
        case 34:
        case 39:
          if (tiefe === 1) inhalt = true;
          await this.zeichenkette(this.t[this.i], this.zeile);
          break;
        case 64:
          if (tiefe === 1) inhalt = true;
          await this.vorrat(3);
          await this.asset(this.zeile);
          break;
        case 60:
          if (tiefe === 1) inhalt = true;
          await this.pfad(this.zeile);
          break;
        case 40:
        case 91:
        case 123:
          if (tiefe === 1) inhalt = true;
          tiefe++;
          this.i++;
          break;
        case 41:
        case 93:
        case 125:
          tiefe--;
          this.i++;
          if (tiefe === 0) {
            this.letzteZeile = this.zeile;
            return inhalt ? anzahl + 1 : anzahl;
          }
          break;
        case 44:
          if (tiefe === 1 && inhalt) {
            anzahl++;
            inhalt = false;
          }
          this.i++;
          break;
        default:
          if (tiefe === 1) inhalt = true;
          this.i++;
      }
    }
  }
}

/** Ein geparster Metadaten-/Attributwert (nur das, was ausgewertet wird). */
type Wert =
  | { art: 'string'; s: string }
  | { art: 'asset'; asset: string; prim?: string }
  | { art: 'pfad'; pfad: string }
  | { art: 'liste'; elemente: Wert[]; anzahl: number }
  | { art: 'dict'; eintraege: Array<{ typ: string; name: string; wert: Wert }> }
  | { art: 'wort'; w: string }
  | { art: 'uebersprungen'; anzahl: number };

export interface UsdaOptionen {
  /** Eigene Aufloesung von Asset-Pfaden (z. B. innerhalb einer .usdz). */
  aufloeser?: (ziel: string) => Promise<boolean | undefined>;
}

/** Parser-Zustand eines Laufs. */
class UsdaParser {
  readonly layer: Record<string, unknown> = {};
  readonly primTypen: Record<string, number> = {};
  prims = 0;
  maxTiefe = 0;
  arrays = 0;
  arrayElemente = 0;
  intakt = true;
  private tiefeGewarnt = false;
  private syntaxWarnungen = 0;

  constructor(
    private readonly lx: UsdaLexer,
    private readonly s: Sammler,
    private readonly ref: (ziel: string, kind: string) => Promise<void>
  ) {}

  private syntax(zeile: number, was: string): void {
    this.intakt = false;
    if (this.syntaxWarnungen++ < 20) this.s.warn('usda_syntax', `Zeile ${zeile}: ${was}`);
  }

  async datei(): Promise<void> {
    const t = await this.lx.peek();
    if (t?.typ === '(') {
      await this.lx.next();
      await this.metadaten('layer', null);
    }
    for (;;) {
      const t2 = await this.lx.next();
      if (!t2) return;
      if (t2.typ === 'wort' && SPEZIFIZIERER.has(t2.wert)) await this.prim(t2, '', 1);
      else if (t2.typ === '}') {
        this.s.warn('klammer_ungleichgewicht', `Zeile ${t2.zeile}: schliessende Klammer ohne offenen Prim.`);
        this.intakt = false;
      } else this.syntax(t2.zeile, `unerwartetes Token "${kurz(t2.wert, 40)}" auf oberster Ebene`);
    }
  }

  /** Wert lesen; liste=false zaehlt Listen nur. */
  private async wert(liste: boolean): Promise<Wert> {
    const t = await this.lx.next();
    if (!t) throw new UsdaEnde();
    switch (t.typ) {
      case 'string':
        return { art: 'string', s: t.wert };
      case 'asset': {
        const w: Wert = { art: 'asset', asset: t.wert };
        const p = await this.lx.peek();
        if (p?.typ === 'pfad') {
          await this.lx.next();
          w.prim = p.wert;
        }
        const p2 = await this.lx.peek();
        if (p2?.typ === '(') {
          await this.lx.next();
          await this.lx.ueberspringe(); // Layer-Offset
        }
        return w;
      }
      case 'pfad': {
        const p2 = await this.lx.peek();
        if (p2?.typ === '(') {
          await this.lx.next();
          await this.lx.ueberspringe();
        }
        return { art: 'pfad', pfad: t.wert };
      }
      case '[': {
        if (!liste) return { art: 'uebersprungen', anzahl: await this.lx.ueberspringe() };
        const elemente: Wert[] = [];
        let anzahl = 0;
        for (;;) {
          const p = await this.lx.peek();
          if (!p) throw new UsdaEnde();
          if (p.typ === ']') {
            await this.lx.next();
            return { art: 'liste', elemente, anzahl };
          }
          if (p.typ === ',') {
            await this.lx.next();
            continue;
          }
          const el = await this.wert(false);
          anzahl++;
          if (elemente.length < MAX_LISTE) elemente.push(el);
        }
      }
      case '{':
        return { art: 'uebersprungen', anzahl: await this.lx.ueberspringe() };
      case '(':
        return { art: 'uebersprungen', anzahl: await this.lx.ueberspringe() };
      case 'wort':
        return { art: 'wort', w: t.wert };
      default:
        return { art: 'wort', w: t.wert };
    }
  }

  /** Dictionary 'variants = { string set = "wahl" }'. Oeffner '{' schon gelesen. */
  private async dict(): Promise<Wert> {
    const eintraege: Array<{ typ: string; name: string; wert: Wert }> = [];
    for (;;) {
      const t = await this.lx.next();
      if (!t) throw new UsdaEnde();
      if (t.typ === '}') return { art: 'dict', eintraege };
      if (t.typ === ',' || t.typ === ';') continue;
      if (t.typ !== 'wort') continue;
      const n = await this.lx.next();
      if (!n) throw new UsdaEnde();
      const gl = await this.lx.peek();
      if (gl?.typ !== '=') continue;
      await this.lx.next();
      const w = await this.wert(false);
      if (eintraege.length < MAX_LISTE) eintraege.push({ typ: t.wert, name: n.wert, wert: w });
    }
  }

  /** Metadatenblock '( ... )'; '(' schon gelesen. */
  private async metadaten(art: 'layer' | 'prim', obj: AssetObject | null): Promise<void> {
    for (;;) {
      const t = await this.lx.next();
      if (!t) throw new UsdaEnde();
      if (t.typ === ')') return;
      if (t.typ === 'string' || t.typ === ',' || t.typ === ';') {
        if (t.typ === 'string' && art === 'layer' && t.wert) this.layer.doc ??= kurz(t.wert, 200);
        continue;
      }
      if (t.typ !== 'wort') {
        if (t.typ === '(' || t.typ === '[' || t.typ === '{') await this.lx.ueberspringe();
        continue;
      }
      let op: string | null = null;
      let schluessel = t.wert;
      if (LISTEN_OPS.has(t.wert)) {
        op = t.wert;
        const k = await this.lx.next();
        if (!k) throw new UsdaEnde();
        schluessel = k.wert;
      }
      const gl = await this.lx.peek();
      if (gl?.typ !== '=') continue;
      await this.lx.next();
      if (schluessel === 'variants') {
        const o = await this.lx.next();
        if (!o) throw new UsdaEnde();
        if (o.typ === '{') {
          const d = await this.dict();
          if (obj && d.art === 'dict') {
            obj.data.varianten_auswahl = Object.fromEntries(
              d.eintraege.map(e => [e.name, e.wert.art === 'string' ? e.wert.s : null])
            );
          }
        }
        continue;
      }
      const sammeln = ['subLayers', 'references', 'payload', 'inherits', 'specializes', 'apiSchemas', 'variantSets'].includes(schluessel);
      const w = await this.wert(sammeln);
      if (art === 'layer') await this.layerSchluessel(schluessel, w);
      else if (obj) await this.primSchluessel(schluessel, w, obj, op);
    }
  }

  private async layerSchluessel(k: string, w: Wert): Promise<void> {
    const skalar = w.art === 'string' ? w.s : w.art === 'wort' ? w.w : null;
    switch (k) {
      case 'upAxis':
      case 'defaultPrim':
        if (skalar !== null) this.layer[k] = skalar;
        break;
      case 'metersPerUnit':
      case 'startTimeCode':
      case 'endTimeCode':
      case 'timeCodesPerSecond':
      case 'framesPerSecond':
        if (skalar !== null) this.layer[k] = Number.isNaN(Number(skalar)) ? skalar : Number(skalar);
        break;
      case 'doc':
        if (skalar !== null) this.layer.doc = kurz(skalar, 200);
        break;
      case 'subLayers': {
        const ziele: string[] = [];
        for (const e of elemente(w)) if (e.art === 'asset') {
          ziele.push(e.asset);
          await this.ref(e.asset, 'sublayer');
        }
        this.layer.subLayers = ziele;
        break;
      }
      default:
        break;
    }
  }

  private async primSchluessel(k: string, w: Wert, obj: AssetObject, op: string | null): Promise<void> {
    const d = obj.data;
    switch (k) {
      case 'references':
      case 'payload': {
        const kind = k === 'payload' ? 'payload' : 'reference';
        const eintraege: Array<Record<string, unknown>> = [];
        for (const e of elemente(w)) {
          if (e.art === 'asset') {
            eintraege.push({ asset: e.asset, prim: e.prim ?? null });
            await this.ref(e.asset, kind);
          } else if (e.art === 'pfad') eintraege.push({ intern: e.pfad });
        }
        d[k === 'payload' ? 'payloads' : 'referenzen'] = eintraege;
        if (op) d[k + '_op'] = op;
        break;
      }
      case 'inherits':
      case 'specializes':
        d[k] = elemente(w).filter(e => e.art === 'pfad').map(e => (e as { pfad: string }).pfad);
        break;
      case 'apiSchemas':
        d.api_schemas = elemente(w).filter(e => e.art === 'string').map(e => (e as { s: string }).s);
        break;
      case 'variantSets':
        d.variant_sets = elemente(w).filter(e => e.art === 'string').map(e => (e as { s: string }).s);
        break;
      case 'kind':
        if (w.art === 'string') d.kind = w.s;
        break;
      case 'instanceable':
      case 'active':
      case 'hidden':
        if (w.art === 'wort') d[k] = w.w === 'true' || w.w === '1';
        break;
      default:
        break;
    }
  }

  private async prim(spec: Tok, eltern: string, tiefe: number): Promise<void> {
    let t = await this.lx.next();
    if (!t) throw new UsdaEnde();
    let typ: string | null = null;
    if (t.typ === 'wort') {
      typ = t.wert;
      t = await this.lx.next();
      if (!t) throw new UsdaEnde();
    }
    if (t.typ !== 'string') {
      this.syntax(t.zeile, `Prim ohne Namen nach "${spec.wert}"`);
      return;
    }
    const name = t.wert;
    // Sdf-Schreibweise: nach einer Variantenauswahl folgt der Name ohne '/' (/Welt{farbe=rot}RotGeo).
    const pfad = eltern.endsWith('}') ? eltern + name : eltern + '/' + name;
    if (tiefe > MAX_TIEFE) {
      if (!this.tiefeGewarnt) {
        this.s.warn('tiefengrenze', `Zeile ${spec.zeile}: Prim-Verschachtelung tiefer als ${MAX_TIEFE}; tiefere Prims werden uebersprungen.`);
        this.tiefeGewarnt = true;
      }
      this.intakt = false;
      let p = await this.lx.next();
      if (p?.typ === '(') {
        await this.lx.ueberspringe();
        p = await this.lx.next();
      }
      if (!p) throw new UsdaEnde();
      if (p.typ === '{') await this.lx.ueberspringe();
      return;
    }
    this.prims++;
    if (tiefe > this.maxTiefe) this.maxTiefe = tiefe;
    const typSchluessel = typ ?? '(ohne Typ)';
    this.primTypen[typSchluessel] = (this.primTypen[typSchluessel] ?? 0) + 1;
    const range = { line_start: spec.zeile, line_end: spec.zeile };
    const obj: AssetObject = {
      name,
      kind: 'prim',
      data: { pfad, typ, spezifizierer: spec.wert, tiefe },
      source_range: range,
    };
    this.s.objekt(obj);
    let p = await this.lx.peek();
    if (p?.typ === '(') {
      await this.lx.next();
      await this.metadaten('prim', obj);
      p = await this.lx.peek();
    }
    if (p?.typ !== '{') {
      this.syntax(p?.zeile ?? spec.zeile, `Prim "${pfad}" ohne Rumpf '{'`);
      return;
    }
    await this.lx.next();
    range.line_end = await this.rumpf(pfad, tiefe, obj);
  }

  /** Prim-Rumpf; '{' schon gelesen. Liefert die Zeile der schliessenden Klammer. */
  private async rumpf(pfad: string, tiefe: number, obj: AssetObject): Promise<number> {
    let attribute = 0;
    for (;;) {
      let t = await this.lx.next();
      if (!t) throw new UsdaEnde();
      if (t.typ === '}') {
        if (attribute) obj.data.attribute = ((obj.data.attribute as number) ?? 0) + attribute;
        return t.zeile;
      }
      if (t.typ !== 'wort') {
        if (t.typ === '(' || t.typ === '[' || t.typ === '{') await this.lx.ueberspringe();
        else if (t.typ !== ';' && t.typ !== ',' && t.typ !== 'string') this.syntax(t.zeile, `unerwartetes "${kurz(t.wert, 40)}" in "${pfad}"`);
        continue;
      }
      if (SPEZIFIZIERER.has(t.wert)) {
        await this.prim(t, pfad, tiefe + 1);
        continue;
      }
      if (t.wert === 'variantSet') {
        await this.variantSet(pfad, tiefe, obj);
        continue;
      }
      if (t.wert === 'reorder') {
        // reorder nameChildren/properties = [...]
        await this.lx.next();
        if ((await this.lx.peek())?.typ === '=') {
          await this.lx.next();
          await this.wert(false);
        }
        continue;
      }
      while (t && t.typ === 'wort' && (MODIFIKATOREN.has(t.wert) || LISTEN_OPS.has(t.wert))) t = await this.lx.next();
      if (!t) throw new UsdaEnde();
      if (t.typ !== 'wort') {
        this.syntax(t.zeile, `Eigenschaft ohne Typ in "${pfad}"`);
        if (t.typ === '}') return t.zeile;
        continue;
      }
      if (t.wert === 'rel') {
        await this.beziehung(pfad, obj);
        continue;
      }
      await this.attribut(t, pfad, obj);
      attribute++;
    }
  }

  private async variantSet(pfad: string, tiefe: number, obj: AssetObject): Promise<void> {
    const n = await this.lx.next();
    if (!n) throw new UsdaEnde();
    const setName = n.wert;
    if (!(await this.lx.erwarte('='))) return this.syntax(n.zeile, `variantSet "${setName}" ohne '='`);
    if (!(await this.lx.erwarte('{'))) return this.syntax(n.zeile, `variantSet "${setName}" ohne '{'`);
    const namen: string[] = [];
    for (;;) {
      const v = await this.lx.next();
      if (!v) throw new UsdaEnde();
      if (v.typ === '}') break;
      if (v.typ !== 'string') continue;
      if (namen.length < MAX_LISTE) namen.push(v.wert);
      let p = await this.lx.next();
      if (p?.typ === '(') {
        await this.lx.ueberspringe();
        p = await this.lx.next();
      }
      if (!p) throw new UsdaEnde();
      if (p.typ !== '{') {
        this.syntax(p.zeile, `Variante "${v.wert}" ohne '{'`);
        continue;
      }
      await this.rumpf(`${pfad}{${setName}=${v.wert}}`, tiefe, obj);
    }
    const def = (obj.data.variant_sets_def as Record<string, string[]>) ?? {};
    def[setName] = namen;
    obj.data.variant_sets_def = def;
  }

  private async beziehung(pfad: string, obj: AssetObject): Promise<void> {
    const n = await this.lx.next();
    if (!n) throw new UsdaEnde();
    const ziele: string[] = [];
    if ((await this.lx.peek())?.typ === '=') {
      await this.lx.next();
      const w = await this.wert(true);
      for (const e of elemente(w)) if (e.art === 'pfad') ziele.push(e.pfad);
    }
    if ((await this.lx.peek())?.typ === '(') {
      await this.lx.next();
      await this.lx.ueberspringe();
    }
    if (n.wert === 'material:binding' && ziele[0]) obj.data.material = ziele[0];
    this.s.objekt({
      name: n.wert,
      kind: 'rel',
      data: { prim: pfad, ziele },
      source_range: { line_start: n.zeile, line_end: this.lx.letzteZeile },
    });
  }

  private async attribut(typTok: Tok, pfad: string, obj: AssetObject): Promise<void> {
    let typ = typTok.wert;
    if ((await this.lx.peek())?.typ === '[') {
      await this.lx.next();
      if (!(await this.lx.erwarte(']'))) return this.syntax(typTok.zeile, `Typ "${typ}[" ohne ']'`);
      typ += '[]';
    }
    const n = await this.lx.next();
    if (!n) throw new UsdaEnde();
    if (n.typ !== 'wort') return this.syntax(n.zeile, `Attribut vom Typ "${typ}" ohne Namen`);
    const name = n.wert;
    if ((await this.lx.peek())?.typ === '=') {
      await this.lx.next();
      const p = await this.lx.peek();
      if (typ.endsWith('[]') && p?.typ === '[') {
        if (typ === 'asset[]') {
          const w = await this.wert(true);
          for (const e of elemente(w)) if (e.art === 'asset') await this.ref(e.asset, istBildPfad(e.asset) ? 'texture' : 'asset');
        } else {
          await this.lx.next();
          const anzahl = await this.lx.ueberspringe();
          this.arrays++;
          this.arrayElemente += anzahl;
          if (name === 'points') obj.data.punkte = anzahl;
          else if (name === 'faceVertexCounts') obj.data.flaechen = anzahl;
        }
      } else if (p?.typ === '{') {
        await this.lx.next();
        await this.lx.ueberspringe(); // timeSamples / Dictionary
      } else {
        const w = await this.wert(false);
        if (typ === 'asset' && w.art === 'asset') await this.ref(w.asset, istBildPfad(w.asset) ? 'texture' : 'asset');
      }
    }
    if ((await this.lx.peek())?.typ === '(') {
      await this.lx.next();
      await this.lx.ueberspringe();
    }
  }
}

function elemente(w: Wert): Wert[] {
  if (w.art === 'liste') return w.elemente;
  if (w.art === 'uebersprungen') return [];
  return [w];
}

/** Inspiziert eine .usda-Datei. */
export async function inspiziereUsda(src: AssetSource, ctx: AssetContext, opt: UsdaOptionen = {}): Promise<AssetResult> {
  const res = erzeugeAssetResult(src.filePath, src.size, {
    asset_type: 'scene',
    format: 'usda',
    inspector: 'dcc-usd',
    parser_version: VERSION,
  });
  const s = new Sammler(ctx.limits.maxObjects);
  const kopf = (await src.readRange(0, 64)).toString('utf8');
  const m = /^﻿?#usda\s+([0-9.]+)/.exec(kopf);
  if (!m) {
    s.warn('kein_usda_kopf', 'Datei beginnt nicht mit "#usda <version>".');
    res.status = 'fehler';
    s.indErgebnis(res);
    return res;
  }
  res.metadata.usda_version = m[1];
  const dir = path.dirname(src.filePath);
  const budget: AufloeseBudget = { rest: Math.min(1000, ctx.limits.maxObjects) };
  let traversal = 0;
  const ref = async (ziel: string, kind: string): Promise<void> => {
    let resolved: boolean | undefined;
    if (/<UDIM>|<UVTILE|<frame>/i.test(ziel)) resolved = undefined;
    else if (opt.aufloeser) resolved = await opt.aufloeser(ziel);
    else {
      const r = await pruefeReferenz(dir, ziel, budget);
      resolved = r.resolved;
      if (r.traversal) traversal++;
    }
    s.referenz({ target: ziel, kind, resolved });
  };
  const lx = new UsdaLexer(src, ctx);
  const p = new UsdaParser(lx, s, ref);
  try {
    await p.datei();
  } catch (e) {
    if (!(e instanceof UsdaEnde)) throw e;
    s.warn('klammer_ungleichgewicht', `Dateiende (Zeile ${lx.zeile}) innerhalb einer offenen Klammer.`);
    p.intakt = false;
  }
  if (traversal > 0) s.warn('pfad_traversal', `${traversal} Asset-Pfade zeigen ausserhalb des Layer-Verzeichnisses (nur gemeldet, nichts geoeffnet).`);
  Object.assign(res.metadata, p.layer);
  res.metadata.prim_anzahl = p.prims;
  res.metadata.prim_typen = p.primTypen;
  res.metadata.max_tiefe = p.maxTiefe;
  res.format_specific.zeilen = lx.zeile;
  res.format_specific.arrays_gezaehlt = p.arrays;
  res.format_specific.array_elemente_gezaehlt = p.arrayElemente;
  if (!p.intakt) res.status = 'teilweise';
  s.indErgebnis(res);
  return res;
}

/** Bekannte Abschnitte des Crate-Inhaltsverzeichnisses. */
const USDC_ABSCHNITTE = new Set(['TOKENS', 'STRINGS', 'FIELDS', 'FIELDSETS', 'PATHS', 'SPECS']);

/** Inspiziert eine .usdc-Datei: Kopf + Inhaltsverzeichnis, Crate-Inhalt nicht dekodiert. */
export async function inspiziereUsdc(src: AssetSource, ctx: AssetContext): Promise<AssetResult> {
  const res = erzeugeAssetResult(src.filePath, src.size, {
    asset_type: 'scene',
    format: 'usdc',
    inspector: 'dcc-usd',
    parser_version: VERSION,
    status: 'teilweise',
  });
  const s = new Sammler(ctx.limits.maxObjects);
  const f = new FensterLeser(src, 4096);
  const fertig = (): AssetResult => {
    s.indErgebnis(res);
    return res;
  };
  const kopf = await f.lies(0, 24);
  if (kopf.length < 24 || kopf.toString('latin1', 0, 8) !== 'PXR-USDC') {
    s.warn(kopf.length < 24 ? 'abgeschnitten' : 'kein_usdc_kopf', 'Crate-Kopf (24 Bytes, "PXR-USDC") fehlt oder ist unvollstaendig.');
    res.status = 'fehler';
    return fertig();
  }
  const version = `${kopf[8]}.${kopf[9]}.${kopf[10]}`;
  res.metadata.usdc_version = version;
  if (kopf[8] !== 0) s.warn('version_unbekannt', `Crate-Version ${version}: Hauptversion != 0 ist unbekannt.`);
  const toc = kopf.readBigInt64LE(16);
  s.warn('usdc_nicht_dekodiert', 'Crate-Inhalt (Prims, Felder) wird nicht dekodiert; nur Kopf und Inhaltsverzeichnis gelesen.');
  if (toc < 24n || toc + 8n > BigInt(src.size)) {
    s.warn('toc_ausserhalb', `Inhaltsverzeichnis-Offset ${toc} liegt ausserhalb der Datei (${src.size} Bytes).`);
    return fertig();
  }
  const tocOff = Number(toc);
  const anzahlRoh = (await f.genau(tocOff, 8)).readBigUInt64LE(0);
  if (anzahlRoh > 64n || BigInt(tocOff) + 8n + anzahlRoh * 32n > BigInt(src.size)) {
    s.warn('toc_ungueltig', `Inhaltsverzeichnis meldet ${anzahlRoh} Abschnitte; passt nicht in die Datei.`);
    return fertig();
  }
  const abschnitte: Array<Record<string, unknown>> = [];
  for (let i = 0; i < Number(anzahlRoh); i++) {
    const b = await f.genau(tocOff + 8 + i * 32, 32);
    const nullAt = b.indexOf(0);
    const name = b.toString('latin1', 0, nullAt < 0 || nullAt > 16 ? 16 : nullAt);
    const start = b.readBigInt64LE(16);
    const groesse = b.readBigInt64LE(24);
    const gueltig = start >= 0n && groesse >= 0n && start + groesse <= BigInt(src.size);
    if (!gueltig) s.warn('abschnitt_ausserhalb', `Abschnitt "${name}" (${start}+${groesse}) liegt ausserhalb der Datei.`);
    if (!USDC_ABSCHNITTE.has(name)) s.warn('abschnitt_unbekannt', `Unbekannter Crate-Abschnitt "${name}".`);
    const ab = { name, offset: Number(start), groesse: Number(groesse), gueltig };
    abschnitte.push(ab);
    if (gueltig) s.objekt({ name, kind: 'crate_abschnitt', data: { groesse: ab.groesse }, source_range: { offset: ab.offset, length: ab.groesse } });
  }
  res.metadata.sections = abschnitte;
  res.format_specific.toc_offset = tocOff;
  return fertig();
}

/** Inspiziert .usd/.usda/.usdc — die Unterscheidung trifft der Inhalt, nicht die Endung. */
export async function inspiziereUsd(src: AssetSource, ctx: AssetContext, opt: UsdaOptionen = {}): Promise<AssetResult> {
  const kopf = await src.readRange(0, 8);
  if (kopf.toString('latin1') === 'PXR-USDC') return inspiziereUsdc(src, ctx);
  if (/^(﻿)?#usda/.test(kopf.toString('utf8')) || ctx.format === 'usda') return inspiziereUsda(src, ctx, opt);
  if (ctx.format === 'usdc') return inspiziereUsdc(src, ctx);
  const res = erzeugeAssetResult(src.filePath, src.size, {
    asset_type: 'scene',
    format: 'usd',
    inspector: 'dcc-usd',
    parser_version: VERSION,
    status: 'fehler',
  });
  res.warnings.push({ code: 'usd_unbekannt', message: 'Weder "#usda"-Kopf noch "PXR-USDC"-Magic gefunden.' });
  return res;
}

export const usdInspektor: AssetInspector = {
  id: 'dcc-usd',
  formats: ['usda', 'usdc', 'usd'],
  extensions: ['.usd', '.usda', '.usdc'],
  magic: [
    { offset: 0, bytes: ASCII('#usda'), format: 'usda' },
    { offset: 0, bytes: ASCII('PXR-USDC'), format: 'usdc' },
  ],
  version: VERSION,
  inspect: (src, ctx) => inspiziereUsd(src, ctx),
};
