#!/bin/sh
# P16-T16 E2: nur Interpreter-Metadaten fuer Pyright, keine Projektdateien starten.
# Pyright 1.1.414 ruft: '<py> -c <code>' (Suchpfade) und '<py> -I -c <code>' (Version). Fuehrende reine
# Isolationsschalter (-I -E -s -S -B) werden deshalb uebersprungen; danach nur -c/-V/--version.
# Ausgefuehrt wird immer der vertrauenswuerdige Image-Python mit -I (keine cwd/PYTHONPATH/User-site) und
# -S (keine site/.pth/sitecustomize-Hooks).
while [ $# -gt 0 ]; do
  case "$1" in
    -I|-E|-s|-S|-B) shift ;;
    *) break ;;
  esac
done
case "${1-}" in
  -c|-V|--version) exec /usr/local/bin/python3 -I -S "$@" ;;
  *) echo 'Nur isolierte Interpreter-Probes erlaubt' >&2; exit 64 ;;
esac
