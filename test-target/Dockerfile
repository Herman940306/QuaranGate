# Disposable bridge-owned integration target. Alpine + git + a workspace,
# a secret outside the workspace, and symlink escape fixtures.
FROM alpine:3.20
RUN apk add --no-cache git coreutils grep findutils procps \
 && git config --system user.email test@bridge.local \
 && git config --system user.name "bridge test" \
 && git config --system init.defaultBranch main
RUN mkdir -p /workspace /secretzone \
 && printf 'hello from workspace\n' > /workspace/README.md \
 && mkdir -p /workspace/src \
 && printf 'export const x = 1;\n' > /workspace/src/app.ts \
 && printf 'TOP SECRET - must never be reachable via the bridge\n' > /secretzone/secret.txt \
 && ln -s /etc/passwd /workspace/escape-passwd \
 && ln -s /secretzone /workspace/escape-dir \
 && cd /workspace && git init -q && git add -A && git commit -q -m "initial" || true
WORKDIR /workspace
# Keep the container alive
CMD ["sh", "-c", "while true; do sleep 3600; done"]
