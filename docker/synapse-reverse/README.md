# synapse-reverse container (RV11)

This image provides static extraction and analysis tools. Original programs are data and are never launched. P20 must enforce network disabled, read-only rootfs, user 65532, cap_drop ALL, no-new-privileges, quotas, and the mount policy in thought 51ea56f7.

## Build

Run from the repository root. The base image and upstream archives are pinned in the Dockerfile; Debian packages come from the dated main snapshot.

    docker buildx build --provenance=false --load \
      -f docker/synapse-reverse/Dockerfile -t synapse-reverse:rv11 docker/synapse-reverse

`--provenance=false` makes the local image manifest digest comparable across identical rebuilds. Exact Debian package versions are recorded in `/opt/reverse/versionen-pakete.txt`; upstream versions and SHA-256 values are in `/opt/reverse/versionen.txt`. Python 3.13 is the RV26 reader runtime; it uses the standard library only, with no pip/npm or package installation at runtime.

Check the runtime boundary with:

    docker run --rm --network none --read-only --cap-drop ALL \
      --security-opt no-new-privileges synapse-reverse:rv11 --self-probe

Expected JSON reports UID 65532, blocked DNS/TCP, and an empty forbidden-tools list.

## Runner

Runner accepts one JSON request per input line, e.g. the executor format `{"kommando":"extrahieren","eingabe":"/bib/<storage_key>","ausgabe":"/arbeit/<jobId>","grenzen":{...}}`. `auftrag_id` is optional; without it the job id is the folder name of `ausgabe` (if both are given they must match). Commands include spurtabelle, extrahieren, leser_ausfuehren (the latter two kinds take `werkzeug`). Each request returns progress and a completion record `{status:"fertig", werkzeug_version, format, dauer_s, manifest:[{pfad,groesse,sha256}], ausgabe_bytes}`. Supported limits are zeitlimit_s, max_dateien, max_bytes, max_tiefe, max_kompressionsfaktor.

`extrahieren` picks the extractor from the file content only, never from the extension: ISO9660 (`CD001` at 0x8001/0x8801/0x9001), UDF (`NSR02`/`NSR03` in the volume recognition sequence), 7z, RAR, ZIP/JAR/APK, PE, CAB, OLE/MSI, gzip, bzip2, xz, tar, LHA, ARJ and CUE sheets (text with a `FILE ... BINARY` line). Anything else, e.g. a raw `.img`/`.bin` without these markers, returns `{status:"fehler", fehlercode:"nicht_unterstuetzt", manifest:[]}` without guessing. Tools run with `TMPDIR=/tmp` and `HOME=/tmp`; with a read-only rootfs P20 must mount `/tmp` as tmpfs. `python3-gi` and the libmirage GIR are installed for wave R3 but not used yet.

The output folder must be empty and unique to the job. The API must validate the manifest before atomic publication. Ghidra's post-script exports JSONL, one function per row. The runtime has no pip/npm or package installation path.
