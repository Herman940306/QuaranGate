import { createHash } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { canonicalSerialize } from '../executor/agents/canonicalJson.js';

export const INSTALLATION_MANIFEST_SCHEMA_VERSION = 1 as const;

const SHA256 = /^[0-9a-f]{64}$/u;
const GIT_COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

function sortedUnique(values: string[]): boolean {
  return values.every((value, index) => index === 0 || (values[index - 1] ?? '') < value);
}

const TimestampSchema = z.string().datetime({ offset: true });
const DigestSchema = z.string().regex(SHA256);
const GitCommitSchema = z.string().regex(GIT_COMMIT);
const SafeIdSchema = z.string().regex(SAFE_ID);
const AbsolutePathSchema = z.string().superRefine((value, ctx) => {
  if (!path.posix.isAbsolute(value) || value === '/' || value.includes('\\') || path.posix.normalize(value) !== value) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'path must be a canonical absolute non-root WSL/Linux path' });
  }
});

const ProviderStateSchema = z.object({
  state: z.enum(['CONFIGURED', 'DEFERRED_ENTITLEMENT', 'DISABLED', 'REAUTHORIZATION_REQUIRED']),
  credentialReference: z.string().regex(/^[A-Za-z][A-Za-z0-9._:/-]{2,127}$/u).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.state === 'CONFIGURED' && value.credentialReference === undefined) {
    // Local Ollama is the only provider allowed to be configured without a credential.
    // The parent provider object applies that provider-specific exception.
  }
  if (value.state !== 'CONFIGURED' && value.credentialReference !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'credential reference is valid only for configured provider state' });
  }
});

const ProvidersSchema = z.object({
  kiro: ProviderStateSchema,
  copilot: ProviderStateSchema,
  ollama: ProviderStateSchema,
}).strict().superRefine((value, ctx) => {
  for (const name of ['kiro', 'copilot'] as const) {
    if (value[name].state === 'CONFIGURED' && !value[name].credentialReference) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [name], message: 'configured provider requires a credential reference' });
    }
  }
});

const IdeIntegrationSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('UPSTREAM_P7_PENDING') }).strict(),
  z.object({
    state: z.literal('BOUND'),
    contractVersion: z.number().int().positive(),
    contractDigest: DigestSchema,
    adapterIds: z.array(SafeIdSchema).min(1).refine(sortedUnique, 'adapterIds must be sorted and unique'),
  }).strict(),
]);

const GithubIntegrationSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('DISABLED') }).strict(),
  z.object({
    state: z.literal('CONFIGURED'),
    selectedRepositories: z.array(z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u))
      .min(1)
      .refine(sortedUnique, 'selectedRepositories must be sorted and unique'),
  }).strict(),
  z.object({ state: z.literal('REAUTHORIZATION_REQUIRED') }).strict(),
]);

const RootSchema = z.object({
  install: AbsolutePathSchema,
  state: AbsolutePathSchema,
  evidence: AbsolutePathSchema,
  models: AbsolutePathSchema,
  backups: AbsolutePathSchema,
  cache: AbsolutePathSchema,
}).strict();

const RuntimeIdentitySchema = z.object({
  component: SafeIdSchema,
  reference: z.string().min(1).max(512).refine((value) => !/(?:^|:)latest$/iu.test(value), 'mutable latest reference is refused'),
  digest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
}).strict();

export const MigrationRecordSchema = z.object({
  id: SafeIdSchema,
  kind: z.enum(['CONFIG', 'STATE']),
  fromVersion: z.number().int().nonnegative(),
  toVersion: z.number().int().positive(),
  digest: DigestSchema,
}).strict().refine((value) => value.toVersion === value.fromVersion + 1, 'migration must advance exactly one schema version');

const StartupRegistrationSchema = z.object({
  id: SafeIdSchema,
  mechanism: z.enum(['WINDOWS_TASK_SCHEDULER_WSL', 'SYSTEMD_USER']),
  identityDigest: DigestSchema,
  enabled: z.boolean(),
}).strict();

const ClientRegistrationSchema = z.object({
  id: SafeIdSchema,
  generation: z.number().int().positive(),
  authorityDigest: DigestSchema,
  state: z.enum(['ACTIVE', 'DISABLED', 'REAUTHORIZATION_REQUIRED']),
}).strict();

