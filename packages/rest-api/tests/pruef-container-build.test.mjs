// P16-T14 (11.10.2026): Build-/Konfig-Sprachen im Pruef-Container - make, linkerscript, meson, dockerfile, hcl,
// starlark, jsonnet (pruefer_build.py, Go-Binary pruefgo) und nix (ts_sprachen/nix.py).
// Aufruf wie pruef-container.test.mjs:
//   DATABASE_URL=postgresql://x:x@127.0.0.1:9/x node --test packages/rest-api/tests/pruef-container-build.test.mjs
// Plain node gegen den gebauten dist, ECHTES Docker, lokal gebautes Image (PRUEFCONTAINER_TEST_IMAGE, Standard
// synapse-pruefcontainer:latest). Ohne Docker/Image werden die Tests SICHTBAR uebersprungen.
// Testcontainer: synapse-pruefcontainer-buildtest. Jede Zusage "0 Befunde" hat einen Anker: derselbe Text mit einem
// eingebauten Fehler MUSS an der erwarteten Zeile gemeldet werden (regel-nullzusagen-brauchen-anker).
import test from 'node:test';
import assert from 'node:assert/strict';
import Docker from 'dockerode';
import { PruefContainer, pruefContainerConfigAusEnv, CONTAINER_SPRACHEN } from '../dist/services/pruef-container.js';

const IMAGE = process.env.PRUEFCONTAINER_TEST_IMAGE || 'synapse-pruefcontainer:latest';
const NAME = 'synapse-pruefcontainer-buildtest';
const docker = new Docker({ socketPath: process.env.WORKSPACE_DOCKER_SOCKET || '/var/run/docker.sock' });

let grund = null;
try { await docker.ping(); } catch (e) { grund = `kein Docker (${e.message})`; }
if (!grund) { try { await docker.getImage(IMAGE).inspect(); } catch { grund = `Image ${IMAGE} fehlt`; } }
if (grund) console.log(`UEBERSPRUNGEN: ${grund}`);
const opt = { skip: grund ?? false };

const pc = grund ? null : new PruefContainer(docker, {
  ...pruefContainerConfigAusEnv(), image: IMAGE, name: NAME, cacheEintraege: 0, timeoutMs: 20_000,
});
const hart = (m) => m.filter((x) => !x.weich);

/** Prueft: gueltiger Text -> 0 harte Befunde; derselbe Text mit `kaputt` VOR Zeile `zeile` -> Befund genau dort. */
async function gueltigMitAnker(sprache, text, pfad, zeile, kaputt, erwarteteZeile = zeile) {
  const g = hart(await pc.pruefe(sprache, text, pfad));
  assert.deepEqual(g, [], `${sprache}: gueltiger Text liefert ${JSON.stringify(g[0])}`);
  const z = text.split('\n');
  z.splice(zeile - 1, 0, kaputt);
  const m = hart(await pc.pruefe(sprache, z.join('\n'), pfad));
  assert.ok(m.length > 0, `${sprache}: Anker-Fehler in Z.${zeile} nicht gemeldet`);
  assert.equal(m[0].zeile, erwarteteZeile, `${sprache}: Anker-Fehler an falscher Zeile ${JSON.stringify(m[0])}`);
  return m[0];
}

test('B0 Anmeldung: Sprachen mit Endungen bzw. Dateinamen', () => {
  const s = Object.fromEntries(CONTAINER_SPRACHEN.map((x) => [x.sprache, x]));
  for (const n of ['make', 'linkerscript', 'meson', 'dockerfile', 'hcl', 'starlark', 'jsonnet', 'nix']) {
    assert.ok(s[n], `${n} fehlt in CONTAINER_SPRACHEN`);
    assert.equal(s[n].sperrfaehig, true, `${n} sperrfaehig`);
  }
  assert.deepEqual(s.make.dateinamen, ['makefile', 'gnumakefile']);
  assert.deepEqual(s.dockerfile.dateinamen, ['dockerfile', 'containerfile']);
  assert.deepEqual(s.starlark.dateinamen, ['build', 'workspace']);
  assert.deepEqual(s.meson.endungen, []);
  // .mak (nmake/Watcom) und Makefile.<x> bewusst NICHT
  assert.ok(!s.make.endungen.includes('mak'));
});

