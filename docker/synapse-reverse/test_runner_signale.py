"""P18-T103: synthetic tests, run only in the coordinator's test phase.
No Docker, production data or project-code copies. Child modes live in this file.
"""
from __future__ import annotations
import hashlib
import json
import os
from pathlib import Path
import selectors
import signal
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from typing import Any, cast

sys.path.insert(0, str(Path(__file__).resolve().parent))
import runner
import checkpoint
import leser


def child_main(mode: str) -> int:
    # A real registration handshake, not a guessed sleep before sending TERM.
    install = signal.signal

    def ready(sig, handler):
        previous = install(sig, handler)
        if sig == signal.SIGTERM and handler is runner.signal_handler:
            os.write(2, b"READY\n")
        return previous

    if mode == "--active":
        def work(_req):
            os.write(2, b"WORK\n")
            while True:
                runner.signal_pruefen()
        runner.run_request = work
    with patch.object(runner.signal, "signal", ready):
        return runner.main()


if __name__ == "__main__" and len(sys.argv) == 2 and sys.argv[1] in ("--idle", "--active"):
    raise SystemExit(child_main(sys.argv[1]))


@unittest.skipUnless(os.environ.get("SYNAPSE_TEST_PHASE") == "P18-T103",
                     "requires the coordinator's P18-T103 test phase")
