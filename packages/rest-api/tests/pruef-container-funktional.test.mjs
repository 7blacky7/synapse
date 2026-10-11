// P16-T12 (11.10.2026): funktionale Sprachen im Pruef-Container ueber tree-sitter (ts_sprachen/haskell.py, ocaml.py,
// ocaml_interface.py, elixir.py, erlang.py, clojure.py, racket.py, r.py).
// Aufruf mit unerreichbarer DB (wie pruef-container.test.mjs):
//   DATABASE_URL=postgresql://x:x@127.0.0.1:9/x node --test packages/rest-api/tests/pruef-container-funktional.test.mjs
// Plain node gegen den gebauten dist (rest-api + core), ECHTES Docker und das lokal gebaute Image
// (PRUEFCONTAINER_TEST_IMAGE, Standard synapse-pruefcontainer:latest). Ohne Docker/Image SICHTBAR uebersprungen.
// Optional PRUEFCONTAINER_ALT_IMAGE=<Image ohne diese Module>: F0 prueft dann, dass der alte Container die Sprachen
// NICHT kennt (Positivkontrolle muss am alten Stand rot sein).
// Testcontainer heissen synapse-pruefcontainer-fn*, ein laufender Produktions-/Dev-Container bleibt unberuehrt.
import test from 'node:test';
import assert from 'node:assert/strict';
import Docker from 'dockerode';
import * as core from '@synapse/core';
import {
  PruefContainer,
  pruefContainerConfigAusEnv,
  registriereContainerSyntaxPruefer,
  beendePruefContainer,
} from '../dist/services/pruef-container.js';
import { TREESITTER_SPRACHEN } from '../dist/services/pruef-container-treesitter.js';

const IMAGE = process.env.PRUEFCONTAINER_TEST_IMAGE || 'synapse-pruefcontainer:latest';
const NAME = 'synapse-pruefcontainer-fn';
const docker = new Docker({ socketPath: process.env.WORKSPACE_DOCKER_SOCKET || '/var/run/docker.sock' });

let grund = null;
try { await docker.ping(); } catch (e) { grund = `kein Docker (${e.message})`; }
if (!grund) { try { await docker.getImage(IMAGE).inspect(); } catch { grund = `Image ${IMAGE} fehlt`; } }
if (grund) console.log(`UEBERSPRUNGEN: ${grund}`);
const opt = { skip: grund ?? false };

function cfg(extra = {}) {
  return { ...pruefContainerConfigAusEnv(), image: IMAGE, name: NAME, ...extra };
}

const SPRACHEN = ['haskell', 'ocaml', 'ocaml_interface', 'elixir', 'erlang', 'clojure', 'racket', 'r'];