const SessionResumePolicySchema = z.object({
  mutating: z.literal('REFUSE_ON_SOURCE_DRIFT_NEW_SESSION_NO_INHERITED_AUTHORITY'),
  readOnly: z.literal('RE_ATTEST_REAUTHORIZE_NEW_GENERATION_ZERO_MUTATION_AUTHORITY'),
  historicalMemory: z.literal('CONTEXT_ONLY_NEVER_AUTHORITY'),
}).strict();

const HealthSchema = z.object({
  state: z.enum(['HEALTHY', 'UNHEALTHY', 'NOT_RUNNING', 'UNCERTAIN']),
  verifiedAt: TimestampSchema,
}).strict();

export const InstallationManifestSchema = z.object({
  schemaVersion: z.literal(INSTALLATION_MANIFEST_SCHEMA_VERSION),
  installationId: z.string().uuid(),
  lifecycleState: z.enum(['INSTALLED', 'UNINSTALLED', 'REPAIR_REQUIRED', 'UNCERTAIN']),
  productVersion: z.string().regex(SEMVER),
  sourceCommit: GitCommitSchema,
  releaseDigest: DigestSchema,
  configSchemaVersion: z.number().int().nonnegative(),
  stateSchemaVersion: z.number().int().nonnegative(),
  installedAt: TimestampSchema,
  updatedAt: TimestampSchema,
  components: z.array(SafeIdSchema).min(1).refine(sortedUnique, 'components must be sorted and unique'),
  integrations: z.object({
    providers: ProvidersSchema,
    ide: IdeIntegrationSchema,
    github: GithubIntegrationSchema,
  }).strict(),
  roots: RootSchema,
  runtimeIdentities: z.array(RuntimeIdentitySchema)
    .refine((values) => sortedUnique(values.map((value) => value.component)), 'runtime identities must be sorted and unique'),
  migrations: z.array(MigrationRecordSchema)
    .refine((values) => sortedUnique(values.map((value) => `${value.kind}:${String(value.fromVersion).padStart(8, '0')}:${value.id}`)), 'migrations must be sorted and unique'),
  startupRegistrations: z.array(StartupRegistrationSchema)
    .refine((values) => sortedUnique(values.map((value) => value.id)), 'startup registrations must be sorted and unique'),
  clientRegistrations: z.array(ClientRegistrationSchema)
    .refine((values) => sortedUnique(values.map((value) => value.id)), 'client registrations must be sorted and unique'),
  sessionResumePolicy: SessionResumePolicySchema,
  health: HealthSchema,
}).strict().superRefine((value, ctx) => {
  for (const [kind, version] of [
    ['CONFIG', value.configSchemaVersion],
    ['STATE', value.stateSchemaVersion],
  ] as const) {
    const records = value.migrations.filter((migration) => migration.kind === kind);
    if (records.length !== version) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['migrations'],
        message: `${kind} migration history does not match declared schema version`,
      });
      continue;
    }
    for (let index = 0; index < version; index += 1) {
      const record = records[index];
      if (!record || record.fromVersion !== index || record.toVersion !== index + 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['migrations', index],
          message: `${kind} migration history is incomplete or out of sequence`,
        });
        break;
      }
    }
  }
  if (Date.parse(value.updatedAt) < Date.parse(value.installedAt)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['updatedAt'],
      message: 'updatedAt cannot precede installedAt',
    });
  }
});

export type InstallationManifest = z.infer<typeof InstallationManifestSchema>;
export type MigrationRecord = z.infer<typeof MigrationRecordSchema>;

export class LifecycleSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LifecycleSchemaError';
  }
}

export function validateInstallationManifest(value: unknown): InstallationManifest {
  const parsed = InstallationManifestSchema.safeParse(value);
  if (!parsed.success) {
    throw new LifecycleSchemaError(`installation manifest validation failed: ${parsed.error.message}`);
  }
  return parsed.data;
}

export function createInstallationManifest(value: unknown): InstallationManifest {
  return validateInstallationManifest(value);
}

export function installationManifestDigest(value: InstallationManifest): string {
  const manifest = validateInstallationManifest(value);
  return createHash('sha256').update(canonicalSerialize(manifest)).digest('hex');
}
