"""RV14 runner integration. No Docker or real binary execution."""
import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch
import runner


class RawNormalisierung(unittest.TestCase):
    def test_rz_bin_outputs_are_dataset_files_not_log_tails(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); source = root / "input.exe"; source.write_bytes(b"MZ" + bytes(62))
            out, work = root / "out", root / "work"; out.mkdir(); work.mkdir()
            commands = []
            def fake(command, timeout, env, cwd, job_tmp, **kwargs):
                commands.append(command)
                payload = [{"string": "data/game.dat", "vaddr": 4096}] if command[1] == "-zj" else []
                (job_tmp / ".stdout").write_text(json.dumps(payload))
                return 0, "tail ignored"
            with patch.object(runner.shutil, "which", return_value="/opt/reverse/bin/rz-bin"), patch.object(runner, "run_isolated", side_effect=fake):
                runner.normalisierer_rohausgaben(source, out, runner.limits({"grenzen": {"max_bytes": 100000}}), {}, work, time.monotonic() + 10)
            self.assertEqual([c[1] for c in commands], ["-zj", "-ij", "-sj"])
            self.assertEqual(json.loads((out / "s1-rz-strings.json").read_text())[0]["string"], "data/game.dat")
            self.assertEqual(json.loads((out / "normalisierer-status.json").read_text())["status"], "fertig")

    def test_missing_tool_is_visible_and_never_executed(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); source = root / "x"; source.write_bytes(b"\0asm" + bytes(4))
            out, work = root / "out", root / "work"; out.mkdir(); work.mkdir()
            with patch.object(runner.shutil, "which", return_value=None), patch.object(runner, "run_isolated") as run:
                runner.normalisierer_rohausgaben(source, out, runner.limits({}), {}, work, time.monotonic() + 10)
            run.assert_not_called()
            self.assertEqual(json.loads((out / "normalisierer-status.json").read_text())["status"], "teilweise")

    def test_wasm_and_class_use_only_static_readers(self):
        for magic, tool, filename in [(b"\0asm", "wasm-objdump", "s1-wasm.txt"), (b"\xca\xfe\xba\xbe", "javap", "s1-javap.txt")]:
            with self.subTest(tool=tool), tempfile.TemporaryDirectory() as temp:
                root = Path(temp); source = root / "x"; source.write_bytes(magic + bytes(4))
                out, work = root / "out", root / "work"; out.mkdir(); work.mkdir()
                def fake(command, timeout, env, cwd, job_tmp, **kwargs):
                    self.assertEqual(command[0], tool); (job_tmp / ".stdout").write_text("fixture")
                    return 0, ""
                with patch.object(runner.shutil, "which", return_value="/usr/bin/" + tool), patch.object(runner, "run_isolated", side_effect=fake):
                    runner.normalisierer_rohausgaben(source, out, runner.limits({}), {}, work, time.monotonic() + 10)
                self.assertEqual((out / filename).read_text(), "fixture")


if __name__ == "__main__":
    unittest.main()