// ─── Faelle: [sprache, pfad, kaputt, Fehlerzeile, gueltig (moderne Syntax), angehaengte Fehlerzeile fuer den Anker] ───
const FAELLE = [
  ['haskell', 'src/M.hs', 'module M where\n\nf :: Int -> Int\nf x = case x of\n  1 -> )\n  _ -> 0\n', 5,
    '{-# LANGUAGE LambdaCase, TypeApplications #-}\nmodule M (f) where\n\nimport qualified Data.Map as Map\n\n'
    + 'data T a = T { unT :: a } deriving (Show, Eq)\n\nf :: Maybe Int -> Int\nf = \\case\n  Just x | x > 0 -> x\n  _ -> 0\n\n'
    + 'main :: IO ()\nmain = do\n  let m = Map.fromList [(1 :: Int, "a")]\n  print (Map.lookup 1 m)\n', 'kaputt = )'],
  ['ocaml', 'lib/a.ml', 'let a = 1\nlet b = a + )\nlet c = 2\n', 2,
    'module M = struct\n  type t = { a : int; b : string }\n  let x = { a = 1; b = "x" }\nend\n'
    + 'let g ?(o = 1) ~l x = o + l + x\nlet () = match M.x with { a; _ } when a > 0 -> print_int a | _ -> ()\n'
    + 'let%ext h = [%e 1]\n', 'let kaputt = 1 + )'],
  ['ocaml_interface', 'lib/a.mli', 'type t\nval f : int -> )\nval g : t\n', 2,
    'type t\nval f : ?o:int -> l:int -> int -> int\nmodule type S = sig\n  val x : t\nend\nexternal g : int -> int = "c_g"\n',
    'val kaputt : int -> )'],
  ['elixir', 'lib/m.ex', 'defmodule M do\n  def f(x) do\n    x + )\n  end\nend\n', 3,
    'defmodule M do\n  def f(%{a: a} = m, [h | _]) when is_integer(a), do: {m, h}\n\n  def g(l) do\n'
    + '    l |> Enum.map(&(&1 * 2)) |> then(fn l -> for i <- l, into: %{}, do: {i, ~s(a)} end)\n  end\nend\n',
    'kaputt = 1 + )'],
  ['erlang', 'src/m.erl', '-module(m).\n-export([f/1]).\nf(X) ->\n    X + ).\n', 4,
    '-module(m).\n-export([f/1]).\n-record(r, {a = 1 :: integer()}).\n-spec f(term()) -> term().\n'
    + 'f(#{k := V} = M) when is_map(M) -> V;\nf(L) -> [X || X <- L, X > 0].\n', 'kaputt() -> 1 + ).'],
  ['clojure', 'src/a.clj', '(ns a)\n(defn f [x]\n  (+ x 1)))\n', 3,
    '(ns a.b (:require [clojure.string :as str]))\n(defn f [{:keys [a b]} & xs]\n'
    + '  [(str/join "," [a b]) #?(:clj 1 :cljs 2) @(atom 1) ^:private \'x #"re\\d" #(+ % 1) xs #{1 2} {:k \\a}])\n',
    '(def kaputt 1))'],
  ['racket', 'a.rkt', '#lang racket/base\n(define (f x)\n  (+ x 1)))\n', 3,
    '#lang racket/base\n(define (f x #:k [k 1]) (+ x k))\n#;(ignored)\n#| block |#\n'
    + '(list #\\a #t \'sym `(q ,(f 1)) #rx"a+" #hash((1 . 2)) #(1 2))\n', '(define kaputt 1))'],
  ['r', 'R/a.R', 'x <- 1\ny <- x + )\n', 2,
    'f <- function(x, ...) {\n  y <- x |> sqrt()\n  g <- \\(z) z + 1\n  if (y > 1) g(y) else NULL\n}\n'
    + 'df$a[df$b == "x"] <- 1L\n`my var` <- r"(raw)"\n', 'kaputt <- 1 + )'],
];

/** Prueft und liefert nur harte Meldungen (weich = Hinweis). */
async function hart(pc, sprache, inhalt, pfad) {
  return (await pc.pruefe(sprache, inhalt, pfad)).filter((m) => !m.weich);
}

test('F0 alter Stand: fuer die funktionalen Endungen gibt es keinen Pruefer (Positivkontrolle muss rot sein)', opt, async () => {
  const fp = await import('../../core/dist/services/fehlermuster-pruefung.js');
  fp._syntaxPrueferLeeren();
  for (const p of ['a.hs', 'a.ml', 'a.mli', 'a.ex', 'a.exs', 'a.erl', 'a.hrl', 'a.clj', 'a.edn', 'a.rkt', 'a.R']) {
    assert.equal(core.hatSyntaxPruefer(p), false, p);
  }
  const r = await core.pruefeSyntaxEinzelweg({ filePath: 'src/M.hs', alt: '', neu: FAELLE[0][2] });
  assert.equal(r.status, 'keine_pruefer');
  const alt = process.env.PRUEFCONTAINER_ALT_IMAGE;
  if (alt) {
    const pc = new PruefContainer(docker, cfg({ image: alt, name: NAME + '-alt', cacheEintraege: 0 }));
    try {
      await assert.rejects(pc.pruefe('haskell', FAELLE[0][2], 'a.hs'), /keine Pruefung fuer Sprache/);
    } finally {
      await pc.beenden();
    }
  } else {
    console.log('  PRUEFCONTAINER_ALT_IMAGE nicht gesetzt - alter Container nicht geprueft');
  }
});

