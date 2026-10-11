/**
 * P16-T4 Funktionstests der Syntaxpruefer Stufe 1 und ihres Worker-Pools. Reine Funktionstests, keine DB.
 * AUFRUF: node packages/core/tests/syntax-pruefer.test.mjs   (nach pnpm run build in packages/core)
 */
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

process.env.SYNTAX_PRUEFER_TESTMODUS = '1';
process.env.SYNTAX_PRUEFER_TIMEOUT_MS = '400';
process.env.SYNTAX_POOL_WIEDERBELEBUNG_MS = '60000';
delete process.env.SYNTAXPRUEFUNG;
delete process.env.SYNTAX_WORKER_THREADS;

const hier = dirname(fileURLToPath(import.meta.url));
const lade = (...t) => import(pathToFileURL(join(hier, '..', 'dist', ...t)).href);
const K = await lade('services', 'syntax-pruefer', 'katalog.js');
const S = await lade('services', 'syntax-pruefer', 'index.js');
const FP = await lade('services', 'fehlermuster-pruefung.js');

let ok = 0;
let fehl = 0;
function pruefe(name, bedingung, info) {
  if (bedingung) { ok++; console.log('  OK  ', name); } else { fehl++; console.log('  FEHL', name, info === undefined ? '' : JSON.stringify(info)); }
}
const def = (n) => K.PRUEFER_KATALOG.find((d) => d.name === n);
const warte = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Positivkontrollen: kaputte Datei erkannt, mit Zeile, Spalte, Meldung ───
console.log('Positivkontrollen');
{
  const m = def('typescript').pruefe('export function f(a: number) {\n  return a +;\n}\n', 'x.ts');
  pruefe('K1 TS: Ausdruck fehlt Z.2', m[0]?.zeile === 2 && m[0]?.spalte === 13 && m[0]?.code === 'TS1109' && /Expression expected/.test(m[0]?.meldung), m[0]);
  pruefe('K1 TS: warum/wie/wo', !!m[0]?.warum && !!m[0]?.wie && m[0]?.wo?.[0]?.includes('ts1109'), m[0]);
  const g = def('typescript').pruefe('const a = <div className="x">{1}</div>;\nexport default a;\n', 'x.jsx');
  pruefe('K2 JSX gueltig', g.length === 0, g);
  const j = def('typescript').pruefe('const a = <div><span></div>;\n', 'x.tsx');
  pruefe('K3 TSX: falsches schliessendes Tag', j.length > 0 && j[0].zeile === 1 && typeof j[0].spalte === 'number', j[0]);
  const c = def('typescript').pruefe('module.exports = { a: 1,, };\n', 'x.cjs');
  pruefe('K4 CJS: doppeltes Komma', c.length > 0 && c[0].zeile === 1, c[0]);
  const t = def('typescript').pruefe('function f() {\n  if (x) {\n    y();\n}\n', 'x.ts');
  pruefe('K5 TS: fehlende } am Dateiende', t.length > 0 && t[0].code === 'TS1005' && t[0].zeile === 5, t[0]);
}
{
  const j = def('json');
  const a = j.pruefe('{\n  "a": 1\n  "b": 2\n}\n', 'x.json');
  pruefe('K6 JSON: Komma fehlt Z.3 Sp.3', a[0]?.zeile === 3 && a[0]?.spalte === 3 && a[0]?.code === 'JSON' && /Expected/.test(a[0]?.meldung) && !/position/.test(a[0]?.meldung), a[0]);
  pruefe('K7 package.json: Trailing Comma ist Fehler', j.pruefe('{"a": 1,}', 'package.json').length === 1);
  pruefe('K8 tsconfig.json: Kommentar + Trailing Comma erlaubt', j.pruefe('{\n // c\n "a": 1,\n}', 'tsconfig.json').length === 0);
  const k = j.pruefe('{\n // c\n "a": 1\n "b": 2\n}', 'tsconfig.app.json');
  pruefe('K9 JSONC: Strukturfehler trotzdem erkannt', k[0]?.zeile === 4 && k[0]?.spalte === 2, k[0]);
  pruefe('K10 JSON: // in String ist kein Kommentar', j.pruefe('{"u": "http://x//y", "a": 1,}', 'x.json').length === 1);
  pruefe('K11 JSON: leer und BOM ok', j.pruefe('  \n', 'x.json').length === 0 && j.pruefe('﻿{"a":1}', 'x.json').length === 0);
  const e = j.pruefe('{"a": [1, 2', 'x.json');
  pruefe('K12 JSON: unerwartetes Ende -> letzte Zeile', e[0]?.zeile === 1 && e[0]?.spalte >= 1, e[0]);
  // Kleinkram D (E0-Befund 1486172c): Kommentar in einer .json ohne JSONC-Namen ist ein Fehler.
  const kom = (inhalt, pfad) => j.pruefe(inhalt, pfad);
  let km = kom('{\n  // c\n  "a": 1\n}\n', 'x.json');
  pruefe('K16 JSON: // Kommentar -> Fehler Z.2 Sp.3', km.length === 1 && km[0].zeile === 2 && km[0].spalte === 3 && /Kommentar/.test(km[0].meldung), km);
  km = kom('{\n  "a": 1 /* c */\n}\n', 'x.json');
  pruefe('K16 JSON: /* */ Kommentar -> Fehler Z.2 Sp.10', km.length === 1 && km[0].zeile === 2 && km[0].spalte === 10 && /Kommentar/.test(km[0].meldung), km);
  pruefe('K16 package.json: Kommentar ist Fehler', kom('{"a": 1, // c\n"b": 2}', 'package.json').length === 1);
  km = kom('{"u": "http://x", // c\n"a": 1}', 'x.json');
  pruefe('K16 JSON: // im String zaehlt nicht, Kommentar danach Sp.19', km.length === 1 && km[0].zeile === 1 && km[0].spalte === 19, km);
  km = kom('{"a": 1 "b": 2 // c\n}', 'x.json');
  pruefe('K16 JSON: Strukturfehler VOR dem Kommentar wird gemeldet', km.length === 1 && km[0].spalte === 9 && !/Kommentar/.test(km[0].meldung), km);
  pruefe('K16 JSONC-Namen bleiben erlaubt (pyrightconfig, .vscode, .jsonc, tsconfig)',
    ['pyrightconfig.json', '.vscode/settings.json', 'a/b.jsonc', 'tsconfig.base.json'].every((p) => kom('{\n // c\n "a": 1\n}', p).length === 0));
  // P16-T9: V8 meldet viele Fehler ohne Position; die Zeile darf bei abschliessendem \n nicht +1 verrutschen.
  const stelle = (inhalt, z, s) => {
    const m = j.pruefe(inhalt, 'x.json')[0];
    pruefe(`K13 JSON-Stelle ${JSON.stringify(inhalt)} -> Z.${z} Sp.${s}`, m?.zeile === z && m?.spalte === s && !/is not valid JSON/.test(m?.meldung), m);
  };
  stelle('{ "a": 1, "b": }\n', 1, 16);
  stelle('{ "a": 1, "b": }', 1, 16);
  stelle('{ "a": 1, "b": }\n\n\n', 1, 16);
  stelle('{"a": tru}\n', 1, 10);
  stelle('[1,2,]\n', 1, 6);
  stelle('{"a":\n', 1, 6);
  stelle('{"a": [1, 2\n\n', 1, 12);
  stelle('{\n "a": 1,\n}\n', 3, 1);
  stelle('{"a":1 "b":2}\n', 1, 8);
  stelle('{"a": 1}\n}\n', 2, 1);
  stelle('{"a": "x\\q"}\n', 1, 10);
  // Engine-unabhaengig: SpiderMonkey-Form (nur line/column) und Meldung ganz ohne Stelle
  pruefe('K14 jsonFehlerStelle: line/column-Form', K.jsonFehlerStelle('{\n "a": }\n', 'JSON.parse: unexpected character at line 2 column 7 of the JSON data') === 8);
  pruefe('K14 jsonFehlerStelle: ohne Stelle -> Scanner', K.jsonFehlerStelle('{\n "a": }\n', 'irgendwas') === 8);
  // Gegenprobe: der Scanner stimmt mit V8 ueberein, wo V8 eine Position nennt, und haelt gueltiges JSON fuer gueltig
  let gleich = 0;
  const v8faelle = ['{"a":1 "b":2}', '{\n "a": 1,\n}', '\n\n{"a" 1}', '{"a": 1}\n}', '{"a": 01}', '{"a": "x\ty"}', '[1, 2 3]'];
  for (const f of v8faelle) {
    let v8 = null;
    try { JSON.parse(f); } catch (err) { v8 = Number(/at position (\d+)/.exec(err.message)?.[1]); }
    if (v8 !== null && v8 === K.jsonFehlerPosition(f)) gleich++;
  }
  pruefe('K15 Scanner = V8-Position', gleich === v8faelle.length, gleich);
  const gueltig = ['{}', '[]', '0', '-1.5e+3', '"\\u00e4\\n"', '{"a": [true, false, null, {"b": "c"}]}', ' \n{"x": -0.0}\n'];
  pruefe('K15 Scanner: gueltiges JSON = null', gueltig.every((g) => K.jsonFehlerPosition(g) === null));
}
{
  const c = def('postcss');
  const a = c.pruefe('a { color: red; }\nb { color: blue\n  margin: 0; }\n', 'x.css');
  pruefe('K13 CSS: Semikolon fehlt Z.2', a[0]?.zeile === 2 && typeof a[0]?.spalte === 'number' && a[0]?.meldung === 'Missed semicolon' && a[0]?.weich === true, a[0]);
  const b = c.pruefe('.x {\n  &__e { c: d; }\n', 'x.scss');
  pruefe('K14 SCSS: Unclosed block', b[0]?.meldung === 'Unclosed block' && b[0]?.zeile === 1, b[0]);
  pruefe('K15 SCSS gueltig (Mixins, //-Kommentar)', c.pruefe('@mixin m($a: 1) { b: $a }\n.x { @include m(2); &__e { c: d } // k\n}\n', 'x.scss').length === 0);
  pruefe('K16 LESS gueltig', c.pruefe('.m(@a: 1) { b: @a }\n.x { .m(2); &:extend(.y); }\n', 'x.less').length === 0);
  const l = c.pruefe('.x { a: b; }\n}\n', 'x.less');
  pruefe('K17 LESS: ueberzaehlige }', l[0]?.zeile === 2 && /Unexpected/.test(l[0]?.meldung), l[0]);
  pruefe('K18 CSS: alte Hacks (progid, *zoom, _height) gueltig', c.pruefe("a { filter: progid:DXImageTransform.Microsoft.gradient(startColorstr='#80000000'); *zoom: 1; _height: 1px; }", 'x.css').length === 0);
}

