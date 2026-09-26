# BE8 Security Analysis

## Authority boundaries

BE8 keeps planner authority separate from execution authority. It does not introduce `run_security_tool`, `run_scanner`, `docker_run`, `shell_exec`, or any generic command execution API.

Browser input may request discovery for a governed project and may supply static file metadata, but it cannot declare authoritative stack facts. The server decides detected technologies and capability applicability.

## Read-only constraints

Discovery is static and read-only. BE8 does not run package scripts, perform dependency installation, build the target merely for discovery, execute scanners, or perform network requests.

## Path and parser safety

Workspace paths are normalized and rejected if absolute, escaping, empty, malformed, too long, or containing NUL/backslash escape shapes. Symlinks are unsupported. Oversized manifests are refused. Malformed package manifests become unsupported facts rather than fallback assumptions.

## Multi-tenant isolation

The service requires a product session with a workspace. Project IDs that attempt path-like or escaping forms are rejected. BE8 does not expose cross-workspace search or browser-supplied organization/workspace authority.

## Live gaps

BE8 does not qualify live Postgres, Keycloak/Entra, OpenBao, STT, audio capture, transcript store, realtime storage, or monitoring/runtime dependencies. Those remain open live qualification gates.
