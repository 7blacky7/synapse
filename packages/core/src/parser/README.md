# Parser

[Synapse](../../../../README.md) › [Core](../../README.md) › [Quellcode](../README.md) › Parser

## Zweck

Der Parser-Ordner ordnet Textdateien anhand von Endung, bekannten Dateinamen und bei endungslosen Dateien optional anhand ihres Inhalts einem Sprachparser zu. Die Parser liefern Symbole und Referenzen; unterstützte Parser können zusätzlich Statements und Aufrufkanten für die Ablaufanalyse erzeugen. Binärdateien gehören zur getrennten [Asset-Intel](../asset-intel/README.md)-Pipeline.

## Inhalt

| Datei / Unterordner | Aufgabe |
|---|---|
| [`index.ts`](index.ts) | Registriert die Sprachparser und stellt Erkennung, unterstützte Endungen, Parser-Versionen sowie Ablaufebenen-Metadaten bereit. |
| [`types.ts`](types.ts) | Definiert gemeinsame Parser-Ergebnisse, Symbole, Referenzen, Statements, Aufrufkanten und Hilfen für Zeilenpositionen. |
| [`worker-pool.ts`](worker-pool.ts) | Stellt den Parser-Worker-Pool für begrenzte, parallele Parse-Aufträge bereit. |
| [`worker-runner.ts`](worker-runner.ts) | Führt Parser-Aufträge in Worker-Threads aus und übermittelt Ergebnisse an den Pool. |
| [`patterns/`](patterns/README.md) | Enthält wiederverwendbare Muster für sprachübergreifende HTTP- und SQL-Erkennung. |
| [`__testdata__/`](__testdata__/README.md) | Vorgesehene Übersicht der Parser-Testdaten; der Inhalt ist derzeit nicht im Code-Index verfügbar. |

### Sprachparser

| Gruppe | Dateien |
|---|---|
| C-Familie und Systemsprachen | [asm.ts](asm.ts), [c.ts](c.ts), [cpp.ts](cpp.ts), [dlang.ts](dlang.ts), [fortran.ts](fortran.ts), [linker.ts](linker.ts), [llvmir.ts](llvmir.ts), [objc.ts](objc.ts), [vala.ts](vala.ts) |
| JVM und verwandte Sprachen | [clojure.ts](clojure.ts), [groovy.ts](groovy.ts), [java.ts](java.ts), [kotlin.ts](kotlin.ts), [scala.ts](scala.ts) |
| Weitere Programmiersprachen | [ada.ts](ada.ts), [cobol.ts](cobol.ts), [crystal.ts](crystal.ts), [csharp.ts](csharp.ts), [dart.ts](dart.ts), [elixir.ts](elixir.ts), [erlang.ts](erlang.ts), [fsharp.ts](fsharp.ts), [glsl.ts](glsl.ts), [go.ts](go.ts), [haskell.ts](haskell.ts), [julia.ts](julia.ts), [lean.ts](lean.ts), [lua.ts](lua.ts), [moo.ts](moo.ts), [nim.ts](nim.ts), [ocaml.ts](ocaml.ts), [perl.ts](perl.ts), [php.ts](php.ts), [powershell.ts](powershell.ts), [python.ts](python.ts), [r.ts](r.ts), [racket.ts](racket.ts), [ruby.ts](ruby.ts), [rust.ts](rust.ts), [solidity.ts](solidity.ts), [swift.ts](swift.ts), [tcl.ts](tcl.ts), [vlang.ts](vlang.ts), [zig.ts](zig.ts) |
| Web, Markup und Styles | [css.ts](css.ts), [html.ts](html.ts), [markdown.ts](markdown.ts), [svelte.ts](svelte.ts), [typescript.ts](typescript.ts), [vue.ts](vue.ts) |
| Konfiguration, Build und Abfragesprachen | [cmake.ts](cmake.ts), [dhall.ts](dhall.ts), [dockerfile.ts](dockerfile.ts), [graphql.ts](graphql.ts), [hcl.ts](hcl.ts), [jsonnet.ts](jsonnet.ts), [makefile.ts](makefile.ts), [meson.ts](meson.ts), [nix.ts](nix.ts), [protobuf.ts](protobuf.ts), [puppet.ts](puppet.ts), [shell.ts](shell.ts), [smithy.ts](smithy.ts), [sql.ts](sql.ts), [starlark.ts](starlark.ts), [toml.ts](toml.ts), [wgsl.ts](wgsl.ts), [yaml.ts](yaml.ts) |

## Schnittstellen nach außen

Die zentrale Auswahl erfolgt über getParserForFile aus [index.ts](index.ts). Aufrufer erhalten einen LanguageParser oder null; die Schnittstelle ist damit zugleich die Grenze zwischen Textparsern und der separaten Asset-Erkennung. Die Typen in [types.ts](types.ts) bilden die Ergebnisse für Symbole, Referenzen und optionale Ablaufdaten ab. Worker-Pool und Runner kapseln die Ausführung vom aufrufenden Prozess.

## Abhängigkeiten

Die Sprachmodule implementieren das gemeinsame LanguageParser-Modell aus [types.ts](types.ts). [index.ts](index.ts) bindet sie in einer gemeinsamen Registry zusammen. Der übergeordnete Core-Quellcode verwendet diese Registry für die Code-Analyse; Binärformate werden über [Asset-Intel](../asset-intel/README.md) verarbeitet.

## Siehe auch

- [Core-Quellcode](../README.md)
- [Asset-Intel](../asset-intel/README.md)
- [Core-Paket](../../README.md)
- [Zusammenhang und Betriebsvarianten](../../../../docs/README.md)
