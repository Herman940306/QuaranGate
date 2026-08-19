# Work-target base image for the assistant environment project.
#
# Git is baked in rather than installed at runtime because this container runs
# as an UNPRIVILEGED user (uid/gid 1000) — `apk add` at start-up would need
# root. Running as uid 1000 is deliberate and is what makes the read/write
# lane work correctly:
#
#   * cap_drop: ALL removes CAP_DAC_OVERRIDE, so a root process could NOT write
#     into the host-owned (uid 1000) project bind mount anyway. Matching the
#     host uid grants write access through ordinary file permissions instead of
#     through privilege.
#   * Files created by shell/exec tooling land on the host owned by the host
#     user, not by root.
#
# No secrets, no credentials, no build context beyond this file.
FROM alpine:3.20

RUN apk add --no-cache git bash python3 \
 && addgroup -g 1000 work \
 && adduser -D -u 1000 -G work -h /home/work work

ENV HOME=/home/work
WORKDIR /workspace
USER work

# Keep the container alive; the bridge drives it via docker exec.
CMD ["sh", "-c", "while true; do sleep 3600; done"]
