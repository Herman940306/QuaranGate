CREATE TABLE IF NOT EXISTS product_schema_migrations (
  version bigint PRIMARY KEY CHECK (version > 0),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 160),
  checksum_sha256 char(64) NOT NULL CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE product_users (
  id uuid PRIMARY KEY,
  keycloak_issuer text NOT NULL CHECK (char_length(keycloak_issuer) BETWEEN 1 AND 2048),
  keycloak_subject text NOT NULL CHECK (char_length(keycloak_subject) BETWEEN 1 AND 512),
  display_name text,
  email text,
  email_verified boolean,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (keycloak_issuer, keycloak_subject)
);

CREATE TABLE organizations (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'archived')),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE workspaces (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'archived')),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (id, organization_id),
  UNIQUE (organization_id, name)
);

CREATE TABLE memberships (
  id uuid PRIMARY KEY,
  product_user_id uuid NOT NULL REFERENCES product_users(id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  workspace_id uuid,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  role_classification text NOT NULL CHECK (role_classification ~ '^[a-z][a-z0-9_-]{0,63}$'),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workspace_id, organization_id)
    REFERENCES workspaces(id, organization_id)
    ON DELETE RESTRICT
);

CREATE UNIQUE INDEX memberships_org_unique
  ON memberships(product_user_id, organization_id)
  WHERE workspace_id IS NULL;

CREATE UNIQUE INDEX memberships_workspace_unique
  ON memberships(product_user_id, workspace_id)
  WHERE workspace_id IS NOT NULL;

CREATE TABLE product_role_defaults (
  role_classification text NOT NULL CHECK (role_classification ~ '^[a-z][a-z0-9_-]{0,63}$'),
  permission_key text NOT NULL CHECK (permission_key ~ '^product\.[a-z][a-z0-9_.:-]{0,95}$'),
  enabled boolean NOT NULL,
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (role_classification, permission_key)
);

CREATE TABLE product_permission_overrides (
  id uuid PRIMARY KEY,
  product_user_id uuid NOT NULL REFERENCES product_users(id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  workspace_id uuid,
  permission_key text NOT NULL CHECK (permission_key ~ '^product\.[a-z][a-z0-9_.:-]{0,95}$'),
  effect text NOT NULL CHECK (effect IN ('allow', 'deny')),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workspace_id, organization_id)
    REFERENCES workspaces(id, organization_id)
    ON DELETE RESTRICT
);

CREATE UNIQUE INDEX product_permission_overrides_org_unique
  ON product_permission_overrides(product_user_id, organization_id, permission_key)
  WHERE workspace_id IS NULL;

CREATE UNIQUE INDEX product_permission_overrides_workspace_unique
  ON product_permission_overrides(product_user_id, workspace_id, permission_key)
  WHERE workspace_id IS NOT NULL;

CREATE TABLE user_preferences (
  product_user_id uuid PRIMARY KEY REFERENCES product_users(id) ON DELETE CASCADE,
  appearance_mode text NOT NULL DEFAULT 'system' CHECK (appearance_mode IN ('system', 'light', 'dark')),
  palette text NOT NULL DEFAULT 'mineral' CHECK (palette ~ '^[a-z][a-z0-9_-]{0,31}$'),
  density text NOT NULL DEFAULT 'comfortable' CHECK (density IN ('comfortable', 'compact')),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
