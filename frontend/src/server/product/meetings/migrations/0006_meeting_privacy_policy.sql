ALTER TABLE meeting_sessions
  DROP CONSTRAINT meeting_sessions_recording_state_check;

ALTER TABLE meeting_sessions
  DROP CONSTRAINT meeting_sessions_retention_state_check;

ALTER TABLE meeting_participants
  DROP CONSTRAINT meeting_participants_consent_state_check;

UPDATE meeting_sessions
SET recording_state = 'DISABLED',
    retention_state = 'NOT_CONFIGURED'
WHERE recording_state = 'OWNER_DECISION_REQUIRED'
   OR retention_state = 'OWNER_DECISION_REQUIRED';

UPDATE meeting_participants
SET consent_state = 'OWNER_ATTESTATION_MODEL'
WHERE consent_state = 'OWNER_DECISION_REQUIRED';

ALTER TABLE meeting_participants
  ALTER COLUMN consent_state SET DEFAULT 'OWNER_ATTESTATION_MODEL',
  ADD CONSTRAINT meeting_participants_consent_state_check
    CHECK (consent_state = 'OWNER_ATTESTATION_MODEL');

ALTER TABLE meeting_sessions
  ALTER COLUMN recording_state SET DEFAULT 'DISABLED',
  ALTER COLUMN retention_state SET DEFAULT 'NOT_CONFIGURED',
  ADD COLUMN recording_opt_in boolean NOT NULL DEFAULT false,
  ADD COLUMN notice_policy text NOT NULL DEFAULT 'PERSISTENT_VISUAL'
    CHECK (notice_policy = 'PERSISTENT_VISUAL'),
  ADD COLUMN notice_state text NOT NULL DEFAULT 'REQUIRED'
    CHECK (notice_state IN ('REQUIRED','CLIENT_ACKNOWLEDGED')),
  ADD COLUMN recording_policy_version integer NOT NULL DEFAULT 1
    CHECK (recording_policy_version > 0),
  ADD CONSTRAINT meeting_sessions_recording_state_check
    CHECK (recording_state IN ('DISABLED','OPTED_IN','READY','RECORDING','STOPPING','STOPPED','FAILED')),
  ADD CONSTRAINT meeting_sessions_retention_state_check
    CHECK (retention_state IN ('NOT_CONFIGURED','CONFIGURED'));

CREATE TABLE meeting_recording_attestations (
  id uuid PRIMARY KEY,
  meeting_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  attesting_product_user_id uuid NOT NULL REFERENCES product_users(id) ON DELETE RESTRICT,
  attestation_code text NOT NULL
    CHECK (attestation_code = 'NOTICE_AND_CONSENT_OBLIGATIONS_ATTESTED_BY_MEETING_OWNER'),
  policy_version integer NOT NULL CHECK (policy_version > 0),
  meeting_version bigint NOT NULL CHECK (meeting_version >= 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (meeting_id, organization_id, workspace_id)
    REFERENCES meeting_sessions(id, organization_id, workspace_id)
    ON DELETE RESTRICT,
  UNIQUE (meeting_id, policy_version, meeting_version)
);

CREATE TABLE workspace_meeting_transcript_retention (
  workspace_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  enabled boolean NOT NULL,
  retention_minutes integer,
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  updated_by uuid NOT NULL REFERENCES product_users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workspace_id, organization_id)
    REFERENCES workspaces(id, organization_id)
    ON DELETE RESTRICT,
  CHECK (
    (enabled = true AND retention_minutes BETWEEN 15 AND 525600)
    OR
    (enabled = false AND retention_minutes IS NULL)
  )
);

CREATE TABLE meeting_transcripts (
  id uuid PRIMARY KEY,
  meeting_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  transcript_version integer NOT NULL CHECK (transcript_version > 0),
  content_ref text NOT NULL
    CHECK (content_ref ~ '^qg-transcript:[0-9a-f-]{36}$'),
  retained_until timestamptz NOT NULL,
  provider_class text NOT NULL CHECK (provider_class = 'LOCAL_ONLY'),
  anonymous_speaker_labels jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(anonymous_speaker_labels) = 'array'),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (meeting_id, organization_id, workspace_id)
    REFERENCES meeting_sessions(id, organization_id, workspace_id)
    ON DELETE RESTRICT,
  UNIQUE (meeting_id, transcript_version)
);

CREATE INDEX meeting_transcripts_active_idx
  ON meeting_transcripts(workspace_id, meeting_id, retained_until DESC);
