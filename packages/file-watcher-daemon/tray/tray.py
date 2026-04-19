#!/usr/bin/env python3
"""
Synapse FileWatcher Tray — minimales System-Tray-UI fuer Linux/macOS/Windows.

Spricht per HTTP mit dem moo-basierten Daemon (packages/file-watcher-daemon/).
Zeigt alle Projekte mit Status (●/○), Klick toggelt enable/disable.
Kein Config-File, keine Persistenz — alles lebt im Daemon.

Start:
    python3 tray.py

Abhaengigkeiten:
    sudo pacman -S python-pystray     (Arch/Cachy)
    sudo apt install python3-pystray  (Debian/Ubuntu)
    pip install pystray pillow        (portabel)
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path
from threading import Thread, Event

from PIL import Image, ImageDraw
import pystray


CONFIG_DIR = Path.home() / ".synapse" / "file-watcher"
PORT_FILE = CONFIG_DIR / "daemon.port"
DEFAULT_PORT = 7878
POLL_INTERVAL_S = 1.0
HTTP_TIMEOUT_S = 1.0


def daemon_port() -> int:
    try:
        return int(PORT_FILE.read_text().strip())
    except (OSError, ValueError):
        return DEFAULT_PORT


def daemon_base() -> str:
    return f"http://127.0.0.1:{daemon_port()}"


def http_json(method: str, path: str, body: dict | None = None) -> tuple[int, dict | str]:
    url = daemon_base() + path
    data = None
    headers = {}
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_S) as resp:
            raw = resp.read().decode()
            try:
                return resp.status, json.loads(raw)
            except json.JSONDecodeError:
                return resp.status, raw
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode())
        except Exception:
            return e.code, str(e)
    except urllib.error.URLError as e:
        return 0, f"connection failed: {e.reason}"
    except Exception as e:  # noqa: BLE001
        return 0, str(e)


# ---------- Icon-Generator ----------

def make_icon(connected: bool) -> Image.Image:
    """64x64 Icon: Kreis mit Punkt. Grau wenn Daemon offline, sonst gruen."""
    size = 64
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    outer = (84, 84, 84) if not connected else (76, 175, 80)
    d.ellipse((4, 4, size - 4, size - 4), fill=outer)
    d.ellipse((20, 20, size - 20, size - 20), fill=(30, 30, 30))
    return img


# ---------- Tray-App ----------

class TrayApp:
    def __init__(self) -> None:
        self.icon = pystray.Icon(
            "synapse-file-watcher",
            icon=make_icon(False),
            title="Synapse FileWatcher",
            menu=pystray.Menu(lambda: self._build_menu()),
        )
        self._stop_event = Event()
        self._projects: list[dict] = []
        self._connected = False

    # --- Daemon-Calls ---

    def refresh(self) -> None:
        status, body = http_json("GET", "/projects")
        connected = status == 200 and isinstance(body, dict)
        self._connected = connected
        self._projects = body.get("projekte", []) if connected else []
        self.icon.icon = make_icon(connected)
        self.icon.update_menu()

    def toggle_project(self, name: str, currently_enabled: bool) -> None:
        path = f"/projects/{name}/{'disable' if currently_enabled else 'enable'}"
        http_json("POST", path)
        self.refresh()

    def delete_project(self, name: str) -> None:
        http_json("DELETE", f"/projects/{name}")
        self.refresh()

    def open_config(self) -> None:
        try:
            os.system(f"xdg-open {CONFIG_DIR}")  # noqa: S605
        except Exception:
            pass

    # --- Menu ---

    def _build_menu(self) -> tuple:
        items: list = []
        items.append(pystray.MenuItem(
            f"Daemon: {'online' if self._connected else 'OFFLINE'}  ({daemon_port()})",
            None, enabled=False,
        ))
        items.append(pystray.Menu.SEPARATOR)

        if not self._connected:
            items.append(pystray.MenuItem(
                "Daemon starten: /tmp/synapse-fwd", None, enabled=False,
            ))
        elif not self._projects:
            items.append(pystray.MenuItem("keine Projekte registriert", None, enabled=False))
        else:
            for proj in self._projects:
                name = proj.get("name", "?")
                enabled = bool(proj.get("enabled", False))
                label = f"{'●' if enabled else '○'}  {name}"
                # Submenu mit Toggle + Delete
                items.append(pystray.MenuItem(
                    label,
                    pystray.Menu(
                        pystray.MenuItem(
                            "deaktivieren" if enabled else "aktivieren",
                            lambda _, n=name, e=enabled: self.toggle_project(n, e),
                        ),
                        pystray.MenuItem(
                            "entfernen",
                            lambda _, n=name: self.delete_project(n),
                        ),
                    ),
                ))

        items.append(pystray.Menu.SEPARATOR)
        items.append(pystray.MenuItem("Config-Ordner oeffnen", lambda _: self.open_config()))
        items.append(pystray.MenuItem("jetzt aktualisieren", lambda _: self.refresh()))
        items.append(pystray.MenuItem("Tray beenden", self._on_quit))
        return tuple(items)

    def _on_quit(self, icon, item) -> None:
        self._stop_event.set()
        icon.stop()

    # --- Push-Thread (SSE) mit Polling-Fallback ---

    def _sse_loop(self) -> None:
        """Verbindet sich mit /events (SSE) und ruft refresh() bei jedem Event.
        Bei Connection-Loss: kurzer Backoff, dann reconnect. Pollt zusaetzlich
        alle 5s als Fallback fuer den Fall dass der Daemon kein /events kann."""
        import urllib.request
        import urllib.error
        last_poll = 0.0
        while not self._stop_event.is_set():
            port = daemon_port()
            url = f"http://127.0.0.1:{port}/events"
            try:
                req = urllib.request.Request(url, headers={'Accept': 'text/event-stream'})
                with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_S) as resp:
                    for raw in resp:
                        if self._stop_event.is_set():
                            return
                        line = raw.decode('utf-8', errors='replace').rstrip()
                        # bei jedem data:-Frame oder Heartbeat refreshen
                        if line.startswith('data:'):
                            try:
                                self.refresh()
                            except Exception as e:  # noqa: BLE001
                                print(f"[tray] refresh error: {e}", file=sys.stderr)
            except (urllib.error.URLError, ConnectionError, OSError):
                pass  # Daemon nicht erreichbar — Backoff + retry
            # Polling-Fallback: refresh wenn lange nichts kam
            now = time.time()
            if now - last_poll >= POLL_INTERVAL_S:
                try:
                    self.refresh()
                except Exception:
                    pass
                last_poll = now
            self._stop_event.wait(POLL_INTERVAL_S)

    def run(self) -> None:
        self.refresh()
        Thread(target=self._sse_loop, daemon=True).start()
        self.icon.run()


if __name__ == "__main__":
    TrayApp().run()
