## Summary

Describe the problem solved and the bounded change made.

## Scope

- Base commit / branch:
- Changed areas:
- Intentionally out of scope:

## Authority / security impact

Check every statement that is true and explain any unchecked item below.

- [ ] No new host-path authority
- [ ] No new Docker authority or privilege
- [ ] No new network destination / egress
- [ ] No new credential or secret handling
- [ ] No new live-source writer or promotion path
- [ ] No weakened authentication / authorization / validation
- [ ] No frozen historical audit evidence rewritten

Security-impact explanation:

## Validation

Record actual results; do not write PASS for checks that were not run.

- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] `git diff --check`
- [ ] Relevant focused tests
- [ ] Security invariants / release gates where applicable

Evidence / logs / receipts:

## Frontend changes

- [ ] Not applicable
- [ ] Screenshots or rendered evidence attached
- [ ] Keyboard / focus behavior checked
- [ ] Narrow viewport / zoom checked where relevant
- [ ] Error, loading, denied, and degraded states considered

## Operational impact

Migration, rollout, rollback, recovery, config, compatibility, or operator notes:

## Documentation

- [ ] User/operator documentation updated if behavior changed
- [ ] Security documentation updated if a trust boundary changed
- [ ] Historical audit records left historical

## Reviewer focus

List the highest-risk assumptions or code paths that deserve adversarial review.