test('F1 Module im Image: sperrend, Endungen wie in der API-Liste', opt, async () => {
  const pc = new PruefContainer(docker, cfg({ name: NAME + '-info', cacheEintraege: 0 }));
  try {
    await pc.pruefe('r', 'x <- 1\n', 'a.R');
    const ts = pc.werkzeugInfo()?.treesitter;
    assert.ok(ts, 'info.treesitter vorhanden');
    assert.deepEqual(ts.fehler, [], 'kein Sprachmodul mit Ladefehler');
    for (const s of SPRACHEN) {
      const m = ts.sprachen[s];
      assert.ok(m, `Modul ts_sprachen/${s}.py fehlt im Image`);
      assert.equal(m.modus, 'sperrend', s);
      const api = TREESITTER_SPRACHEN.find((t) => t.sprache === s);
      assert.ok(api && api.sperrfaehig, `${s} in pruef-container-treesitter.ts sperrfaehig`);
      assert.deepEqual([...api.endungen].sort(), [...m.endungen].sort(), `${s}: Endungen`);
    }
  } finally {
    await pc.beenden();
  }
});

test('F2 Fehler mit Zeile und Spalte je Sprache, sperrend; gueltige moderne Syntax ohne Befund (mit Anker)', opt, async () => {
  const pc = new PruefContainer(docker, cfg({ name: NAME + '-faelle', cacheEintraege: 0 }));
  try {
    for (const [sprache, pfad, kaputt, zeile, gueltig, fehlerzeile] of FAELLE) {
      const m = await hart(pc, sprache, kaputt, pfad);
      assert.ok(m.length >= 1, `${sprache}: kaputt erkannt`);
      assert.equal(m[0].zeile, zeile, `${sprache}: Zeile ${JSON.stringify(m[0])}`);
      assert.ok(Number.isInteger(m[0].spalte) && m[0].spalte >= 1, `${sprache}: Spalte`);
      assert.match(m[0].code, /^ts-(error|missing)$/);
      // Anker gegen den DATEITEXT: an der gemeldeten Zeile steht der eingebaute Fehler.
      assert.match(kaputt.split('\n')[zeile - 1], /\)/, `${sprache}: Fehlerzeile`);
      // Nullzusage mit Anker: gueltig ohne Befund, dieselbe Datei mit angehaengter Fehlerzeile wird genau dort gemeldet.
      assert.deepEqual(await pc.pruefe(sprache, gueltig, pfad), [], `${sprache}: gueltig`);
      const mitFehler = gueltig.replace(/\n?$/, '\n') + fehlerzeile + '\n';
      const ankerZeile = mitFehler.split('\n').length - 1;
      const a = await hart(pc, sprache, mitFehler, pfad);
      assert.ok(a.length >= 1 && a[0].zeile === ankerZeile, `${sprache}: Anker Z.${ankerZeile} ${JSON.stringify(a[0])}`);
    }
  } finally {
    await pc.beenden();
  }
});

