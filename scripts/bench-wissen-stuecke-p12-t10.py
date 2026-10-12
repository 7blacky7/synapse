"""P12-T10: Langtext-Abnahme mit embedding-vergleich, ohne Dienst-/Bestandsaenderung.

Liest dessen identischen Korpus, Haiku-Fragen und vorhandene Vektor-Caches.
Misst vorher (Gesamtvektor) gegen nachher (Gesamtvektor + echte Synapse-Stuecke).
Alle Treffer werden vor MRR/Recall auf Eintrags-IDs aggregiert, bestes Stueck zaehlt.
Keine Modelle entladen, kein Qdrant/PG-Schreibzugriff, keine Fremd-Dateien schreiben.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
VERGLEICH = ROOT.parent / "embedding-vergleich"
sys.path.insert(0, str(VERGLEICH / "src"))
import httpx
import numpy as np
from embedding_vergleich.bench import embed, kennzahlen, normiere
from embedding_vergleich.gemeinsam import DATEN, KORPUS, VEKTOREN, lies_jsonl
from embedding_vergleich.modelle import nach_schluessel, formatiere_dok, formatiere_query

p = argparse.ArgumentParser()
p.add_argument("--modell", required=True)
p.add_argument("--dim", required=True, type=int)
p.add_argument("--ollama", required=True)
a = p.parse_args()
m = nach_schluessel(a.modell)
client = httpx.Client(base_url=a.ollama, timeout=300)
korpus = lies_jsonl(KORPUS)
index = {x["id"]: i for i, x in enumerate(korpus)}
lang = {x["id"]: x for x in lies_jsonl(DATEN / "lang_voll.jsonl") if x["id"] in index}
fragen = []
for datei in sorted((DATEN / "haiku").glob("lang_ausgabe_*.jsonl")):
    fragen += [x for x in lies_jsonl(datei) if x.get("geeignet") and x.get("ziel_id") in lang]
assert fragen and lang, "Langtext-Korpus und Ziel-Fragen sind Pflichtanker"

def rechnen(texte):
    teile = []
    for i in range(0, len(texte), 8):
        teile.append(embed(client, m.ollama, texte[i:i + 8], m.api))
        time.sleep(0.1)
    return np.concatenate(teile)

def docs_cache(docs):
    key = hashlib.sha1((m.ollama + m.dok_vorlage + "".join(x["id"] for x in docs)).encode()).hexdigest()[:12]
    pfad = VEKTOREN / f"dok_{key}.npy"
    if pfad.exists():
        return np.load(pfad)
    return rechnen([formatiere_dok(m, x["titel"], x["text"]) for x in docs])

basis = normiere(docs_cache(korpus), a.dim)
voll = [{"id": f"voll_{i}", "titel": korpus[index[i]]["titel"], "text": x["voll"][:20000]} for i, x in lang.items()]
v_voll = normiere(docs_cache(voll), a.dim)
qtexte = [x["frage"] for x in fragen]
qkey = hashlib.sha1((m.ollama + m.query_vorlage + "\n".join(qtexte)).encode()).hexdigest()[:12]
qpfad = VEKTOREN / f"query_{qkey}.npy"
q = normiere(np.load(qpfad) if qpfad.exists() else rechnen([formatiere_query(m,x) for x in qtexte]), a.dim)

# Die produktive, bereits gebaute Split-Funktion, keine Benchmark-Nachbildung.
js = """import {teileWissen} from './packages/core/dist/services/wissen-stuecke.js';
let s=''; for await (const x of process.stdin) s+=x;
process.stdout.write(JSON.stringify(JSON.parse(s).map(teileWissen)));"""
split = subprocess.run(["node", "--input-type=module", "-e", js], cwd=ROOT,
                       input=json.dumps([x["text"] for x in voll]), text=True, capture_output=True, check=True)
stuecke = json.loads(split.stdout)
texte, besitzer = [], []
for dokument, teile in zip(voll, stuecke):
    eintrag = dokument["id"][5:]
    for teil in teile:
        texte.append(formatiere_dok(m, dokument["titel"], teil))
        besitzer.append(eintrag)
v_stuecke = normiere(rechnen(texte), a.dim)
rest = [i for i, x in enumerate(korpus) if x["id"] not in lang]
alt = np.vstack([basis[rest], v_voll])
alt_ids = [korpus[i]["id"] for i in rest] + list(lang)
neu = np.vstack([alt, v_stuecke])
neu_ids = alt_ids + besitzer

def messen(v, ids):
    scores = q @ v.T
    raenge = []
    for zeile, frage in zip(scores, fragen):
        top = {}
        for ident, score in zip(ids, zeile):
            top[ident] = max(top.get(ident, -float("inf")), float(score))
        reihe = sorted(top, key=top.get, reverse=True)[:10]
        raenge.append(reihe.index(frage["ziel_id"]) + 1 if frage["ziel_id"] in reihe else None)
    return kennzahlen(raenge), raenge

vorher, rang_alt = messen(alt, alt_ids)
nachher, rang_neu = messen(neu, neu_ids)
print(json.dumps({"modell": a.modell, "dimension": a.dim, "korpus": len(korpus),
    "lange_eintraege": len(lang), "fragen": len(fragen), "zusatzstuecke": len(besitzer),
    "vorher": vorher, "nachher": nachher,
    "verbessert": sum((x or 11) > (y or 11) for x, y in zip(rang_alt, rang_neu)),
    "verschlechtert": sum((x or 11) < (y or 11) for x, y in zip(rang_alt, rang_neu)),
    "bedeutung": "Qualitaet auf vorhandenem Langtext-Korpus; kein Produktions-Gesamtabgleich.",
    }, ensure_ascii=False, indent=2))
