# Read-only review target for the Secure Dev assistant environment project.
#
# git, bash, and python3 are baked in at build time so the container needs
# no network access or package manager at runtime.
#
# No secrets, no credentials, no build context beyond this file.
FROM alpine:3.20

RUN apk add --no-cache git bash python3

WORKDIR /workspace

# Keep the container alive; the bridge drives it via docker exec.
CMD ["sh", "-c", "while true; do sleep 3600; done"]
