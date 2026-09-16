# Security Policy

QuaranGate treats security reports as private engineering evidence, not public bug discussion.

## Supported versions

QuaranGate is currently pre-1.0. Security fixes target the current accepted development/release line unless a release note explicitly states that an older version is supported.

## Reporting a vulnerability

Do **not** open a public GitHub issue for a suspected vulnerability.

Use **Report a vulnerability** from the repository's Security tab once private vulnerability reporting is enabled. Include:

- affected version or exact commit SHA;
- affected component and trust boundary;
- minimal reproduction steps;
- realistic impact;
- required preconditions;
- whether credentials, private data, Docker authority, host paths, network egress, source mutation, or privilege escalation are involved;
- sanitized logs or proof where useful.

Do not send real credentials or unrelated private source. If private vulnerability reporting is temporarily unavailable, contact the repository owner through an established private channel and disclose details only after a private channel is confirmed.

## Handling and disclosure

The maintainer will validate the report, classify affected versions and severity, develop a bounded fix and regression test, and coordinate disclosure after remediation evidence exists. Public disclosure may be delayed when immediate publication would materially increase exploitation risk before a fix is available.

## Technical security model

The detailed QuaranGate threat model, trust zones, residual risks, and security invariants live in the versioned security documentation under `docs/`. Historical audit files remain historical evidence and are not retroactively rewritten.
