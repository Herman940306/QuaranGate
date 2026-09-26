# BE2 PostgreSQL Foundation

## Ownership

PostgreSQL owns new product-context relational data only: product users, organizations, workspaces, memberships, product-space role defaults/overrides and user preferences.

It does not own MCP/API-key/OAuth authority, ACP or IDE state, evidence, OIDC access/refresh/ID tokens, final QuaranGate Principal mapping, or live operational grants.

## Connection boundary

The server-only data layer uses `pg@8.23.0` and reads `QG_PRODUCT_DATABASE_URL` only on the server. Query values are parameterized. Repository code does not accept table/column identifiers from browser or identity input.

## Migration policy

Source migrations under `frontend/src/server/product/data/migrations/` are ordered and forward-only. The runner records version, name, SHA-256 and application time. A previously applied version with a different checksum fails closed.

The source migration is applied inside the runner-owned transaction. DDL constraints enforce issuer+subject uniqueness, workspace/organization integrity, product-only permission-key shape, nonnegative revisions and UTC-compatible timestamps.

## Recovery / rollback

BE2 does not claim destructive down-migrations are safe. Recovery is backup/restore or a reviewed forward corrective migration. A migration that fails inside the runner transaction is rolled back. Production migration execution, backup/restore qualification and database credentials are outside this source-only candidate.

## Concurrency

Mutable preferences require `expectedVersion`; successful writes increment `version`, while zero-row updates return a typed stale-version error. Product-user safe display-field refresh also uses a version predicate.

## Tenant isolation

Workspace resolution always binds both product-user id and workspace id through active membership, workspace and organization status. Visible workspace queries are user-bound. Effective product-role reads first prove active membership, then apply only `product.*` defaults/overrides.

No operational QuaranGate scope/grant field exists in this schema.

## Live qualification

No governed disposable PostgreSQL target was exposed during BE2 implementation. Schema/repository behavior is therefore contract/static-qualified only in this candidate; live migration, PostgreSQL constraint execution, backup/restore and database-role least-privilege qualification remain explicitly unclaimed.
