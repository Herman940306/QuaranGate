# BE8 R4 Documentation Truth Reconciliation Handoff

Role: narrow remediation author only. This candidate is not self-accepted.

## Base

BE8 R3 candidate:
e324c100fe50369de10596dd4f79b4728c3607ff

## Independent finding

The R3 source implementation closed the caller-controlled source-authority defect, but two retained BE8 architecture/security documents still described the obsolete model where browser input could supply static file metadata, and the acceptance matrix still cited the obsolete callerDeclaredStack test shape.

That documentation contradicted the remediated runtime boundary and could mislead future implementation work.

## R4 scope

Documentation only.

Updated:
- BE8_SECURITY_ANALYSIS.md
- BE8_ARCHITECTURE.md
- BE8_ACCEPTANCE_MATRIX.md

The corrected documents now state:
- browser input is limited to projectId, optional targetId and optional assessmentIntent;
- source files/metadata/sourceRevision/detected stack/provenance/discovery result are not browser authority;
- SecuritySourceAdapter is the only trusted source snapshot boundary;
- default production source adapter fails closed until governed registered-project integration exists;
- current R3 spoofing, request-bound and ownership tests are the acceptance references.

No frontend/runtime/test/dependency/evidence-history source changed.

## Acceptance boundary

R4 requires independent read-only review because the remediation author cannot accept the candidate.
BE8 integration remains blocked until R4 receives PASS_REVIEW and the subsequent backend convergence candidate is independently accepted.
