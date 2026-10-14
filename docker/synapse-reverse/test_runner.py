import gzip
import hashlib
import importlib.util
import io
import shutil
import subprocess
import tarfile
import tempfile
import time
import zipfile
import unittest
from pathlib import Path
from unittest.mock import patch

MODULE_PATH = Path(__file__).with_name("runner.py")
SPEC = importlib.util.spec_from_file_location("reverse_runner", MODULE_PATH)
runner = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(runner)


def disc_image(sector_ids, offset_ids=()):
    """Synthetic disc head: sector_ids are written into sectors 16.. (VRS), offset_ids as (offset, ident)."""
    data = bytearray((16 + len(sector_ids) + 4) * 2048)
    for index, ident in enumerate(sector_ids):
        start = (16 + index) * 2048
        data[start] = 1
        data[start + 1:start + 6] = ident
        data[start + 6] = 1
    for offset, ident in offset_ids:
        data[offset:offset + 5] = ident
    return bytes(data)


class Sandbox:
    """Temporary /bib and /arbeit roots patched into the runner."""

    def __enter__(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.bib = root / "bib"
        self.work = root / "arbeit"
        self.bib.mkdir()
        self.patches = [patch.object(runner, "BIB", self.bib), patch.object(runner, "WORK", self.work)]
        for item in self.patches:
            item.start()
        return self

    def put(self, key, data):
        path = self.bib / key
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return f"{self.bib}/{key}"

    def __exit__(self, *exc):
        for item in self.patches:
            item.stop()
        self.temp.cleanup()


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

    def test_extract_selection_maps_content_format_not_extension(self):
        request = {"kommando": "extrahieren", "eingabe": "/bib/a.iso"}
        self.assertEqual(runner.selected_tool(request, "iso9660"), "7zz")
        self.assertEqual(runner.selected_tool(request, "udf"), "7zz")
        self.assertEqual(runner.selected_tool(request, "cue"), "bchunk")
        self.assertEqual(runner.selected_tool(request, ""), "")
        with self.assertRaises(ValueError):
            runner.selected_tool({"kommando": "ausfuehren"})

    def test_iso9660_magic_is_found_at_all_three_offsets(self):
        for offset in (0x8001, 0x8801, 0x9001):
            self.assertEqual(runner.disc_format(disc_image([], [(offset, b"CD001")])), "iso9660", hex(offset))
        self.assertEqual(runner.disc_format(disc_image([], [(0x8002, b"CD001")])), "")
        self.assertEqual(runner.disc_format(b"\x00" * 0x9100), "")

    def test_udf_is_recognised_by_nsr_descriptor_in_vrs(self):
        self.assertEqual(runner.disc_format(disc_image([b"BEA01", b"NSR02", b"TEA01"])), "udf")
        self.assertEqual(runner.disc_format(disc_image([b"CD001", b"CD001", b"BEA01", b"NSR03", b"TEA01"])), "udf")
        self.assertEqual(runner.disc_format(disc_image([b"CD001", b"CD001"])), "iso9660")
        # NSR after a foreign sector is not part of the recognition sequence
        self.assertEqual(runner.disc_format(disc_image([b"XXXXX", b"NSR02"])), "")

    def test_detect_format_reads_content_and_ignores_extension(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            cases = {
                "game.bin": (disc_image([b"CD001", b"CD001"]), "iso9660"),
                "movie.img": (disc_image([b"BEA01", b"NSR03", b"TEA01"]), "udf"),
                "fake.iso": (b"\x00" * 70000, ""),
                "raw.bin": (b"\xff" * 0x9800, ""),
                "disk.img": (b"no magic here", ""),
                "setup.dat": (b"MZ\x90\x00" + b"\x00" * 60, "pe"),
                "x.iso": (b"7z\xbc\xaf\x27\x1c\x00\x04", "7z"),
                "x.lzh": (b"\x00\x00-lh5-" + b"\x00" * 20, "lha"),
                "disc.txt": (b'FILE "track.bin" BINARY\r\n  TRACK 01 MODE1/2352\r\n', "cue"),
            }
            buffer = io.BytesIO()
            with zipfile.ZipFile(buffer, "w") as archive:
                archive.writestr("a.txt", "a")
            cases["app.iso"] = (buffer.getvalue(), "zip")
            cases["data.gz"] = (gzip.compress(b"abc"), "gzip")
            buffer = io.BytesIO()
            with tarfile.open(fileobj=buffer, mode="w") as archive:
                info = tarfile.TarInfo("a.txt")
                info.size = 1
                archive.addfile(info, io.BytesIO(b"a"))
            cases["plain.bin"] = (buffer.getvalue(), "tar")
            for name, (data, expected) in cases.items():
                (root / name).write_bytes(data)
                self.assertEqual(runner.detect_format(root / name), expected, name)

    def test_job_id_comes_from_executor_output_path(self):
        self.assertEqual(runner.job_id({"ausgabe": "/arbeit/0f0e-job_1"}), "0f0e-job_1")
        self.assertEqual(runner.job_id({"ausgabe": "/arbeit/abc/"}), "abc")
        self.assertEqual(runner.job_id({"auftrag_id": "abc", "ausgabe": "/arbeit/abc"}), "abc")
        self.assertEqual(runner.job_id({"auftrag_id": "abc"}), "abc")
        for bad in ({"auftrag_id": "abc", "ausgabe": "/arbeit/other"}, {"ausgabe": "/arbeit/../etc"},
                    {"ausgabe": "/tmp/abc"}, {"ausgabe": "/arbeit/a/b"}, {}):
            with self.assertRaises(ValueError, msg=str(bad)):
                runner.job_id(bad)

    def test_executor_request_without_magic_is_nicht_unterstuetzt_and_writes_nothing(self):
        for key in ("r1/original/fake.iso", "r1/original/raw.bin", "r1/original/disk.img"):
            with Sandbox() as box:
                request = {"kommando": "extrahieren", "eingabe": box.put(key, b"\x00" * 70000),
                           "ausgabe": "/arbeit/job-nm", "grenzen": {"zeitlimit_s": 10}}
                with patch.object(runner.subprocess, "run") as run:
                    events = runner.run_request(request)
                run.assert_not_called()
                self.assertEqual(events, [{"status": "fehler", "fehlercode": "nicht_unterstuetzt",
                                           "meldung": "Format am Inhalt nicht erkannt", "manifest": []}], key)
                self.assertFalse((box.work / "job-nm").exists())

    def test_executor_request_rejects_paths_outside_mounts(self):
        with Sandbox() as box:
            box.put("ok.iso", disc_image([b"CD001"]))
            for request in (
                {"kommando": "extrahieren", "eingabe": f"{box.bib}/../outside.iso", "ausgabe": "/arbeit/j1"},
                {"kommando": "extrahieren", "eingabe": "/etc/passwd", "ausgabe": "/arbeit/j1"},
                {"kommando": "extrahieren", "eingabe": f"{box.bib}/ok.iso", "ausgabe": "/arbeit/../j1"},
            ):
                with self.assertRaises(ValueError):
                    runner.run_request(request)

    def test_executor_request_runs_tool_with_tmp_dirs_and_forced_disc_type(self):
        with Sandbox() as box:
            request = {"kommando": "extrahieren", "eingabe": box.put("r1/original/disc.bin", disc_image([b"CD001", b"CD001"])),
                       "ausgabe": "/arbeit/job-env", "grenzen": {"zeitlimit_s": 5}}
            # P18-T64/M1: Werkzeug laeuft ueber run_isolated mit TMPDIR/HOME je Auftrag (nicht mehr gemeinsames /tmp).
            with tempfile.TemporaryDirectory() as tmp_root, \
                 patch.object(runner, "TMP_ROOT", Path(tmp_root)), \
                 patch.object(runner.shutil, "which", return_value="/usr/bin/7zz"), \
                 patch.object(runner, "run_isolated", return_value=(0, "")) as run:
                events = runner.run_request(request)
                self.assertFalse((Path(tmp_root) / "job-env").exists(), "TMPDIR nach dem Auftrag entfernt")
            command, timeout, env = run.call_args.args[0], run.call_args.args[1], run.call_args.args[2]
            self.assertEqual(env["TMPDIR"], str(Path(tmp_root) / "job-env"))
            self.assertEqual(env["HOME"], env["TMPDIR"])
            self.assertEqual(timeout, 5)
            self.assertIn("-tiso", command)
            self.assertEqual(command[-2:], [f"-o{box.work / 'job-env'}", str(box.bib / "r1/original/disc.bin")])
            self.assertEqual(events[-1]["status"], "fertig")
            self.assertEqual(events[-1]["format"], "iso9660")
            self.assertEqual(events[-1]["manifest"], [])

    def test_e2e_mini_iso_from_xorriso_extracts_with_manifest(self):
        seven = shutil.which("7zz") or shutil.which("7z")
        if not shutil.which("xorriso") or not seven:
            self.skipTest("xorriso oder 7-Zip fehlt")
        with Sandbox() as box, tempfile.TemporaryDirectory() as src_temp:
            src = Path(src_temp)
            (src / "DATEN").mkdir()
            (src / "README.TXT").write_bytes(b"hallo siedler\n")
            (src / "DATEN" / "KARTE.DAT").write_bytes(bytes(range(256)) * 4)
            image = box.bib / "r1" / "original" / "cd1.img"
            image.parent.mkdir(parents=True)
            subprocess.run(["xorriso", "-as", "mkisofs", "-quiet", "-R", "-J", "-V", "MINI", "-o", str(image), str(src)],
                           check=True, stdin=subprocess.DEVNULL, capture_output=True, timeout=60)
            self.assertEqual(runner.detect_format(image), "iso9660")
            request = {"kommando": "extrahieren", "eingabe": f"{box.bib}/r1/original/cd1.img",
                       "ausgabe": "/arbeit/job-e2e", "grenzen": {"zeitlimit_s": 60, "max_dateien": 10}}
            with patch.dict(runner.TOOLS, {"7zz": (seven, *runner.TOOLS["7zz"][1:])}):
                events = runner.run_request(request)
            final = events[-1]
            self.assertEqual(final["status"], "fertig", final)
            manifest = {entry["pfad"]: entry for entry in final["manifest"]}
            self.assertEqual(set(manifest), {"README.TXT", "DATEN/KARTE.DAT"})
            for entry in final["manifest"]:
                self.assertEqual(set(entry), {"pfad", "sha256", "groesse"})
            self.assertEqual(manifest["README.TXT"]["sha256"], hashlib.sha256(b"hallo siedler\n").hexdigest())
            self.assertEqual(manifest["DATEN/KARTE.DAT"]["groesse"], 1024)
            # same ISO under a misleading name is still recognised, and the output folder must be fresh
            with self.assertRaises(ValueError):
                runner.run_request(request)

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
            udf = runner.command_for("7zz", Path("/bib/in.iso"), Path("/arbeit/job"), {}, "udf")
        self.assertEqual(command[-2:], ["-o/arbeit/job", "/bib/in.iso"])
        self.assertNotIn("-tiso", command)
        self.assertEqual(udf[-3:], ["-tudf", "-o/arbeit/job", "/bib/in.iso"])
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


class ReverseT64Tests(unittest.TestCase):
    """P18-T64: Begleitdateien und klare Codes fuer noch nicht unterstuetzte Formate."""

    def test_clonecd_and_raw2352_are_named(self):
        with Sandbox() as box:
            ccd = box.put("rev/original/dateien/aa/disc.ccd", b"[CloneCD]\nVersion=3\n")
            img = box.put("rev/original/dateien/bb/disc.img", b"\x00" + b"\xff" * 10 + b"\x00" + b"\x00" * 2340)
            for source, detail in ((ccd, "clonecd"), (img, "raw2352")):
                events = runner.run_request({"kommando": "extrahieren", "eingabe": source, "ausgabe": "/arbeit/job1"})
                self.assertEqual(events[-1]["fehlercode"], "format_nicht_unterstuetzt")
                self.assertEqual(events[-1]["format_detail"], detail)

    def test_cue_finds_bin_among_companions(self):
        with Sandbox() as box:
            cue = box.put("rev/original/dateien/aa/game.cue", b'FILE "game.bin" BINARY\n  TRACK 01 MODE1/2352\n')
            binary = box.put("rev/original/dateien/bb/game.bin", b"\x00" * 4096)
            req = {"begleitdateien": [{"pfad": binary, "name": "game.bin"}]}
            self.assertEqual(runner.cue_image(Path(cue), runner.companions(req)), Path(binary))
            with self.assertRaises(ValueError):
                runner.companions({"begleitdateien": [{"pfad": "/etc/passwd", "name": "x"}]})

    def test_raw_bin_with_cue_companion_is_not_unsupported(self):
        with Sandbox() as box:
            binary = box.put("rev/original/dateien/aa/game.bin", runner.RAW_SYNC + b"\x00" * 2340)
            cue = box.put("rev/original/dateien/bb/game.cue", b'FILE "game.bin" BINARY\n')
            begleit = runner.companions({"begleitdateien": [{"pfad": cue, "name": "game.cue"}]})
            self.assertEqual(runner.unsupported_format(Path(binary), begleit), "")
            self.assertEqual(runner.unsupported_format(Path(binary)), "raw2352")

    def test_job_isolation_kills_orphans_and_cleans_tmp(self):
        """M1: verwaiste Kindprozesse sterben mit dem Auftrag, TMPDIR ist je Auftrag eigen und danach weg."""
        with Sandbox() as box, tempfile.TemporaryDirectory() as tmp_root, tempfile.TemporaryDirectory() as probe:
            source = box.put("rev/original/dateien/aa/a.zip", b"PK\x03\x04" + b"\x00" * 64)
            pidfile, tmpfile = Path(probe) / "pid", Path(probe) / "tmp"
            script = (f'sleep 60 & echo $! > {pidfile}; echo "$TMPDIR" > {tmpfile}; '
                      'echo rest > "$TMPDIR/rest"; exit 0')
            with patch.object(runner, "TMP_ROOT", Path(tmp_root)), \
                 patch.object(runner, "command_for", return_value=["sh", "-c", script]):
                started = time.monotonic()
                events = runner.run_request({"kommando": "extrahieren", "eingabe": source, "ausgabe": "/arbeit/job-iso"})
            self.assertLess(time.monotonic() - started, 20, "kein Warten auf das verwaiste Kind")
            self.assertEqual(events[-1]["status"], "fertig")
            job_tmp = tmpfile.read_text().strip()
            self.assertEqual(job_tmp, str(Path(tmp_root) / "job-iso"), "TMPDIR je Auftrag")
            self.assertFalse(Path(job_tmp).exists(), "TMPDIR nach dem Auftrag entfernt")
            pid = int(pidfile.read_text())
            deadline = time.monotonic() + 5
            while runner.alive(pid) and time.monotonic() < deadline:
                time.sleep(0.05)
            self.assertFalse(runner.alive(pid), "Kindprozess ueberlebt den Auftrag nicht")


class ReverseT62BombTests(unittest.TestCase):
    """P18-T62: Grenzen greifen WAEHREND des Entpackens; Abbruch in Sekunden, keine Teilausgabe auf der Platte."""

    CAP = {"zeitlimit_s": 30, "max_dateien": 50, "max_bytes": 1_000_000, "max_tiefe": 4,
           "max_kompressionsfaktor": 10}
    SOURCE = b"PK\x03\x04" + b"\x00" * 96  # 100 Bytes Eingabe

    def run_bomb(self, box, script, grenzen, guard_interval=None):
        source = box.put("rev/original/dateien/aa/bomb.zip", self.SOURCE)
        patches = [patch.object(runner, "command_for", return_value=["sh", "-c", script])]
        if guard_interval is not None:
            patches.append(patch.object(runner, "GUARD_INTERVAL_S", guard_interval))
        with tempfile.TemporaryDirectory() as tmp_root, patch.object(runner, "TMP_ROOT", Path(tmp_root)):
            for item in patches:
                item.start()
            try:
                started = time.monotonic()
                events = runner.run_request({"kommando": "extrahieren", "eingabe": source,
                                             "ausgabe": "/arbeit/job-bomb", "grenzen": grenzen})
                return events, time.monotonic() - started
            finally:
                for item in patches:
                    item.stop()

    def assert_no_output(self, box):
        self.assertEqual(list((box.work / "job-bomb").iterdir()), [], "keine Teilausgabe auf der Platte")

    def test_scan_output_names_each_limit(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            self.assertIsNone(runner.scan_output(root, self.CAP, 100))
            (root / "a").write_bytes(b"x" * 2000)
            self.assertEqual(runner.scan_output(root, self.CAP, 100)[0], "bombe_verdacht")
            self.assertIsNone(runner.scan_output(root, self.CAP, 1000))
            self.assertEqual(runner.scan_output(root, {**self.CAP, "max_bytes": 1000}, 0)[0], "zu_gross")
            for index in range(60):
                (root / f"e{index}").touch()
            self.assertEqual(runner.scan_output(root, self.CAP, 1000)[0], "zu_gross")
        with tempfile.TemporaryDirectory() as temp:
            Path(temp).joinpath(*["d"] * 6).mkdir(parents=True)
            self.assertEqual(runner.scan_output(Path(temp), self.CAP, 0)[0], "bombe_verdacht")

    def test_manifest_limit_errors_carry_deterministic_codes(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "a").write_bytes(b"x" * 2000)
            with self.assertRaises(runner.GrenzeUeberschritten) as bomb:
                runner.output_manifest(root, self.CAP, 100)
            self.assertEqual(bomb.exception.code, "bombe_verdacht")
            with self.assertRaises(runner.GrenzeUeberschritten) as big:
                runner.output_manifest(root, {**self.CAP, "max_bytes": 1000}, 0)
            self.assertEqual(big.exception.code, "zu_gross")

    def test_per_file_limit_uses_the_tighter_bound(self):
        self.assertEqual(runner.per_file_limit(self.CAP, 100), 1001)
        self.assertEqual(runner.per_file_limit(self.CAP, 0), 1_000_001)
        self.assertEqual(runner.per_file_limit(self.CAP, 10_000_000), 1_000_001)
        self.assertEqual(runner.file_limit_violation(self.CAP, 100)[0], "bombe_verdacht")
        self.assertEqual(runner.file_limit_violation(self.CAP, 10_000_000)[0], "zu_gross")

    def test_growing_output_is_stopped_within_seconds_and_removed(self):
        with Sandbox() as box:
            script = 'i=0; while :; do head -c 4096 /dev/zero > "f$i" 2>/dev/null; i=$((i+1)); done'
            events, elapsed = self.run_bomb(box, script, {"zeitlimit_s": 60, "max_kompressionsfaktor": 200})
            self.assertLess(elapsed, 10, "Abbruch waehrend des Laufs, nicht erst am Zeitlimit")
            self.assertEqual(events[-1]["status"], "fehler")
            self.assertEqual(events[-1]["fehlercode"], "bombe_verdacht", events[-1])
            self.assertEqual(events[-1]["manifest"], [])
            self.assert_no_output(box)

    def test_single_file_is_capped_by_rlimit_fsize(self):
        with Sandbox() as box, tempfile.TemporaryDirectory() as probe:
            size_file = Path(probe) / "size"
            script = f'head -c 10000000 /dev/zero > big 2>/dev/null; wc -c < big > {size_file}; exit 0'
            # Laufende Pruefung praktisch aus: nur RLIMIT_FSIZE + Endpruefung greifen.
            events, elapsed = self.run_bomb(box, script, {"zeitlimit_s": 60, "max_kompressionsfaktor": 200},
                                            guard_interval=60)
            self.assertLess(elapsed, 10)
            self.assertEqual(int(size_file.read_text().strip()), 100 * 200 + 1, "Datei bei der Grenze abgeschnitten")
            self.assertEqual(events[-1]["fehlercode"], "bombe_verdacht", events[-1])
            self.assert_no_output(box)

    def test_tool_killed_by_sigxfsz_counts_as_limit_even_without_leftover(self):
        with Sandbox() as box:
            script = 'head -c 10000000 /dev/zero > big 2>/dev/null; rm -f big; kill -XFSZ $$'
            events, _ = self.run_bomb(box, script, {"zeitlimit_s": 60, "max_kompressionsfaktor": 200},
                                      guard_interval=60)
            self.assertEqual(events[-1]["fehlercode"], "bombe_verdacht", events[-1])
            self.assert_no_output(box)

    def test_endless_files_hit_max_dateien(self):
        with Sandbox() as box:
            script = 'i=0; while :; do : > "e$i"; i=$((i+1)); done'
            events, elapsed = self.run_bomb(box, script, {"zeitlimit_s": 60, "max_dateien": 50})
            self.assertLess(elapsed, 10)
            self.assertEqual(events[-1]["fehlercode"], "zu_gross", events[-1])
            self.assert_no_output(box)

    def test_clear_output_removes_protected_directories(self):
        with tempfile.TemporaryDirectory() as temp:
            out = Path(temp) / "out"
            (out / "ro").mkdir(parents=True)
            (out / "ro" / "datei").write_bytes(b"x")
            (out / "zu" / "tief").mkdir(parents=True)
            (out / "zu" / "tief" / "datei").write_bytes(b"x")
            (out / "lose.bin").write_bytes(b"x")
            (out / "ro").chmod(0o555)
            (out / "zu").chmod(0o000)
            try:
                runner.clear_output(out)
                self.assertEqual(list(out.iterdir()), [])
            finally:
                for path in (out / "ro", out / "zu"):
                    if path.exists():
                        path.chmod(0o700)

    def test_cue_with_bin_companion_counts_the_whole_medium(self):
        """Kompressionsfaktor bezieht sich auf CUE + BIN, nicht nur auf die winzige CUE."""
        with Sandbox() as box:
            cue = box.put("rev/original/dateien/aa/game.cue", b'FILE "game.bin" BINARY\n  TRACK 01 MODE1/2352\n')
            binary = box.put("rev/original/dateien/bb/game.bin", b"\x00" * 50_000)
            script = 'head -c 40000 /dev/zero > track01.iso'
            with tempfile.TemporaryDirectory() as tmp_root, patch.object(runner, "TMP_ROOT", Path(tmp_root)), \
                 patch.object(runner, "command_for", return_value=["sh", "-c", script]):
                events = runner.run_request({"kommando": "extrahieren", "eingabe": cue, "ausgabe": "/arbeit/job-cue",
                                             "begleitdateien": [{"pfad": binary, "name": "game.bin"}],
                                             "grenzen": {"max_kompressionsfaktor": 2}})
            self.assertEqual(events[-1]["status"], "fertig", events[-1])

    def test_real_zip_bomb_with_7zip_is_stopped(self):
        seven = shutil.which("7zz") or shutil.which("7z")
        if not seven:
            self.skipTest("7-Zip fehlt")
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            archive.writestr("null.bin", b"\x00" * 50_000_000)
        data = buffer.getvalue()
        self.assertLess(len(data), 200_000, "klein komprimiert")
        with Sandbox() as box, tempfile.TemporaryDirectory() as tmp_root, \
             patch.object(runner, "TMP_ROOT", Path(tmp_root)), \
             patch.dict(runner.TOOLS, {"7zz": (seven, *runner.TOOLS["7zz"][1:])}):
            source = box.put("rev/original/dateien/aa/bomb.zip", data)
            started = time.monotonic()
            events = runner.run_request({"kommando": "extrahieren", "eingabe": source, "ausgabe": "/arbeit/job-bomb",
                                         "grenzen": {"zeitlimit_s": 120}})
            self.assertLess(time.monotonic() - started, 30)
            self.assertEqual(events[-1]["fehlercode"], "bombe_verdacht", events[-1])
            self.assert_no_output(box)


if __name__ == "__main__":
    unittest.main()
