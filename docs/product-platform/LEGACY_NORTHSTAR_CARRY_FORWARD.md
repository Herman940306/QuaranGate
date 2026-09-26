# Legacy North-Star Carry-Forward

This classification is based on current source/control evidence inspected during BE0. Historical narrative alone is not treated as completion evidence.

Status vocabulary:
- CLOSED_REUSABLE
- STILL_REQUIRED
- EXTERNAL_BLOCKED
- SUPERSEDED_BY_NEW_ARCHITECTURE
- MERGED_WITH_NEW_PRODUCT_GATE

## SH-03 — MCP protocol migration
**STILL_REQUIRED**

Current product source has a mature MCP surface, but the legacy roadmap still carries exact protocol migration/qualification work. Do not declare it closed from current tool count alone. Schedule through the orchestrator when exact dependencies/provenance are available.

## SH-04 — enterprise IdP decision
**MERGED_WITH_NEW_PRODUCT_GATE**

Identity architecture is now:
- Keycloak = product identity/session broker;
- Microsoft Entra ID = first enterprise federation profile;
- Entra claims never directly grant QuaranGate operational authority.

Legacy Entra-only framing is superseded by the merged model, but enterprise federation remains required.

## O1 — local model plane live requalification
**STILL_REQUIRED**

Source exists and current Control Center can report Ollama state. Final complete post-remediation live acceptance/requalification remains required.

## A7 — Copilot live acceptance
**EXTERNAL_BLOCKED**

Current source contains Copilot backend code, but project documentation still requires real provider/subscription qualification before production closeout.

## A8 — provider-backed live continuity
**STILL_REQUIRED**

Source/session-continuity machinery exists, but live provider-backed continuity remains not fully qualified in current executable state.

## P7 / IDE live closure
**STILL_REQUIRED**

IDE session/control source exists, including durable registry and writer binding. Live qualification remains a separate gate and current runtime reports IDE session control as not configured/fully live-qualified.

## GitHub platform governance / remote synchronization
**STILL_REQUIRED**

The governed GitHub control plane is reusable. Platform-level branch/rules/workflow/remote synchronization truth remains a release-track obligation and cannot be inferred from local source alone.

## P9 final release material rebuild
**MERGED_WITH_NEW_PRODUCT_GATE**

All pre-final-topology release material becomes historical once product topology changes. Exact-final product composition must rebuild/sign/bind P9 material from the final accepted candidate.

## P10 / A9 exact 15-step E2E
**MERGED_WITH_NEW_PRODUCT_GATE**

Preserve the established final system gate unless an authoritative contract change is separately reviewed. It must run against the final merged product, not only the legacy backend.

## P10-V visual contract
**MERGED_WITH_NEW_PRODUCT_GATE**

The legacy 21-route Console evidence remains relevant if that Console still ships. Final P10-V must reconcile all actually shipped product surfaces and use real runtime/rendered evidence plus independent acceptance.

## SH-14 external pentest
**EXTERNAL_BLOCKED**

Readiness/source work does not equal the external campaign. Final-candidate independent pentest/retest remains required.

## P11 production/tag/baseline
**STILL_REQUIRED**

Final forensic audit, immutable release artifacts, release version/tag, production deployment, post-deploy acceptance, documentation freeze and production baseline remain downstream release gates.

## P11-D
**STILL_REQUIRED**

The named gate exists in current handoff/orchestration material, but a detailed authoritative contract is still missing. Do not invent it. Recover or define it with owner approval before execution.

## Carry-forward sequencing

Product development should not be blocked by unavailable external gates where the roadmap explicitly permits parallel source work.

Required final convergence:
1. required frontend/backend waves accepted;
2. BE1A/F2A accepted;
3. legacy live/external obligations legitimately closed or explicitly owner-deferred where policy allows;
4. final integration candidate frozen;
5. independent final pentest/retest;
6. exact-final P9 release material/signing/trust;
7. P10/A9;
8. P10-V;
9. P11;
10. authoritative P11-D;
11. production baseline.
