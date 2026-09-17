/**
 * Production composition for Plane-B IDE Session Control.
 *
 * The composition is intentionally review-only. It owns the durable session
 * store, exact trusted enrollment reconciliation, exact B4 runtime recovery /
 * provisioning, and B6/I2.2 Unix listener lifecycle. It exposes no public
 * enrollment API and no implementation writer authority.
 */
import {
  existsSync,
  lstatSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { BridgeError } from '../../shared/errors.js';
import { IdeCompanionListener } from './ideCompanionListener.js';
import {
  assertTrustedIdeCompanionRuntimeRoot,
  createIdeCompanionRuntime,
  recoverIdeCompanionRuntime,
  type IdeCompanionRuntimeRef,
} from './ideCompanionRuntime.js';
import { loadIdeSessionConfig, type IdeSessionControlConfig } from './ideSessionConfig.js';
import { IdeSessionStore } from './ideSessionStore.js';

export type IdeSessionControlRuntimeState =
  | 'NOT_CONFIGURED'
  | 'AVAILABLE_NOT_LIVE_QUALIFIED'
  | 'FAILED';

export interface IdeCompanionProductionOptions {
  configPath: string;
  databasePath: string;
  runtimeRoot: string;
  /** Trusted test seam. Production uses IdeSessionStore directly. */
  storeFactory?: (path: string) => IdeSessionStore;
  /** Trusted test seam. Production uses IdeCompanionListener directly. */
  listenerFactory?: (options: ConstructorParameters<typeof IdeCompanionListener>[0]) => IdeCompanionListener;
}

export interface IdeCompanionBootstrapBinding {
  ideInstanceId: string;
  runtimeInstanceId: string;
  credentialPath: string;
}

export class IdeCompanionProductionRuntime {
  private stopped = false;
  private stopping = false;

  constructor(
    public readonly state: Exclude<IdeSessionControlRuntimeState, 'FAILED'>,
    public readonly bootstrapBindings: readonly IdeCompanionBootstrapBinding[],
    private readonly listeners: readonly IdeCompanionListener[],
    private readonly store: IdeSessionStore | null,
  ) {}

  async stop(): Promise<void> {
    if (this.stopped || this.stopping) return;
    this.stopping = true;
    let firstError: unknown;
    for (const listener of [...this.listeners].reverse()) {
      try { await listener.stop(); }
      catch (error) { firstError ??= error; }
    }
    if (firstError === undefined) {
      this.store?.close();
      this.stopped = true;
    }
    this.stopping = false;
    if (firstError !== undefined) throw firstError;
  }
}

function currentUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) throw new BridgeError('PRECONDITION_FAILED', 'IDE Session Control requires Unix user identity', 503);
  return uid;
}

function assertTrustedConfigFile(path: string): void {
  if (!isAbsolute(path) || path !== resolve(path) || path.includes('\0')) {
    throw new BridgeError('PRECONDITION_FAILED', 'IDE session config path must be an absolute trusted path', 503);
  }
  let info;
  try { info = lstatSync(path); }
  catch { throw new BridgeError('PRECONDITION_FAILED', 'IDE session config is unavailable', 503); }
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== currentUid() || (info.mode & 0o022) !== 0) {
    throw new BridgeError('PRECONDITION_FAILED', 'IDE session config ownership/type/mode is unsafe or writable by another Unix identity', 503);
  }
  let canonical: string;
  try { canonical = realpathSync(path); }
  catch { throw new BridgeError('PRECONDITION_FAILED', 'IDE session config cannot be canonicalized', 503); }
  if (canonical !== path) throw new BridgeError('PRECONDITION_FAILED', 'IDE session config contains a symlink', 503);

  // Config bytes select trusted enrollment/capability bindings. A safe file is
  // insufficient if an untrusted Unix identity can replace one of its path
  // components. Sticky shared ancestors (for example /tmp) remain acceptable
  // because they prevent another UID from replacing this user's entry.
  let current = dirname(path);
  for (;;) {
    let ancestor;
    try { ancestor = lstatSync(current); }
    catch { throw new BridgeError('PRECONDITION_FAILED', 'IDE session config ancestor is unavailable', 503); }
    if (!ancestor.isDirectory() || ancestor.isSymbolicLink()) {
      throw new BridgeError('PRECONDITION_FAILED', 'IDE session config ancestor type is unsafe', 503);
    }
    const writableByOthers = (ancestor.mode & 0o022) !== 0;
    const sticky = (ancestor.mode & 0o1000) !== 0;
    if (writableByOthers && !sticky) {
      throw new BridgeError('PRECONDITION_FAILED', 'IDE session config ancestor is writable by another Unix identity without sticky protection', 503);
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function assertTrustedDatabasePath(path: string): void {
  if (!isAbsolute(path) || path !== resolve(path) || path.includes('\0') || path === ':memory:') {
    throw new BridgeError('PRECONDITION_FAILED', 'IDE session database path must be an absolute trusted filesystem path', 503);
  }
  const parent = dirname(path);
  let parentInfo;
  try { parentInfo = lstatSync(parent); }
  catch { throw new BridgeError('PRECONDITION_FAILED', 'IDE session database parent is unavailable', 503); }
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || parentInfo.uid !== currentUid() || (parentInfo.mode & 0o077) !== 0) {
    throw new BridgeError('PRECONDITION_FAILED', 'IDE session database parent ownership/type is unsafe', 503);
  }
  let canonicalParent: string;
  try { canonicalParent = realpathSync(parent); }
  catch { throw new BridgeError('PRECONDITION_FAILED', 'IDE session database parent cannot be canonicalized', 503); }
  if (canonicalParent !== parent) throw new BridgeError('PRECONDITION_FAILED', 'IDE session database parent contains a symlink', 503);
  if (existsSync(path)) {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== currentUid() || (info.mode & 0o077) !== 0) {
      throw new BridgeError('PRECONDITION_FAILED', 'IDE session database ownership/type/mode is unsafe', 503);
    }
  }
}