console.log('Positivkontrollen E2');
{
  const s = def('libpg-query');
  const a = await s.pruefe('SELECT a,\n  b\nFROM t WHERE (a = 1;\n', 'x.sql');
  pruefe('S1 SQL: Klammer offen Z.3 Sp.20', a[0]?.zeile === 3 && a[0]?.spalte === 20 && a[0]?.code === 'PG' && /syntax error at or near/.test(a[0]?.meldung), a[0]);
  const u = await s.pruefe("-- äöü\nSELECT 'ää' FROM t WHERE x = ;\n", 'x.sql');
  pruefe('S2 SQL: Spalte trotz Umlauten (Bytes -> Zeichen)', u[0]?.zeile === 2 && u[0]?.spalte === 30, u[0]);
  pruefe('S3 SQL gueltig (Funktion, $$, CTE)', (await s.pruefe('CREATE FUNCTION f() RETURNS int AS $$ select 1 $$ LANGUAGE sql;\nWITH x AS (SELECT 1) SELECT * FROM x;\n', 'x.sql')).length === 0);
  pruefe('S4 SQL: MySQL-Datei wird nicht gemeldet', (await s.pruefe('CREATE TABLE `t` (id INT AUTO_INCREMENT PRIMARY KEY) ENGINE=InnoDB;\n', 'x.sql')).length === 0);
  pruefe('S5 SQL: psql-Variable wird nicht gemeldet', (await s.pruefe('SELECT * FROM t WHERE id = :id;\n', 'x.sql')).length === 0);
  const t = await def('toml').pruefe('a = 1\nb = [1,\nc = "x"\n', 'x.toml');
  pruefe('T1 TOML: Array offen Z.3', t[0]?.zeile === 3 && t[0]?.spalte === 1 && t[0]?.code === 'TOML' && !!t[0]?.meldung, t[0]);
  pruefe('T2 TOML: Tabelle doppelt', (await def('toml').pruefe('[a]\nx = 1\n[a]\ny = 2\n', 'x.toml'))[0]?.zeile === 3);
  pruefe('T3 TOML gueltig', (await def('toml').pruefe('[tools]\nnode = "22"\n[[a.b]]\nc = { d = 1 }\n', 'x.toml')).length === 0);
  const y = def('yaml').pruefe('a: 1\nb: [1, 2\nc: 3\n', 'x.yaml');
  pruefe('Y1 YAML: Flow-Sequenz offen Z.3', y[0]?.zeile === 3 && typeof y[0]?.spalte === 'number' && !!y[0]?.code, y[0]);
  pruefe('Y2 YAML: eigene Tags, doppelte Schluessel, mehrere Dokumente ok', def('yaml').pruefe('a: !Ref x\nb: !GetAtt y.z\nb: 2\n---\nc: 1\n', 'x.yml').length === 0);
  pruefe('Y3 YAML: Helm-Vorlage wird nicht gemeldet', def('yaml').pruefe('a: {{ .Values.x }}\n  b: [\n', 'templates/x.yaml').length === 0);
  const yt = def('yaml').pruefe('a:\n\tb: 1\n', 'x.yaml');
  pruefe('Y4 YAML: Tabulator-Einrueckung', yt[0]?.zeile === 2, yt[0]);
  const x = def('xml').pruefe('<a>\n  <b></a>\n', 'x.xml');
  pruefe('X1 XML: Tag-Mismatch Z.2', x[0]?.zeile === 2 && typeof x[0]?.spalte === 'number' && /mismatch/.test(x[0]?.meldung), x[0]);
  pruefe('X2 XML: SVG, &nbsp;, DOCTYPE gueltig', def('xml').pruefe('<?xml version="1.0"?>\n<!DOCTYPE svg>\n<svg xmlns="http://www.w3.org/2000/svg"><text>&nbsp;</text></svg>\n', 'x.svg').length === 0);
  pruefe('X3 XML: Attribut doppelt', def('xml').pruefe('<a x="1" x="2"/>', 'x.csproj')[0]?.zeile === 1);
  pruefe('X4 XML: Fragment mit zwei Wurzeln ok, Fehler im Fragment erkannt', def('xml').pruefe('<?xml version="1.0"?>\n<a/>\n<b/>\n', 'x.xml').length === 0
    && def('xml').pruefe('<a/>\n<b>\n</c>\n', 'x.xml')[0]?.zeile === 2); // xmldom meldet das oeffnende Tag
  pruefe('X5 XML ist nicht sperrfaehig', def('xml').sperrfaehig === false);
  pruefe('Y5 YAML: ${...}-Vorlage wird nicht gemeldet', def('yaml').pruefe('a: [out_${X}.yaml]\n', 'x.yaml').length === 0);
  const ym = def('yaml').pruefe('name: x\nexpertise: Researcher: kuratiert Docs\n', 'meta.yaml');
  pruefe('Y6 YAML: Doppelpunkt im Klartext-Wert erkannt', ym[0]?.zeile === 2 && ym[0]?.spalte === 12, ym[0]);
}

