# BE9.2 R2 — product assessment MCP client bridge test hardening

Status: `CANDIDATE_READY_FOR_REVIEW / NOT_SELF_ACCEPTED`

Parent BE9.2 R1 candidate:

```text
fed2ca0449a8c6e253a4991784da3fcc03fa27c6
tree f319e05d146f1edd33e7e8bfedb38a61186042c2
subject fix(be9): bind durable reload truth
```

Accepted BE9.1 base remains:

```text
5be680eae9f492d36092abbe3f461a4fa6d70ff0
```

## Scope

This R2 continuation does not start BE10 and does not expand product, MCP, Docker, scanner, or credential authority.

It adds focused root unit coverage for the Gateway-side product assessment MCP client bridge:

- `QG_PRODUCT_INTERNAL_URL` must be an origin only;
- `PRODUCT_ASSESSMENT_MCP_TOKEN` must be distinct from bridge/internal credentials;
- malformed, oversized, and bad-envelope product responses fail closed;
- product internal status errors are mapped to bounded bridge errors;
- summary and evidence calls are routed only through the internal product adapter.

## Blocker handled

A source-hardening rewrite of `src/gateway/productAssessmentClient.ts` was attempted but rejected by Docker Authority command bounds. The writer did not bypass or weaken the authority control. The bounded continuation was reduced to focused test/evidence hardening.

## Qualification

See `docs/product-platform/be9/evidence/BE9_2_R2/VALIDATION.txt`.

Fresh executed gates:

- focused new test: 1 file / 6 tests PASS;
- root typecheck PASS;
- focused BE9/BE1A/AgentJobStore pack: 12 files / 181 tests PASS;
- full root unit suite: 184 files / 3463 tests PASS;
- `git diff --check` PASS.

Frontend gates were not rerun because this R2 changes only a root unit test and BE9 evidence docs.

## Review boundary

This implementation writer does not self-accept.

```text
BE9_2_ACCEPTED=NO
SELF_ACCEPTANCE=NO
BE10_START_ALLOWED=NO_UNTIL_INDEPENDENT_BE9_2_PASS_AND_ORCHESTRATION_GATE
NEXT=STRICT_INDEPENDENT_READ_ONLY_REVIEW_OF_CUMULATIVE_BE9_2
```
