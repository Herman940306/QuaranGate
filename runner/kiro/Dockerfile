# A4 Kiro ACP runner image — trusted Executor-selected infrastructure.
#
# Runs kiro-cli in ACP mode inside a hardened, isolated container. NOT a
# general-purpose Kiro image.
#
# Security invariants (rootfs/user/network are ALSO enforced by the Docker
# HostConfig at run time — this Dockerfile is defense in depth, not the only
# control):
#   * non-root (uid 1000:1000)
#   * read-only rootfs compatible (writable state lives on the per-job home
#     volume mounted at /home/runner and on /tmp tmpfs)
#   * isolated HOME/KIRO_HOME/XDG (no personal Builder ID inheritance)
#   * NO agent config baked in — the per-job bridge agent (with an unguessable
#     name) is delivered on the home volume, so a workspace .kiro/agents file
#     can never override it (Critical Finding #1)
#   * kiro-cli pinned — no auto-update; telemetry disabled; no MCP servers
#   * the API key is read at runtime from a RO secret file by the entrypoint;
#     it is NEVER baked into the image and NEVER in the container Env
#
# Build context must contain the pinned `kiro-cli` AND `kiro-cli-chat` binaries
# (both verified by SHA256).
#
# `kiro-cli` is only a DISPATCHER: `--version`, `--help`, `whoami` and
# `diagnostic` are answered in-process, but `acp`, `chat`, `agent`, `mcp` and
# `settings` are delegated by `Cli::execute_chat` to the sibling binary
# `kiro-cli-chat`, resolved next to the current executable. Shipping only
# `kiro-cli` makes `kiro-cli acp` fail at startup with
# `error: No such file or directory (os error 2)` while `whoami` still passes.
# `kiro-cli-term` (pty/shell integration) is deliberately NOT shipped: ACP needs
# no terminal integration, and omitting it keeps the runner surface minimal.
#
# kiro-cli is a glibc-linked (GNU/Linux) ELF, so the base MUST be glibc — an
# alpine/musl base cannot load its interpreter (/lib64/ld-linux-x86-64.so.2).
# ca-certificates is required for TLS to the Kiro endpoints.

FROM node:24-slim

# git gives Kiro repo awareness; ca-certificates for TLS. Create the isolated
# runner dir skeleton. The `node` user in this image is already uid:gid 1000.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /workspace /home/runner/.kiro/agents /home/runner/.kiro/settings \
    /home/runner/.local/bin /home/runner/.cache /home/runner/.config \
    /home/runner/.local/share /home/runner/.local/state /run/secrets \
 && chown -R 1000:1000 /workspace /home/runner /run/secrets \
 && chmod 0755 /workspace \
 && chmod 0700 /run/secrets

# Pinned kiro-cli binaries (SHA256-verified in the build pipeline). Installed
# OUTSIDE $HOME so the per-job RW home volume mounted at /home/runner cannot
# mask them. `kiro-cli-chat` MUST sit in the SAME directory as `kiro-cli` —
# the dispatcher resolves it relative to the current executable.
COPY kiro-cli /usr/local/bin/kiro-cli
COPY kiro-cli-chat /usr/local/bin/kiro-cli-chat
RUN chmod 0555 /usr/local/bin/kiro-cli /usr/local/bin/kiro-cli-chat

# Entrypoint: exports KIRO_API_KEY from the RO secret file, then exec's the
# trusted command. Owned by root, world-executable, not writable by the runner.
COPY kiro-acp-entrypoint.sh /usr/local/bin/kiro-acp-entrypoint
RUN chmod 0555 /usr/local/bin/kiro-acp-entrypoint

# Fully isolated environment — no host personal state is reachable.
ENV HOME=/home/runner \
    KIRO_HOME=/home/runner/.kiro \
    XDG_CONFIG_HOME=/home/runner/.config \
    XDG_DATA_HOME=/home/runner/.local/share \
    XDG_STATE_HOME=/home/runner/.local/state \
    XDG_CACHE_HOME=/home/runner/.cache \
    KIRO_DISABLE_UPDATE=1 \
    KIRO_TELEMETRY=off \
    NO_COLOR=1

USER 1000:1000
WORKDIR /workspace

# Verify the binaries are functional (no network). `acp --help` additionally
# proves the dispatcher can resolve and exec the `kiro-cli-chat` sibling — the
# exact defect that made `kiro-cli acp` exit 1 while `whoami` passed.
RUN kiro-cli --version \
 && kiro-cli acp --help

ENTRYPOINT ["/usr/local/bin/kiro-acp-entrypoint"]
CMD ["kiro-cli", "--version"]
