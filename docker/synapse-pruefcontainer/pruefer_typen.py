#!/usr/bin/env python3
"""
MODUL: Kleine Typpruefung je files-Plan im Pruef-Container (P16-T24, 08.11.2026)

Regel memory regel-container-pruefcontainer-ein-container-workspace-nur-auf-anweisung: EIN Pruef-Container fuer alle
Pruefarten. Die Plan-Typpruefung (P16-T15, core typen-pruefung.ts) lief bisher im Projekt-Workspace (synapse-ws-*), den
sie dafuer automatisch startete. Jetzt laeuft derselbe Core-Checker (typen-pruefung-worker.js, von der API mitgeschickt)
hier mit dem Node/TypeScript des Images. Der Pruefer ist nur fuer die Dauer eines Auftrags an (Unterprozess), danach aus.

PROTOKOLL (in pruefserver.py eingehaengt):
  rein:  {"id": 11, "typen": {"engine": "<JS typen-pruefung-worker.js>", "diff": "<JS file-diff.js>", "auftrag": {TypAuftrag}}}
  raus:  {"id": 11, "ok": true, "typen": {TypPruefung ..., "ort": "pruefcontainer", "werkzeug_ms": 812}}

GRUNDSAETZE
  - Quelltexte kommen nur aus dem Auftrag (PG-Stand + Plan-Schatten); nichts von der Platte ausser TypeScript-Libs.
    Projekt-node_modules gibt es hier nicht: Abhaengigkeiten ohne Typen landen in fehlende_module (keine Sperre).
  - Zeitlimit = budget_ms des Auftrags; danach wird der Node-Prozess samt Gruppe beendet -> 'zeitlimit'.
  - Ein Typauftrag zur Zeit (PRUEF_TYPEN_PARALLEL, Standard 1); Heap PRUEF_TYPEN_HEAP_MB (Standard 256).
"""
import json
import os
import signal
import subprocess
import threading
import time

NODE = os.environ.get('PRUEF_NODE', 'node')
TYPESCRIPT = os.environ.get('PRUEF_TYPESCRIPT', '/opt/pruef/tsc/node_modules/typescript/lib/typescript.js')
LEERES_VERZEICHNIS = os.environ.get('PRUEF_LEER', '/opt/pruef/leer')
HEAP_MB = int(os.environ.get('PRUEF_TYPEN_HEAP_MB', '256'))
_sperre = threading.Semaphore(max(1, int(os.environ.get('PRUEF_TYPEN_PARALLEL', '1'))))

# Wie der fruehere Workspace-Bootstrap (P16-T15), nur mit dem TypeScript des Images und ohne /workspace.
BOOTSTRAP = r"""
const {Worker}=require('node:worker_threads');
const {pathToFileURL}=require('node:url');
const leer=(status,hinweis)=>({status,dauer_ms:0,befunde:[],altlasten:0,dateien:[],vollstaendig:false,fehlende_module:[],betroffene_aufrufer:[],hinweis});
let input='';
process.stdin.setEncoding('utf8');
process.stdin.on('data',b=>{input+=b;});
process.stdin.on('end',()=>{
 let fertig=false;
 const finish=r=>{if(fertig)return;fertig=true;process.stdout.write(JSON.stringify(r),()=>process.exit(0));};
 try{
  const payload=JSON.parse(input);
  const source=payload.engine.replace("'typescript'",JSON.stringify(pathToFileURL(process.env.PRUEF_TYPESCRIPT).href))
   .replace("'./file-diff.js'",JSON.stringify('data:text/javascript;base64,'+Buffer.from(payload.diff).toString('base64')));
  const workerSource="import {parentPort,workerData} from 'node:worker_threads'; const m=await import(workerData.engine); parentPort.postMessage(m.pruefeTypAuftrag(workerData.auftrag));";
  const w=new Worker(new URL('data:text/javascript;base64,'+Buffer.from(workerSource).toString('base64')),{
   workerData:{engine:'data:text/javascript;base64,'+Buffer.from(source).toString('base64'),auftrag:payload.auftrag}});
  w.once('message',finish);
  w.once('error',e=>finish(leer('nicht_verfuegbar',String((e&&e.message)||e))));
  w.once('exit',()=>{if(!fertig)finish(leer('nicht_verfuegbar','Typpruef-Worker im Pruef-Container beendet.'));});
 }catch(e){finish(leer('nicht_verfuegbar',String((e&&e.message)||e)));}
});
"""


