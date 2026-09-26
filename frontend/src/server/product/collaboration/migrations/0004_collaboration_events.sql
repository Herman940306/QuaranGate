CREATE TABLE product_event_sequences (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  workspace_id uuid NOT NULL,
  stream_key text NOT NULL CHECK (stream_key ~ '^[a-z][a-z0-9_.:-]{0,95}$'),
  next_sequence bigint NOT NULL DEFAULT 1 CHECK (next_sequence > 0),
  PRIMARY KEY (workspace_id, stream_key),
  FOREIGN KEY (workspace_id, organization_id)
    REFERENCES workspaces(id, organization_id)
    ON DELETE RESTRICT
);

CREATE TABLE product_events (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  workspace_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9_.:-]{0,95}$'),
  event_version integer NOT NULL DEFAULT 1 CHECK (event_version > 0),
  actor_product_user_id uuid REFERENCES product_users(id) ON DELETE RESTRICT,
  subject_type text NOT NULL CHECK (subject_type ~ '^[a-z][a-z0-9_.:-]{0,63}$'),
  subject_id text NOT NULL CHECK (char_length(subject_id) BETWEEN 1 AND 256),
  aggregate_version bigint NOT NULL DEFAULT 0 CHECK (aggregate_version >= 0),
  stream_key text NOT NULL CHECK (stream_key ~ '^[a-z][a-z0-9_.:-]{0,95}$'),
  sequence bigint NOT NULL CHECK (sequence > 0),
  correlation_id text NOT NULL CHECK (char_length(correlation_id) BETWEEN 1 AND 128),
  idempotency_key text CHECK (
    idempotency_key IS NULL OR char_length(idempotency_key) BETWEEN 1 AND 128
  ),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  delivery_attempts integer NOT NULL DEFAULT 0 CHECK (delivery_attempts >= 0),
  last_delivery_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workspace_id, organization_id)
    REFERENCES workspaces(id, organization_id)
    ON DELETE RESTRICT,
  UNIQUE (workspace_id, stream_key, sequence)
);

CREATE UNIQUE INDEX product_events_idempotency_unique
  ON product_events(workspace_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX product_events_replay_idx
  ON product_events(workspace_id, sequence, id);

CREATE TABLE product_event_replay_cursors (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  workspace_id uuid NOT NULL,
  consumer_key text NOT NULL CHECK (consumer_key ~ '^[a-z][a-z0-9_.:-]{0,95}$'),
  stream_key text NOT NULL CHECK (stream_key ~ '^[a-z][a-z0-9_.:-]{0,95}$'),
  last_sequence bigint NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, consumer_key, stream_key),
  FOREIGN KEY (workspace_id, organization_id)
    REFERENCES workspaces(id, organization_id)
    ON DELETE RESTRICT
);

CREATE TABLE collaboration_groups (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  workspace_id uuid NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_by uuid NOT NULL REFERENCES product_users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workspace_id, organization_id)
    REFERENCES workspaces(id, organization_id)
    ON DELETE RESTRICT,
  UNIQUE (workspace_id, name),
  UNIQUE (id, organization_id, workspace_id)
);

CREATE TABLE collaboration_group_members (
  group_id uuid NOT NULL,
  product_user_id uuid NOT NULL REFERENCES product_users(id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed')),
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (group_id, product_user_id),
  FOREIGN KEY (group_id, organization_id, workspace_id)
    REFERENCES collaboration_groups(id, organization_id, workspace_id)
    ON DELETE RESTRICT
);

CREATE TABLE collaboration_messages (
  id uuid PRIMARY KEY,
  group_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  author_product_user_id uuid NOT NULL REFERENCES product_users(id) ON DELETE RESTRICT,
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 8000),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  retention_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  edited_at timestamptz,
  FOREIGN KEY (group_id, organization_id, workspace_id)
    REFERENCES collaboration_groups(id, organization_id, workspace_id)
    ON DELETE RESTRICT,
  UNIQUE (id, workspace_id)
);

CREATE INDEX collaboration_messages_group_page_idx
  ON collaboration_messages(group_id, created_at DESC, id DESC);

