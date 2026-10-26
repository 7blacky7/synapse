// schema.mjs — P25-T1 Gesamt-Testlaeufer: Rot wegen fehlendem Live-Schema erkennen (User-Entscheidung thought 3f202323).
// Zuerst wird gegen synapse_test im Schemastand der Produktion getestet. Scheitert ein Test an
// 'relation/column ... does not exist' (bzw. 'Relation/Spalte »…« existiert nicht') und legt der AKTUELLE Code das
// Objekt an, ist das SCHEMA_FEHLT_LIVE (erwartet bis zum naechsten Deploy) statt NEU_ROT, mit Herkunft
// (Schema-Datei, Zeile, Task). Legt der Code das Objekt nicht an, bleibt es NEU_ROT (echter Fehler).
// P25-T8: Zusaetzlich muss das Objekt in public von synapse_test FEHLEN (objektImBestand); hat public es, baut der Test ein
// veraltetes privates Schema (search_path=<privat>,public) -> NEU_ROT grund=privates_schema_veraltet, kein Nachzug hilft.
// Reine Funktionen bis auf ladeSchemaQuellen (liest nur packages/*/src, schreibt nichts).

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ohneSchema = (n) => n.slice(n.lastIndexOf('.') + 1);
const FEHLER_MUSTER = [
  { art: 'spalte', r: /column "([\w$]+)" of relation "([\w$.]+)" does not exist/g, f: (m) => ({ name: m[1], tabelle: ohneSchema(m[2]) }) },
  { art: 'spalte', r: /Spalte »([\w$]+)« von Relation »([\w$.]+)« existiert nicht/g, f: (m) => ({ name: m[1], tabelle: ohneSchema(m[2]) }) },
  { art: 'tabelle', r: /(?<!of )relation "([\w$.]+)" does not exist/g, f: (m) => ({ name: ohneSchema(m[1]) }) },
  { art: 'tabelle', r: /(?<!von )Relation »([\w$.]+)« existiert nicht/g, f: (m) => ({ name: ohneSchema(m[1]) }) },
  // 'column x.y does not exist': x ist meist ein Alias, daher nur der Spaltenname
  { art: 'spalte', r: /column "?([\w$]+(?:\.[\w$]+)?)"? does not exist/g, f: (m) => ({ name: ohneSchema(m[1]) }) },
  { art: 'spalte', r: /Spalte »?([\w$]+(?:\.[\w$]+)?)«? existiert nicht/g, f: (m) => ({ name: ohneSchema(m[1]) }) },
];

