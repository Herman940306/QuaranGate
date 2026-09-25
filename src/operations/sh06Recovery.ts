export type ContainerRuntimeState = 'created' | 'running' | 'restarting' | 'exited' | 'dead' | 'paused' | 'removing' | 'unknown';
export type ContainerHealthState = 'none' | 'starting' | 'healthy' | 'unhealthy' | 'unknown';

export interface SchemaPreflightInput {
  currentSchema: number;
  candidateSupportedSchema: number;
  rollbackSupportedSchema: number;
  snapshotCreated: boolean;
  snapshotVerified: boolean;
  /**
   * The schema version read back from the verified snapshot.  When provided,
   * the evaluator enforces that it equals currentSchema (M9 guard: snapshot
   * captured after an interleaved migration is unusable for restoration to the
   * pre-deploy state).  Omit or pass undefined only when snapshotVerified is
   * false (i.e. the snapshot step has not yet completed).
   */
  snapshotSchema?: number | undefined;
}

export interface SchemaPreflightResult {
  allowed: boolean;
  migrationPossible: boolean;
  snapshotMandatory: boolean;
  reason: string;
}

export function evaluateSchemaPreflight(input: SchemaPreflightInput): SchemaPreflightResult {
  // Validate all numeric evidence before any comparison.
  const requiredValues = [input.currentSchema, input.candidateSupportedSchema, input.rollbackSupportedSchema];
  if (requiredValues.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    return { allowed: false, migrationPossible: false, snapshotMandatory: true, reason: 'INVALID_SCHEMA_EVIDENCE' };
  }
  if (input.snapshotSchema !== undefined && (!Number.isSafeInteger(input.snapshotSchema) || input.snapshotSchema < 0)) {
    return { allowed: false, migrationPossible: false, snapshotMandatory: true, reason: 'INVALID_SCHEMA_EVIDENCE' };
  }

  // Rule A: candidate cannot read a database it does not support.
  if (input.currentSchema > input.candidateSupportedSchema) {
    return { allowed: false, migrationPossible: false, snapshotMandatory: true, reason: 'CURRENT_SCHEMA_NEWER_THAN_CANDIDATE' };
  }

  // Rule B (CRITICAL): if the live database is already at a schema the rollback
  // binary cannot read, a standard deployment is unconditionally unsafe.  A
  // verified snapshot does NOT change this — it captures a v9 state that the
  // v7 rollback binary still cannot open.  Any deployment that could leave the
  // system in a state where the rollback executor would crash is blocked here
  // before any runtime mutation occurs.
  if (input.currentSchema > input.rollbackSupportedSchema) {
    return {
      allowed: false,
      migrationPossible: false,
      snapshotMandatory: true,
      reason: 'ROLLBACK_SCHEMA_INCOMPATIBLE_WITH_CURRENT_STATE',
    };
  }

  const migrationPossible = input.currentSchema < input.candidateSupportedSchema;
  // Snapshot is mandatory whenever the candidate could migrate the DB to a
  // version the rollback binary cannot read, or when a migration will occur at
  // all.  SH-06 also requires it unconditionally before any executor startup.
  const snapshotMandatory = migrationPossible || input.candidateSupportedSchema > input.rollbackSupportedSchema;

  // SH-06 always requires a verified snapshot before candidate executor startup,
  // even when the version relationship would otherwise be rollback-compatible.
  if (!input.snapshotCreated) {
    return { allowed: false, migrationPossible, snapshotMandatory: true, reason: 'SNAPSHOT_NOT_CREATED' };
  }
  if (!input.snapshotVerified) {
    return { allowed: false, migrationPossible, snapshotMandatory: true, reason: 'SNAPSHOT_NOT_VERIFIED' };
  }

  // M9: the snapshot must have captured the schema that was current at the
  // point the snapshot was taken.  A mismatch means an interleaved write
  // changed the schema between the snapshot and its verification, making the
  // snapshot useless for restoration to the pre-deploy state.
  if (input.snapshotSchema !== undefined && input.snapshotSchema !== input.currentSchema) {
    return { allowed: false, migrationPossible, snapshotMandatory: true, reason: 'SNAPSHOT_SCHEMA_MISMATCH' };
  }

  return { allowed: true, migrationPossible, snapshotMandatory, reason: 'PREFLIGHT_OK' };
}

export interface RollbackDimensions {
  imageState: boolean;
  persistentState: boolean;
  configState: boolean;
  githubState: boolean;
  networkState: boolean;
  healthState: boolean;
}

export function rollbackPassed(dimensions: RollbackDimensions): boolean {
  return Object.values(dimensions).every(Boolean);
}

export interface ReadinessObservation {
  service: string;
  runtimeState: ContainerRuntimeState;
  healthState: ContainerHealthState;
}

export type ReadinessClassification = 'READY' | 'STARTING' | 'UNHEALTHY' | 'EXITED';

export function classifyReadiness(observation: ReadinessObservation): ReadinessClassification {
  if (['exited', 'dead', 'removing'].includes(observation.runtimeState)) return 'EXITED';
  if (observation.runtimeState !== 'running') return 'STARTING';
  if (observation.healthState === 'unhealthy') return 'UNHEALTHY';
  if (observation.healthState === 'healthy' || observation.healthState === 'none') return 'READY';
  return 'STARTING';
}

export interface ReadinessSequenceResult {
  ready: boolean;
  admitted: string[];
  failedService: string | null;
  classification: ReadinessClassification | null;
}

export function evaluateReadinessSequence(
  orderedServices: readonly string[],
  observations: ReadonlyMap<string, ReadinessObservation>,
): ReadinessSequenceResult {
  const admitted: string[] = [];
  for (const service of orderedServices) {
    const observation = observations.get(service);
    const classification = observation ? classifyReadiness(observation) : 'STARTING';
    if (classification !== 'READY') {
      return { ready: false, admitted, failedService: service, classification };
    }
    admitted.push(service);
  }
  return { ready: true, admitted, failedService: null, classification: null };
}

export interface GithubBaseline {
  brokerIds: readonly string[];
  proxyIds: readonly string[];
}

export function classifyGithubBaseline(input: GithubBaseline): 'ABSENT' | 'PRESENT' {
  if (input.brokerIds.length > 1 || input.proxyIds.length > 1) {
    throw new Error('AMBIGUOUS_GITHUB_BASELINE');
  }
  if (input.brokerIds.length !== input.proxyIds.length) {
    throw new Error('INCOMPLETE_GITHUB_BASELINE');
  }
  return input.brokerIds.length === 1 ? 'PRESENT' : 'ABSENT';
}

export function githubRollbackAction(
  baseline: 'ABSENT' | 'PRESENT',
  candidateCreatedServices: boolean,
): 'RESTORE_PREEXISTING' | 'REMOVE_CANDIDATE_CREATED' | 'NO_ACTION' {
  if (baseline === 'PRESENT') return 'RESTORE_PREEXISTING';
  return candidateCreatedServices ? 'REMOVE_CANDIDATE_CREATED' : 'NO_ACTION';
}
