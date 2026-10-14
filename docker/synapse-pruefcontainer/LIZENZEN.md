# Zusätzliche Werkzeuge für P16-T16 Etappe 2

Die vorhandenen Parser und Node/TypeScript aus Etappe 1 bleiben erhalten. Diese Liste dokumentiert die neuen Werkzeuge; die bereits eingebauten Bibliotheken werden dadurch nicht umbenannt oder entfernt.

| Bestandteil | Feste Version / Herkunft | Lizenz | Lizenztext im Image |
| --- | --- | --- | --- |
| Go-Toolchain | 1.27.2 (neueste stabile, 14.10.2026); offizielles go.dev-Releasearchiv, Linux amd64/arm64 | BSD-3-Clause; weitere mitgelieferte Komponenten gemäß Originalarchiv | /opt/pruef/go/LICENSE, Originalhinweise im vollständigen Archiv |
| Pyright CLI | 1.1.414; Originalpaket von Microsoft im npm-Registry | MIT | /opt/pruef/pyright/LICENSE.txt |
| Pyright Typeshed-Fallback | Bestandteil des obigen unveränderten Pyright-Tarballs | Typeshed-Lizenz und komponentenspezifische Hinweise laut mitgelieferter LICENSE | /opt/pruef/pyright/dist/typeshed-fallback/LICENSE |

Download nur in der Builder-Stufe, SHA256 vor dem Entpacken. Keine Install-Skripte. Node wird aus Etappe 1 wiederverwendet. Die optionale macOS-Abhängigkeit fsevents wird auf Linux nicht installiert.

Prüfsummen:

- Go amd64: `ecbadb99091a3f46e31f5f934b068b1864eafa7995211b39eaddf76996045fe5` (70590635 Byte; Download am 14.10.2026 mit sha256sum -c nachgeprueft, claude-e2)
- Go arm64: `94f3e30b8e374bc285e7dadc11e0865726b9bc6e85b841ccceaabc0214c6b7c8` (67076180 Byte; aus go.dev-Metadaten)
- Pyright-Tarball: `bf5f473f6167c0d14175492c3263d783b4489a6956e1c06c18e15228e3a3fa42`

Quellen: [Go-Release-Metadaten](https://go.dev/dl/?mode=json), [Pyright-Release 1.1.414](https://github.com/microsoft/pyright/releases/tag/1.1.414), [Pyright-Paketmetadaten](https://registry.npmjs.org/pyright/1.1.414). Pyright-Download wurde zusätzlich gegen die publizierte SHA512-Integrity geprüft (Synapse-Job 746caa8d) und am 14.10.2026 erneut per SHA256 bestätigt (claude-e2).

Vorher (Vorbereitung sol-11) war Go 1.26.9 eingetragen (amd64 `42d158b4…`, arm64 `4a97373d…`, ebenfalls korrekt laut go.dev). Angehoben, weil eine neuere Toolchain ältere go.mod-Stände mitprüft, eine ältere neuere aber nur als 'teilweise' (requires go >=) melden kann.

### P16-T21: Dart und C#

Dart SDK 3.13.5 (BSD-3-Clause, mitgelieferte LICENSE/Third-Party-Hinweise) unter /opt/pruef/dart; SHA256 amd64 ea864bc64df30a6b8bdf30b2e32550f7717d9a890de8f40293aeabb924fe232b, arm64 19a731647c3ed55058ee46dde00330150e6a8729bb6121b4a31e86084c8a3e6d. Offizielles Dart-Archiv: https://storage.googleapis.com/dart-archive/channels/stable/release/3.13.5/VERSION.

.NET SDK 10.0.402 mit Roslyn (MIT und Third-Party-Hinweise des Originalarchivs) vollständig unter /opt/pruef/dotnet; SHA512 im Dockerfile aus https://dotnetcli.blob.core.windows.net/dotnet/release-metadata/10.0/releases.json. Roslyn-Helfer unter /opt/pruef/roslyn, Build ausschließlich csc, ohne MSBuild/NuGet.

Kein pub get, kein NuGet-Restore, keine Analyzer/Source-Generatoren, kein Flutter-SDK. C#-Referenzen derzeit net10.0; andere Ziele und fehlender Konfigurations-/Abhängigkeitskontext werden teilweise, F# nicht unterstützt. Selftest beim Image-Build/Deploy: python3 /opt/pruef/pruefer_dart_csharp.py; erwartet "dart+csharp probe ok".

