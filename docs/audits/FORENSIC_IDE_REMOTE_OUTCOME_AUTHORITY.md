# Forensic convergence — remote IDE mutation outcome authority

**Status:** REMEDIATED SOURCE CANDIDATE / NOT A LIVE-PRODUCTION CLAIM

## Discovery

The post-SH-15 forensic convergence pass inspected preserved divergent/dirty worktrees instead of deleting them. A preserved alternate SH-13 lane contained an unintegrated security finding: `IdeCompanionRemoteChannel` accepted the remote IDE/client's `implementation_result.outcome` verbatim. The current canonical implementation still reproduced that behavior.

## Security finding

`IdeImplementationCoordinator` intentionally treats several outcomes from a **trusted mutation adapter** as sufficient to release the exact B8 live-writer lease, including:

- `completed`;
- `failed_no_mutation`;
- `failed_rolled_back`;
- `cancelled_no_mutation`;
- `cancelled_rolled_back`.

That trust is not valid when the adapter result is merely a remote IDE/client assertion. A compromised same-user IDE extension/client could claim a safe terminal without independent proof of filesystem state, allowing shared writer authority to be released while mutation state remained unknown.

The defect is a latent source authority flaw rather than evidence of an active deployed exploit: current production IDE composition enables `userReviewIntents: true` and does not configure the paired `writerStore` + `implementationAdapter` required for mutation execution.

## Remediation

The remote channel now maps every valid remote implementation terminal outcome to exactly `indeterminate`. The backend-neutral coordinator therefore records `INDETERMINATE`, settles the exact live-writer lease to `UNCERTAIN`, and continues blocking a competing writer.

Trusted non-remote adapters retain their existing safe-outcome contract. A future remote path may release writer authority only after QuaranGate owns an independent mutation/postcondition verifier outside the remote client's assertion.

## Regression evidence

The direct protocol regression iterates every allowed remote implementation outcome and requires the server-side adapter result to be exactly `indeterminate`. VS Code and Cursor command-channel tests additionally require:

- a client-reported `completed` outcome to end `INDETERMINATE + UNCERTAIN`; and
- a client-reported pre-mutation/workspace failure to remain `INDETERMINATE + UNCERTAIN`, because the server cannot independently prove the client's no-mutation claim.

Red-before-fix evidence reproduced five unsafe outcome classes (`completed`, both failed safe claims, and both cancelled safe claims). The already-indeterminate class remained safe.

## Governance / non-claims

This remediation was performed on a fresh descendant of the accepted SH-15 canonical tip after forensic discovery. The preserved historical lane remains untouched. ChatGPT's acceptance, if completed, is an owner-authorized strict self-audit and is not independent review. No live VS Code/Cursor/provider qualification, production deployment, external penetration-test result, or same-UID malware isolation is claimed by this source fix.