function assertRuntimeRootInventory(runtimeRoot: string, config: IdeSessionControlConfig): void {
  const allowed = new Set(config.enrollments.map((entry) => entry.runtimeInstanceId));
  for (const name of readdirSync(runtimeRoot)) {
    if (!allowed.has(name)) {
      throw new BridgeError('PRECONDITION_FAILED', 'IDE runtime root contains an unconfigured runtime entry', 503);
    }
    const info = lstatSync(join(runtimeRoot, name));
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== currentUid() || (info.mode & 0o777) !== 0o700) {
      throw new BridgeError('PRECONDITION_FAILED', 'IDE runtime root contains an unsafe runtime directory', 503);
    }
  }
}

function provisionOrRecoverRuntime(
  runtimeRoot: string,
  enrollmentId: string,
  entry: IdeSessionControlConfig['enrollments'][number],
): IdeCompanionRuntimeRef {
  const input = {
    runtimeRoot,
    runtimeInstanceId: entry.runtimeInstanceId,
    enrollmentId,
    ideInstanceId: entry.ideInstanceId,
    ideProduct: entry.ideProduct,
    adapterVersion: entry.adapterVersion,
  } as const;
  const directory = join(runtimeRoot, entry.runtimeInstanceId);
  return existsSync(directory)
    ? recoverIdeCompanionRuntime(input)
    : createIdeCompanionRuntime(input);
}

/**
 * Start Plane-B only when its dedicated trusted config exists. A partially
 * configured deployment fails startup rather than becoming ambiguously active.
 */
export async function startIdeCompanionProduction(options: IdeCompanionProductionOptions): Promise<IdeCompanionProductionRuntime> {
  const configured = existsSync(options.configPath);
  if (!configured) {
    if (options.runtimeRoot.length > 0) {
      throw new BridgeError('PRECONDITION_FAILED', 'IDE runtime root is configured without ide-sessions.yaml', 503);
    }
    return new IdeCompanionProductionRuntime('NOT_CONFIGURED', [], [], null);
  }
  if (options.runtimeRoot.length === 0) {
    throw new BridgeError('PRECONDITION_FAILED', 'IDE Session Control config requires IDE_RUNTIME_ROOT', 503);
  }

  assertTrustedConfigFile(options.configPath);
  const config = loadIdeSessionConfig(options.configPath);
  assertTrustedIdeCompanionRuntimeRoot(options.runtimeRoot);
  assertTrustedDatabasePath(options.databasePath);
  assertRuntimeRootInventory(options.runtimeRoot, config);

  const storeFactory = options.storeFactory ?? ((path: string) => new IdeSessionStore(path));
  const listenerFactory = options.listenerFactory ?? ((listenerOptions) => new IdeCompanionListener(listenerOptions));
  const store = storeFactory(options.databasePath);
  const listeners: IdeCompanionListener[] = [];
  const bootstrapBindings: IdeCompanionBootstrapBinding[] = [];

  try {
    // Restart is a conservative authority boundary: all previously live
    // sessions become STALE and any active operation becomes INDETERMINATE
    // before a new B6 endpoint can accept a connection.
    store.recoverAfterRestart();

    for (const entry of config.enrollments) {
      const reconciled = store.reconcileEnrollment({
        principalId: entry.principalId,
        projectId: entry.projectId,
        worktreeId: entry.worktreeId,
        ideProduct: entry.ideProduct,
        ideInstanceId: entry.ideInstanceId,
        workspaceFingerprint: entry.workspaceFingerprint,
        ...(entry.baseRevision === undefined ? {} : { baseRevision: entry.baseRevision }),
        capabilities: entry.capabilities,
      });
      const runtime = provisionOrRecoverRuntime(options.runtimeRoot, reconciled.enrollment.enrollmentId, entry);
      bootstrapBindings.push({
        ideInstanceId: entry.ideInstanceId,
        runtimeInstanceId: runtime.runtimeInstanceId,
        credentialPath: runtime.credentialPath,
      });
      listeners.push(listenerFactory({
        store,
        runtime,
        userReviewIntents: true,
      }));
    }

    // Refuse ambient/unconfigured runtime directories even after first-start
    // provisioning. The exact configured set is the whole runtime namespace.
    assertRuntimeRootInventory(options.runtimeRoot, config);

    // Sequential startup is deliberate. The executor HTTP server is started
    // only after this function resolves, so no readiness claim can race a
    // listener that has not bound and hardened its Unix socket yet.
    for (const listener of listeners) await listener.start();

    return new IdeCompanionProductionRuntime(
      'AVAILABLE_NOT_LIVE_QUALIFIED',
      Object.freeze(bootstrapBindings.map((binding) => Object.freeze({ ...binding }))),
      listeners,
      store,
    );
  } catch (error) {
    for (const listener of [...listeners].reverse()) {
      try { await listener.stop(); } catch { /* preserve primary startup failure */ }
    }
    try { store.close(); } catch { /* preserve primary startup failure */ }
    throw error;
  }
}
