# SH-12 Prompt-Injection Security Campaign

STATUS: `R1_REMEDIATED / PENDING_INDEPENDENT_REVIEW`

SH-12 tests the product invariant that untrusted text may influence model prose
but can never grant, widen, or trigger product authority. The campaign is
source/test evidence; it is not a live-provider red-team certification.

## Threat sources

The fixed hostile corpus represents instructions embedded in:

- caller prompts;
- repository/file/tool-result content;
- provider assistant prose and native tool requests;
- review/evidence text;
- GitHub issue/review/body text;
- ACP server-initiated request parameters.

The corpus explicitly attempts to upgrade the profile, obtain shell/web/MCP or
Docker authority, read secrets, mutate host files, approve GitHub state, and
invoke `agent_apply` from text.

## Authority boundaries exercised or source-verified

1. **Kiro profile/tool authority** comes from the trusted profile contract, not
   prompt text. Read-only profiles retain only read/grep/glob. Implement adds
   the single path-scoped write tool; write is never globally trusted and shell,
   web, MCP, AWS and delegation remain outside the capability set.
2. **ACP server requests** are behaviorally exercised: terminal/fs/permission/
   MCP requests containing hostile approval/command/path data are refused with
   JSON-RPC method-not-permitted responses and increase the refusal counter.
3. **Ollama O1** exposes exactly `read_file`, `list_files`, and
   `literal_search`, all with closed argument schemas. Unknown native tool
   requests such as write/shell/apply/GitHub operations fail `FORBIDDEN_POLICY`.
   JSON/tool-looking assistant prose without native `tool_calls` remains prose.
4. **Copilot** starts with fixed read-only argv (`view,grep,glob`) and explicit
   write/shell/url/MCP denial. It rejects privileged ACP request attempts and
   any observed tool kind outside the read-only policy. The implement profile
   cannot be selected for this backend.
5. **Job authority** (`writer`) is derived from the trusted profile contract,
   not wording in the prompt. A hostile model summary may be stored as bounded
   result data but does not make the job APPLIED and cannot invoke apply.
6. **Apply/discard** remain separate owner/principal-authorized operations
   requiring the current job owner and trusted job/evidence state. The SH-12
   corpus directly proves hostile summary text cannot invoke apply; the wider
   principal/grant/discard checks are inherited source controls and existing
   A6 regressions, not new dedicated SH-12 cases.
7. **Review/evidence display** escapes structural newline/bidi controls so
   hostile file/path text cannot create fake diff control lines.
8. **GitHub review authority** remains a typed, separately authorized `event`;
   hostile review body text cannot substitute the event or smuggle scope/
   approval fields through the strict MCP schema. SH-12 directly exercises
   strict MCP input parsing; the gateway-to-executor forwarding revalidation is
   source-verified and covered by the existing GitHub suites.
9. **IDE review/implementation prompts** are bound to the exact session,
   connection generation, workspace attestation and operation capability, with
   a separate live-writer lease for implementation. These are inherited
   source controls and existing IDE regressions; this SH-12 fixed corpus does
   not claim a new end-to-end IDE adapter red-team run.

## Release integration

SH-12 adds mandatory release gate `security-prompt-injection`:

- fixed command: self-cleaning Vitest over `tests/unit/sh12`;
- tool identity: pinned Vitest `3.2.7`;
- exact clean source binding;
- nonzero all-passing test counts required by evidence bundling;
- included in release policy, assurance orchestration, policy report and final
  evidence bundle.

The required release-gate count becomes 18.

## Findings remediated

1. **Kiro runner-result framing was weaker than the declared trust boundary.**
   The executor searched for the result marker anywhere in any stdout line and
   cast arbitrary JSON directly to `RunnerResult`. SH-12 now requires exactly
   one marker-prefixed stdout frame, rejects unknown fields, validates bounded
   tool/result fields, and fails closed on duplicate/noisy/spoofed frames.
2. **Kiro's assistant bound used JavaScript character slicing even though the
   contract is bytes.** Hostile multi-byte Unicode could exceed the advertised
   result bound. Kiro now uses UTF-8 byte-safe truncation, matching Copilot.
3. **Kiro failure propagation could expose raw provider/container diagnostics.**
   Provider error text or stderr could become durable `failureReason` and later
   surface through `agent_result`. SH-12 replaces that path with bounded generic
   stage failures; raw provider stderr remains local execution evidence and is
   not copied into the public job result.
4. **Copilot result framing accepted additional stdout around the last marker.**
   The same single-frame fail-closed rule and bounded optional-field validation
   are now applied for parity.
