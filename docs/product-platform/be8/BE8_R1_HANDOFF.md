# BE8 R1 Authority-Binding Remediation Handoff

Role: implementation lead only. This candidate is not self-accepted.

## Base

- Failed BE8 candidate: `d7d6b451065a9a4875ddfa82873dfeaf6ebec829`
- Failed candidate tree: `306969757c89923498f62d9737e63dabccabf83a`
- Accepted common-base parent: `dae3b6bedb6f7d38481bc1de0d8bc61f0d7799e3`

## R1 scope

R1 closes the independent-review authority findings without broadening BE8 into scanner execution:

- current workspace membership is re-resolved through the existing trusted product context adapter;
- mapped QuaranGate Principal authority is mandatory and freshly resolved;
- API discovery input is limited to bounded project/target/intent identifiers;
- source revision and file bytes come only from a trusted `SecuritySourceAdapter`;
- the default production source adapter fails closed as unavailable until a governed registered-project source adapter is wired;
- server-owned discovery results are retained in a bounded store;
- plan creation accepts only a server-owned `discoveryId`;
- project/target mismatch fails closed;
- UTF-8 byte length is authoritative for size limits;
- file count, per-file bytes, total bytes, path length, project id, and target id are bounded.

## Preserved BE8 properties

Static stack detection, provenance, capability registry, applicability states, deterministic planning, UNKNOWN semantics, no scanner execution, no network, no dependency installation, no package-script execution, and `executionAuthority=false` remain unchanged.

## Acceptance boundary

R1 requires independent read-only review. It must not be integrated and BE9 must not start until that review passes and the subsequent convergence loop completes.
