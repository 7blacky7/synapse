#!/usr/bin/env python3
"""
IMAGE-BAU (P16-T11): Grammatiken aller ts_sprachen-Module aus tree-sitter-language-pack holen.

Laeuft nur in der Builder-Stufe 'treesitter' des Dockerfiles (mit Netz). Ergebnis in <ziel>: je Grammatik die .so und
grammatiken.json ({pack, grammatiken: {name: {datei, symbol, abi}}}). Danach wird jede Sprache mit ihrer probe geprueft
(gueltig -> 0 Befunde, kaputt -> mind. 1); ein Fehler bricht den Bau ab. Die Pack-Version (ARG TS_PACK_VERSION)
legt die Grammatik-Staende fest; die Downloads prueft das Pack per Checksumme.

Aufruf: python3 ts_holen.py <ziel> <pack-version>
"""
import json
import os
import re
import shutil
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pruefer_treesitter as pt  # noqa: E402
import tree_sitter_language_pack as pack  # noqa: E402


def so_von(lang_name):
    """Pfad der .so, die das Pack fuer diese Grammatik geladen hat (aus /proc/self/maps)."""
    vorher = set(_geladen())
    pack.get_language(lang_name)
    neu = [p for p in _geladen() if p not in vorher]
    if len(neu) == 1:
        return neu[0]
    kandidat = os.path.join(pack.cache_dir(), f'libtree_sitter_{lang_name}.so')
    if os.path.exists(kandidat):
        return kandidat
    raise LookupError(f'.so fuer {lang_name} nicht eindeutig: {neu}')


def _geladen():
    with open('/proc/self/maps', encoding='utf-8') as f:
        return sorted({z.split()[-1] for z in f if 'libtree_sitter_' in z})


def main():
    ziel, pack_version = sys.argv[1], sys.argv[2]
    sprachen = pt.lade_sprachen(streng=True)
    grammatiken = sorted({s['grammatik'] for s in sprachen.values()})
    os.makedirs(ziel, exist_ok=True)
    pack.configure(pack.PackConfig(cache_dir='/tmp/ts-pack'))
    pack.download(grammatiken)
    eintraege = {}
    for g in grammatiken:
        quelle = so_von(g)
        datei = os.path.basename(quelle)
        m = re.fullmatch(r'lib(tree_sitter_\w+)\.so', datei)
        if not m:
            raise LookupError(f'unerwarteter Dateiname {datei} fuer {g}')
        shutil.copy2(quelle, os.path.join(ziel, datei))
        abi = pack.get_language(g).abi_version
        eintraege[g] = {'datei': datei, 'symbol': m.group(1), 'abi': abi}
        print(f'grammatik {g}: {datei} abi {abi} {os.path.getsize(quelle) // 1024} KB')
    verzeichnis = {'pack': pack_version, 'grammatiken': eintraege}
    with open(os.path.join(ziel, 'grammatiken.json'), 'w', encoding='utf-8') as f:
        json.dump(verzeichnis, f, indent=1, sort_keys=True)
    probleme = pt.selbsttest(verzeichnis, ziel)
    for p in probleme:
        print(f'PROBE FEHLGESCHLAGEN {p}', file=sys.stderr)
    if probleme:
        sys.exit(1)
    for n, s in sprachen.items():
        print(f'sprache {n}: grammatik {s["grammatik"]}, modus {s["modus"]}, endungen {",".join(s["endungen"])} - probe ok')


if __name__ == '__main__':
    main()
