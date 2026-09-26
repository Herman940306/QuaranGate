CREATE TABLE meeting_sessions (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  workspace_id uuid NOT NULL,
  created_by uuid NOT NULL REFERENCES product_users(id) ON DELETE RESTRICT,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 160),
  state text NOT NULL DEFAULT 'DRAFT'
    CHECK (state IN ('DRAFT','READY','ACTIVE','STOPPED','PROCESSING','COMPLETED','FAILED','CANCELLED','EXPIRED')),
  recording_state text NOT NULL DEFAULT 'OWNER_DECISION_REQUIRED'
    CHECK (recording_state = 'OWNER_DECISION_REQUIRED'),
  transcription_state text NOT NULL DEFAULT 'NOT_AVAILABLE'
    CHECK (transcription_state IN ('NOT_AVAILABLE','PROCESSING','COMPLETED','FAILED')),
  summary_state text NOT NULL DEFAULT 'NOT_AVAILABLE'
    CHECK (summary_state IN ('NOT_AVAILABLE','PROCESSING','COMPLETED','FAILED')),
  retention_state text NOT NULL DEFAULT 'OWNER_DECISION_REQUIRED'
    CHECK (retention_state = 'OWNER_DECISION_REQUIRED'),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workspace_id, organization_id)
    REFERENCES workspaces(id, organization_id)
    ON DELETE RESTRICT,
  UNIQUE (id, organization_id, workspace_id)
);

CREATE INDEX meeting_sessions_workspace_page_idx
  ON meeting_sessions(workspace_id, updated_at DESC, id DESC);

CREATE TABLE meeting_participants (
  meeting_id uuid NOT NULL,
  product_user_id uuid NOT NULL REFERENCES product_users(id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  role text NOT NULL DEFAULT 'owner' CHECK (role IN ('owner','participant')),
  consent_state text NOT NULL DEFAULT 'OWNER_DECISION_REQUIRED'
    CHECK (consent_state = 'OWNER_DECISION_REQUIRED'),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (meeting_id, product_user_id),
  FOREIGN KEY (meeting_id, organization_id, workspace_id)
    REFERENCES meeting_sessions(id, organization_id, workspace_id)
    ON DELETE RESTRICT
);

CREATE TABLE meeting_attachment_links (
  meeting_id uuid NOT NULL,
  attachment_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  purpose text NOT NULL DEFAULT 'reference'
    CHECK (purpose IN ('reference','agenda','evidence')),
  created_by uuid NOT NULL REFERENCES product_users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (meeting_id, attachment_id),
  FOREIGN KEY (meeting_id, organization_id, workspace_id)
    REFERENCES meeting_sessions(id, organization_id, workspace_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (attachment_id, organization_id, workspace_id)
    REFERENCES collaboration_attachments(id, organization_id, workspace_id)
    ON DELETE RESTRICT
);