console.log('Positivkontrollen E3');
{
  const h = def('html');
  const a = await h.pruefe('<div>\n  <a href="x" class="y"title="z">t</a>\n</div>\n', 'x.html');
  pruefe('H1 HTML: Leerzeichen zwischen Attributen fehlt Z.2', a[0]?.zeile === 2 && a[0]?.code === 'missing-whitespace-between-attributes' && typeof a[0]?.spalte === 'number' && a[0]?.wo[0]?.includes('#parse-error-'), a[0]);
  const s = await h.pruefe('<!doctype html>\n<html><body>\n<script>\n  let a = ;\n</script>\n</body></html>\n', 'x.html');
  pruefe('H2 HTML: Fehler im <script> auf Dateizeile 4 abgebildet', s[0]?.zeile === 4 && s[0]?.spalte === 11 && s[0]?.code === 'TS1109' && s[0]?.meldung.startsWith('<script>'), s[0]);
  const st = await h.pruefe('<p>x</p><style>a { color: red; } }</style>\n', 'x.htm');
  pruefe('H3 HTML: <style> in Zeile 1, Spalte verschoben', st[0]?.zeile === 1 && st[0]?.spalte === 34 && st[0]?.code === 'CssSyntaxError', st[0]);
  pruefe('H4 HTML: Vorlage {{ }} wird nicht gemeldet', (await h.pruefe('<div>{{ a }}<a b="1"c="2"></a></div>', 'x.html')).length === 0);
  const j = await h.pruefe('<script type="application/ld+json">\n{"a": 1,}\n</script><script type="text/template"><div>{ a</div></script>', 'x.html');
  pruefe('H5 HTML: JSON-Script geprueft, text/template nicht', j.length === 1 && j[0].zeile === 2 && j[0].code === 'JSON', j);
  pruefe('H6 HTML: Fragment, <div/>, a < b, &copy gueltig', (await h.pruefe('<div/><p>a < b &copy 2026</p><br>\n', 'x.html')).length === 0);
  const e = await h.pruefe('<ul>\n  <li>x</li>\n</ul\n\n<p class="a">y</p>\n', 'x.html');
  pruefe('H7 HTML: </ul ohne > erkannt', e.length >= 1 && e[0].code === 'unexpected-character-in-attribute-name', e[0]);
  const md = def('markdown-codebloecke');
  const m = await md.pruefe('# T\n\n```json\n{"a": 1\n "b": 2}\n```\n', 'x.md');
  pruefe('M1 Markdown: json-Fence, Fehler auf Dateizeile 5', m[0]?.zeile === 5 && m[0]?.code === 'JSON' && /Codeblock/.test(m[0]?.meldung), m[0]);
  const l = await md.pruefe('- Punkt:\n\n  ```ts\n  const a = ;\n  ```\n', 'x.md');
  pruefe('M2 Markdown: eingerueckter Fence in Liste', l[0]?.zeile === 4 && l[0]?.spalte === 13, l[0]);
  pruefe('M3 Markdown: Auslassung, unbekannte Sprache, offener Fence nicht gemeldet', (await md.pruefe('```js\nfoo(a, ...)\n// ...\n```\n```text\n{ a\n```\n```json\n{', 'x.md')).length === 0);
  pruefe('M4 Markdown nicht sperrfaehig', md.sperrfaehig === false && def('html').sperrfaehig === true);
}

