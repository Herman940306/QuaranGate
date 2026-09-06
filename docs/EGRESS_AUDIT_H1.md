# H1-7: Egress Audit Inventory

**Machine-readable inventory of QuaranGate egress destinations.**

This document catalogs every external network destination used by QuaranGate components. Every entry includes:
- **Component**: which QuaranGate service/process originates the connection
- **Destination**: hostname or network endpoint
- **Port**: TCP port number
- **Purpose**: what the connection is used for
- **Source of Authority**: where this requirement is documented/proven

**Policy**: Do not broaden any egress rule without owner approval. Narrowing is permitted when safety can be proven.

---

## Kiro ACP Runner Egress (A4)

**Component**: Kiro runner sandbox (ephemeral job containers)<br>
**Enforcement**: `src/executor/agents/egressProxy.ts` CONNECT proxy allowlist<br>
**Network**: job-scoped internal network → proxy → external

| Destination | Port | Purpose | Source of Authority |
|------------|------|---------|-------------------|
| `runtime.us-east-1.kiro.dev` | 443 | Kiro Runtime Service (KRS) — primary model inference | A4 audit: kiro-cli 2.5.0 binary egress trace |
| `runtime.eu-central-1.kiro.dev` | 443 | Kiro Runtime Service (KRS) — EU region | A4 audit: kiro-cli 2.5.0 binary egress trace |
| `prod.us-east-1.auth.desktop.kiro.dev` | 443 | Kiro desktop auth endpoint — API key exchange | A4 audit: kiro-cli 2.5.0 binary egress trace |
| `cognito-identity.us-east-1.amazonaws.com` | 443 | AWS Cognito Identity — Kiro credential exchange | A4 audit: proxy logs prove this is required for "not logged in" → authenticated |
| `oidc.us-east-1.amazonaws.com` | 443 | AWS OIDC token endpoint — part of Kiro auth flow | A4 audit: kiro-cli 2.5.0 binary egress trace |
| `codewhisperer.us-east-1.amazonaws.com` | 443 | AWS CodeWhisperer backend — ACP startup + auth | A4 audit: kiro-cli 2.5.0 binary egress trace |
| `q.us-east-1.amazonaws.com` | 443 | Amazon Q inference backend — REQUIRED for model turns | A4 audit: proxy logs prove turn fails without this (ACP -32603 error) |

**Explicitly OMITTED** (non-fatal; must not be allowlisted):
- `client-telemetry.us-east-1.amazonaws.com` — optional telemetry; blocked by design
- `desktop-release.q.us-east-1.amazonaws.com` — update check; blocked by design

**IP Literal Policy**: Refused (hostname-only allowlist)<br>
**Private Address Policy**: Refused post-DNS (169.254.169.254, RFC1918, etc.)<br>
**Docker Internal**: Refused (172.17.0.0/16, job networks, quarangate-internal)<br>
**Connection Lifetime**: Max 10 minutes per connection<br>
**Concurrency**: Max 32 connections per proxy instance

**Validation**: `src/executor/agents/egressProxy.ts` lines 42–77 (KIRO_PROVIDER_ALLOWLIST constant)

---

## Ollama Backend Egress (O1)

**Component**: Ollama read-only backend (optional)<br>
**Enforcement**: no network isolation for Ollama itself; the Ollama service runs on the host or a trusted network location<br>
**Configuration**: `OLLAMA_HOST` env var (operator-configured, not caller-selectable)

| Destination | Port | Purpose | Source of Authority |
|------------|------|---------|-------------------|
| `${OLLAMA_HOST}` | 11434 (default) | Ollama API endpoint — model inference for O1 read-only jobs | O1 design: operator deploys Ollama separately |

**Network Boundary**: Ollama is NOT accessed from inside the runner sandbox. The O1 helper container (separate from Kiro runner) makes HTTP requests to `OLLAMA_HOST` directly from the executor's network context. No egress proxy is used.

**Default**: Disabled. Ollama backend is only wired when `OLLAMA_HOST`, `OLLAMA_MODEL_QUALIFIER`, `AGENT_HELPER_IMAGE`, and `AGENT_STAGER_IMAGE` are all explicitly set.

**Validation**: `src/executor/startupPolicy.ts` lines 48–52 (Ollama host requirement)

---

## GitHub Control Plane Egress (A7 Candidate)

**Component**: GitHub App control plane (optional)<br>
**Enforcement**: git-helper container on a dedicated `GITHUB_CONTROL_NETWORK`<br>
**Configuration**: `GITHUB_CONFIG` env var (operator-configured)

| Destination | Port | Purpose | Source of Authority |
|------------|------|---------|-------------------|
| `github.com` | 443 | GitHub API — repository metadata, push operations | A7 design: GitHub App authenticated push |
| `api.github.com` | 443 | GitHub REST API — optional direct API access | GitHub API documentation |

