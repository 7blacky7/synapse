# synapse-workspace-podman — Tier-2-Image fuer Container-Szenarien (WS5).
# Aufbau auf dem Tier-1-Image: KI kann hier Dockerfiles BAUEN und Container/
# Compose-Stacks AUSFUEHREN — rootless + daemonlos via Podman, OHNE dass die
# Sandbox den Host-Docker sieht (kein docker.sock, kein --privileged, NIE).
#
# Sicherheitsmodell:
#   - podman/buildah laufen als User synapse (rootless, user namespaces via
#     newuidmap/newgidmap + /etc/subuid).
#   - Image-/Container-Storage liegt im persistenten HOME-Volume
#     ($HOME/.local/share/containers) — reset_home = kompletter Cache-Reset.
#   - Voller Komfort (overlay via fuse-overlayfs) braucht /dev/fuse +
#     angepasstes seccomp → kommt per Rollen-Privilegien (WS5-1, ENV-Allowlist
#     SYNAPSE_WS_PRIVILEGED_ROLES). Ohne diese Flags: --storage-driver vfs
#     als langsamer Fallback (funktioniert je nach Host-Docker-Version).
#
# Bauen (NACH dem Basis-Image!):
#   docker build -t synapse-workspace:latest docker/synapse-workspace/
#   docker build -t synapse-workspace-podman:latest docker/synapse-workspace-podman/

FROM synapse-workspace:latest

USER root

# ---------------------------------------------------------------------------
# Podman-Stack (bookworm: podman 4.3): buildah (Builds), skopeo (Registry-Ops),
# fuse-overlayfs (Storage mit /dev/fuse), slirp4netns (rootless-Netz),
# uidmap (setuid newuidmap/newgidmap fuer user namespaces), podman-compose.
# subuid/subgid-Ranges fuer synapse — Pflicht fuer rootless userns.
# ---------------------------------------------------------------------------
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      podman buildah skopeo \
      fuse-overlayfs slirp4netns uidmap \
      podman-compose \
 && apt-get clean && rm -rf /var/lib/apt/lists/* \
 && echo 'synapse:100000:65536' > /etc/subuid \
 && echo 'synapse:100000:65536' > /etc/subgid \
 && ln -s /usr/bin/podman /usr/local/bin/docker

# ---------------------------------------------------------------------------
# Rootless-in-Container-Ergonomie:
# - XDG_RUNTIME_DIR → /tmp (einziges tmpfs mit exec; /run ist ReadonlyRootfs).
# - BUILDAH_ISOLATION=chroot: Builds ohne zusaetzliche Privilegien.
# - containers.conf/storage.conf: cgroupfs + file-Logger (kein systemd im
#   Container), overlay mit fuse-overlayfs als mount_program.
# ---------------------------------------------------------------------------
ENV XDG_RUNTIME_DIR=/tmp/runtime-synapse \
    BUILDAH_ISOLATION=chroot
RUN mkdir -p /etc/containers \
 && printf '[engine]\ncgroup_manager = "cgroupfs"\nevents_logger = "file"\n' > /etc/containers/containers.conf \
 && printf '[storage]\ndriver = "overlay"\n[storage.options.overlay]\nmount_program = "/usr/bin/fuse-overlayfs"\n' > /etc/containers/storage.conf

WORKDIR /workspace
USER synapse:synapse
