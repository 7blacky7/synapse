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

`extrahieren` picks the extractor from the file content only, never from the extension: ISO9660 (`CD001` at 0x8001/0x8801/0x9001), UDF (`NSR02`/`NSR03` in the volume recognition sequence), 7z, RAR, ZIP/JAR/APK, PE, CAB, OLE/MSI, gzip, bzip2, xz, tar, LHA, ARJ and CUE sheets (text with a `FILE ... BINARY` line). Anything else, e.g. a raw `.img`/`.bin` without these markers, returns `{status:"fehler", fehlercode:"nicht_unterstuetzt", manifest:[]}` without guessing. Tools run with `TMPDIR=/tmp` and `HOME=/tmp`; with a read-only rootfs P20 must mount `/tmp` as tmpfs.

## Disc images (P18-T49/RV34)

Disc images use one shared model: every image parser returns only the *Spurtabelle* (versioned JSON, `disc.py`, mirrored by `ReverseSpurtabelle` in `packages/core/src/services/reverse-spurtabelle.ts`); one shared extractor does the rest. The parser registry (`disc.py`, `REGISTRY`, `REGISTRY_VERSION`) detects the format by content/footer and companion files (CUE, CloneCD `[CloneCD]`, MDS/MDX, B6T, NRG, CDI, cdrdao TOC, C2D, CIF, raw 2352 sectors) and picks the first available parser. libMirage (via `python3-gi`) is the default parser; own parsers register in front of it (`registriere(..., vorne=True)`). A known format without an available parser returns `format_nicht_unterstuetzt` with `format_detail`; a CUE without libMirage keeps the old `bchunk` path.

Parsing and extraction run in their own process (`python3 -I disc.py <auftrag.json>`) with the job time limit, `RLIMIT_AS` (`grenzen.parser_ram_mb`, default 2048) and `RLIMIT_FSIZE`; the output is checked while it grows. Files are offered to libMirage through symlinks with their original names (`eingabe_name`, `begleitdateien[].name`). The extractor writes `spurtabelle.json`, `daten/session<N>.iso` (2048-byte user data from MODE1/MODE2 Form 1 sectors at their absolute LBA; for a later session its volume descriptors are copied to sector 16, recorded as `verweis`), `audio/spurNN.wav` (16-bit stereo 44.1 kHz LE, pregap excluded unless `optionen.wav_pregap`), `rohspuren/spurNN.raw` for MODE2 Form 2/formless/mixed tracks, and then unpacks each ISO with 7-Zip into `inhalt/session<N>/`. Manifest entries of these files carry `art` and `metadaten` (WAV: `asset`, `asset_art: musik`). `kommando: "spurtabelle"` without `werkzeug` returns only the table. Validation rejects tracks outside their file, overlapping tracks and invalid sector sizes (`beschaedigt` / `nicht_unterstuetzt`).

The output folder must be empty and unique to the job. The API must validate the manifest before atomic publication. Ghidra's post-script exports JSONL, one function per row. The runtime has no pip/npm or package installation path.


## PE resources (P18-T76)

The existing E runner can extract individual PE resource leaves with `pe_ressourcen.py`. It uses the same directory/data-entry layout as `exe-pe-resource` (P21-T9): type/name/language directories use offsets relative to the resource root; payload RVAs must map entirely to file-backed section bytes. It never loads or executes the original program.

The global product switch `reverse_pe_ressourcen` defaults to OFF and must be enabled explicitly (the switch `alle` does not enable it). Manage it through `admin(profil_schalter_setzen, profil_funktion:"reverse_pe_ressourcen", ebene:"global", aktiv, grund)` or Settings → Reverse-Bibliothek. The optional internal switch of the same name, mode `freigegeben`, is a temporary override only when the API started with the intern tool enabled. Expiration, disabled intern mode or an unavailable override returns to the product value. The executor passes the effective value and its source to each E job as `optionen.pe_ressourcen` and `optionen.pe_ressourcen_stand`.

