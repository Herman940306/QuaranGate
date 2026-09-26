# BE8 R3 Request-Body Bound Remediation Handoff

Role: implementation lead only. This candidate is not self-accepted.

## Base

- BE8 R2 candidate: `3c3f1d30a13bfdd385b0a4077bd577dda362f720`
- R2 tree: `cc6848bc67f1ca1d2f0dd75b56c3392c50ecee23`

## Scope

R3 closes the remaining HTTP payload-bound gap identified during continued backend review:

- security discovery/start and plan POST bodies are bounded before JSON parsing;
- declared Content-Length above the bound fails before body consumption;
- bodies without Content-Length are streamed incrementally and cancelled once the byte ceiling is exceeded;
- invalid UTF-8 or malformed JSON maps to the bounded security request error;
- no route falls back to unbounded `request.json()` for these BE8 POST surfaces.

The current bound is 16 KiB, appropriate to the intentionally tiny BE8 command envelopes (`projectId`, optional `targetId`, optional intent, or `discoveryId`).

## Preserved authority model

R1/R2 protections remain intact:

- current workspace membership is freshly resolved;
- mapped QuaranGate Principal authority is mandatory and refreshed;
- browser cannot supply authoritative files, source revision, detected stack, provenance or discovery result;
- source bytes come only from the trusted source adapter;
- production source adapter remains fail-closed until governed project-source integration exists;
- plans accept only a server-owned discoveryId;
- discovery IDs are scoped to user/org/workspace/Principal plus trusted source discovery identity;
- CSRF/origin enforcement precedes both POST mutations;
- scanner execution/network/package scripts/dependency installation remain unavailable;
- executionAuthority remains false.

## Acceptance boundary

R3 requires independent read-only review. Do not integrate BE8 and do not start BE9 until independent review passes, BE8 is integrated into the backend convergence line, the combined candidate passes validation, and that convergence candidate is independently accepted.
