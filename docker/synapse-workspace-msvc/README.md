# synapse-workspace-msvc

Tier-2-Workspace fuer native Windows-C/C++-Cross-Builds mit
`clang-cl`/`lld-link`, echten MSVC-Headers und echten Windows-SDK-Libraries.

## Was dieser Workspace beweist

- MSVC-kompatibles ABI und PE/COFF-Ausgabe
- Kompilieren gegen native Windows-Headers, darunter Media Foundation/WASAPI
- Linken gegen die originalen Windows-SDK-Import-Libraries
- optionale, hardwarefreie Laufzeit-Smokes unter Wine

Er ersetzt keinen echten Windows-Rechner fuer Kamera, Mikrofon, Treiber,
COM-Apartment-/Timing-Verhalten, Application Verifier oder Race-Tests.

## Lizenzmodell

Das Image enthaelt **keine** Microsoft-Binaries. `msvc-wine` selbst weist
darauf hin, dass Visual Studio und die installierte Toolchain nicht
redistribuierbar sind. Der User muss die Microsoft-Lizenz lesen und die
Installation explizit starten. Die Dateien landen in `$HOME/.msvc`; das Workspace-HOME ist persistent und
projektspezifisch. Auch Download-/Entpack-Temps werden bewusst unter `$HOME`
statt im begrenzten Workspace-`/tmp` angelegt. Vor dem ersten Setup muessen dort
mindestens 12 GiB frei sein; sonst endet der Init frueh und klar mit Exit 70.

## Unraid: Images bauen

```bash
docker build -t synapse-workspace:latest docker/synapse-workspace/
docker build -t synapse-workspace-msvc:latest docker/synapse-workspace-msvc/
```

Danach den Synapse-API-Container mit der neuen Schema-Version starten. Sie
seedet die globale Rolle `windows-msvc` mit `msvc-setup --accept-license` als
automatischem Rollen-Init (30 Minuten Timeout). Keine neue Device-Freigabe, kein
`--privileged`, kein Docker-Socket und kein Windows-SDK-Host-Mount sind
erforderlich.

## Nutzung

```text
workspace(start, project:"moo", name:"msvc", role:"windows-msvc")
# Beim ersten Start: Lizenzannahme + MSVC/SDK-Download automatisch.
# Spaetere Starts: Ready-Marker, kein erneuter Download.
workspace(materialize, project:"moo")
shell(exec, project:"moo", target:"workspace", workspace:"msvc",
  command:"msvc-smoke", timeout_ms:120000)
```

Direkter Build:

```bash
msvc-run x64 clang-cl -fuse-ld=lld /nologo /W4 /WX /MT quelle.c /Feprogramm.exe
# Alternativ:
msvc-run x64 clang --target=x86_64-windows-msvc quelle.c -fuse-ld=lld -o programm.exe
```

`msvc-setup` ist idempotent. `workspace(reset_home)` entfernt bewusst auch
die heruntergeladene Microsoft-Toolchain; beim naechsten Start installiert der
Rollen-Init sie mit der vom User dauerhaft freigegebenen Lizenzannahme erneut.

## Pins

- Basis: `synapse-workspace:latest`
- LLVM/Clang/LLD: 18 aus dem bereits konfigurierten apt.llvm.org-Repository
- msvc-wine: `514f8ea34842cd6d831804d0e9658d3a32870ae1`

Beim Update des msvc-wine-Pins zuerst Docker-Build und `msvc-smoke` gegen
eine frische HOME-Installation ausfuehren.
