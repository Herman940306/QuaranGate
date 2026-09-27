# BE8 Acceptance Matrix

| Requirement | Evidence |
| --- | --- |
| Stack detection for React/JS/Next.js | `frontend/tests/unit/be8-security-discovery-planner.test.ts` focused tests |
| .NET/C# detection | `frontend/tests/unit/be8-security-discovery-planner.test.ts` focused tests |
| Mixed-stack detection | `frontend/tests/unit/be8-security-discovery-planner.test.ts` focused tests |
| Unknown remains unknown | `frontend/tests/unit/be8-security-discovery-planner.test.ts` focused tests |
| Malicious paths/symlinks/oversized/binary/malformed manifests | `frontend/tests/unit/be8-security-discovery-planner.test.ts` focused tests |
| No package-script execution / no network / no dependency install | discovery safety contract and focused tests |
| Caller cannot spoof source/stack | R3 focused tests reject browser-supplied `files`, `sourceRevision`, `detectedStack`, forged discovery content and unknown fields |
| Trusted source authority | `SecuritySourceAdapter` is the only source snapshot boundary; requested project/target must match its trusted result; default production adapter fails closed |
| Caller cannot inject scanner commands | focused planner tests and no generic scanner API |
| Deterministic plan generation | focused planner tests using server-owned discovery state |
| Unavailable/required future capabilities remain unavailable | focused planner tests |
| Project/workspace/Principal isolation | `SecurityAssessmentService` re-resolves current membership and mapped Principal, authority-scopes discovery IDs, and ownership-checks result/plan lookup |
| HTTP request bounds | R3 tests cover declared and undeclared oversized request bodies plus invalid UTF-8/JSON before semantic parsing |
| BE1A regressions | `docs/product-platform/be8/evidence/be1a-regressions.txt` |
| Root validation | `docs/product-platform/be8/evidence/root-*.txt` |
| Frontend validation | `docs/product-platform/be8/evidence/frontend-*.txt` |