**Proxy Configuration**: `https.proxy=http://github-egress-proxy:8080` (git config)<br>
**Network**: GITHUB_CONTROL_NETWORK (operator-managed Docker network, separate from quarangate-internal)

**Default**: Disabled. GitHub control plane is only wired when `GITHUB_CONFIG` exists and `GITHUB_GIT_HELPER_IMAGE` + `GITHUB_CONTROL_NETWORK` are configured.

**Validation**: `src/executor/index.ts` lines 411–429 (GitHub precondition checks)

---

## Gateway OAuth Egress

**Component**: Gateway OAuth 2.1 provider flows<br>
**Status**: **OWNER_NETWORK_DECISION_REQUIRED**

The gateway OAuth implementation (`src/gateway/auth/oauth.ts`) defines redirect URIs and token endpoints but does NOT make outbound HTTPS connections to external OAuth providers in the current A0-A6 implementation. All OAuth flows are:
- Authorization Code + PKCE (redirect to external provider, callback to gateway)
- Refresh token exchange (client → gateway, no gateway → external provider call)

**No active egress destinations are present in the current OAuth implementation.**

If future phases wire external OAuth provider token introspection or dynamic client registration against live external IdPs:
- Document the exact provider hostnames here
- Require owner approval before enabling

---

## Copilot Backend Egress (A7 Candidate, Deferred)

**Component**: GitHub Copilot backend (A7, transport decision deferred)<br>
**Status**: **NOT IMPLEMENTED / TRANSPORT TBD**

When A7 implements the Copilot backend, this section must document:
- Whether Copilot uses the same egress proxy as Kiro or a separate mechanism
- The exact GitHub/Azure endpoints required for Copilot API access
- Network isolation design (job-scoped or shared)

**Current State**: `config/agents.example.yaml` shows `copilot` backend as `enabled: false`. No egress destinations are configured.

**Validation**: Deferred to A7 implementation.

---

## Host Docker Engine API

**Component**: Executor service<br>
**Destination**: `/var/run/docker.sock` (Unix socket, local only)<br>
**Purpose**: Docker Engine API — container/volume/network lifecycle<br>
**Source of Authority**: Architecture requirement (executor is the trusted execution authority)

**Not a network egress** — local Unix socket only. The executor never reaches external Docker registries directly; image pulls are an operator pre-deployment responsibility.

---

## Compose Networks

**Component**: QuaranGate stack itself<br>
**Configuration**: `compose.yaml` lines 151–156

| Network | Internal | Purpose |
|---------|----------|---------|
| `quarangate-edge` | No | Gateway public ingress (loopback-bound by default) |
| `quarangate-internal` | Yes | Gateway ↔ executor private communication (no external route) |

**External Route**: Only `quarangate-edge` can route externally, and it is bound to `127.0.0.1` by default (docs/OPERATIONS.md remote ingress setup required for external access).

---

## Tailscale / Remote Ingress (Optional, Operator-Configured)

**Component**: Remote owner orchestration (optional)<br>
**Status**: **OWNER_NETWORK_DECISION_REQUIRED** (operator deploys Tailscale separately if needed)

Tailscale is NOT bundled with QuaranGate. Remote owner scenarios (docs/REMOTE_OWNER_ORCHESTRATION.md) document Tailscale as an optional authenticated remote access layer. If the operator deploys it:
- Tailscale daemon runs on the host (outside QuaranGate containers)
- Gateway remains bound to `127.0.0.1`; Tailscale reverse-proxies the local port

**No QuaranGate code makes outbound calls to Tailscale control plane servers.**

---

## Summary Table: Active Egress Destinations

| Component | Hostnames | Port | Operator Control |
|-----------|-----------|------|------------------|
| Kiro runner | 7 Kiro/AWS endpoints | 443 | Cannot disable (required for Kiro backend) |
| Ollama | `${OLLAMA_HOST}` | 11434 | Optional (disabled by default; operator configures) |
| GitHub control | `github.com`, `api.github.com` | 443 | Optional (disabled by default; A7 candidate) |
| Copilot | (not implemented) | — | Deferred to A7 |

**Zero-egress mode**: Disable all backends except `fake` (A2) — no external network required.

---

## Change Control

**Date**: 2026-09-06 (H1-7 baseline)<br>
**Approved By**: This inventory reflects the state at commit `c0d885371aeee6fdb2b2a970b5771a2335462c6c` (H1 base).

Any addition to this inventory requires:
1. Documentation of the exact hostname, port, and purpose
2. Proof of authority (which upstream dependency requires it)
3. Owner approval for the new egress destination
4. Update to `src/executor/agents/egressProxy.ts` or equivalent enforcement point

**Never authorize domains based solely on vendor documentation — only add destinations proven necessary by runtime evidence (egress logs, traced failures).**
