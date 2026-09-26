CREATE TABLE product_principal_mappings (
  id uuid PRIMARY KEY,
  product_user_id uuid NOT NULL REFERENCES product_users(id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  workspace_id uuid NOT NULL,
  principal_ref text NOT NULL CHECK (
    char_length(principal_ref) BETWEEN 1 AND 256
    AND principal_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$'
  ),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'revoked')),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workspace_id, organization_id)
    REFERENCES workspaces(id, organization_id)
    ON DELETE RESTRICT,
  UNIQUE (product_user_id, workspace_id)
);

CREATE INDEX product_principal_mappings_principal_ref_idx
  ON product_principal_mappings(principal_ref);
