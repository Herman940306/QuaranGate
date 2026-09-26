# BE1A Acceptance Matrix

| Requirement | Evidence / test | Status before independent review |
|---|---|---|
| Long A does not stall B/C/D | `be1a-execution-fabric.test.ts` four-project long-job test | IMPLEMENTED |
| Four projects active concurrently | same test observes `countActive() === 4` | IMPLEMENTED |
| Same resource serializes | temp-root shared resource test | IMPLEMENTED |
| Non-overlap runs concurrently | distinct temp-root / owner-host scope tests | IMPLEMENTED |
| Owner-host conflict semantics | distinct/same owner-host scope test | IMPLEMENTED |
| Global-exclusive serialization | global-exclusive test + held-lease admission rule | IMPLEMENTED |
| Starvation resistance | repeated Project A load first-wave A/B/C/D test | IMPLEMENTED |
| Cancellation isolation | A cancellation while B continues/completes | IMPLEMENTED |
| Crash uncertainty | recoverActive -> UNCERTAIN test | IMPLEMENTED |
| Stale/uncertain recovery | conflict blocks until evidence-bound settlement | IMPLEMENTED |
| Cache invalidation | snapshot generation/cache test | IMPLEMENTED |
| Caller cannot choose resources/concurrency | spoofed request + config-negative tests | IMPLEMENTED |
| Path traversal/selector identity rejected | store/config negative tests | IMPLEMENTED |
| Existing ACP regressions | existing agent job engine/store/config suites | REQUIRED GATE |
| Live-writer regressions | existing live-writer suites | REQUIRED GATE |
| Apply/evidence regressions | existing apply/artifact suites | REQUIRED GATE |
| Full unit suite | serialized root Vitest | REQUIRED GATE |
| Build/typecheck | root scripts | REQUIRED GATE |
| SCA/secret scan | available project gates | REQUIRED GATE / availability recorded honestly |

No row in this file constitutes independent acceptance.