5. **Normalized results still carried result-derived policy and diagnostic
   seams.** Kiro's malformed-control path embedded raw parser/filesystem error
   text even though the control JSON contains the caller prompt; both parsers
   accepted arbitrary bounded `error` strings; Kiro still accepted obsolete
   `stderrTail`; and the runner-provided `dryRun` echo was not bound to trusted
   construction-time policy. SH-12 now emits and accepts only enumerated
   stage errors, rejects `stderrTail`, binds `dryRun` to trusted options,
   rejects truncated output and nonzero success frames, and token-bounds
   protocol control strings. Raw prompt/provider diagnostics cannot become a
   durable failure reason through this boundary.
6. **The release-policy evaluator omitted fixed proof checks for mandatory
   security gates.** The new `security-prompt-injection` receipt—and the
   inherited `security-docker` receipt—could reach a policy PASS without the
   evaluator requiring the fixed command identity and nonzero passing test
   counts. Evidence bundling independently rejected such receipts, but the
   policy report itself was fail-open. Both gates now require exact execution
   evidence and test counts, with negative regressions for minimal fabricated
   PASS receipts.
7. **Ollama streamed provider results were accumulated before enforcement of
   a terminal envelope/summary limit.** Hostile or malformed provider prose or
   native tool-call structures could grow executor memory before validation.
   SH-12 adds fixed in-stream UTF-8 byte bounds, an immediate per-turn tool-call
   count bound and structured tool-result byte accounting. Oversized prose and
   tool structures fail closed before retention or execution.
8. **The widened unit gate exposed an invalid Unix-socket test oracle.** Two P7
   crash-recovery tests required a rebound socket to have a different inode
   number from the unlinked orphan, even though POSIX filesystems may reuse that
   number immediately. The product recovery path succeeded, but the tests failed
   deterministically on this filesystem. The tests now prove the intended
   security property directly: the exact owner-only orphan is reclaimed, the
   listener is rebound at mode `0600`, and the rebound endpoint completes an
   authenticated handshake or reaches the expected production availability
   state without rotating its durable credential. No P7 production code changed.
9. **Independent R1 review found raw Ollama provider diagnostics could still
   cross the backend boundary.** A rejected `chat()` request or streaming SDK
   exception could be classified as `FAILED_AGENT` while its arbitrary raw
   `Error.message` was persisted as `failureReason` and then reflected by public
   `agent_result`. R1 now converts only provider/SDK/stream failures to fixed
   `ollama provider request failed` or `ollama provider stream failed` errors at
   the Ollama boundary. Trusted QuaranGate `BridgeError` policy/output failures
   and AbortSignal-owned cancellation/timeout/shutdown causes retain their
   existing taxonomy. Deterministic regressions inject unique hostile markers
   through both request and stream failure paths and prove the markers are absent
   from the durable terminal row and public `agent_result`.

After R1 remediation, writer-side source and regression qualification found no
remaining reproduced path by which untrusted provider diagnostic text becomes
Ollama durable/client-visible failure state. Independent acceptance remains
pending; this is not a self-review or live-provider certification.

## R1 mutable-tree qualification

The final R1 pre-freeze mutable tree passed:

- fixed SH-12 gate: `2/2` files, `15/15` tests;
- adjacent Kiro/Copilot/Ollama/IDE corpus: `14/14` files, `424/424` tests;
- release policy/receipt/bundle corpus: `3/3` files, `35/35` tests;
- full unit corpus: `144/144` files, `3032/3032` tests;
- cumulative SH-09 through SH-12 fixed corpus: `7/7` files, `99/99` tests;
- TypeScript typecheck and production build: PASS;
- authority invariants: `15/15` rules across 10 Compose files and 7
  Dockerfiles;
- fixed-seed security fuzz: seed `1374718481`, 15 targets, 30,067 executions,
  and 395 coverage ranges;
- `git diff --check`: PASS;
- no new `.skip`, `.todo`, or `.only` weakening in the R1 test delta;
- `/tmp/q`: absent after widened validation;
- active-cgroup `oom_kill`: unchanged at `17` from the prior immutable SH-12
  qualification through this R1 pre-freeze run.

The sandboxed fuzz attempt was denied before execution with subprocess
`EPERM`; the identical command passed when permitted to run its local build
subprocess. That denial is isolation evidence and is not reported as a product
test result.

## Non-claims

- No live Kiro/Copilot/Ollama provider inference was performed for this gate.
- No live IDE extension/adapter red-team run or end-to-end downstream UI/log
  rendering certification was performed for this gate.
- No independent external prompt-injection red team is claimed.
- This does not replace SH-14 independent penetration testing.
- Text may still influence the *content* of model output or a write-capable
  Kiro implement sandbox within its pre-authorized capability; SH-12 proves it
  cannot create additional QuaranGate authority from text alone.
- Full release assurance remains separately blocked by the recorded external
  integration/E2E/scanner/provenance prerequisites until those are available.
