# Tree-sitter-Sprachmodule

[Synapse](../../../README.md) › [Docker-Umgebung](../../README.md) › [Syntax-Prüfcontainer](../README.md) › Tree-sitter-Sprachmodule

## Zweck

Jedes Modul beschreibt eine Sprache für den Tree-sitter-Prüfer: Dateiendungen, Grammatikname, Prüfmodus und gültige beziehungsweise fehlerhafte Probe. Diese Beschreibungen steuern, welche Grammatiken der Image-Build vorbereitet und wie die Module geprüft werden. Ein vorhandenes Modul bedeutet nicht automatisch, dass die Sprache produktiv aktiviert ist; der Modus ist Teil der jeweiligen Definition.

## Inhalt

| Datei | Sprache / Aufgabe |
|---|---|
| [ada.py](ada.py) | Ada-Modul. |
| [c.py](c.py) | C-Modul; legt den Prüfmodus und die Proben fest. |
| [clojure.py](clojure.py) | Clojure-Modul. |
| [cpp.py](cpp.py) | C++-Modul. |
| [csharp.py](csharp.py) | C#-Modul. |
| [dart.py](dart.py) | Dart-Modul. |
| [elixir.py](elixir.py) | Elixir-Modul. |
| [erlang.py](erlang.py) | Erlang-Modul. |
| [haskell.py](haskell.py) | Haskell-Modul. |
| [nix.py](nix.py) | Nix-Modul. |
| [objc.py](objc.py) | Objective-C-Modul. |
| [ocaml.py](ocaml.py) | OCaml-Modul. |
| [ocaml_interface.py](ocaml_interface.py) | OCaml-Interface-Modul. |
| [perl.py](perl.py) | Perl-Modul. |
| [r.py](r.py) | R-Modul. |
| [racket.py](racket.py) | Racket-Modul. |
| [swift.py](swift.py) | Swift-Modul. |
| [zig.py](zig.py) | Zig-Modul. |
| [__init__.py](__init__.py) | Macht den Ordner als Python-Modul importierbar. |

## Schnittstellen nach außen

Die Module stellen ihre Sprachmetadaten über die Variable `SPRACHE` bereit. [ts_holen.py](../ts_holen.py) und [pruefer_treesitter.py](../pruefer_treesitter.py) verwenden diese Angaben im Build und bei Prüfungen. Der Prüfserver ist der übergeordnete Integrationspunkt.

## Abhängigkeiten

Die Sprachmodule werden vom Python-Prüfcode im [Syntax-Prüfcontainer](../README.md) geladen. Die verfügbaren Grammatikbibliotheken kommen aus tree-sitter-language-pack; der Image-Build überführt die benötigten Grammatiken in Laufzeitdateien.

## Siehe auch

- [Syntax-Prüfcontainer](../README.md)
- [Tree-sitter-Prüfer](../pruefer_treesitter.py)
- [Grammatik-Download](../ts_holen.py)
- [Zusammenhang und Betriebsvarianten](../../../docs/README.md)
