"""P18-T88: disk-backed metadata manifest. Binary bytes stay on the dataset.
No parser, no database, no second sync protocol: JSONL records + confirmed descriptor.
"""
from __future__ import annotations
import hashlib
import json
import os
from pathlib import Path
from typing import Any, Callable, Iterator

MANIFEST_NAME = ".e-manifest.jsonl"


class ManifestListe:
    """A bounded writer/iterator with the small control reply expected by the API."""
    def __init__(self, root: Path, record_bytes: int, segment_rows: int) -> None:
        self.root = root
        self.path = root / MANIFEST_NAME
        self.record_bytes = record_bytes
        self.segment_rows = segment_rows
        self.count = 0
        self.bytes = 0
        self.sha256 = ""
        self._handle: Any = None
        self._hash = hashlib.sha256()

    def __len__(self) -> int:
        return self.count

    def __iter__(self) -> Iterator[dict[str, Any]]:
        with self.path.open("rb") as source:
            while True:
                line = source.readline(self.record_bytes + 2)
                if not line:
                    return
                if len(line) > self.record_bytes + 1 or not line.endswith(b"\n"):
                    raise ValueError("manifest_record_zu_gross")
                yield json.loads(line)

    def append(self, value: dict[str, Any]) -> None:
        # Sizes remain exact through JavaScript's JSON transport.
        value = {**value, "groesse": str(value["groesse"])}
        raw = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if len(raw) > self.record_bytes:
            raise ValueError("manifest_record_zu_gross")
        if self._handle is None:
            self._handle = self.path.open("xb")
        raw += b"\n"
        self._handle.write(raw)
        self._hash.update(raw)
        self.count += 1
        self.bytes += len(raw)
        if self.count % self.segment_rows == 0:
            self._handle.flush()
            os.fsync(self._handle.fileno())

    def finish(self) -> None:
        if self._handle is None:
            self._handle = self.path.open("xb")
        self._handle.flush()
        os.fsync(self._handle.fileno())
        self._handle.close()
        self._handle = None
        self.sha256 = self._hash.hexdigest()

    def augment(self, update: Callable[[dict[str, Any]], None]) -> None:
        # Transform one record at a time; interrupted rewrite preserves the previous complete file.
        target = self.root / (MANIFEST_NAME + ".next")
        digest = hashlib.sha256()
        size = 0
        try:
            with target.open("xb") as sink:
                for value in self:
                    update(value)
                    raw = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
                    if len(raw) > self.record_bytes:
                        raise ValueError("manifest_record_zu_gross")
                    raw += b"\n"
                    sink.write(raw)
                    digest.update(raw)
                    size += len(raw)
                sink.flush()
                os.fsync(sink.fileno())
            target.replace(self.path)
            # Rename durable machen, bevor der Descriptor bestätigt wird.
            folder = os.open(self.root, os.O_RDONLY)
            try:
                os.fsync(folder)
            finally:
                os.close(folder)
            self.sha256 = digest.hexdigest()
            self.bytes = size
        finally:
            # Only our incomplete metadata replacement; never source/media bytes.
            target.unlink(missing_ok=True)

    def descriptor(self) -> dict[str, Any]:
        return {"version": 1, "pfad": MANIFEST_NAME, "sha256": self.sha256,
                "bytes": str(self.bytes), "zeilen": str(self.count)}