test('B1 make: gueltig + Anker, $(shell) wird NICHT ausgefuehrt, $(error)/include zaehlen nicht', opt, async () => {
  const mk = [
    'CC ?= gcc',
    'SRC := $(wildcard src/*.c)',
    'OBJ = $(SRC:.c=.o)',
    'define REZEPT',
    '\t@echo $(1)',
    'endef',
    'ifeq ($(OS),Windows_NT)',
    '  EXE := .exe',
    'else ifdef DEBUG',
    '  CFLAGS += -g',
    'endif',
    '-include fehlt.mk',
    '%.o: %.c',
    '\t$(CC) -c $< -o $@',
    'all: $(OBJ) ; @true',
    '.PHONY: all',
    '',
  ].join('\n');
  // Rezeptzeile mit Leerzeichen statt TAB hinter einer Regel -> missing separator in genau dieser Zeile.
  const m = await gueltigMitAnker('make', mk, 'Makefile', 15, '    $(CC) -o prog $(OBJ)');
  assert.match(m.meldung, /missing separator/);
  // Waere $(shell) ausgefuehrt worden, liefe der ifeq-Zweig und die Zeile 'x y z' waere ein Syntaxfehler.
  const shell = 'ifeq ($(shell echo ja),ja)\nx y z\nendif\nall: ; @true\n';
  assert.deepEqual(hart(await pc.pruefe('make', shell, 'Makefile')), [], '$(shell) wurde ausgefuehrt');
  const kontrolle = hart(await pc.pruefe('make', shell.replace('$(shell echo ja)', 'ja'), 'Makefile'));
  assert.equal(kontrolle[0]?.zeile, 2, 'Kontrolle: ohne $(shell) muss Z.2 gemeldet werden');
  const fehler = 'ifndef PFLICHT\n$(error PFLICHT fehlt)\nendif\ninclude gibt-es-nicht.mk\nall: ; @true\n';
  assert.deepEqual(hart(await pc.pruefe('make', fehler, 'Makefile')), []);
  const endif = hart(await pc.pruefe('make', 'ifeq (a,a)\nX = 1\nall: ; @true\n', 'GNUmakefile'));
  assert.match(endif[0]?.meldung ?? '', /missing 'endif'/);
});

test('B2 linkerscript: fremde Architektur ist kein Fehler, Fehler am Ende -> letzte Zeile, Vorlagen ausgelassen', opt, async () => {
  const ld = [
    'OUTPUT_FORMAT("elf32-littleriscv", "elf32-littleriscv",',
    '              "elf32-littleriscv")',
    'OUTPUT_ARCH(riscv)',
    'ENTRY(_start)',
    'MEMORY { FLASH (rx) : ORIGIN = 0x20000000, LENGTH = 512K }',
    '_STACK = 0x1000;',
    'SECTIONS',
    '{',
    '  .text : { KEEP(*(.init)) *(.text*) } > FLASH',
    '  PROVIDE(__global_pointer$ = . + 0x800);',
    '  /DISCARD/ : { *(.comment) }',
    '}',
    '',
  ].join('\n');
  await gueltigMitAnker('linkerscript', ld, 'link.ld', 9, '  .data : : { }');
  const offen = hart(await pc.pruefe('linkerscript', 'SECTIONS\n{\n  .text : { *(.text) }\n', 'a.ld'));
  assert.equal(offen[0]?.zeile, 3, JSON.stringify(offen));
  assert.deepEqual(hart(await pc.pruefe('linkerscript', '#include "x.h"\nSECTIONS { ( }\n', 'a.lds')), []);
});

test('B3 meson: gueltig + Anker', opt, async () => {
  const meson = [
    "project('x', ['c', 'cpp'], version : '1.0', default_options : ['warning_level=3'])",
    "deps = [dependency('zlib', required : get_option('zlib'))]",
    'if host_machine.system() == \'linux\'',
    "  deps += dependency('threads')",
    'endif',
    "foreach n : ['a', 'b']",
    "  executable(n, n + '.c', dependencies : deps)",
    'endforeach',
    "x = {'k': 1}.get('k', 0) > 0 ? 'ja' : 'nein'",
    '',
  ].join('\n');
  // Eine offene Klammer meldet der Meson-Parser an der FOLGENDEN Anweisung (hier foreach in Z.7).
  await gueltigMitAnker('meson', meson, 'meson.build', 6, "message('offen'", 7);
  await gueltigMitAnker('meson', meson, 'meson.build', 6, 'x = = 1');
});

