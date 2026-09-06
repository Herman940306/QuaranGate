# QuaranGate GitHub App Control Plane

Status: **IMPLEMENTATION CANDIDATE — OWNER-APPROVED READ / WRITE / REVIEW, NO MERGE**

## Purpose

QuaranGate may discover and operate on repositories exposed by the `QuaranHUB` GitHub App installations on explicitly trusted GitHub accounts without placing a reusable GitHub credential inside `projects-work`, the gateway, an agent runner, or an ordinary project target. Direct Git publication remains limited to separately registered local project mappings.

Approved public scopes:

```text
github:read
github:write
github:review
```

There is deliberately no `github:merge` authority or tool.

## Trust split

```text
ChatGPT / authenticated MCP client
             |
             v
Gateway
NO GitHub credential
NO GitHub-control network
             |
             v
Executor
Docker authority
NO App private key
NO direct Internet route
       |                         |
       | private control         | bounded branch push
       v                         v
GitHub broker                short-lived push helper
App private key              trusted project mounted RO
NO Docker socket             one-operation token volume RO
NO project mount             NO Docker socket
       |                         |
       +----------+--------------+
                  |
                  v
        GitHub-only CONNECT proxy
        exact hosts only, TLS passthrough
        api.github.com:443
        github.com:443
                  |
                  v
               GitHub
```

Three network boundaries are deliberate:

- `quarangate-internal`: gateway ↔ executor; the broker is not attached;
- `quarangate-github-control`: executor ↔ broker ↔ GitHub egress proxy and ephemeral push helpers; `internal: true`;
- `quarangate-github-egress`: proxy only; the proxy is the sole GitHub-control component with an external route.

The proxy uses an exact replacement allowlist (`api.github.com`, `github.com`) and port 443 only. Broker API traffic uses `HTTPS_PROXY=http://github-egress-proxy:8080`; push helpers use a fixed Git `https.proxy` setting. Neither the broker nor push helper has direct external routing.

## Credential boundary

The GitHub App RSA private key is mounted only into `github-broker`. The broker has no published port, Docker socket, or project filesystem mount. Its only non-secret configuration mount is the exact read-only `config/github.yaml` trust registry, which lets the credential boundary independently reject untrusted GitHub accounts even if an upstream caller is compromised. It validates the key and registry at startup and generates short-lived GitHub App installation tokens.

The JWT issuer uses `GITHUB_APP_CLIENT_ID`. For repository discovery, the broker resolves the QuaranHUB installation for a trusted account and mints a metadata-read installation token covering only repositories that installation can access. For repository-specific operations, it mints a token scoped to exactly one repository and the minimum operation-class permissions.

For branch publication, the executor receives a one-repository `contents:write` installation token only after it has independently verified that `expectedHead` equals the trusted local repository's current `HEAD`. The token is written into an operation-scoped Docker volume as a file and mounted read-only into the push helper. It never appears in Docker Env, command arguments, labels, MCP output, Git remote URLs, or public failure diagnostics.

The helper and token volume are removed after every attempt. Startup reconciliation removes any QuaranGate-labelled GitHub push helper/token resources left by an interrupted operation.

## Trusted account registry and local push mappings

`config/github.yaml` is gitignored live configuration. `config/github.example.yaml` is the committed contract.

The `accounts` list is the remote authority root. QuaranGate will enumerate only QuaranHUB installations whose account login matches one of those trusted entries. A public remote operation uses a bounded `owner/repository` identifier; both the gateway and executor reject owners outside the principal grant and trusted account registry, and the broker can obtain a repository token only when QuaranHUB actually has installation access to that repository.

```text
trusted account -> QuaranHUB installation -> repositories visible to the App
```

This enables current and future repositories on an approved account to appear automatically when the App installation uses **All repositories**, without broadening authority to unrelated GitHub accounts.

The optional `repositories` list is a separate local-push registry:

```text
local project -> owner/repo             from config/github.yaml
local project -> trusted hostPath       from config/agents.yaml
```

Only `github_push_branch` uses that local mapping. Multiple local worktrees may intentionally map to one remote repository.

Client authorization is split again:

- `githubAccounts` grants remote discovery/read/PR/review authority over trusted GitHub accounts;
- `githubProjects` grants direct-push authority over explicitly mapped local projects.

Target grants and agent `projects` grants imply neither GitHub grant. Missing/empty grants deny. `"*"` means the complete corresponding trusted registry, never arbitrary GitHub accounts, URLs, installation ids, API paths, host paths, Docker options, or credentials.

## Public tools

Read (`github:read`):

- `github_repositories`
- `github_repository`
- `github_branches`
- `github_commits`
- `github_pull_requests`
- `github_pull_request`
- `github_pull_request_files`
- `github_issues`
- `github_issue`
- `github_issue_comments`
- `github_pull_request_reviews`
- `github_pull_request_review_comments`
- `github_checks`

Write (`github:write`):

- `github_push_branch`
- `github_pull_request_create`
- `github_pull_request_update`

Review (`github:review`):

- `github_pull_request_review` (`COMMENT`, `APPROVE`, `REQUEST_CHANGES`)

Not exposed:

```text
merge
force push
ref deletion
tag/release creation
workflow modification
repository creation/deletion
repository settings
secrets
collaborators/teams
webhooks
GitHub App administration
arbitrary REST/GraphQL requests
arbitrary remote URLs
```

## Push contract

`github_push_branch` accepts only:

```text
project
expectedHead   exact 40-hex current local HEAD
remoteBranch
```

Before requesting a write token, a hardened network-disabled helper mounts only the trusted project read-only and runs a fixed `git rev-parse HEAD`. Any mismatch with `expectedHead` fails closed.