console.log('Positivkontrollen E4');
{
  const p = await def('protobuf').pruefe('syntax = "proto3";\nmessage A {\n  int32 a = 1\n  string b = 2;\n}\n', 'x.proto');
  pruefe('P-1 protobuf: Semikolon fehlt, Z.4', p[0]?.zeile === 4 && p[0]?.code === 'PROTO' && /expected/.test(p[0]?.meldung), p[0]);
  pruefe('P-2 protobuf gueltig (import, map, oneof, service, proto2)', (await def('protobuf').pruefe('syntax = "proto3";\nimport "google/protobuf/timestamp.proto";\nmessage A { google.protobuf.Timestamp t = 1; map<string,int32> m = 2; oneof o { string s = 3; } }\nservice S { rpc F(A) returns (stream A); }\n', 'x.proto')).length === 0
    && (await def('protobuf').pruefe('syntax = "proto2";\nmessage A { required int32 a = 1; extensions 100 to 199; }\n', 'x.proto')).length === 0);
  const g = await def('graphql').pruefe('query {\n  a {\n    b(x: )\n  }\n}\n', 'x.graphql');
  pruefe('G1 GraphQL: Wert fehlt Z.3 Sp.10', g[0]?.zeile === 3 && g[0]?.spalte === 10 && g[0]?.code === 'GraphQL', g[0]);
  pruefe('G2 GraphQL-Schema gueltig', (await def('graphql').pruefe('type A @key(fields: "id") { id: ID! b(x: Int = 1): [String!] }\nextend type Query { a: A }\n', 'x.graphqls')).length === 0);
  const vue = def('vue');
  const v1 = await vue.pruefe('<template>\n  <div>\n    <span>\n  </div>\n</template>\n', 'x.vue');
  pruefe('V1 Vue: Tag nicht geschlossen Z.3', v1[0]?.zeile === 3 && v1[0]?.code === 'VUE', v1[0]);
  const v2 = await vue.pruefe('<template>\n  <p v-if="a &&">{{ b }}</p>\n</template>\n', 'x.vue');
  pruefe('V2 Vue: Template-Ausdruck Z.2', v2[0]?.zeile === 2 && v2[0]?.spalte === 12 && /JavaScript expression/.test(v2[0]?.meldung), v2[0]);
  const v3 = await vue.pruefe('<template><p>{{ a }}</p></template>\n<script setup lang="ts">\nconst a: number = ;\n</script>\n<style lang="scss">\n.a { .b { c: d }\n</style>\n', 'x.vue');
  pruefe('V3 Vue: <script setup lang=ts> Z.3 und <style lang=scss> Z.6', v3.length === 2 && v3[0].zeile === 3 && v3[0].code === 'TS1109' && v3[1].zeile === 6, v3);
  pruefe('V4 Vue gueltig', (await vue.pruefe('<template><div v-for="x in xs" :key="x.id" @click="f(x)">{{ x.n }}</div></template>\n<script>\nexport default { data: () => ({ xs: [] }) };\n</script>\n', 'x.vue')).length === 0);
  const s = await def('svelte').pruefe('<script lang="ts">\n  let a: number = 1;\n</script>\n{#if a}\n  <p>{a}</p>\n', 'x.svelte');
  pruefe('S-1 Svelte: {#if} nicht geschlossen', s.length === 1 && typeof s[0].zeile === 'number' && s[0].wo[0].includes('compiler-errors'), s[0]);
  const s2 = await def('svelte').pruefe('<div>\n  <p>{a +}</p>\n</div>\n', 'x.svelte');
  pruefe('S-2 Svelte: Ausdruck Z.2', s2[0]?.zeile === 2 && s2[0]?.spalte > 1, s2[0]);
  pruefe('S-3 Svelte gueltig (Svelte-4- und -5-Syntax)', (await def('svelte').pruefe('<script>\n  export let a = 1;\n  let b = $state(0);\n</script>\n{#each [1,2] as x (x)}<p on:click={() => b++}>{x}</p>{/each}\n<style>p { color: red; }</style>\n', 'x.svelte')).length === 0);
  pruefe('S-4 Svelte sperrfaehig, protobuf/graphql/vue/solidity nicht', def('svelte').sperrfaehig && !def('protobuf').sperrfaehig && !def('graphql').sperrfaehig && !def('vue').sperrfaehig && !def('solidity').sperrfaehig);
  const sol = await def('solidity').pruefe('pragma solidity ^0.8.0;\ncontract A {\n  function f() public {\n}\n', 'x.sol');
  pruefe('SOL1 Solidity: } fehlt -> ParserError', sol.length === 1 && /^ParserError/.test(sol[0].code), sol[0]);
  const sol2 = await def('solidity').pruefe('// ÄÖÜ\npragma solidity ^0.8.0;\ncontract A {\n  function f() public { uint a = ; }\n}\n', 'x.sol');
  pruefe('SOL2 Solidity: Ausdruck fehlt Z.4 Sp.34 (Bytes -> Zeichen)', sol2[0]?.zeile === 4 && sol2[0]?.spalte === 34 && /primary expression/.test(sol2[0]?.meldung), sol2[0]);
  pruefe('SOL4 Solidity: andere Compiler-Hauptversion nicht gemeldet', (await def('solidity').pruefe('pragma solidity ^0.4.24;\ncontract A { function A() public { var x = 1; } }\n', 'x.sol')).length === 0);
  pruefe('SOL3 Solidity gueltig', (await def('solidity').pruefe('pragma solidity ^0.8.0;\ncontract A { mapping(address => uint) b; event E(uint a); function f(uint x) external returns (uint) { emit E(x); return x * 2; } }\n', 'x.sol')).length === 0);
}