CREATE TABLE collaboration_reactions (
  message_id uuid NOT NULL,
  product_user_id uuid NOT NULL REFERENCES product_users(id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  reaction_key text NOT NULL CHECK (reaction_key ~ '^[a-z][a-z0-9_-]{0,31}$'),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (message_id, product_user_id, reaction_key),
  FOREIGN KEY (message_id, workspace_id)
    REFERENCES collaboration_messages(id, workspace_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, organization_id)
    REFERENCES workspaces(id, organization_id)
    ON DELETE RESTRICT
);

CREATE TABLE collaboration_attachments (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  workspace_id uuid NOT NULL,
  uploader_product_user_id uuid NOT NULL REFERENCES product_users(id) ON DELETE RESTRICT,
  original_name text NOT NULL CHECK (char_length(original_name) BETWEEN 1 AND 240),
  content_type text NOT NULL CHECK (char_length(content_type) BETWEEN 1 AND 160),
  size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 1 AND 52428800),
  sha256_hex char(64) CHECK (sha256_hex IS NULL OR sha256_hex ~ '^[0-9a-f]{64}$'),
  storage_ref text NOT NULL CHECK (
    storage_ref ~ '^qg-attachment:[0-9a-f-]{36}$'
  ),
  scan_state text NOT NULL DEFAULT 'pending'
    CHECK (scan_state IN ('pending', 'clean', 'infected', 'error')),
  status text NOT NULL DEFAULT 'initiated'
    CHECK (status IN ('initiated', 'uploaded', 'safe', 'rejected')),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  retention_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workspace_id, organization_id)
    REFERENCES workspaces(id, organization_id)
    ON DELETE RESTRICT,
  UNIQUE (id, organization_id, workspace_id)
);

CREATE TABLE product_notifications (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  workspace_id uuid NOT NULL,
  product_user_id uuid NOT NULL REFERENCES product_users(id) ON DELETE RESTRICT,
  notification_type text NOT NULL CHECK (notification_type ~ '^[a-z][a-z0-9_.:-]{0,95}$'),
  summary text NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 320),
  subject_type text CHECK (
    subject_type IS NULL OR subject_type ~ '^[a-z][a-z0-9_.:-]{0,63}$'
  ),
  subject_id text CHECK (
    subject_id IS NULL OR char_length(subject_id) BETWEEN 1 AND 256
  ),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 128),
  read_at timestamptz,
  dismissed_at timestamptz,
  expires_at timestamptz,
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workspace_id, organization_id)
    REFERENCES workspaces(id, organization_id)
    ON DELETE RESTRICT,
  UNIQUE (product_user_id, workspace_id, idempotency_key)
);

CREATE TABLE product_approvals (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  workspace_id uuid NOT NULL,
  requester_product_user_id uuid NOT NULL REFERENCES product_users(id) ON DELETE RESTRICT,
  decision_product_user_id uuid REFERENCES product_users(id) ON DELETE RESTRICT,
  action_class text NOT NULL CHECK (action_class ~ '^[a-z][a-z0-9_.:-]{0,95}$'),
  subject_type text NOT NULL CHECK (subject_type ~ '^[a-z][a-z0-9_.:-]{0,63}$'),
  subject_id text NOT NULL CHECK (char_length(subject_id) BETWEEN 1 AND 256),
  evidence_digest_sha256 char(64) CHECK (
    evidence_digest_sha256 IS NULL OR evidence_digest_sha256 ~ '^[0-9a-f]{64}$'
  ),
  request_correlation_id text NOT NULL CHECK (char_length(request_correlation_id) BETWEEN 1 AND 128),
  rationale text CHECK (rationale IS NULL OR char_length(rationale) <= 1000),
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED')),
  expires_at timestamptz,
  decided_at timestamptz,
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workspace_id, organization_id)
    REFERENCES workspaces(id, organization_id)
    ON DELETE RESTRICT,
  UNIQUE (id, organization_id, workspace_id)
);

CREATE INDEX product_approvals_inbox_idx
  ON product_approvals(workspace_id, status, created_at DESC, id);

CREATE TABLE product_autonomous_policies (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  workspace_id uuid NOT NULL,
  action_class text NOT NULL CHECK (action_class ~ '^[a-z][a-z0-9_.:-]{0,95}$'),
  enabled boolean NOT NULL DEFAULT false,
  approval_requirement text NOT NULL DEFAULT 'required'
    CHECK (approval_requirement IN ('required', 'conditional', 'not_required')),
  max_operations integer CHECK (max_operations IS NULL OR max_operations BETWEEN 1 AND 1000),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_by uuid NOT NULL REFERENCES product_users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workspace_id, organization_id)
    REFERENCES workspaces(id, organization_id)
    ON DELETE RESTRICT,
  UNIQUE (workspace_id, action_class)
);
