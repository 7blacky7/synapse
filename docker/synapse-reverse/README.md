# synapse-reverse container (RV11)

This image provides static extraction and analysis tools. Original programs are data and are never launched. P20 must enforce network disabled, read-only rootfs, user 65532, cap_drop ALL, no-new-privileges, quotas, and the mount policy in thought 51ea56f7.

## Build

Run from the repository root. Supply the approved immutable OCI digest for the base image.

    docker build --build-arg DEBIAN_BASE='debian:trixie-slim@sha256:<approved-digest>' \
      --build-arg DEBIAN_SNAPSHOT=20261001T000000Z \
      -f docker/synapse-reverse/Dockerfile -t synapse-reverse:rv11 docker/synapse-reverse

The dated Debian snapshot and pinned 7-Zip, FFmpeg, and Ghidra inputs stabilize the package set and large upstream archive. The build records tool versions in /opt/reverse/versionen.txt.

## Runner

Runner accepts one JSON request per input line with auftrag_id, schicht, werkzeug, eingabe (/bib/...), ausgabe (/arbeit/<auftrag_id>) and grenzen. Commands include spurtabelle, extrahieren, leser_ausfuehren. Each request returns progress and a completion record with tool version and a SHA-256 file manifest. Supported limits are zeitlimit_s, max_dateien, max_bytes, max_tiefe.

The output folder must be empty and unique to the job. The API must validate the manifest before atomic publication. Ghidra's post-script exports JSONL, one function per row. The runtime has no pip/npm or package installation path.