test('B4 dockerfile: Heredoc, ARG vor FROM, syntax-Direktive + Anker', opt, async () => {
  const df = [
    '# syntax=docker/dockerfile:1.7',
    'ARG BASIS=debian:trixie-slim',
    'FROM ${BASIS} AS bau',
    'RUN --mount=type=cache,target=/var/cache/apt <<EOF',
    'apt-get update',
    'apt-get install -y make',
    'EOF',
    'COPY --chmod=0755 --from=bau /a /b',
    'HEALTHCHECK --interval=30s CMD ["true"]',
    'ENTRYPOINT ["/b"]',
    '',
  ].join('\n');
  const m = await gueltigMitAnker('dockerfile', df, 'Dockerfile', 8, 'RUNN make');
  assert.match(m.meldung, /unknown instruction/i);
  assert.deepEqual(hart(await pc.pruefe('dockerfile', df.replace(/\n/g, '\r\n'), 'x/Containerfile')), [], 'CRLF');
});

test('B5 hcl: Terraform mit for, Templates, Heredoc + Anker', opt, async () => {
  const tf = [
    'variable "namen" { type = list(string) }',
    'locals {',
    '  m = { for n in var.namen : n => upper(n) if n != "" }',
    '  t = "%{ for n in var.namen }${n},%{ endfor }"',
    '}',
    'resource "x" "y" {',
    '  count = length(var.namen)',
    '  text  = <<-EOT',
    '    hallo ${var.namen[count.index]}',
    '    EOT',
    '  dynamic "b" {',
    '    for_each = local.m',
    '    content { v = b.value }',
    '  }',
    '}',
    '',
  ].join('\n');
  await gueltigMitAnker('hcl', tf, 'main.tf', 7, '  a = = 1');
});

test('B6 starlark: BUILD und .bzl + Anker', opt, async () => {
  const build = [
    'load("@rules_cc//cc:defs.bzl", "cc_library")',
    'cc_library(',
    '    name = "a",',
    '    srcs = glob(["*.c"], exclude = ["t_*.c"]),',
    '    deps = [":" + n for n in ["b", "c"] if n],',
    ')',
    '',
  ].join('\n');
  await gueltigMitAnker('starlark', build, 'pkg/BUILD', 2, 'x = = 1');
  // Einzeiliger Block mit mehreren Argumenten ist in HCL ungueltig (echte Meldung von hclsyntax).
  const einzeilig = hart(await pc.pruefe('hcl', 'a "b" { x = 1  y = 2 }\n', 'x.hcl'));
  assert.equal(einzeilig[0]?.zeile, 1, JSON.stringify(einzeilig));
  const bzl = 'def _impl(ctx):\n    return [DefaultInfo(files = depset(ctx.files.srcs))]\n\nregel = rule(implementation = _impl, attrs = {"srcs": attr.label_list()})\n';
  await gueltigMitAnker('starlark', bzl, 'regel.bzl', 3, 'def kaputt(:');
});

test('B7 jsonnet: Comprehension, Textblock + Anker', opt, async () => {
  const js = [
    'local f(x, y=2) = x + y;',
    '{',
    '  a: f(1),',
    '  b:: [i * 2 for i in std.range(1, 3) if i > 1],',
    '  c+: { d: self.a },',
    '} + { [k]: k for k in ["x", "y"] } + {',
    '  t: |||',
    '    Textblock',
    '  |||,',
    '}',
    '',
  ].join('\n');
  await gueltigMitAnker('jsonnet', js, 'a.jsonnet', 4, '  c: 1 d: 2,');
});

test('B8 nix: tree-sitter-nix + Anker', opt, async () => {
  const nix = [
    '{ lib, stdenv, fetchurl, ... }@args:',
    'let v = "1.0"; in',
    'stdenv.mkDerivation rec {',
    '  pname = "x";',
    '  version = v;',
    '  src = fetchurl { url = "https://e/${pname}-${version}.tgz"; hash = lib.fakeHash; };',
    "  postInstall = ''\n    echo ''${out}\n  '';",
    '  meta = with lib; { license = licenses.mit; platforms = platforms.unix; };',
    '}',
    '',
  ].join('\n');
  await gueltigMitAnker('nix', nix, 'default.nix', 4, '  a = 1 b = 2;');
});

test('B9 Aufraeumen', opt, async () => {
  await pc.beenden();
});
