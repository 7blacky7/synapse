"""P18-T97: alter Test-Einstieg bleibt als Weiterleitung zum externen Leser.
Kein Legacy-Import, kein Decoder-Oracle und kein --export/Originaldaten-Zugriff."""
from pathlib import Path
import runpy
import sys

if __name__ == "__main__":
    if "--export" in sys.argv or "--probe-original" in sys.argv:
        raise SystemExit("Legacy-Export stillgelegt; externe Leser-Fixtures verwenden.")
    target = Path(__file__).resolve().parents[2] / "reverse-leser/tests/test_regression.py"
    sys.argv[0] = str(target)
    runpy.run_path(str(target), run_name="__main__")
