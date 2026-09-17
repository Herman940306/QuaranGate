# Forensic convergence — Ollama tool-argument representation

**Status:** REMEDIATED SOURCE CANDIDATE / LIVE PROVIDER REQUALIFICATION EXTERNAL

## Discovery

The preserve-first forensic convergence pass inspected the dirty historical `lane/o1-final-closeout` worktree rather than deleting it. That lane contained an uncommitted compatibility change based on a locally observed Ollama/model response in which `tool_calls[].function.arguments` arrived as one JSON-object string instead of the object shape declared by ollama-js.

Current canonical source still assumed the TypeScript declaration was a runtime guarantee and explicitly rejected every string representation. The preserved patch handled only `read_file`; its separate model-convergence instruction is already superseded by stronger current canonical O1 guidance and is not transplanted.

## Runtime evidence and boundary

Pinned ollama-js is `0.6.3`. Its `ToolCall` type declares `function.arguments` as an object, but the streaming parser JSON-parses only each outer response object and does not normalize the nested argument value. QuaranGate therefore cannot safely use the static type assertion as proof of the nested runtime representation.

This is a provider-compatibility/integrity defect, not an authorization bypass. Tool names, per-tool schemas, sensitive-path policy, read bounds, immutable staged workspace, no-write authority and Docker isolation remain unchanged.

## Remediation

QuaranGate now accepts exactly two top-level representations for arguments of the three existing O1 read tools:

1. an object, as before; or
2. one UTF-8 JSON string whose decoded value is a non-null, non-array object.

The string is bounded by the existing `MAX_OLLAMA_PROVIDER_RESULT_BYTES` limit before parsing and is parsed exactly once. Malformed JSON, double-encoded strings, arrays, scalars and `null` remain `MALFORMED_REQUEST`. After normalization, the existing strict field/value validators run unchanged, including unknown-field rejection.

The runtime tool-call type is changed to `unknown` at this boundary so the implementation no longer relies on the SDK declaration for authority or validation.

## Duplicate-call integrity

The immutable-snapshot duplicate suppressor previously signed the raw provider representation. An otherwise identical call could therefore alternate object and stringified-object encodings and appear distinct.

The signature now canonicalizes one valid top-level JSON-object string to the same semantic object form before stable key-order hashing. JSON-looking strings inside legitimate tool fields are not parsed. Malformed/oversized top-level strings retain their raw signature and subsequently fail strict validation.

## Red-before-fix evidence

Before remediation:

- a valid stringified `read_file` object failed with `arguments must be a plain object`;
- strict unknown-field validation was never reached for the stringified representation; and
- an object `literal_search` call followed by the same arguments as a JSON string executed twice instead of producing `REPEATED_TOOL_CALL`.

## Non-claims

This source remediation does not claim a fresh live Ollama/provider qualification, because the governed target currently has no Docker/provider runtime for that gate. It does not broaden the O1 tool catalog, add write/shell/web authority, alter sensitive-read policy, or accept arbitrary JSON/string coercions. ChatGPT acceptance, if completed, is an owner-authorized strict self-audit and is not independent review.

## Qualification before freeze

On the isolated lane based on exact canonical `28fc87f916d69ad7a1e24f044fd87a938111c381`:

- focused `tests/unit/o1-ollama-backend.test.ts`: `203/203 PASS`;
- full unit: `148/148 test files`, `3077/3077 tests PASS`;
- TypeScript typecheck: `PASS`;
- build: `PASS`;
- `git diff --check`: `PASS`;
- security invariants: `16/16 PASS`;
- deterministic security fuzz: `30067 executions`, `395 coverage ranges`, seed `1374718481`, `PASS`.

The governed worker has no live Docker/Ollama provider capability for a fresh provider-runtime requalification, so live provider truth remains explicitly external rather than inferred from these source tests.
