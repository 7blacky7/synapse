"""
MODUL: Kotlin und Java im Pruef-Container (P16-T5 E3b, 11.10.2026)

Ein dauerhafter JVM-Hilfsprozess (jvm/JvmPruefer.java) parst Kotlin (PSI aus kotlin-compiler-embeddable) und Java
(javac-API, nur parse). pruefserver.py haelt genau EINEN solchen Prozess; dieses Modul startet ihn TRAEGE (erste
Kotlin-/Java-Anfrage oder Vorwaermen), reicht Anfragen durch und startet ihn nach einem Absturz neu.

LEBENSZYKLUS: Die JVM lebt so lange wie der Container (gleicher Start, gleicher Idle-Stop der API). Stirbt die JVM
(OOM-Kill, Absturz, Reissleine), scheitern nur die offenen Kotlin-/Java-Anfragen mit ok:false; der Pruefserver und
alle anderen Sprachen laufen weiter. Die naechste Kotlin-/Java-Anfrage startet die JVM neu. Mehr als JVM_MAX_STARTS
Starts in 5 min -> JVM_PAUSE_S lang sofort ok:false (Kotlin/Java ungeprueft, Schreiben geht durch).

ZEITEN: Der JVM-Start hat ein eigenes Limit (PRUEF_JVM_START_S, Standard 60 s); erst danach gilt das normale
Werkzeug-Zeitlimit je Anfrage. Ueberschreitet eine Anfrage es, wird die JVM beendet (haengender Parser blockiert sonst
alle folgenden Anfragen) und beim naechsten Mal neu gestartet.

SPEICHER: JVM-Optionen PRUEF_JVM_OPTS (Standard -Xmx160m, SerialGC, nur C1). Die JVM teilt sich das Speicherlimit
des Containers mit allen anderen Werkzeugen (Messung im Bericht P16-T5 E3b).

NUR BEI BEDARF (P16-T22): die JVM ist das einzige dauerhaft laufende Werkzeug im Container. Ohne Kotlin-/Java-/Scala-/
Groovy-Anfrage seit PRUEF_JVM_IDLE_S (Standard 600, 0 = nie) wird sie beendet (Zaehler idle_stops); die naechste Anfrage
startet sie wieder (Startlimit wie beim ersten Mal). Die API waermt sie nicht mehr bei jedem Containerstart vor.
"""
import base64
import os
import subprocess
import sys
import threading
import time

JVM_HOME = os.environ.get('PRUEF_JVM_HOME', '/opt/pruef/jvm')
JVM_OPTS = os.environ.get(
    'PRUEF_JVM_OPTS',
    '-Xmx160m -Xss2m -XX:+UseSerialGC -XX:TieredStopAtLevel=1 -XX:CICompilerCount=1 -XX:-UsePerfData '
    '-XX:+ExitOnOutOfMemoryError -XX:ActiveProcessorCount=1 -Xshare:auto -Djava.awt.headless=true '
    '-Djava.io.tmpdir=/tmp -Duser.home=/tmp -Didea.home.path=/tmp -Dfile.encoding=UTF-8').split()
JVM_START_S = float(os.environ.get('PRUEF_JVM_START_S', '60'))
JVM_MAX_STARTS = int(os.environ.get('PRUEF_JVM_MAX_STARTS', '3'))
JVM_PAUSE_S = float(os.environ.get('PRUEF_JVM_PAUSE_S', '60'))
JVM_IDLE_S = float(os.environ.get('PRUEF_JVM_IDLE_S', '600'))
VERSIONEN = os.environ.get('PRUEF_VERSIONEN', '/opt/pruef/versionen')
_START_FENSTER_S = 300


def _b64(s: str) -> str:
    return base64.b64encode(s.encode('utf-8')).decode('ascii')


def _aus64(s: str) -> str:
    return base64.b64decode(s.encode('ascii')).decode('utf-8', 'replace')


