# Workspace mit Podman

[Synapse](../../README.md) › [Docker-Umgebung](../README.md) › Workspace mit Podman

## Zweck

Dieses Tier-2-Image erweitert den [Basis-Workspace](../synapse-workspace/README.md) um Podman und Werkzeuge zum Bauen und Ausführen verschachtelter Container. Podman läuft rootless und ohne Docker-Daemon; das Image stellt keinen Host-Docker-Socket bereit.

## Inhalt

| Datei | Aufgabe |
|---|---|
| [Dockerfile](Dockerfile) | Ergänzt das Basis-Image um Podman, Buildah, Skopeo, rootless Netzwerk- und Storage-Komponenten. |

## Schnittstellen nach außen

Die Workspace-Orchestrierung kann dieses Image als Workspace-Image verwenden. Innerhalb des Containers stellt Podman eine Docker-kompatible Kommandozeile bereit. Die Image- und Containerdaten liegen im persistenten Home des jeweiligen Workspace.

## Abhängigkeiten

Das Image baut auf [synapse-workspace](../synapse-workspace/README.md) auf. Podman, Buildah und Skopeo stellen die Containerfunktionen bereit; fuse-overlayfs und slirp4netns ergänzen Storage und rootless Netzwerk. Die REST-API-Orchestrierung ist in [REST-API-Services](../../packages/rest-api/src/services/README.md) eingeordnet.

## Siehe auch

- [Docker-Umgebung](../README.md)
- [Basis-Workspace](../synapse-workspace/README.md)
- [Zusammenhang und Betriebsvarianten](../../docs/README.md)