def info():
    """Diagnose fuer pruefserver.info(): TypeScript-Pfad (None = fehlt im Image)."""
    return {'typescript': TYPESCRIPT if os.path.exists(TYPESCRIPT) else None, 'heap_mb': HEAP_MB}


def _leer(status, hinweis):
    return {'status': status, 'dauer_ms': 0, 'befunde': [], 'altlasten': 0, 'dateien': [], 'vollstaendig': False,
            'fehlende_module': [], 'betroffene_aufrufer': [], 'hinweis': hinweis}


def _beende(p):
    try:
        os.killpg(p.pid, signal.SIGKILL)
    except Exception:  # noqa: BLE001
        try:
            p.kill()
        except Exception:  # noqa: BLE001
            pass
    try:
        p.wait(timeout=5)
    except Exception:  # noqa: BLE001
        pass


def _pruefe(a):
    engine, diff, auftrag = a.get('engine'), a.get('diff'), a.get('auftrag')
    if not isinstance(engine, str) or not isinstance(diff, str) or not isinstance(auftrag, dict):
        return _leer('nicht_verfuegbar', 'Typauftrag unvollstaendig (engine, diff, auftrag).')
    if not os.path.exists(TYPESCRIPT):
        return _leer('nicht_verfuegbar', f'TypeScript fehlt im Pruef-Container ({TYPESCRIPT}).')
    try:
        limit_s = max(0.5, float(auftrag.get('budget_ms') or 5000) / 1000.0)
    except (TypeError, ValueError):
        limit_s = 5.0
    eingabe = json.dumps({'engine': engine, 'diff': diff, 'auftrag': auftrag}).encode('utf-8')
    env = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'HOME': LEERES_VERZEICHNIS, 'LANG': 'C.UTF-8',
           'PRUEF_TYPESCRIPT': TYPESCRIPT, 'NODE_OPTIONS': f'--max-old-space-size={HEAP_MB}'}
    t0 = time.monotonic()
    with _sperre:
        rest = limit_s - (time.monotonic() - t0)
        if rest <= 0:
            return _leer('zeitlimit', 'Typbudget im Pruef-Container in der Warteschlange verbraucht.')
        p = subprocess.Popen([NODE, '-e', BOOTSTRAP], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, cwd=LEERES_VERZEICHNIS, env=env, start_new_session=True)
        try:
            out, err = p.communicate(eingabe, timeout=rest)
        except subprocess.TimeoutExpired:
            _beende(p)
            return _leer('zeitlimit', 'Typbudget im Pruef-Container ueberschritten; keine Typ-Sperre.')
    try:
        erg = json.loads(out.decode('utf-8', 'replace'))
        if isinstance(erg, dict) and erg.get('status'):
            return erg
    except Exception:  # noqa: BLE001
        pass
    return _leer('nicht_verfuegbar', 'Typpruefung ohne gueltige Antwort: ' + err.decode('utf-8', 'replace')[:300])


def pruefe(a):
    """Fuehrt einen Typauftrag aus; wirft nie. ort/werkzeug_ms fuer die Debug-Anzeige (P16-T24 SOLL 4)."""
    t0 = time.monotonic()
    try:
        erg = _pruefe(a if isinstance(a, dict) else {})
    except Exception as e:  # noqa: BLE001
        erg = _leer('nicht_verfuegbar', str(e)[:300])
    erg['ort'] = 'pruefcontainer'
    erg['werkzeug_ms'] = round((time.monotonic() - t0) * 1000)
    return erg
