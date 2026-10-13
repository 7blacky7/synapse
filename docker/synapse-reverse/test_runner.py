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

    def test_self_probe_passes_only_when_network_is_blocked_as_uid_65532(self):
        with patch.object(runner, "socket", create=True) as network, \
             patch.object(runner.shutil, "which", return_value=None), \
             patch.object(runner.os, "getuid", return_value=65532):
            network.getaddrinfo.side_effect = OSError("DNS blocked")
            network.create_connection.side_effect = OSError("TCP blocked")
            self.assertEqual(runner.self_probe(), {
                "status": "ok", "uid": 65532, "dns": "blocked", "tcp": "blocked",
                "forbidden_tools": [],
            })

    def test_self_probe_fails_if_network_or_forbidden_tools_are_available(self):
        with patch.object(runner, "socket", create=True) as network, \
             patch.object(runner.shutil, "which", side_effect=lambda name: "/usr/bin/gdb" if name == "gdb" else None), \
             patch.object(runner.os, "getuid", return_value=65532):
            network.getaddrinfo.return_value = [(None,)]
            network.create_connection.return_value = unittest.mock.Mock()
            result = runner.self_probe()
        self.assertEqual(result["status"], "fehler")
        self.assertEqual(result["dns"], "reachable")
        self.assertEqual(result["forbidden_tools"], ["gdb"])

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
        self.assertEqual(runner.selected_tool({"kommando": "extrahieren", "eingabe": "/bib/a.cue"}), "bchunk")
        self.assertEqual(runner.selected_tool({"kommando": "extrahieren", "eingabe": "/bib/a.jar"}), "7zz")
        self.assertEqual(runner.selected_tool({"kommando": "extrahieren", "eingabe": "/bib/a.unknown"}), "")

    def test_bchunk_uses_the_cue_referenced_image_and_safe_output_prefix(self):
        with tempfile.TemporaryDirectory() as temp:
            bib = Path(temp)
            cue = bib / "disc.cue"
            image = bib / "track.bin"
            cue.write_text('FILE "track.bin" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00\n')
            image.write_bytes(b"bin")
            with patch.object(runner, "BIB", bib), patch.object(runner.shutil, "which", return_value="/usr/bin/bchunk"):
                command = runner.command_for("bchunk", cue, Path("/arbeit/job"), {})
        self.assertEqual(command, ["bchunk", "-w", str(image), str(cue), "/arbeit/job/track"])

    def test_commands_are_argument_arrays_and_tool_is_allowlisted(self):
        with patch.object(runner.shutil, "which", return_value="/usr/bin/7zz"):
            command = runner.command_for("7zz", Path("/bib/in.iso"), Path("/arbeit/job"), {})
        self.assertEqual(command[-2:], ["-o/arbeit/job", "/bib/in.iso"])
        with self.assertRaises(ValueError):
            runner.command_for("arbitrary-shell", Path("/bib/in"), Path("/arbeit/job"), {})



    def test_tool_version_comes_from_pinned_manifests(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            package_manifest = root / "packages.txt"
            upstream_manifest = root / "upstream.txt"
            package_manifest.write_text("7zip=25.01+dfsg-1~deb13u2\nfile=1:5.46-5\n")
            upstream_manifest.write_text("rizin=0.9.1 sha256=abc\nghidra=11.4.3 sha256=def\n")
            with patch.object(runner, "PACKAGE_VERSION_FILE", package_manifest), \
                 patch.object(runner, "UPSTREAM_VERSION_FILE", upstream_manifest):
                self.assertEqual(runner.tool_version("7zz"), "25.01+dfsg-1~deb13u2")
                self.assertEqual(runner.tool_version("file"), "1:5.46-5")
                self.assertEqual(runner.tool_version("rz-bin"), "0.9.1")
                self.assertEqual(runner.tool_version("analyzeHeadless"), "11.4.3")

if __name__ == "__main__":
    unittest.main()
