CREATE TABLE product_providers (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  workspace_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('kiro', 'copilot')),
  display_label text NOT NULL CHECK (char_length(display_label) BETWEEN 1 AND 120),
  display_hint text CHECK (display_hint IS NULL OR char_length(display_hint) BETWEEN 1 AND 160),
  status text NOT NULL DEFAULT 'enabled' CHECK (status IN ('enabled', 'disabled')),
  custody_ref text CHECK (
    custody_ref IS NULL OR (
      char_length(custody_ref) BETWEEN 1 AND 512
      AND custody_ref ~ '^qg/product/[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}/v[0-9]+$'
    )
  ),
  validation_status text NOT NULL DEFAULT 'unavailable'
    CHECK (validation_status IN ('valid', 'invalid', 'unavailable', 'forbidden', 'stale')),
  validation_code text CHECK (
    validation_code IS NULL OR validation_code ~ '^[a-z][a-z0-9_.:-]{0,95}$'
  ),
  validated_at timestamptz,
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workspace_id, organization_id)
    REFERENCES workspaces(id, organization_id)
    ON DELETE RESTRICT,
  UNIQUE (id, organization_id, workspace_id),
  UNIQUE (workspace_id, kind, display_label)
);

CREATE INDEX product_providers_workspace_idx
  ON product_providers(organization_id, workspace_id, updated_at DESC, id);
