# Product Authority Model

## Four distinct layers

### 1. Human identity
Source: Keycloak product session.

Represents who the human is and whether the product session is valid.

### 2. Product context
Source: PostgreSQL product platform.

Represents:
- user;
- organization;
- workspace;
- memberships;
- product role defaults;
- per-user overrides.

These determine product UX permissions and business workflow eligibility only.

### 3. Operational principal
Source: current QuaranGate trusted principal configuration/authority model.

Represents:
- operational scopes;
- target grants;
- agent project/backend/profile grants;
- GitHub account/project grants;
- current enabled/rate-limit state.

### 4. Resource/runtime preconditions
Source: live QuaranGate server state.

Examples:
- target running;
- source revision current;
- project not quarantined;
- live writer available;
- apply artifact valid;
- provider available;
- required lease available;
- global-exclusive operation free.

## Effective authority

A product action may proceed only when all required layers allow it:

`authenticated human ∩ product membership/role ∩ mapped QuaranGate Principal grants ∩ live resource preconditions`

A broader product role can never widen a narrower QuaranGate Principal.

## Federation rule

Keycloak is the product identity/session broker.

Microsoft Entra ID is the first enterprise federation profile.

The source contract requires `keycloak` as the product broker. Production must declare that broker explicitly. The first Entra profile requires an explicit tenant identifier and rejects the ambiguous Entra authorities `common`, `organizations` and `consumers`. These values are server-owned configuration; they are not browser-selectable authority.

Entra claims may establish/authenticate product identity attributes through Keycloak but must never directly grant:
- MCP scopes;
- target access;
- agent project/backend/profile access;
- GitHub operational grants;
- Docker/host authority.

## Product roles and overrides

Role defaults and per-user overrides are evaluated in product space. They should be explicit, versioned and auditable.

Example: a workspace Administrator may be allowed by product policy to request an agent apply. That request still fails unless the mapped QuaranGate Principal has `agents:apply` plus the relevant project/resource authority and all live preconditions pass.

## No client authority

The frontend may:
- render capabilities;
- hide or disable obviously unavailable actions for usability;
- show server preflight results.

The frontend may not:
- compute final effective authority;
- trust JWT claims as MCP scopes;
- mint QuaranGate grants;
- infer permission from prior success.

Every operation is re-authorized server-side.

## Approval model

Persisted product approvals are decision records, not operational capability tokens.

An approval record should bind at minimum:
- approval id;
- workspace/org;
- action class;
- actor/approver;
- exact subject/resource;
- version/source revision where relevant;
- expiry;
- status;
- rationale/metadata;
- created/decided timestamps.

At execution time QuaranGate still re-checks current authority and stale state.

## Autonomous mode

Autonomous mode is a product policy that can reduce repeated human prompts only for pre-approved bounded classes. It cannot bypass:
- destructive-action policy;
- provider/secret constraints;
- writer arbitration;
- stale/source checks;
- environment stop conditions;
- production/release/signing gates.

## Denial precedence

When multiple layers deny, the service should prefer safe typed denial categories without leaking inaccessible resource details:
1. unauthenticated;
2. forbidden/product context;
3. forbidden operational authority;
4. resource/precondition conflict;
5. backend unavailable.

Audit should retain enough correlation to explain the server decision without exposing secrets.
