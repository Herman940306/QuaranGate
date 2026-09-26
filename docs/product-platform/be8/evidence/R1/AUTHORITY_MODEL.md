# BE8 R1 trusted authority model

Request authority is intentionally narrow:

`authenticated session -> current membership -> current mapped Principal -> trusted registered source adapter -> bounded static snapshot -> server-owned discovery store -> plan by discoveryId`

The browser can provide only `projectId`, optional `targetId`, and optional `assessmentIntent`.

The browser cannot provide source files, file contents, source revision, detected stack, provenance, applicability, discovery results, scanner commands, host paths, Docker options, or execution resource keys.

The default production `SecuritySourceAdapter` is unavailable/fail-closed. Tests inject an explicit trusted adapter. This avoids inventing arbitrary host-path access before the governed registered-project source integration exists.

Discovery results are process-local BE8 planning state only. No durable asynchronous-job claim is made and `executionAuthority=false`.