The push helper executes a fixed pure-argv command equivalent to:

```text
git \
  -c safe.directory=/src \
  -c https.proxy=http://github-egress-proxy:8080 \
  -C /src \
  push --porcelain \
  https://github.com/<trusted-owner>/<trusted-repo>.git \
  <expectedHead>:refs/heads/<remoteBranch>
```

Authentication is supplied through a file-backed `GIT_ASKPASS` helper. The token is never embedded in the URL or command line.

Direct push is refused when the destination is:

- the repository's current default branch;
- listed in trusted `protectedBranches`;
- reported by GitHub as protected.

No force flag, delete refspec, tag refspec, arbitrary refspec, or caller-selected remote can be expressed. Ordinary Git non-fast-forward protection remains active. After success, the executor re-reads the exact branch from GitHub and requires its SHA to equal `expectedHead`.

## GitHub App permissions

Owner-approved QuaranGate-required repository permissions:

```text
Metadata:         Read-only
Contents:         Read & write
Pull requests:    Read & write
Issues:           Read-only
Commit statuses:  Read-only
```

GitHub **Checks** permission is intentionally not required. The public `github_checks` tool retains its existing response shape for compatibility, but reads only commit statuses and returns `checkRuns: []`. Any additional GitHub App permissions the owner has deliberately enabled (for example Actions or Discussions) remain owner-controlled and are not requested or depended on by QuaranGate.

No Administration permission and no Workflows permission are required. Webhooks and user authorization are not required.

The broker uses App JWT authentication to resolve trusted-account installations and repository installations. Discovery tokens are account-installation tokens reduced to metadata read and see only repositories granted to that installation. Operation tokens are reduced again to one repository and one operation-class permission set. Installation tokens expire according to GitHub's installation-token contract.

## Installation visibility

The owner-selected App name is **QuaranHUB**. Register it as installable on **Any account** so the same App can be installed on the personal account and approved organizations.

The initial live trust registry may contain only the owner's personal account:

```text
Herman940306
```

Choose **All repositories** for that installation. GitHub then automatically includes repositories created later under the account. Organizations such as `JustAGameZA` or `ZerithZA` are added only after their owner/admin installs QuaranHUB with **All repositories** and the QuaranGate owner explicitly adds that organization to `config/github.yaml`. QuaranGate still fails closed because only accounts listed in trusted `config/github.yaml` and allowed by the client `githubAccounts` grant are usable. An installation on some unrelated third-party account does not become visible merely because the App can be installed there.

Repository-specific Git push remains more restrictive: a repository must additionally have a trusted local `project` mapping before `github_push_branch` can publish an exact local HEAD.

## Runtime overlay

Enable only after the App exists, its private key is stored locally, and `config/github.yaml` has been reviewed:

```text
compose.yaml
+ compose.ollama.yaml   when O1 is active
+ compose.github.yaml
```

Required operator inputs:

```text
GITHUB_APP_CLIENT_ID
GITHUB_APP_PRIVATE_KEY_FILE
GITHUB_GIT_HELPER_IMAGE
```

The Git helper image must already exist locally and must be an explicit non-`:latest` selection. Unattended recovery performs no pull or build.

## Secret handling

Recommended host path:

```text
/home/herman/.config/quarangate/github-app-private-key.pem
```

The host file should be mode `0600`, owned by the normal workstation user. Never put the private key in `.env`, `config/github.yaml`, `config/clients.yaml`, MCP arguments, Git URLs, logs, or source control.

The GitHub App Client ID is not secret and may be stored in the ignored `.env`.

## Acceptance gates

Before production enablement:

1. typecheck, focused tests, full unit suite and build pass;
2. config validator accepts `clients.yaml`, `agents.yaml`, and `github.yaml`;
3. combined base + O1 + GitHub Compose graph preserves every required network/service;
4. gateway remains absent from `quarangate-github-control`;
5. broker has no published port, Docker socket, project mount, general internal network, or direct egress network;
6. private key is visible only to the broker;
7. GitHub egress proxy has no project mount/socket/host port and is the only GitHub component attached to `quarangate-github-egress`;
8. push helper has source RO, secret volume RO, no Docker socket, cap-drop ALL, no-new-privileges, read-only rootfs, and only `quarangate-github-control`;
9. local `HEAD` must equal `expectedHead` before a write token is minted;
10. `github:read` client can list/read only repositories under granted trusted accounts;
11. client without `github:write` cannot push/create/update PRs;
12. client without `github:review` cannot submit a review;
13. untrusted GitHub account is denied, and direct push from an unmapped local project is denied;
14. arbitrary owner/repo/URL cannot be expressed;
15. default/protected branch direct push is denied;
16. exact-current-HEAD feature-branch push succeeds and post-verifies remote SHA;
17. PR creation and bounded PR read/files/reviews/review-comments plus `github_checks` commit-status reads and issue/detail/comment reads succeed;
18. COMMENT review succeeds; APPROVE/REQUEST_CHANGES are exercised only on a disposable owner-approved PR where GitHub permits the App actor to submit that review;
19. no merge scope/tool exists in the advertised MCP surface;
20. gateway remains loopback-only and executor/broker/proxy remain unpublished;
21. remote-owner recovery preserves the GitHub overlay without pulling/building;
22. failure rollback restores the exact prior GitHub-service presence/images as well as gateway/executor state.

## Owner gate

Creating/installing the GitHub App, selecting its globally unique name, choosing the accounts/repositories where it is installed, and supplying the generated private key remain owner actions. Source implementation must not invent the App identity, expand installation access, or enable additional permissions without a separate owner decision.
