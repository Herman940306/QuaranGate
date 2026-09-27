CREATE TABLE security_discoveries (
  discovery_id text PRIMARY KEY
    CHECK (discovery_id ~ '^disc_[0-9a-f]{24}$'),
  product_user_id uuid NOT NULL REFERENCES product_users(id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  workspace_id uuid NOT NULL,
  principal_ref text NOT NULL CHECK (
    char_length(principal_ref) BETWEEN 1 AND 256
    AND principal_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$'
  ),
  principal_mapping_version bigint NOT NULL CHECK (principal_mapping_version >= 0),
  project_id text NOT NULL CHECK (project_id ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  target_id text CHECK (
    target_id IS NULL OR target_id ~ '^[a-z0-9][a-z0-9_-]{0,63}$'
  ),
  source_revision char(40) NOT NULL CHECK (source_revision ~ '^[0-9a-f]{40}$'),
  snapshot_schema_version text NOT NULL DEFAULT 'BE9_DISCOVERY_SNAPSHOT_V1'
    CHECK (snapshot_schema_version = 'BE9_DISCOVERY_SNAPSHOT_V1'),
  snapshot_json jsonb NOT NULL CHECK (jsonb_typeof(snapshot_json) = 'object'),
  snapshot_digest_sha256 char(64) NOT NULL
    CHECK (snapshot_digest_sha256 ~ '^[0-9a-f]{64}$'),
  snapshot_byte_length integer NOT NULL
    CHECK (snapshot_byte_length BETWEEN 1 AND 262144),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workspace_id, organization_id)
    REFERENCES workspaces(id, organization_id)
    ON DELETE RESTRICT,
  UNIQUE (discovery_id, organization_id, workspace_id)
);

CREATE INDEX security_discoveries_tenant_idx
  ON security_discoveries(
    organization_id,
    workspace_id,
    product_user_id,
    created_at DESC,
    discovery_id
  );

CREATE INDEX security_discoveries_principal_idx
  ON security_discoveries(principal_ref, created_at DESC, discovery_id);

CREATE TABLE security_assessments (
  assessment_id text PRIMARY KEY
    CHECK (assessment_id ~ '^assessment_[0-9a-f]{24}$'),
  product_user_id uuid NOT NULL REFERENCES product_users(id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  workspace_id uuid NOT NULL,
  principal_ref text NOT NULL CHECK (
    char_length(principal_ref) BETWEEN 1 AND 256
    AND principal_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$'
  ),
  principal_mapping_version bigint NOT NULL CHECK (principal_mapping_version >= 0),
  discovery_id text NOT NULL,
  plan_id text NOT NULL CHECK (plan_id ~ '^plan_[0-9a-f]{24}$'),
  project_id text NOT NULL CHECK (project_id ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  target_id text CHECK (
    target_id IS NULL OR target_id ~ '^[a-z0-9][a-z0-9_-]{0,63}$'
  ),
  source_revision char(40) NOT NULL CHECK (source_revision ~ '^[0-9a-f]{40}$'),
  assessment_intent text NOT NULL DEFAULT 'source'
    CHECK (assessment_intent IN ('source','runtime','pipeline')),

  discovery_snapshot_schema_version text NOT NULL DEFAULT 'BE9_SNAPSHOT_V1'
    CHECK (discovery_snapshot_schema_version = 'BE9_SNAPSHOT_V1'),
  discovery_snapshot_json jsonb NOT NULL
    CHECK (jsonb_typeof(discovery_snapshot_json) = 'object'),
  discovery_snapshot_digest_sha256 char(64) NOT NULL
    CHECK (discovery_snapshot_digest_sha256 ~ '^[0-9a-f]{64}$'),
  discovery_snapshot_byte_length integer NOT NULL
    CHECK (discovery_snapshot_byte_length BETWEEN 1 AND 262144),

  plan_snapshot_schema_version text NOT NULL DEFAULT 'BE9_SNAPSHOT_V1'
    CHECK (plan_snapshot_schema_version = 'BE9_SNAPSHOT_V1'),
  plan_snapshot_json jsonb NOT NULL
    CHECK (jsonb_typeof(plan_snapshot_json) = 'object'),
  plan_snapshot_digest_sha256 char(64) NOT NULL
    CHECK (plan_snapshot_digest_sha256 ~ '^[0-9a-f]{64}$'),
  plan_snapshot_byte_length integer NOT NULL
    CHECK (plan_snapshot_byte_length BETWEEN 1 AND 262144),

  state text NOT NULL CHECK (state IN (
    'PLANNED','ADMITTED','PREPARING','RUNNING','CANCELLING','CLEANUP',
    'COMPLETED','FAILED_POLICY','FAILED_PRECONDITION','FAILED_TOOL',
    'FAILED_TIMEOUT','FAILED_INFRASTRUCTURE','CANCELLED','CLEANUP_FAILED'
  )),
  pending_outcome text CHECK (
    pending_outcome IS NULL OR pending_outcome IN (
      'SUCCESS','CANCELLED','FAILED_PRECONDITION','FAILED_TOOL',
      'FAILED_TIMEOUT','FAILED_INFRASTRUCTURE'
    )
  ),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  correlation_id text NOT NULL CHECK (
    char_length(correlation_id) BETWEEN 1 AND 128
    AND correlation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  requested_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (workspace_id, organization_id)
    REFERENCES workspaces(id, organization_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (discovery_id, organization_id, workspace_id)
    REFERENCES security_discoveries(discovery_id, organization_id, workspace_id)
    ON DELETE RESTRICT,

  UNIQUE (assessment_id, organization_id, workspace_id),

  CHECK (updated_at >= requested_at),
  CHECK (
    (state = 'CLEANUP' AND pending_outcome IS NOT NULL)
    OR (state <> 'CLEANUP')
  ),
  CHECK (
    state NOT IN ('PLANNED','ADMITTED','PREPARING','RUNNING','FAILED_POLICY')
    OR pending_outcome IS NULL
  ),
  CHECK (
    state <> 'CANCELLING'
    OR pending_outcome IS NULL
    OR pending_outcome IN (
      'FAILED_PRECONDITION','FAILED_TOOL','FAILED_TIMEOUT','FAILED_INFRASTRUCTURE'
    )
  ),
  CHECK (state <> 'COMPLETED' OR pending_outcome = 'SUCCESS'),
  CHECK (state <> 'FAILED_TOOL' OR pending_outcome = 'FAILED_TOOL'),
  CHECK (state <> 'FAILED_TIMEOUT' OR pending_outcome = 'FAILED_TIMEOUT'),
  CHECK (
    state <> 'FAILED_PRECONDITION'
    OR pending_outcome IS NULL
    OR pending_outcome = 'FAILED_PRECONDITION'
  ),
  CHECK (
    state <> 'CANCELLED'
    OR pending_outcome IS NULL
    OR pending_outcome = 'CANCELLED'
  ),
  CHECK (state <> 'CLEANUP_FAILED' OR pending_outcome IS NOT NULL)
);

CREATE INDEX security_assessments_tenant_page_idx
  ON security_assessments(
    organization_id,
    workspace_id,
    product_user_id,
    updated_at DESC,
    assessment_id
  );

CREATE INDEX security_assessments_recovery_idx
  ON security_assessments(state, updated_at, assessment_id)
  WHERE state IN ('PLANNED','ADMITTED','PREPARING','RUNNING','CANCELLING','CLEANUP');

CREATE INDEX security_assessments_principal_idx
  ON security_assessments(principal_ref, updated_at DESC, assessment_id);

CREATE TABLE security_assessment_transitions (
  assessment_id text NOT NULL,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  version bigint NOT NULL CHECK (version > 0),
  prior_state text NOT NULL CHECK (prior_state IN (
    'PLANNED','ADMITTED','PREPARING','RUNNING','CANCELLING','CLEANUP',
    'COMPLETED','FAILED_POLICY','FAILED_PRECONDITION','FAILED_TOOL',
    'FAILED_TIMEOUT','FAILED_INFRASTRUCTURE','CANCELLED','CLEANUP_FAILED'
  )),
  event text NOT NULL CHECK (event IN (
    'ADMISSION_REVALIDATION_PASS','ADMISSION_POLICY_DENIED',
    'ADMISSION_PRECONDITION_FAILED','ADMISSION_TEMPORARILY_UNAVAILABLE',
    'CANCEL_REQUEST','PREPARE_BEGIN',
    'PREPARATION_INFRASTRUCTURE_FAILURE_NO_RESOURCES',
    'PREPARATION_INFRASTRUCTURE_FAILURE_WITH_RESOURCES',
    'PREPARATION_ABORT_REQUIRING_CLEANUP','PREPARATION_COMPLETE',
    'PRECONDITION_DRIFT_NO_RESOURCES','PRECONDITION_DRIFT_WITH_RESOURCES',
    'TOOL_SUCCESS','TOOL_FAILURE','EXECUTION_TIMEOUT',
    'EXECUTION_INFRASTRUCTURE_FAILURE','EXECUTION_STOPPED_OR_ABSENT',
    'STOP_STATE_AMBIGUOUS','CLEANUP_PROVEN',
    'EVIDENCE_FINALIZATION_FAILED','CLEANUP_NOT_PROVABLE'
  )),
  next_state text NOT NULL CHECK (next_state IN (
    'PLANNED','ADMITTED','PREPARING','RUNNING','CANCELLING','CLEANUP',
    'COMPLETED','FAILED_POLICY','FAILED_PRECONDITION','FAILED_TOOL',
    'FAILED_TIMEOUT','FAILED_INFRASTRUCTURE','CANCELLED','CLEANUP_FAILED'
  )),
  pending_outcome text CHECK (
    pending_outcome IS NULL OR pending_outcome IN (
      'SUCCESS','CANCELLED','FAILED_PRECONDITION','FAILED_TOOL',
      'FAILED_TIMEOUT','FAILED_INFRASTRUCTURE'
    )
  ),
  reason text NOT NULL CHECK (
    char_length(reason) BETWEEN 1 AND 500
    AND char_length(btrim(reason)) > 0
    AND position(chr(0) in reason) = 0
  ),
  actor text NOT NULL CHECK (
    actor IN ('product-service','operational-bridge','worker','recovery')
  ),
  correlation_id text NOT NULL CHECK (
    char_length(correlation_id) BETWEEN 1 AND 128
    AND correlation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  transitioned_at timestamptz NOT NULL,
  PRIMARY KEY (assessment_id, version),
  FOREIGN KEY (assessment_id, organization_id, workspace_id)
    REFERENCES security_assessments(assessment_id, organization_id, workspace_id)
    ON DELETE RESTRICT
);

CREATE INDEX security_assessment_transitions_tenant_idx
  ON security_assessment_transitions(
    organization_id,
    workspace_id,
    assessment_id,
    version
  );

CREATE TABLE security_assessment_admission_receipts (
  receipt_digest_sha256 char(64) PRIMARY KEY
    CHECK (receipt_digest_sha256 ~ '^[0-9a-f]{64}$'),
  assessment_id text NOT NULL,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  assessment_version bigint NOT NULL CHECK (assessment_version >= 0),
  decision text NOT NULL CHECK (decision IN (
    'ADMITTED','DENIED_POLICY','FAILED_PRECONDITION',
    'TEMPORARILY_UNAVAILABLE','REPLAY_REJECTED'
  )),
  decision_code text NOT NULL CHECK (
    char_length(decision_code) BETWEEN 1 AND 128
    AND decision_code ~ '^[A-Z][A-Z0-9_:-]{0,127}$'
  ),
  receipt_schema_version text NOT NULL
    CHECK (receipt_schema_version = 'BE9_ADMISSION_RECEIPT_V1'),
  receipt_json jsonb NOT NULL CHECK (jsonb_typeof(receipt_json) = 'object'),
  decision_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (assessment_id, organization_id, workspace_id)
    REFERENCES security_assessments(assessment_id, organization_id, workspace_id)
    ON DELETE RESTRICT,
  CHECK (expires_at >= decision_at)
);

CREATE INDEX security_assessment_admission_receipts_assessment_idx
  ON security_assessment_admission_receipts(
    assessment_id,
    decision_at DESC,
    receipt_digest_sha256
  );

CREATE TABLE security_assessment_evidence (
  evidence_id text PRIMARY KEY
    CHECK (evidence_id ~ '^evidence_[0-9a-f]{24}$'),
  assessment_id text NOT NULL,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  evidence_type text NOT NULL CHECK (
    evidence_type ~ '^[A-Z][A-Z0-9_:-]{0,95}$'
  ),
  producer_class text NOT NULL CHECK (
    producer_class IN ('ADMISSION','SOURCE_STAGING','SCANNER_OUTPUT','CLEANUP','RECOVERY')
  ),
  content_ref text CHECK (
    content_ref IS NULL OR (
      char_length(content_ref) BETWEEN 1 AND 512
      AND content_ref ~ '^qg-security-evidence:[A-Za-z0-9._:-]{1,480}$'
    )
  ),
  sha256_hex char(64) NOT NULL CHECK (sha256_hex ~ '^[0-9a-f]{64}$'),
  size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 0 AND 67108864),
  truncated boolean NOT NULL DEFAULT false,
  finalized boolean NOT NULL DEFAULT false,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finalized_at timestamptz,
  FOREIGN KEY (assessment_id, organization_id, workspace_id)
    REFERENCES security_assessments(assessment_id, organization_id, workspace_id)
    ON DELETE RESTRICT,
  CHECK (
    (finalized = true AND finalized_at IS NOT NULL)
    OR (finalized = false AND finalized_at IS NULL)
  )
);

CREATE INDEX security_assessment_evidence_assessment_idx
  ON security_assessment_evidence(
    organization_id,
    workspace_id,
    assessment_id,
    created_at,
    evidence_id
  );