class JvmHelfer:
    """Ein JVM-Prozess, Anfragen per Zeilenprotokoll (siehe JvmPruefer.java), Antworten per id zugeordnet."""

    def __init__(self):
        self._proc = None
        self._start_sperre = threading.Lock()
        self._schreib_sperre = threading.Lock()
        self._offen = {}  # id -> [Event, Ergebnis]
        self._offen_sperre = threading.Lock()
        self._naechste = 1
        self._starts = []
        self._pause_bis = 0.0
        self.letzter_start_ms = None
        self.zaehler = {'starts': 0, 'abstuerze': 0, 'timeouts': 0, 'anfragen': 0, 'idle_stops': 0}
        self._zuletzt = time.monotonic()
        self._waechter = None

    def _waechter_lauf(self):
        """P16-T22: beendet die JVM nach JVM_IDLE_S ohne Anfrage (keine offenen Anfragen)."""
        while True:
            time.sleep(min(30.0, max(1.0, JVM_IDLE_S / 4)))
            p = self._proc
            with self._offen_sperre:
                offen = len(self._offen)
            if p is None or offen or time.monotonic() - self._zuletzt < JVM_IDLE_S:
                continue
            with self._start_sperre:
                if self._proc is not p or time.monotonic() - self._zuletzt < JVM_IDLE_S:
                    continue
                self._proc = None
            self.zaehler['idle_stops'] += 1
            sys.stderr.write(f'[pruefserver] JVM nach {JVM_IDLE_S:g} s ohne Anfrage beendet (Speicher frei) - naechste Anfrage startet neu\n')
            self._beende(p)

    # ── Start / Ende ──
    def laeuft(self) -> bool:
        p = self._proc
        return p is not None and p.poll() is None

    def sicherstellen(self):
        """Startet die JVM, falls sie nicht laeuft. Rueckgabe: Startdauer in ms (None = lief schon). Wirft bei Fehler."""
        if self.laeuft():
            return None
        with self._start_sperre:
            if self.laeuft():
                return None
            jetzt = time.monotonic()
            if jetzt < self._pause_bis:
                raise RuntimeError(f'JVM pausiert nach {JVM_MAX_STARTS} Starts in {_START_FENSTER_S // 60} min '
                                   f'(noch {self._pause_bis - jetzt:.0f} s) - Kotlin/Java ungeprueft')
            self._starts = [t for t in self._starts if jetzt - t < _START_FENSTER_S]
            if len(self._starts) >= JVM_MAX_STARTS:
                self._pause_bis = jetzt + JVM_PAUSE_S
                self._starts = []
                raise RuntimeError(f'JVM: {JVM_MAX_STARTS} Starts in {_START_FENSTER_S // 60} min - Pause {JVM_PAUSE_S:g} s')
            self._starts.append(jetzt)
            self.zaehler['starts'] += 1
            t0 = time.perf_counter()
            cmd = [os.path.join(JVM_HOME, 'rt/bin/java'), *JVM_OPTS,
                   '-cp', f"{os.path.join(JVM_HOME, 'lib')}/*:{os.path.join(JVM_HOME, 'klassen')}", 'JvmPruefer']
            env = {'PATH': '/usr/bin:/bin', 'HOME': '/tmp', 'LANG': 'C.UTF-8', 'TMPDIR': '/tmp'}
            p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 cwd=os.environ.get('PRUEF_LEER', '/opt/pruef/leer'), env=env, start_new_session=True)
            threading.Thread(target=self._stderr_weiter, args=(p,), daemon=True).start()
            bereit = threading.Event()
            erste = []

            def warte_bereit():
                erste.append(p.stdout.readline())
                bereit.set()
            threading.Thread(target=warte_bereit, daemon=True).start()
            if not bereit.wait(JVM_START_S) or not erste or erste[0].strip() != b'bereit':
                self._beende(p)
                raise RuntimeError(f'JVM nicht bereit nach {JVM_START_S:g} s: {erste[0][:200] if erste else b""!r}')
            self._proc = p
            threading.Thread(target=self._leser, args=(p,), daemon=True).start()
            if JVM_IDLE_S > 0 and self._waechter is None:
                self._waechter = threading.Thread(target=self._waechter_lauf, daemon=True)
                self._waechter.start()
            self.letzter_start_ms = round((time.perf_counter() - t0) * 1000, 1)
            sys.stderr.write(f'[pruefserver] JVM gestartet nach {self.letzter_start_ms} ms (pid {p.pid})\n')
            return self.letzter_start_ms

    def _stderr_weiter(self, p):
        for z in p.stderr:
            text = z.decode('utf-8', 'replace').rstrip()
            if text:
                sys.stderr.write(f'[jvm] {text[:500]}\n')

    def _leser(self, p):
        for z in p.stdout:
            teile = z.decode('utf-8', 'replace').rstrip('\n').split('\t')
            try:
                aid = int(teile[0])
            except ValueError:
                continue
            with self._offen_sperre:
                eintrag = self._offen.pop(aid, None)
            if eintrag:
                eintrag[1] = teile
                eintrag[0].set()
        # Stream-Ende: JVM ist weg (Absturz, OOM-Kill, beendet). Offene Anfragen scheitern.
        rc = p.wait()
        if self._proc is p:
            self._proc = None
            self.zaehler['abstuerze'] += 1
            sys.stderr.write(f'[pruefserver] JVM beendet (rc={rc}) - naechste Kotlin-/Java-Anfrage startet neu\n')
        with self._offen_sperre:
            offen, self._offen = self._offen, {}
        for eintrag in offen.values():
            eintrag[1] = None
            eintrag[0].set()

    def _beende(self, p):
        try:
            os.killpg(p.pid, 9)
        except (ProcessLookupError, PermissionError):
            pass
        try:
            p.wait(timeout=5)
        except Exception:  # noqa: BLE001
            pass

    # ── Anfragen ──
    def anfrage(self, felder, timeout_s: float):
        """Schickt eine Anfrage, gibt die Antwortfelder ab 'ok' zurueck. Wirft RuntimeError/TimeoutError."""
        self._zuletzt = time.monotonic()
        start_ms = self.sicherstellen()
        p = self._proc
        if p is None:
            raise RuntimeError('JVM nicht verfuegbar')
        ev = threading.Event()
        eintrag = [ev, None]
        with self._offen_sperre:
            aid = self._naechste
            self._naechste += 1
            self._offen[aid] = eintrag
        self.zaehler['anfragen'] += 1
        try:
            with self._schreib_sperre:
                p.stdin.write(('\t'.join([str(aid), *felder]) + '\n').encode('utf-8'))
                p.stdin.flush()
        except (BrokenPipeError, OSError) as e:
            with self._offen_sperre:
                self._offen.pop(aid, None)
            raise RuntimeError(f'JVM nicht erreichbar: {e}') from e
        if not ev.wait(timeout_s):
            with self._offen_sperre:
                self._offen.pop(aid, None)
            self.zaehler['timeouts'] += 1
            sys.stderr.write(f'[pruefserver] JVM-Anfrage nach {timeout_s:g} s abgebrochen - JVM wird neu gestartet\n')
            if self._proc is p:
                self._proc = None
            self._beende(p)
            raise TimeoutError(f'JVM nach {timeout_s:g} s abgebrochen')
        self._zuletzt = time.monotonic()
        teile = eintrag[1]
        if teile is None:
            raise RuntimeError('JVM beendet waehrend der Pruefung (Absturz/Speicher) - Kotlin/Java voruebergehend ungeprueft')
        if len(teile) >= 3 and teile[1] == 'fehler':
            raise RuntimeError(f'JVM: {_aus64(teile[2])[:300]}')
        return teile[1:], start_ms

    def pruefe(self, sprache: str, inhalt: str, pfad: str, timeout_s: float):
        teile, _start = self.anfrage([sprache, _b64(pfad or ''), _b64(inhalt)], timeout_s)
        # teile = ['ok', n, (zeile, spalte, weich, b64 code, b64 meldung)*n]
        n = int(teile[1])
        meldungen = []
        for i in range(n):
            z, s, w, code, text = teile[2 + i * 5:7 + i * 5]
            m = {'zeile': int(z), 'spalte': int(s), 'code': _aus64(code) or None, 'meldung': _aus64(text)}
            if w == '1':
                m['weich'] = True
            meldungen.append(m)
        return meldungen

    def vorwaermen(self, timeout_s: float):
        """JVM starten und beide Parser initialisieren. Rueckgabe: {'jvm_start_ms', 'warm_ms'}."""
        t0 = time.perf_counter()
        _teile, start_ms = self.anfrage(['warm'], max(timeout_s, JVM_START_S))
        return {'jvm_start_ms': start_ms, 'warm_ms': round((time.perf_counter() - t0) * 1000, 1)}

    def zustand(self):
        return {'laeuft': self.laeuft(), 'letzter_start_ms': self.letzter_start_ms, **self.zaehler,
                'pause': time.monotonic() < self._pause_bis, 'idle_s': JVM_IDLE_S,
                'ohne_anfrage_s': round(time.monotonic() - self._zuletzt)}