class SignalTest(unittest.TestCase):
    def spawn(self, mode="--idle"):
        proc = subprocess.Popen([sys.executable, "-B", __file__, mode],
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.addCleanup(self.cleanup, proc)
        self.assertEqual(self.line(proc.stderr), b"READY\n")
        return proc

    @staticmethod
    def cleanup(proc):
        if proc.poll() is None:
            proc.kill()
        proc.wait(timeout=5)
        for stream in (proc.stdin, proc.stdout, proc.stderr):
            if stream is not None:
                stream.close()

    def line(self, stream):
        with selectors.DefaultSelector() as sel:
            sel.register(stream, selectors.EVENT_READ)
            self.assertTrue(sel.select(5), "handshake deadline")
            return stream.readline()

    def test_idle_and_fragment_are_not_jobs(self):
        for fragment in (b"", b'{"unfinished":'):
            with self.subTest(fragment=fragment):
                p = self.spawn()
                assert p.stdin is not None and p.stdout is not None and p.stderr is not None
                p.stdin.write(fragment)
                p.stdin.flush()
                p.send_signal(signal.SIGTERM)
                self.assertEqual(p.wait(timeout=5), 143)
                self.assertEqual(p.stdout.read(), b"")

    def test_cpu_stop_and_queued_request_not_started(self):
        p = self.spawn("--active")
        assert p.stdin is not None and p.stdout is not None and p.stderr is not None
        p.stdin.write(b'{}\n{}\n')
        p.stdin.flush()
        self.assertEqual(self.line(p.stderr), b"WORK\n")
        p.send_signal(signal.SIGTERM)
        self.assertEqual(p.wait(timeout=5), 143)
        result = [json.loads(x) for x in p.stdout.read().splitlines()]
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["fehlercode"], "signal_sigterm")
        self.assertNotIn(b"WORK", p.stderr.read())

    def test_eof_and_two_normal_json_errors(self):
        p = self.spawn()
        assert p.stdin is not None and p.stdout is not None and p.stderr is not None
        p.stdin.write(b'[]\nnull\n')
        p.stdin.close()
        self.assertEqual(p.wait(timeout=5), 0)
        result = [json.loads(x) for x in p.stdout.read().splitlines()]
        self.assertEqual(len(result), 2)
        self.assertTrue(all(r["fehlercode"] == "ungueltiger_auftrag" for r in result))

    def test_import_did_not_install_handler(self):
        self.assertNotEqual(signal.getsignal(signal.SIGTERM), runner.signal_handler)

    @staticmethod
    def caps():
        return {"zeitlimit_s": 60, "nachlauf_s": 0, "lese_block_bytes": 64,
                "manifest_record_bytes": 8192, "manifest_segment_zeilen": 8,
                "max_tiefe": 16, "max_verschachtelung": 4, "max_datei_bytes": 4096,
                "max_dateien": 20, "max_bytes": 8192, "max_kompressionsfaktor": 100}

    def checkpoint_case(self, phase):
        with tempfile.TemporaryDirectory(prefix="p18-t103-data-") as tmp:
            root = Path(tmp)
            source, work = root / "source", root / "output"
            source.write_bytes(b"own archive fixture" * 10)
            stopped = False
            calls = []
            def stop():
                return stopped
            def inventory(_source):
                yield {"pfad": "one", "groesse": 3}
                yield {"pfad": "two", "groesse": 3}
            def extract(_source, name, target, _deadline):
                nonlocal stopped
                calls.append(name)
                target.write_bytes(b"abc")
                if phase == "before_fsync" and len(calls) == 1:
                    stopped = True
            fsync = os.fsync
            def synced(fd):
                nonlocal stopped
                fsync(fd)
                target = os.readlink("/proc/self/fd/" + str(fd))
                if phase == "after_fsync" and "/.e-member-" in target:
                    stopped = True
            rename = os.rename
            def renamed(a, b):
                nonlocal stopped
                rename(a, b)
                if phase == "after_rename":
                    stopped = True
            def detect(_target):
                nonlocal stopped
                if phase == "after_member":
                    stopped = True
                return False
            with patch.object(checkpoint.os, "fsync", synced), patch.object(checkpoint.os, "rename", renamed):
                first = checkpoint.ausfuehren(work, source, {"fixture": 1}, self.caps(),
                    inventory, extract, detect, stopp=stop)
            self.assertEqual(first["status"], "teilweise")
            self.assertEqual(first["fehlercode"], "signal_sigterm")
            self.assertFalse(first["extraktion"]["fertig"])
            self.assertFalse(first["extraktion"]["leertabelle_belegt"])
            manifest = (work / first["manifest_datei"]["pfad"]).read_bytes()
            self.assertEqual(hashlib.sha256(manifest).hexdigest(), first["manifest_datei"]["sha256"])
            rows = [json.loads(x) for x in manifest.splitlines()]
            self.assertEqual(len(rows), 0 if phase == "before_fsync" else 1)
            if phase == "before_fsync":
                self.assertTrue(list(work.glob(".e-member-*")))
                # No durable member was confirmed; no automatic resume is promised.
                self.assertFalse(first["extraktion"]["fortsetzbar"])
                return
            saved = (work / "one").read_bytes()
            stopped = False
            resumed = checkpoint.ausfuehren(work, source, {"fixture": 1}, self.caps(),
                inventory, extract, lambda _: False, importiert_sha=first["manifest_datei"]["sha256"])
            self.assertEqual(resumed["status"], "fertig")
            self.assertEqual((work / "one").read_bytes(), saved)
            self.assertEqual(calls, ["one", "two"])
            with sqlite3.connect(work / checkpoint.JOURNAL) as db:
                self.assertEqual(db.execute("SELECT count(*) FROM member WHERE status='fertig'").fetchone()[0], 2)

    def test_checkpoint_before_and_after_durability(self):
        for phase in ("before_fsync", "after_fsync", "after_rename", "after_member"):
            with self.subTest(phase=phase):
                self.checkpoint_case(phase)

    def test_reader_stop_before_start_is_not_fake_child_signal(self):
        with patch.object(leser.subprocess, "Popen") as spawn:
            result = leser.ausfuehren({}, stopp=lambda: True)
        spawn.assert_not_called()
        self.assertEqual(result["fehlercode"], "leser_runner_sigterm")
        self.assertIsNone(result["leser_exit"])
        self.assertIsNone(result["leser_diagnose"]["signal"])

    def test_stop_does_not_clear_process_latch(self):
        with patch.object(runner, "_SIGTERM", signal.SIGTERM):
            with self.assertRaises(runner.SignalStopp):
                runner.run_request({"kommando": "leser_ausfuehren"})


    def test_r2_reader_and_sweep_share_signal_deadline(self):
        from types import SimpleNamespace
        clock = [10.0]
        class Child:
            pid = 123456789
            stdin = stdout = stderr = None
            calls = []
            def wait(self, timeout):
                self.calls.append(timeout)
                clock[0] += timeout
                if len(self.calls) == 1:
                    raise subprocess.TimeoutExpired("fixture", timeout)
                return 0
        child = Child()
        # No real signal/kill/sleep: the clock and process table are complete fakes.
        with patch.object(runner, "_SIGTERM", 0), patch.object(runner, "_SIGNAL_BEGINN", None), \
             patch.object(runner, "_SIGNAL_DEADLINE", None), patch.object(runner, "_SIGNAL_WAIT_S", 0.1), \
             patch.object(runner.time, "monotonic", lambda: clock[0]), \
             patch.object(leser.os, "killpg"):
            runner.signal_handler(signal.SIGTERM, None)
            deadline = runner.signal_frist()
            self.assertEqual(leser._signal_beende(cast(Any, child), 100, runner.signal_frist), None)
            self.assertLessEqual(sum(child.calls), 0.1)
            self.assertEqual(runner.signal_frist(), deadline)
            fake_proc = SimpleNamespace(iterdir=lambda: [SimpleNamespace(name=str(child.pid))])
            with patch.object(runner, "CONTAINER_MODUS", True), patch.object(runner, "Path", return_value=fake_proc), \
                 patch.object(runner, "parent_of", return_value=0), patch.object(runner, "alive", return_value=True), \
                 patch.object(runner.os, "kill"), \
                 patch.object(runner.time, "sleep", side_effect=lambda dt: clock.__setitem__(0, clock[0] + dt)):
                # Budget exhausted: leave an explicit unconfirmed remainder, never add 100ms.
                self.assertEqual(runner.sweep_processes(), 1)
            self.assertLessEqual(clock[0], 10.1)


    def test_r2_prior_cause_with_expired_parent_deadline_uses_zero_budget(self):
        # Repro 8354f421: real adapter control flow; processes/signals are all fakes.
        for kind in ("guard", "child"):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory(prefix="t103-r2-data-") as td:
                root = Path(td)
                inp, out, pkg = root / "input", root / "output", root / "package"
                inp.write_bytes(b"own data")
                out.mkdir()
                pkg.mkdir()
                (pkg / "fixture").write_bytes(b"")
                mapping = {"/eingabe": inp, "/arbeit": out, "/leser": pkg}
                stopped = [False]
                waits = []
                class Stream:
                    def fileno(self):
                        return 0
                    def close(self):
                        pass
                class Child:
                    pid = 99999999
                    stdin = stdout = stderr = Stream()
                    def poll(self):
                        if kind == "child":
                            stopped[0] = True
                            return -15
                        return None
                    def wait(self, timeout):
                        waits.append(timeout)
                        return -9
                class Selector:
                    def __enter__(self):
                        return self
                    def __exit__(self, *args):
                        pass
                    def register(self, *args):
                        pass
                    def get_map(self):
                        return {0: True}
                def guard(*args):
                    stopped[0] = True
                    raise ValueError("leser_zeitlimit")
                grenzen = {k: "100" for k in leser._GRENZEN_FELDER}
                grenzen.update(eingabe_bytes="4096", zeit_ms="1000")
                req = {"leser_grenzen": grenzen, "leser_entrypoint": "fixture",
                       "leser_eingabe": {"schnittstelle_version": 1,
                                         "eingabe": "/eingabe", "ausgabe": "/arbeit"}}
                with patch.object(leser, "Path", side_effect=lambda s: mapping.get(str(s), Path(s))), \
                     patch.object(leser.subprocess, "Popen", return_value=Child()), \
                     patch.object(leser.selectors, "DefaultSelector", Selector), \
                     patch.object(leser.os, "set_blocking"), \
                     patch.object(leser.time, "monotonic", return_value=200.0), \
                     patch.object(leser, "_baum", side_effect=guard), \
                     patch.object(leser.os, "killpg") as kill:
                    result = leser.ausfuehren(req, stopp=lambda: stopped[0],
                                             stopp_frist=lambda: 100.1)
                self.assertTrue(stopped[0])
                self.assertEqual(waits, [0])
                kill.assert_called_once_with(Child.pid, signal.SIGKILL)
                self.assertEqual(result["fehlercode"],
                                 "leser_zeitlimit" if kind == "guard" else "leser_prozess_signal")
                self.assertEqual(result["leser_exit"], None if kind == "guard" else -15)
                self.assertEqual(result["leser_diagnose"]["signal"], None if kind == "guard" else 15)
                self.assertIsNone(result["leser_diagnose"]["cleanup_code"])

    def test_r3_late_parent_stop_keeps_observed_child_and_protocol(self):
        code = "leser_runner_sigterm"
        protocol = {"pfad": ".leser-protokoll.jsonl", "sha256": "a" * 64, "bytes": "12", "zeilen": "1"}
        success = {"status": "fertig", "fehlercode": None, "leser_exit": 0,
                   "leser_protokoll": protocol, "leser_diagnose": leser._diagnose(None, "ausfuehrung", 0)}
        # The same call is used after adapter-return, immediately before the terminal write.
        late = runner.signal_abbruch({"kommando": "leser_ausfuehren"}, success)
        self.assertEqual(late["fehlercode"], code)
        self.assertEqual(late["status"], "fehler")
        self.assertEqual(late["leser_exit"], 0)
        self.assertEqual(late["leser_protokoll"], protocol)
        self.assertEqual(late["leser_diagnose"]["exit_code"], 0)
        self.assertIsNone(late["leser_diagnose"]["signal"])
        previous = {"status": "fehler", "fehlercode": "leser_prozess_signal", "leser_exit": -15,
                    "leser_protokoll": protocol, "leser_diagnose": leser._diagnose("leser_prozess_signal", "ausfuehrung", -15)}
        self.assertEqual(runner.signal_abbruch({"kommando": "leser_ausfuehren"}, previous), previous)
        early = runner.signal_abbruch({"kommando": "leser_ausfuehren"})
        self.assertEqual(early["fehlercode"], code)
        self.assertIsNone(early["leser_exit"])
        self.assertIsNone(early["leser_diagnose"]["signal"])

    def test_r3_actual_publication_window_preserves_reader_diagnosis(self):
        # Execute main's actual event branch with a real pipe, no container.
        read_fd, write_fd = os.pipe()
        try:
            os.write(write_fd, b'{"kommando":"leser_ausfuehren"}\n')
            os.close(write_fd)
            write_fd = -1
            source = os.fdopen(read_fd, "r")
            read_fd = -1
            recorded = []
            def work(_req):
                answer = {"status": "fertig", "fehlercode": None, "leser_exit": 0,
                          "leser_protokoll": {"pfad": "proof", "bytes": "2", "zeilen": "1", "sha256": "b" * 64},
                          "leser_diagnose": leser._diagnose(None, "ausfuehrung", 0)}
                runner.signal_handler(signal.SIGTERM, None)
                return [answer]
            with source, patch.object(runner.sys, "stdin", source), patch.object(runner, "run_request", work), \
                 patch.object(runner, "ausgabe", recorded.append), patch.object(runner, "CONTAINER_MODUS", False), \
                 patch.object(runner, "_SIGTERM", 0), patch.object(runner, "_SIGNAL_BEGINN", None), \
                 patch.object(runner, "_SIGNAL_DEADLINE", None):
                self.assertEqual(runner.main(), 143)
            self.assertEqual(len(recorded), 1)
            self.assertEqual(recorded[0]["fehlercode"], "leser_runner_sigterm")
            self.assertEqual(recorded[0]["leser_exit"], 0)
            self.assertEqual(recorded[0]["leser_protokoll"]["pfad"], "proof")
        finally:
            for fd in (read_fd, write_fd):
                if fd >= 0:
                    os.close(fd)

if __name__ == "__main__":
    unittest.main()