test('F3 Erlang: Befund in Makro-Argumenten nur weich, derselbe Fehler als Funktionsaufruf hart', opt, async () => {
  const pc = new PruefContainer(docker, cfg({ name: NAME + '-erlang', cacheEintraege: 0 }));
  try {
    // ?assertMatch(Muster when Guard, Ausdruck): in Makro-Argumenten ist ein Guard gueltig (Makro-Expansion),
    // tree-sitter sieht nur einen Aufruf. Die Fehlerzeile 4 selbst enthaelt kein '?' -> greift die Argument-Regel.
    const makro = '-module(m).\nt() ->\n    ?assertMatch(\n        {ok, X} when X > 0; X < 9,\n        f()).\n';
    const m = await pc.pruefe('erlang', makro, 'test/m_SUITE.erl');
    assert.ok(m.length >= 1, 'tree-sitter sieht die Stelle');
    assert.ok(m.every((x) => x.weich), JSON.stringify(m));
    assert.match(m[0].meldung, /Makro/);
    // Anker: ohne Makro (normaler Funktionsaufruf) ist ein Guard im Argument ein harter Fehler (Zeile 4).
    const h = await hart(pc, 'erlang', '-module(m).\nt() ->\n    X = 1,\n    assert_match({ok, X} when X > 0; X < 9, f()).\n', 'test/m_SUITE.erl');
    assert.equal(h[0]?.zeile, 4, JSON.stringify(h));
    // Makro in der Fehlerzeile: weich (Zeilenregel).
    const z = await pc.pruefe('erlang', '-module(m).\nf() -> ?LOG(info \"x\").\n', 'src/m.erl');
    assert.ok(z.length >= 1, 'tree-sitter sieht die Makro-Zeile');
    assert.ok(z.every((x) => x.weich), JSON.stringify(z));
  } finally {
    await pc.beenden();
  }
});

test('F4 Racket: #lang mit eigenem Reader (at-exp) wird nicht geprueft, derselbe Text als racket/base schon', opt, async () => {
  const pc = new PruefContainer(docker, cfg({ name: NAME + '-racket', cacheEintraege: 0 }));
  try {
    const rumpf = '(define (f x) @list{Text @x ende})\n(define y @string-append{a|b})\n';
    assert.deepEqual(await pc.pruefe('racket', '#lang at-exp racket/base\n' + rumpf, 'doc.rkt'), []);
    assert.deepEqual(await pc.pruefe('racket', '#reader(lib "x.rkt")\n' + rumpf, 'doc.rkt'), []);
    // Anker: mit #lang racket/base ist das '|' ein offenes Symbol -> harter Befund in Zeile 3.
    const h = await hart(pc, 'racket', '#lang racket/base\n' + rumpf, 'doc.rkt');
    assert.equal(h[0]?.zeile, 3, JSON.stringify(h));
  } finally {
    await pc.beenden();
  }
});

test('F5 OCaml: Datei mit Primitiv-Alias (trunk) nur weich, ohne Alias derselbe Fehler hart', opt, async () => {
  const pc = new PruefContainer(docker, cfg({ name: NAME + '-ocaml', cacheEintraege: 0 }));
  try {
    const m = await pc.pruefe('ocaml', 'external identity = id\nlet x = 1 +\n', 'a.ml');
    assert.ok(m.length >= 1 && m.every((x) => x.weich), JSON.stringify(m));
    assert.match(m[0].meldung, /Primitiv-Alias/);
    const h = await hart(pc, 'ocaml', 'let identity x = x\nlet x = 1 +\n', 'a.ml');
    assert.equal(h[0]?.zeile, 2, JSON.stringify(h));
    // Ein normales external mit String ist KEIN Alias: gueltig ohne Befund.
    assert.deepEqual(await pc.pruefe('ocaml', 'external g : int -> int = "c_g"\nlet x = g 1\n', 'a.ml'), []);
  } finally {
    await pc.beenden();
  }
});