console.log('P16-T10 TS/JS-Grammatik (Binder/Checker)');
{
  const ts = (c, p) => def('typescript').pruefe(c, p);
  const erst = (c, p) => ts(c, p)[0] ?? null;
  // Rot am Stand vor P16-T10 (nur parseDiagnostics): jede Zeile muss jetzt erkannt werden
  const rot = [
    ['GR1 .mjs await in nicht-async Funktion', 'export function f() {\n  return await g();\n}\n', 'a.mjs', 'TS1308', 2],
    ['GR2 .js await in nicht-async Funktion (gemma javascript_1)', 'function f() {\n  return (await new Promise((r) => r(1)));\n}\n', 'a.js', 'TS1308', 2],
    ['GR3 .ts doppelter Modifier', 'class A {\n  public public x = 1;\n}\n', 'a.ts', 'TS1028', 2],
    ['GR4 .ts Modifier-Reihenfolge', 'class A { static public x = 1; }\n', 'a.ts', 'TS1029', 1],
    ['GR5 .ts return ausserhalb Funktion', 'const a = 1;\nreturn a;\n', 'a.ts', 'TS1108', 2],
    ['GR6 .mjs ohne import/export ist trotzdem Modul (strict): reserviertes Wort', 'const x = 1;\nconst package = x;\n', 'a.mjs', 'TS1214', 2],
    ['GR7 .js Typannotation', 'function f(x: number) { return x; }\n', 'a.js', 'TS8010', 1],
    ['GR8 .js let doppelt', 'let a = 1;\nlet a = 2;\n', 'a.js', 'TS2451', 1],
    ['GR9 .ts break ausserhalb Schleife', 'for (;;) {}\nbreak;\n', 'a.ts', 'TS1105', 2],
    ['GR10 .ts Pflichtparameter nach optionalem', 'export function f(a?: number, b: number) { return b; }\n', 'a.ts', 'TS1016', 1],
    ['GR11 .ts yield ausserhalb Generator', 'export function h() {\n  yield 1;\n}\n', 'a.ts', 'TS1163', 2],
    ['GR12 .tsx doppeltes JSX-Attribut', 'export const E = () => <div a="1" a="2" />;\n', 'a.tsx', 'TS17001', 1],
    ['GR13 .ts zwei export default', 'export default 1;\nexport default 2;\n', 'a.ts', 'TS2528', 1],
    ['GR14 .ts reserviertes Wort im Modul', 'export const interface = 1;\n', 'a.ts', 'TS1214', 1],
    ['GR15 .ts abstrakte Methode in normaler Klasse', 'export class B {\n  abstract g(): void;\n}\n', 'a.ts', 'TS1244', 2],
  ];
  for (const [name, c, p, code, zeile] of rot) {
    const m = erst(c, p);
    pruefe(name, m?.code === code && m?.zeile === zeile && typeof m?.spalte === 'number' && !!m?.warum && !!m?.wie && m?.wo?.[0]?.includes(code.toLowerCase()), m);
  }
  const m = erst('function f() {\n  return await g();\n}\n', 'a.mjs');
  pruefe('GR16 Grammatik-Befund: Spalte des await, eigener warum-Text', m?.spalte === 10 && /Grammatikregel/.test(m?.warum) && /async/.test(m?.wie), m);
  const pz = ts('function f() {\n  await g();\n  const a = ;\n}\n', 'a.ts');
  pruefe('GR17 Parse-Fehler gehen vor (nur TS1109, kein TS1308)', pz.length === 1 && pz[0].code === 'TS1109', pz);

  // Gueltig: darf nichts melden (Top-Level-await, CommonJS, Typfehler, Dekoratoren, Flow, JSX)
  const gruen = [
    ['GN1 .mjs Top-Level-await ohne Export', 'const x = await fetch("u");\nconsole.log(x);\n', 'a.mjs'],
    ['GN2 .ts Top-Level-await mit Export', 'export const x = await g();\n', 'a.ts'],
    ['GN3 .ts Top-Level-await ohne Import/Export (Moduldatei je nach tsconfig)', 'const x = await g();\n', 'a.ts'],
    ['GN4 .js Top-Level-await', 'import { a } from "./a.js";\nawait a();\n', 'a.js'],
    ['GN5 .cjs return auf oberster Ebene', 'if (!process.env.X) return;\nmodule.exports = 1;\n', 'a.cjs'],
    ['GN6 .js return auf oberster Ebene (CommonJS)', 'if (x) return 1;\n', 'a.js'],
    ['GN7 .ts nur Typfehler und unbekannte Namen', 'const x: number = "s";\nfoo();\nArray.from([]);\nimport y from "gibt-es-nicht";\nexport { y };\n', 'a.ts'],
    ['GN8 .ts async/await, for await, Generator', 'export async function f(b: AsyncIterable<number>) {\n  for await (const a of b) await a;\n}\nexport function* g() { yield 1; }\n', 'a.ts'],
    ['GN9 .ts NestJS-Parameterdekorator', 'import { Body, Controller, Post } from "@nestjs/common";\n@Controller("x")\nexport class C {\n  @Post()\n  m(@Body() b: unknown) { return b; }\n}\n', 'a.ts'],
    ['GN10 .js Flow-Annotation', '// @flow\nfunction f(x: number): number { return x; }\nmodule.exports = f;\n', 'a.js'],
    ['GN11 .jsx JSX', 'export const E = () => <div className="x">{1}</div>;\n', 'a.jsx'],
    ['GN12 .tsx Generics + JSX', 'export function L<T,>(p: { xs: T[] }) {\n  return <ul>{p.xs.map((x, i) => <li key={i}>{String(x)}</li>)}</ul>;\n}\n', 'a.tsx'],
    ['GN13 .ts enum/namespace/interface/abstract/overloads', 'export enum E { A }\nexport namespace N { export const x = 1; }\nexport interface I { a: number }\nexport abstract class A { abstract f(): void; }\nexport function o(a: string): string;\nexport function o(a: number): number;\nexport function o(a: any) { return a; }\n', 'a.ts'],
    ['GN14 .d.ts Deklarationen', 'declare module "x" {\n  export function f(): void;\n}\nexport declare const a: number;\n', 'a.d.ts'],
    ['GN15 .js Skript mit with und package (sloppy mode)', 'var package = 1;\nwith (o) { x = package; }\n', 'a.js'],
    ['GN16 .mts/.cts gueltig', 'export const a = 1;\n', 'a.mts'],
  ];
  for (const [name, c, p] of gruen) {
    const r = ts(c, p);
    pruefe(name, r.length === 0, r);
  }
  pruefe('GN17 cts gueltig', ts('const a = require("x");\nexport = a;\n', 'a.cts').length === 0, ts('const a = require("x");\nexport = a;\n', 'a.cts'));

  // Eingebettete Bloecke bleiben beim reinen Parse (Doku-Schnipsel mit Top-Level-return/await sind normal)
  pruefe('GE1 Markdown-Fence mit return/await ausserhalb Funktion: keine Meldung', (await def('markdown-codebloecke').pruefe('```js\nreturn await x;\n```\n```ts\nfunction f() { await g(); }\n```\n', 'x.md')).length === 0);
  pruefe('GE2 pruefeTypescript (eingebettet) bleibt Parse-only', K.pruefeTypescript('function f() { await g(); }\n', 'e.js').length === 0);

  // Schalter und Zeitdeckel
  const alt = process.env.SYNTAX_TS_GRAMMATIK_MS;
  const altKb = process.env.SYNTAX_TS_GRAMMATIK_MAX_KB;
  process.env.SYNTAX_TS_GRAMMATIK_MS = '0';
  pruefe('GS1 SYNTAX_TS_GRAMMATIK_MS=0 schaltet die Grammatikstufe ab', ts('function f() { await g(); }\n', 'a.ts').length === 0 && ts('const a = ;\n', 'a.ts').length === 1);
  process.env.SYNTAX_TS_GRAMMATIK_MS = '0.000001';
  process.env.SYNTAX_TS_GRAMMATIK_MAX_KB = '0';
  const gross = Array.from({ length: 3000 }, (_, i) => `export function f${i}(a: number) { const b = a * ${i}; return [b].map((x) => x + 1); }`).join('\n') + '\nfunction z() { await q(); }\n';
  const t0 = performance.now();
  const gd = ts(gross, 'gross.ts');
  pruefe('GS2 gerissener Zeitdeckel: kein Befund, kein Wurf, schnell', gd.length === 0 && performance.now() - t0 < 2000, gd.length);
  process.env.SYNTAX_TS_GRAMMATIK_MS = '60000';
  delete process.env.SYNTAX_TS_GRAMMATIK_MAX_KB;
  pruefe('GS4 Standard-Groessengrenze 32 KB: grosse Datei nur geparst', gross.length > 32 * 1024 && ts(gross, 'gross.ts').length === 0);
  process.env.SYNTAX_TS_GRAMMATIK_MAX_KB = '0';
  const g2 = ts(gross, 'gross.ts');
  if (alt === undefined) delete process.env.SYNTAX_TS_GRAMMATIK_MS; else process.env.SYNTAX_TS_GRAMMATIK_MS = alt;
  if (altKb === undefined) delete process.env.SYNTAX_TS_GRAMMATIK_MAX_KB; else process.env.SYNTAX_TS_GRAMMATIK_MAX_KB = altKb;
  pruefe('GS3 ohne Groessengrenze, grosser Deckel: Befund am Dateiende', g2.length === 1 && g2[0].code === 'TS1308' && g2[0].zeile === 3001, g2[0]);
}

