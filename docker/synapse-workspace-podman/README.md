# synapse-workspace-podman — Container-Szenarien in der Sandbox testen (WS5)

Tier-2-Image auf Basis von `synapse-workspace:latest`: die KI kann hier
**Dockerfiles bauen** und **Container/Compose-Stacks ausfuehren** — rootless
und daemonlos via Podman. `docker` ist als Alias auf `podman` verlinkt, die
meisten Docker-Workflows laufen unveraendert.

## Warum Podman statt Docker?

| Variante | Risiko | Status |
|---|---|---|
| docker.sock in die Sandbox mounten | Sandbox kontrolliert den Unraid-Host-Docker = Host-Takeover | NIEMALS |
| `--privileged` DinD (dockerd im Container) | praktisch Root auf dem Host | NIEMALS |
| **rootless Podman (dieses Image)** | kein Daemon, kein Socket, user namespaces | ✅ WS5 |
| Sysbox-Runtime auf Unraid | echtes unpriv. DinD, Host-Eingriff noetig | optionaler spaeterer Track |

## Bauen (Unraid, NACH dem Basis-Image)

```bash
docker build -t synapse-workspace:latest        docker/synapse-workspace/
docker build -t synapse-workspace-podman:latest docker/synapse-workspace-podman/
```

## Nutzung (als Rolle, ab WS5-1/WS5-3)

```text
workspace(role_list)                       # Rolle "container-builder" (Seed, WS5-3)
workspace(exec, project, name:"builder", role:"container-builder",
  command:"podman build -t test:1 . && podman run --rm test:1")
podman-compose up -d                       # Compose-Stacks
```

Storage (Images/Container) liegt in `$HOME/.local/share/containers` —
persistent ueber Restarts, `reset_home` = kompletter Cache-Reset.

## Ehrliche Grenzen + Abhaengigkeiten

- **Voller Betrieb braucht WS5-1**: Rollen-Privilegien (devices `/dev/fuse` +
  seccomp-Anpassung, gated via ENV `SYNAPSE_WS_PRIVILEGED_ROLES`). Ohne diese
  Flags je nach Host-Docker-Version nur Teilbetrieb mit
  `podman --storage-driver vfs` (langsam) oder gar nicht — WS5-4 verifiziert
  das empirisch und dokumentiert den Ist-Stand.
- `BUILDAH_ISOLATION=chroot` ist gesetzt (Builds ohne Zusatzprivilegien);
  `XDG_RUNTIME_DIR=/tmp/runtime-synapse` (tmpfs, /run ist read-only).
- Kein KVM, kein systemd, keine privilegierten Container IN der Sandbox.
- Verschachtelte Container haengen NICHT im proxynet — Ports innerhalb des
  Workspace testen (`podman run -p` bindet auf den Workspace-Container,
  andere Instanzen erreichen ihn via `synapse-ws-<projekt>-<name>:<port>`).
- Abgrenzung: "Ich brauche eine DB/einen Dienst daneben" ist KEIN Fall fuer
  dieses Image — dafuer gibt es die WS4-Rollen (db-postgres, server, ...).
  Dieses Image ist fuer Projekte, deren Testgegenstand selbst
  Dockerfiles/Compose sind.