test('F6 Anmeldung: alle acht Sprachen sperren im Einzelweg, gueltige Dateien ohne Befund', opt, async () => {
  process.env.FEHLERPRUEFUNG_BUDGET_MS = '20000'; // deterministisch: Kaltstart abwarten
  try {
    const namen = await registriereContainerSyntaxPruefer({ cfg: cfg({ name: NAME + '-reg' }), takt: false, vorwaermen: false });
    for (const s of SPRACHEN) assert.ok(namen.includes(s), s);
    for (const [sprache, pfad, kaputt, zeile, gueltig] of FAELLE) {
      const r = await core.pruefeSyntaxEinzelweg({ filePath: pfad, alt: '', neu: kaputt });
      assert.equal(r.status, 'fertig', `${sprache}: ${JSON.stringify(r)}`);
      assert.equal(r.blockierend.length, 1, `${sprache}: ${JSON.stringify(r)}`);
      assert.equal(r.blockierend[0].zeilen[0], zeile, sprache);
      assert.match(r.blockierend[0].pruefer, new RegExp(`^syntax:${sprache}@tree-sitter-`));
      const g = await core.pruefeSyntaxEinzelweg({ filePath: pfad, alt: '', neu: gueltig });
      assert.deepEqual([g.blockierend.length, g.hinweise.length], [0, 0], `${sprache}: ${JSON.stringify(g)}`);
    }
    // Grossschreibung der Endung (.R) und Dateiname mit Punkt vorne (.Rprofile) landen beim R-Pruefer.
    assert.equal(core.hatSyntaxPruefer('pkg/R/zz.R'), true);
    assert.equal(core.hatSyntaxPruefer('.Rprofile'), true);
  } finally {
    await beendePruefContainer();
  }
});

test('F8 Fehlerort letztes_kind: Haskell-Fehler hinter den Importen wird an SEINER Zeile gemeldet, nicht beim import', opt, async () => {
  const pc = new PruefContainer(docker, cfg({ name: NAME + '-ort', cacheEintraege: 0 }));
  try {
    // Vor fehlerort 'letztes_kind' (Standard 'start') kam hier Z.2 (import) - der Befund lag damit nicht in der
    // geaenderten Zeile und haette im Einzelweg nicht gesperrt.
    const inhalt = 'module M where\nimport Data.List (sort)\n\nf :: [Int] -> [Int]\nf = sort\n\ng = (1 +\n';
    const m = await hart(pc, 'haskell', inhalt, 'src/M.hs');
    assert.ok(m.length >= 1, 'erkannt');
    assert.ok(m[0].zeile >= 7, JSON.stringify(m[0]));
    assert.match(inhalt.split('\n')[6], /\(1 \+/);
  } finally {
    await pc.beenden();
  }
});

test('F7 Latenz warm (ohne Cache) im 30-ms-Budget', opt, async () => {
  const pc = new PruefContainer(docker, cfg({ name: NAME + '-lat', cacheEintraege: 0 }));
  try {
    for (const [sprache, pfad, , , gueltig] of FAELLE) {
      // ca. 30-fache gueltige Datei (Haskell: Modulkopf nur einmal).
      const kopfweg = sprache === 'haskell' ? gueltig.split('\n').slice(4).join('\n') : gueltig;
      const inhalt = sprache === 'haskell'
        ? gueltig + Array.from({ length: 30 }, (_, i) => kopfweg.replace(/\b(T|unT|f|main|m)\b/g, (w) => w + i)).join('\n')
        : sprache === 'racket' ? gueltig + Array.from({ length: 30 }, () => gueltig.split('\n').slice(1).join('\n')).join('\n')
          : sprache === 'erlang' ? gueltig + Array.from({ length: 30 }, (_, i) => `g${i}(X) -> [Y || Y <- X, Y > ${i}].`).join('\n') + '\n'
            : Array.from({ length: 30 }, () => gueltig).join('\n');
      assert.deepEqual(await hart(pc, sprache, inhalt, pfad), [], `${sprache}: Lastdatei gueltig`);
      const zeiten = [];
      for (let i = 0; i < 30; i++) {
        const t = performance.now();
        await pc.pruefe(sprache, inhalt + '\n'.repeat(i + 1), pfad);
        zeiten.push(performance.now() - t);
      }
      zeiten.sort((a, b) => a - b);
      const p = (q) => zeiten[Math.min(zeiten.length - 1, Math.floor(zeiten.length * q))];
      console.log(`  warm ${sprache} (${inhalt.split('\n').length} Zeilen): p50 ${p(0.5).toFixed(1)} ms, p95 ${p(0.95).toFixed(1)} ms`);
      assert.ok(p(0.5) < 30, `${sprache}: p50 ${p(0.5)} ms im 30-ms-Budget`);
    }
  } finally {
    await pc.beenden();
  }
});