// ─── Einzelweg ueber registriereStandardSyntaxPruefer (Pool) ───
console.log('Einzelweg mit Pool');
{
  FP._syntaxPrueferLeeren();
  const namen = S.registriereStandardSyntaxPruefer();
  pruefe('E1 angemeldet', ['typescript', 'json', 'postcss', 'libpg-query', 'toml', 'yaml', 'xml', 'zz-pooltest'].every((n) => namen.includes(n)), namen);
  pruefe('E1 hatSyntaxPruefer E2', ['a.sql', 'b.toml', 'c.yml', 'd.svg'].every((p) => FP.hatSyntaxPruefer(p)));
  pruefe('E1 hatSyntaxPruefer', FP.hatSyntaxPruefer('a/b.tsx') && FP.hatSyntaxPruefer('a.JSON') && !FP.hatSyntaxPruefer('a.py'));
  await warte(1500); // Worker laden typescript/postcss
  const alt = Array.from({ length: 40 }, (_, i) => `export function f${i}(a: number): number {\n  return a + ${i};\n}`).join('\n') + '\n';
  const neu = alt.replace('return a + 10;\n}', 'return a + 10;\n');
  const r = await FP.pruefeSyntaxEinzelweg({ filePath: 'm/x.ts', alt, neu });
  pruefe('E2 fehlende } mitten in der Datei sperrt (Fehlerstelle am Dateiende)', r.blockierend.length === 1 && /ausserhalb der geaenderten Zeilen/.test(r.blockierend[0].was) && r.blockierend[0].pruefer.startsWith('syntax:typescript@'), r);
  pruefe('E2 Befundformat', r.blockierend[0]?.severity === 'error' && r.blockierend[0]?.spalte > 0 && !!r.blockierend[0]?.wie && r.blockierend[0]?.wo.length === 1, r.blockierend[0]);
  const altKaputt = alt + 'function kaputt( {\n';
  const r2 = await FP.pruefeSyntaxEinzelweg({ filePath: 'm/x.ts', alt: altKaputt, neu: altKaputt.replace('return a + 3;', 'return a + 4;') });
  pruefe('E3 Altlast sperrt nicht', r2.blockierend.length === 0 && r2.altlasten >= 1, r2);
  const r3 = await FP.pruefeSyntaxEinzelweg({ filePath: 'm/x.ts', alt, neu: alt.replace('return a + 5;', 'return a + ;'), quittieren: 'Negativbeispiel fuer Test' });
  pruefe('E4 quittiert -> Hinweis', r3.blockierend.length === 0 && r3.hinweise[0]?.quittiert_grund === 'Negativbeispiel fuer Test', r3);
  const r4 = await FP.pruefeSyntaxEinzelweg({ filePath: 'p/package.json', alt: '{"a": 1}\n', neu: '{"a": 1,\n "b": 2,}\n' });
  pruefe('E5 JSON im Einzelweg', r4.blockierend.length === 1 && r4.blockierend[0].zeilen[0] === 2, r4.blockierend[0]);
  const t0 = performance.now();
  const r5 = await FP.pruefeSyntaxEinzelweg({ filePath: 'm/y.ts', alt, neu: alt.replace('a + 7', 'a + 8') });
  pruefe('E6 gueltige Aenderung fertig, keine Befunde', r5.status === 'fertig' && r5.blockierend.length === 0 && r5.hinweise.length === 0, r5);
  console.log('     E6 Dauer', Math.round((performance.now() - t0) * 10) / 10, 'ms');

  // Budget und Nachlieferung: SCHLAF 120 > Budget 30 -> teilweise, nachgeliefert; zweiter Lauf aus dem Cache.
  process.env.FEHLERPRUEFUNG_BUDGET_MS = '30';
  let nach = null;
  const inhalt = 'SCHLAF 120 FEHLER';
  const b1 = await FP.pruefeSyntaxEinzelweg({ filePath: 'n/a.zzpool', alt: '', neu: inhalt, onNachgereicht: (b) => { nach = b; } });
  pruefe('E7 Budget gerissen -> teilweise', b1.status === 'teilweise', b1);
  await warte(250);
  pruefe('E7 nachgeliefert', Array.isArray(nach) && /nachgeliefert/.test(nach[0]?.was), nach);
  const t1 = performance.now();
  const b2 = await FP.pruefeSyntaxEinzelweg({ filePath: 'n/a.zzpool', alt: '', neu: inhalt });
  pruefe('E8 erneute Pruefung bekommt das spaete Ergebnis sofort (Cache)', b2.status === 'fertig' && b2.hinweise.length === 1 && performance.now() - t1 < 25, { b2, ms: performance.now() - t1 });
  delete process.env.FEHLERPRUEFUNG_BUDGET_MS;
  const z = S.syntaxPoolZustand();
  pruefe('E9 Pool-Zustand mit Cache-Treffer', z && z.zaehler.cache_treffer >= 1 && z.groesse === 2, z?.zaehler);
  await S.beendeSyntaxPool();
  FP._syntaxPrueferLeeren();
}