_helfer = JvmHelfer()


def _version(datei, standard):
    try:
        with open(os.path.join(VERSIONEN, datei), encoding='utf-8') as f:
            return f.read().strip() or standard
    except OSError:
        return standard


def pruefer(timeout_s: float):
    """Eintraege fuer PRUEFER in pruefserver.py: sprache -> (pruefe(inhalt, pfad), version())."""
    def kotlin(inhalt, pfad):
        return _helfer.pruefe('kotlin', inhalt, pfad, timeout_s)

    def java(inhalt, pfad):
        return _helfer.pruefe('java', inhalt, pfad, timeout_s)

    # P16-T13: Scala (scalameta) und Groovy (Groovy-Compiler bis CONVERSION) im selben JVM-Prozess.
    def scala(inhalt, pfad):
        return _helfer.pruefe('scala', inhalt, pfad, timeout_s)

    def groovy(inhalt, pfad):
        return _helfer.pruefe('groovy', inhalt, pfad, timeout_s)
    return {
        'kotlin': (kotlin, lambda: _version('kotlin', 'kotlin-psi unbekannt')),
        'java': (java, lambda: _version('java', 'javac unbekannt')),
        'scala': (scala, lambda: _version('scala', 'scalameta unbekannt')),
        'groovy': (groovy, lambda: _version('groovy', 'groovy unbekannt')),
    }


def vorwaermen(timeout_s: float):
    return _helfer.vorwaermen(timeout_s)


def zustand():
    return _helfer.zustand()