/** Fehlende Tabellen/Spalten aus einer Testausgabe: [{art, name, tabelle?}], hoechstens 5, ohne Doppel. */
export function erkenneSchemaFehler(text) {
  const gefunden = new Map();
  // P25-T14: Tests geben Tool-Antworten oft als JSON aus ('column \"x\" of relation \"y\" ...'); \" wie " behandeln
  const ausgabe = String(text ?? '').replace(/\\"/g, '"');
  for (const { art, r, f } of FEHLER_MUSTER) {
    for (const m of ausgabe.matchAll(r)) {
      const o = { art, ...f(m) };
      const schluessel = `${art}:${o.tabelle ?? ''}.${o.name}`;
      // eine Spalte ohne Tabelle nicht doppelt melden, wenn sie mit Tabelle schon da ist
      if (art === 'spalte' && !o.tabelle && [...gefunden.values()].some((x) => x.art === 'spalte' && x.name === o.name)) continue;
      if (!gefunden.has(schluessel)) gefunden.set(schluessel, o);
    }
  }
  return [...gefunden.values()].slice(0, 5);
}

/** Anzeigename eines Objekts: tabelle 'x', spalte 'x.y' bzw. 'y'. */
export function objektName(o) { return o.art === 'spalte' && o.tabelle ? `${o.tabelle}.${o.name}` : o.name; }

/** P25-T8: Bestand von public aus schema-nachzug.mjs (pruefen <datei>) -> { tabelle: Set, spalte: Set('tabelle.spalte'), index: Set }. */
export function leseBestand(json) {
  return { tabelle: new Set(json?.tabelle ?? []), spalte: new Set(json?.spalte ?? []), index: new Set(json?.index ?? []) };
}

/**
 * P25-T8 (Inventur 2f2f6776 Punkt 1): Hat public von synapse_test das Objekt? Nur wenn NICHT, ist Rot SCHEMA_FEHLT_LIVE; sonst baut
 * der Test ein veraltetes privates Schema. o: {art, name, tabelle?} aus erkenneSchemaFehler oder {art, name: 'tabelle.spalte'|'spalte'}
 * aus schema-objekte.json. Spalte ohne Tabelle (Alias im Fehlertext): vorhanden, wenn irgendeine Tabelle sie hat.
 */
export function objektImBestand(bestand, o) {
  if (o.art !== 'spalte') return !!bestand[o.art]?.has(o.name);
  const voll = o.tabelle ? `${o.tabelle}.${o.name}` : o.name;
  if (voll.includes('.')) return bestand.spalte.has(voll);
  return [...bestand.spalte].some((n) => n.endsWith('.' + voll));
}

/** Quelltexte, in denen Schema-SQL steht (packages/core/src, packages/rest-api/src): [{datei, zeilen}]. */
export function ladeSchemaQuellen(repo, pakete = ['core', 'rest-api']) {
  const quellen = [];
  const lauf = (dir, rel) => {
    let eintraege;
    try { eintraege = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of eintraege) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      if (e.isDirectory()) lauf(join(dir, e.name), `${rel}/${e.name}`);
      else if (/\.(?:ts|mjs|js|sql)$/.test(e.name) && !/\.d\.ts$/.test(e.name)) {
        let text;
        try { text = readFileSync(join(dir, e.name), 'utf8'); } catch { continue; }
        if (/CREATE\s+(?:UNLOGGED\s+)?TABLE|ADD\s+COLUMN/i.test(text)) quellen.push({ datei: `${rel}/${e.name}`, zeilen: text.split('\n') });
      }
    }
  };
  for (const p of pakete) lauf(join(repo, 'packages', p, 'src'), `packages/${p}/src`);
  return quellen;
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SPALTEN_TYP = /^\s*"?([\w$]+)"?\s+(?:TEXT|INTEGER|INT|BIGINT|SMALLINT|BOOLEAN|BOOL|TIMESTAMPTZ|TIMESTAMP|UUID|JSONB|JSON|SERIAL|BIGSERIAL|NUMERIC|REAL|DOUBLE|VARCHAR|CHAR|DATE|BYTEA|VECTOR|INET|TEXT\[\])\b/i;

function taskBei(zeilen, i) {
  for (let j = i + 1; j >= Math.max(0, i - 10); j--) {
    const z = zeilen[j] ?? '';
    const t = /\bP\d+-[A-Z]{1,2}\d+\b/.exec(z);
    if (t) return t[0];
    const s = /\b(?:Schema|SCHEMA|Migration)\s*(\d{2,4})\b/.exec(z);
    if (s) return `Schema ${s[1]}`;
  }
  return null;
}

/** Sucht, wo der aktuelle Code das Objekt anlegt: {datei, zeile (1-basiert), task} oder null. */
export function sucheSchemaObjekt(quellen, o) {
  const treffer = (q, i) => ({ datei: q.datei, zeile: i + 1, task: taskBei(q.zeilen, i) });
  if (o.art === 'tabelle') {
    const r = new RegExp(`CREATE\\s+(?:UNLOGGED\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(?:public\\.)?"?${esc(o.name)}"?(?![\\w$])`, 'i');
    for (const q of quellen) for (let i = 0; i < q.zeilen.length; i++) if (r.test(q.zeilen[i])) return treffer(q, i);
    return null;
  }
  const add = new RegExp(`ADD\\s+COLUMN\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?"?${esc(o.name)}"?(?![\\w$])`, 'i');
  const tab = o.tabelle ? new RegExp(`(?:^|[^\\w$])(?:public\\.)?"?${esc(o.tabelle)}"?(?![\\w$])`) : null;
  for (const q of quellen) {
    for (let i = 0; i < q.zeilen.length; i++) {
      if (!add.test(q.zeilen[i])) continue;
      if (!tab || q.zeilen.slice(Math.max(0, i - 6), i + 1).some((z) => tab.test(z))) return treffer(q, i);
    }
  }
  // Spaltendefinition im CREATE-TABLE-Block (der Tabelle, falls bekannt)
  const create = o.tabelle ? new RegExp(`CREATE\\s+(?:UNLOGGED\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(?:public\\.)?"?${esc(o.tabelle)}"?(?![\\w$])`, 'i') : /CREATE\s+(?:UNLOGGED\s+)?TABLE/i;
  for (const q of quellen) {
    for (let i = 0; i < q.zeilen.length; i++) {
      if (!create.test(q.zeilen[i])) continue;
      for (let j = i + 1; j < Math.min(q.zeilen.length, i + 200); j++) {
        const m = SPALTEN_TYP.exec(q.zeilen[j]);
        if (m && m[1].toLowerCase() === o.name.toLowerCase()) return treffer(q, j);
        if (/^\s*\)\s*;?\s*$/.test(q.zeilen[j])) break;
      }
    }
  }
  return null;
}
