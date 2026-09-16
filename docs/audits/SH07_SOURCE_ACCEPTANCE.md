# SH-07 Source Acceptance Receipt

## Verdict

`OWNER_AUTHORIZED_STRICT_SELF_AUDIT_PASS / SH07_SOURCE_ACCEPTED`

This is an owner-authorized strict self-audit by the active ChatGPT engineering
writer. It is not represented as independent review, penetration-test
certification, live-provider certification, fuzzing, chaos testing, or a
production-release approval.

## Immutable source identity

- Canonical base: `218ad1befb0778642bcb22687d950b4047ce0962`
- Transplanted principal-isolation commit: `80c9a031bed7272e3e9b227394e8dae8c0f282c5`
- SH-07 implementation candidate: `4076060d3779fa5b4a83de1e1f1560da237e33fb`
- Implementation parent: `80c9a031bed7272e3e9b227394e8dae8c0f282c5`
- Implementation tree: `16664e70bdc7e85a3e92ac7f7f22870ca0999deb`
- Implementation patch SHA-256: `9ee7e3ae96458a9936944b37931392bff6043b5a60b1356733fc0ee961256fff`
- Base-to-implementation cumulative patch SHA-256: `1efc744e0cfd9e61e533e56671917c1b9e91bedb7177ddc9f241ea971a99c943`
- Base-to-implementation path/status SHA-256: `b7adc32a684c9031779637f73a5e3975245cf89f589fb8fc573836bdcc814e6a`
- Base-to-implementation content-manifest SHA-256: `f22635cd3f1c1a8b0421a5cee6c55a407a8d74e230cdef820c4370d315589b60`

The cumulative SH-07 source delta is eight paths: one audit document, six new
SH-07 unit files, the previously transplanted principal-context unit file, and
one existing apply-engine unit file. There is no `src/`, runner, package,
Compose, Dockerfile, config, credential, egress, runtime, or authority mutation.

## Adversarial matrix accepted

The exact candidate proves all frozen SH-07 families:

- concurrent AsyncLocalStorage principal isolation and nested exception restore;
- static API-key / OAuth bearer identity equivalence and shared principal rate accounting;
- target / Agent / GitHub confused-deputy separation;
- hostile audit/telemetry credential redaction and JSON framing;
- malformed/oversized multi-plane rejection and authority-smuggling refusal;
- evidence tamper cannot cross `agent_apply` into applier I/O;
- provider failure/cooldown state cannot create grants or fallback authority;
- cryptographically valid stale IDE generations remain denied by session/event binding.

SH-01 origin/DNS, SH-03 MCP protocol migration, SH-08 fuzz/property testing and
SH-09 crash/chaos testing remain separate gates and are not inferred from this
acceptance.

## Validation on exact immutable candidate

- Focused SH-07 + underlying primitive suites: `18/18 files`, `225/225 tests` PASS.
- Full repository unit suite: `130/130 files`, `2893/2893 tests` PASS.
- TypeScript typecheck: PASS.
- Build: PASS.
- `security:invariants`: PASS, `12/12` rules across `10` Compose files and `7` Dockerfiles.
- `git diff --check`: PASS.
- Skip/todo/only scan over the cumulative SH-07 test delta: none.
- Production/runtime path delta: none.
- Cgroup `oom_kill` remained `17 -> 17` across typecheck/build; no SH-07 resource failure occurred.
- The exclusive `/tmp/q` test root was absent after focused and full-unit runs.

## Security conclusion

No SH-07 adversarial case exposed a product-controlled defect requiring runtime
remediation. The accepted source adds regression evidence only and does not
broaden Docker, filesystem, network, provider, GitHub, IDE, writer, credential,
or production authority.
