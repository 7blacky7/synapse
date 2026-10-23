"""P18-T106: synthetische Kindprozesse, keine Container-/Liveprobe."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch


def kind():
    request = json.loads(sys.stdin.readline())
    mode = request["testfall"]
    n = request.get("n", 0)
    if mode == "zeile":
        os.write(1, b"x" * n + b"\n")
    elif mode == "protokoll":
        os.write(1, b"x\n" * (n // 2) + (b"\n" if n % 2 else b""))
    elif mode == "stderr":
        os.write(2, b"S" * n)
    elif mode == "fragment":
        os.write(1, b'{"NUTZDATEN_GEHEIM":')
    elif mode == "symlink":
        Path("privater-name").symlink_to("nicht-lesen")
    elif mode == "hardlink":
        Path("eins").write_bytes(b"data")
        os.link("eins", "zwei")
    elif mode == "frist":
        time.sleep(10)
    elif mode == "signal":
        os.kill(os.getpid(), signal.SIGTERM)
    elif mode == "exit":
        sys.exit(7)
    elif mode == "ok":
        os.write(1, b"{}\n")


# Das bestehende Testfile selbst ist der Kind-Entrypoint, keine Codekopie in /tmp.
if __name__ == "__main__" and len(sys.argv) == 5:
    kind()
    sys.exit(0)

sys.path.insert(0, str(Path(__file__).resolve().parent))
import leser


class DiagnoseTest(unittest.TestCase):
    def auftrag(self, mode, n=0):
        return {
            "leser_entrypoint": Path(__file__).name,
            "leser_eingabe": {"schnittstelle_version": 1, "eingabe": "/eingabe",
                              "ausgabe": "/arbeit", "testfall": mode, "n": n},
            "leser_grenzen": {
                "zeit_ms": "2000", "ram_mib": "256", "dateien": "10", "bytes": "65536",
                "cpu": "1", "datei_bytes": "65536", "protokoll_bytes": "1024",
                "zeile_bytes": "64", "eingabe_bytes": "4096", "lese_bytes": "128",
                "tiefe": "5", "poll_ms": "5", "wait_ms": "1000"}}

    def invoke(self, mode, n=0, cleanup_error=False, **limits):
        request = self.auftrag(mode, n)
        request["leser_grenzen"].update({k: str(v) for k, v in limits.items()})
        with tempfile.TemporaryDirectory(prefix="t106-data-") as temp:
            root = Path(temp)
            source = root / "input"
            source.write_bytes(b"synthetic")
            output = root / "output"
            output.mkdir()
            mapping = {"/eingabe": source, "/arbeit": output,
                       "/leser": Path(__file__).resolve().parent}
            real_path, real_wait = Path, subprocess.Popen.wait

            def wait(process, *args, **kwargs):
                result = real_wait(process, *args, **kwargs)
                if cleanup_error:
                    raise subprocess.TimeoutExpired("NUTZDATEN_GEHEIM", 1)
                return result

            with patch.object(leser, "Path", side_effect=lambda p: mapping.get(str(p), real_path(p))), \
                    patch.object(subprocess.Popen, "wait", wait):
                result = leser.ausfuehren(request)
            self.assertNotIn("NUTZDATEN_GEHEIM", json.dumps(result))
            self.assertNotIn("privater-name", json.dumps(result))
            return result

    def test_legacy_success_and_nonzero_exit(self):
        ok = self.invoke("ok")
        self.assertEqual((ok["status"], ok["leser_exit"]), ("fertig", 0))
        self.assertIsNone(ok["fehlercode"])
        error = self.invoke("exit")
        self.assertEqual(error["fehlercode"], "leser_exit_fehler")
        self.assertEqual(error["leser_diagnose"]["exit_code"], 7)

    def test_link_subtypes_without_paths(self):
        for mode, code in (("symlink", "leser_pfad_symlink"), ("hardlink", "leser_hardlink")):
            with self.subTest(mode=mode):
                self.assertEqual(self.invoke(mode)["fehlercode"], code)

    def test_independent_output_limits_below_equal_above(self):
        for mode, limit, factor, code in (
            ("zeile", 64, 1, "leser_zeile_limit"),
            ("protokoll", 1024, 1, "leser_protokoll_limit"),
            ("stderr", 1024, 1, "leser_stderr_limit"),
        ):
            for delta in (-1, 0, 1):
                with self.subTest(mode=mode, delta=delta):
                    result = self.invoke(mode, limit // factor + delta)
                    self.assertEqual(result["fehlercode"], code if delta > 0 else None)

    def test_fragment_and_wallclock(self):
        self.assertEqual(self.invoke("fragment")["fehlercode"], "leser_ende_unvollstaendig")
        r = self.invoke("frist", zeit_ms=150)
        self.assertEqual(r["fehlercode"], "leser_zeitlimit")
        self.assertIsNone(r["leser_exit"], "eigenes Cleanup-SIGKILL ist keine ursprüngliche Ursache")
        self.assertIsNone(r["leser_diagnose"]["signal"])

    def test_real_sigterm_survives_finally_wait_failure(self):
        r = self.invoke("signal", cleanup_error=True)
        self.assertEqual(r["fehlercode"], "leser_prozess_signal")
        self.assertEqual(r["leser_exit"], -signal.SIGTERM)
        self.assertEqual(r["leser_diagnose"]["signal"], signal.SIGTERM)
        self.assertEqual(r["leser_diagnose"]["cleanup_code"], "leser_prozess_cleanup_fehler")
        self.assertIsNone(r["leser_diagnose"]["exit_code"])

    def test_primary_limit_survives_cleanup_failure(self):
        r = self.invoke("frist", cleanup_error=True, zeit_ms=150)
        self.assertEqual(r["fehlercode"], "leser_zeitlimit")
        self.assertIsNone(r["leser_diagnose"]["signal"])
        self.assertEqual(r["leser_diagnose"]["cleanup_code"], "leser_prozess_cleanup_fehler")

    def test_input_and_foreign_exceptions_are_fixed_codes(self):
        self.assertEqual(leser.ausfuehren({})["fehlercode"], "leser_grenzen_fehlen")
        for exc in (ValueError("leser_zeitlimit:NUTZDATEN_GEHEIM"),
                    OSError("/privater/pfad NUTZDATEN_GEHEIM"), RuntimeError("NUTZDATEN_GEHEIM")):
            with patch.object(leser, "leser_stdin", side_effect=exc):
                result = leser.ausfuehren({})
            self.assertEqual(result["fehlercode"], "leser_prozess_fehler")
            self.assertNotIn("NUTZDATEN_GEHEIM", json.dumps(result))


if __name__ == "__main__":
    unittest.main()
