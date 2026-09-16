# Contributing to QuaranGate

QuaranGate is a security-sensitive engineering control plane. Contributions are welcome when they preserve its governed-authority model and arrive with evidence proportional to their risk.

## Before opening a change

For significant behavior, architecture, authority, security, installer, protocol, or UI changes, open an issue first so scope and acceptance criteria are clear. Small documentation and narrowly obvious fixes can go directly to a pull request.

Never include credentials, tokens, private customer source, or sensitive machine data in issues, commits, tests, screenshots, or logs.

## Development baseline

Use Node.js 22 or newer and the repository lockfile.

```bash
npm ci
npm run typecheck
npm test
npm run build
git diff --check
```

Run additional focused, integration, security, fuzz, chaos, installer, browser, or release-assurance checks when your change touches those surfaces. If a required environment is unavailable, report the check as blocked instead of claiming it passed.

## Change discipline

- Keep each change bounded to one understandable purpose.
- Preserve one live writer per worktree.
- Do not expand Docker, host-path, network, credential, provider, or live-source authority as a convenience workaround.
- Add a regression test for defects, especially security, recovery, lifecycle, race, or evidence-integrity defects.
- Do not rewrite frozen files under `docs/audits/` to make history look current.
- Update current-facing documentation when behavior, configuration, trust boundaries, or operator workflows change.

## Pull requests

Use the repository PR template. Record the exact checks actually run and their real outcomes. Include rendered evidence for Console/frontend changes where appropriate. Call out security and authority changes explicitly.

A merged change is not automatically a deployed or released capability. QuaranGate intentionally keeps implementation, review, acceptance, deployment, and release as separate gates.
