# BE8 Acceptance Matrix

| Requirement | Evidence |
| --- | --- |
| Stack detection for React/JS/Next.js | `frontend/tests/unit/be8-security-discovery-planner.test.ts` focused tests |
| .NET/C# detection | `frontend/tests/unit/be8-security-discovery-planner.test.ts` focused tests |
| Mixed-stack detection | `frontend/tests/unit/be8-security-discovery-planner.test.ts` focused tests |
| Unknown remains unknown | `frontend/tests/unit/be8-security-discovery-planner.test.ts` focused tests |
| Malicious paths/symlinks/oversized/binary/malformed manifests | `frontend/tests/unit/be8-security-discovery-planner.test.ts` focused tests |
| No package-script execution / no network / no dependency install | discovery safety contract and focused tests |
| Caller cannot spoof stack | focused tests using `callerDeclaredStack` |
| Caller cannot inject scanner commands | focused planner tests and no generic scanner API |
| Deterministic plan generation | focused planner tests |
| Unavailable/required future capabilities remain unavailable | focused planner tests |
| Project/workspace isolation | `SecurityAssessmentService` focused tests |
| BE1A regressions | `docs/product-platform/be8/evidence/be1a-regressions.txt` |
| Root validation | `docs/product-platform/be8/evidence/root-*.txt` |
| Frontend validation | `docs/product-platform/be8/evidence/frontend-*.txt` |