For each PE found during recursive E extraction, output goes beside the source under `<source>~ressourcen/` (a numbered suffix avoids existing directories). Numeric directory-entry indices form safe filenames; original type/name/language remain in metadata. Every leaf has an unchanged `.bin` and source offset, length, SHA-256 and codepage. ICON adds ICO/PNG, BITMAP adds BMP, and STRING/DIALOG/VERSION add UTF-8 text. Version text includes localized strings, the original fixed-info bytes and structured file/product versions. Unknown resource types remain raw. Existing E date/byte/depth/ratio/time budgets apply to the combined output. Corrupt nodes preserve good siblings and produce a partial result with diagnostics.

Manifest metadata uses the existing T71 origin (`herkunft.archiv/pfad/tiefe`) plus `pe_ressource`; the normal E importer persists it in `reverse_dateien`. Use `reverse(dateien)` for provenance/paging, `reverse(inspect)` for metadata, and `reverse(ansicht)` for ICO/PNG/BMP. No new public tool parameters are introduced.

Tests: `uv run --no-project python -B -m unittest discover -s docker/synapse-reverse -p 'test_*.py'` and `node packages/core/tests/reverse-pe-ressourcen-p18-t76.test.mjs` (the latter requires the Synapse shell's synapse_test:5433 database). `probe-pe-ressourcen.sh <existing-image> <original-exe> <working-sources>` is the coordinator's no-deploy probe: original read-only, output in container tmpfs.


## Ghidra graph and raw normalizers (P18-T74 / RV14)

The existing requested S3 job, controlled by the product switch reverse_s3 (default OFF), runs Ghidra once. ExportFunctions.java exports each function's decompilation, callees (including address space), string/data/import references, and an instruction listing when decompilation fails. Runner limits supply the per-function entry/text/time bounds; the existing output guard and S3 PG budget bound publication. No rizin S2 analysis or second Ghidra pass is started.

After successful Ghidra analysis the same job may collect static S1 stdout with rz-bin (-zj, -ij, -sj); WASM/class magic selects wasm-objdump or javap instead. Fixed s1-* raw files stay in the analysis dataset. normalisierer-status.json reports missing tools, time or budget limits without raw values. The API checks size, SHA-256, regular-file/no-link properties and the job manifest before parsing; all names/text/contexts pass through the shared reverse mask catalog. Only masked records and counters enter the existing reverse code tables. S1 enrichment keeps the current inspector fingerprint; S2 output uses the same S3 job's derived S2 fingerprint. Filename-like strings become RV30 candidates.

Use existing reverse(calls/references/functions/file) to read the results. A failed function has an S2 .asm function symbol; its S3 placeholder does not duplicate the function symbol. Call/reference source lines point to the calling function's header, while reference context includes the exact machine address. A Ghidra EXTERNAL offset is an index in a separate address space: it is labelled, for example, callee_receiver:"EXTERNAL:0x00000010", call_kind:"import" and is never resolved to a RAM address with the same number.

Tests: node packages/core/tests/reverse-rea1-p18-t74-rv14.test.mjs uses a private schema in synapse_test:5433; optional P18_REA_NORMAL_JSONL / P18_REA_FALLBACK_JSONL point to the coordinator's generated AUTORUN test exports, with S1 raw files beside them. uv run --no-project python -B -m unittest discover -s docker/synapse-reverse -p 'test_*.py' covers runner and extractor contracts.

Coordinator probe: probe-ghidra.sh <existing-image> <original-exe> <working-sources>, with FORCE_FALLBACK=1 for the test-only subclass that forces entry to fail while retaining real Ghidra instructions/graph. Originals mount read-only; all container output is tmpfs. TESTEXPORT_TAR=1 emits generated analysis files as a tar stream; pipe stdout directly into a local scratch directory, never a tool log. A rebuilt reverse image is needed to use the new exporter in production.
