import hashlib
import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

MODULE_PATH = Path(__file__).with_name("runner.py")
SPEC = importlib.util.spec_from_file_location("reverse_runner", MODULE_PATH)
runner = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(runner)


class RunnerContractTests(unittest.TestCase):
    def test_mount_paths_reject_traversal_and_symlinks(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "bib"
            root.mkdir()
            (root / "ok.bin").write_bytes(b"data")
            (root / "link").symlink_to(root / "ok.bin")
            self.assertEqual(runner.path_under("ok.bin", root, True), root / "ok.bin")
            with self.assertRaises(ValueError):
                runner.path_under("../outside", root, True)
            with self.assertRaises(ValueError):
                runner.path_under("link", root, True)

    def test_manifest_has_sha256_and_enforces_output_caps(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "a.txt").write_bytes(b"hello")
            cap = {"max_dateien": 2, "max_bytes": 10, "max_tiefe": 2,
                   "max_kompressionsfaktor": 10}
            files, size = runner.output_manifest(root, cap, input_size=1)
            self.assertEqual(size, 5)
            self.assertEqual(files[0]["sha256"], hashlib.sha256(b"hello").hexdigest())
            with self.assertRaises(ValueError):
                runner.output_manifest(root, {**cap, "max_bytes": 4}, input_size=100)
            with self.assertRaises(ValueError):
                runner.output_manifest(root, {**cap, "max_kompressionsfaktor": 4}, input_size=1)

    def test_extract_selection_uses_extension_allowlist(self):
        self.assertEqual(runner.selected_tool({"kommando": "extrahieren", "eingabe": "/bib/a.iso"}), "7zz")
        self.assertEqual(runner.selected_tool({"kommando": "extrahieren", "eingabe": "/bib/a.unknown"}), "")

    def test_commands_are_argument_arrays_and_tool_is_allowlisted(self):
        with patch.object(runner.shutil, "which", return_value="/usr/bin/7zz"):
            command = runner.command_for("7zz", Path("/bib/in.iso"), Path("/arbeit/job"), {})
        self.assertEqual(command[-2:], ["-o/arbeit/job", "/bib/in.iso"])
        with self.assertRaises(ValueError):
            runner.command_for("arbitrary-shell", Path("/bib/in"), Path("/arbeit/job"), {})


if __name__ == "__main__":
    unittest.main()