// ─── Pool-Verhalten (eigener Pool, Groesse 1) ───
console.log('Pool');
{
  const P = await lade('services', 'syntax-pruefer', 'pool.js');
  const pool = new P.SyntaxWorkerPool(1);
  const z = () => pool.zustand();
  pruefe('P1 Ergebnis wie direkt', JSON.stringify(await pool.pruefe('zz-pooltest', 'FEHLER', 'a.zzpool')) === JSON.stringify(def('typescript') && [{ zeile: 1, spalte: 1, code: 'ZZ', meldung: 'Testfehler' }]));
  const [x1, x2] = await Promise.all([pool.pruefe('zz-pooltest', 'SCHLAF 50', 'g.zzpool'), pool.pruefe('zz-pooltest', 'SCHLAF 50', 'g.zzpool')]);
  pruefe('P2 gleiche Auftraege teilen einen Lauf', x1 === x2 && z().zaehler.geteilt === 1, z().zaehler);
  const gestartet0 = z().zaehler.worker_gestartet;
  let fehler = null;
  try { await pool.pruefe('zz-pooltest', 'HAENGT', 'h.zzpool'); } catch (e) { fehler = e; }
  pruefe('P3 Timeout -> SyntaxPrueferTimeout', fehler?.name === 'SyntaxPrueferTimeout', fehler?.message);
  await warte(300);
  pruefe('P3 genau EIN Ersatz-Worker (kein Doppel-Respawn)', z().zaehler.worker_gestartet === gestartet0 + 1 && z().zaehler.ausfaelle === 0 && z().beendet_exit_ausstehend === 0, z());
  pruefe('P3 danach wieder nutzbar', (await pool.pruefe('zz-pooltest', 'ok 1', 'a.zzpool')).length === 0);
  fehler = null;
  try { await pool.pruefe('zz-pooltest', 'ABSTURZ', 'a.zzpool'); } catch (e) { fehler = e; }
  await warte(200);
  pruefe('P4 Absturz -> Ablehnung, ein Ersatz', /ausgefallen/.test(fehler?.message) && z().zaehler.worker_gestartet === gestartet0 + 2 && z().zaehler.ausfaelle === 1, { f: fehler?.message, z: z().zaehler });
  pruefe('P4 Erfolg setzt Ausfaelle zurueck', (await pool.pruefe('zz-pooltest', 'ok 2', 'a.zzpool')).length === 0 && z().slots[0].ausfaelle === 0, z().slots);
  for (let i = 0; i < 4; i++) { try { await pool.pruefe('zz-pooltest', 'ABSTURZ ' + i, 'a.zzpool'); } catch { /* erwartet */ } await warte(150); }
  pruefe('P5 nach 4 Ausfaellen in Folge stillgelegt', z().slots[0].stillgelegt === true, z().slots);
  const t0 = performance.now();
  fehler = null;
  try { await pool.pruefe('zz-pooltest', 'ok 3', 'a.zzpool'); } catch (e) { fehler = e; }
  pruefe('P5 stillgelegt -> sofortige Ablehnung', fehler?.name === 'SyntaxPoolNichtVerfuegbar' && performance.now() - t0 < 20, fehler?.message);
  process.env.SYNTAX_POOL_WIEDERBELEBUNG_MS = '0';
  pruefe('P5 Wiederbelebung nach der Pause', (await pool.pruefe('zz-pooltest', 'ok 4', 'a.zzpool')).length === 0 && !z().slots[0].stillgelegt, z().slots);
  process.env.SYNTAX_POOL_WIEDERBELEBUNG_MS = '60000';
  await pool.beenden();
}
{
  process.env.SYNTAX_WORKER_MAX_MB = '128'; // muss ueber dem Aufwaerm-Bedarf aller Bibliotheken liegen
  const P = await lade('services', 'syntax-pruefer', 'pool.js');
  const pool = new P.SyntaxWorkerPool(1);
  let fehler = null;
  const t0 = performance.now();
  try { await pool.pruefe('zz-pooltest', 'SPEICHER', 'a.zzpool'); } catch (e) { fehler = e; }
  pruefe('P6 Speicherlimit -> Ausfall statt Prozess-OOM', /ausgefallen/.test(fehler?.message) && performance.now() - t0 < 5000, fehler?.message);
  await warte(200);
  pruefe('P6 Ersatz-Worker arbeitet', (await pool.pruefe('zz-pooltest', 'ok 5', 'a.zzpool')).length === 0);
  delete process.env.SYNTAX_WORKER_MAX_MB;
  await pool.beenden();
}

console.log(`\n${ok} OK, ${fehl} FEHL`);
process.exit(fehl === 0 ? 0 : 1);
