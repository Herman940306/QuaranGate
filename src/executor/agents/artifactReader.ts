/**
 * A6-B4: Read-only canonical artifact reader.
 *
 * Verifies and exposes the immutable B3 canonical artifact so the public
 * agent_diff review surface can render EXACTLY what a job proposed changing,
 * using ONLY trusted job binding + verified evidence bytes. It never reads
 * host source, never mutates evidence, and never trusts caller-supplied paths
 * as storage locations.
 *
 * Trust model (A6-B4, Option D):
 *   - the executor derives project/volume/artifactHash ONLY from the durable
 *     AgentJobRow (never from caller input) — the engine performs those checks;
 *   - this module verifies the full B3 identity chain (manifest → snapshots →
 *     blobs) with the FROZEN B3 validators before any content is trusted.
 *
 * Every canonical storage failure (absence where required, malformed JSON,
 * strict-validation failure, hash/size mismatch, immutable-field inconsistency)
 * maps to ARTIFACT_STORAGE_INTEGRITY_FAILED — never swallowed into fake success.
 */
import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { extract as tarExtract } from 'tar-stream';
import { BridgeError } from '../../shared/errors.js';
import {
  validateArtifactManifest,
  validateSnapshotManifest,
  isValidSha256,
  type ArtifactManifest,
  type SnapshotManifest,
  type SnapshotEntry,
} from './canonicalJson.js';
import { SANDBOX_LABEL_NS, LABEL_MANAGED, LABEL_RESOURCE, LABEL_JOB } from './sandboxSpec.js';
import { createContainer, startContainer, waitContainer, removeContainer, getArchive } from '../docker.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const EVIDENCE_MOUNT = '/evidence';
export const ARTIFACT_MANIFEST_FILE = 'artifact-manifest.json';
export const BEFORE_SNAPSHOT_FILE = 'before-snapshot-manifest.json';
export const POST_SNAPSHOT_FILE = 'post-snapshot-manifest.json';

const FIXED_EVIDENCE_FILES = new Set([
  ARTIFACT_MANIFEST_FILE,
  BEFORE_SNAPSHOT_FILE,
  POST_SNAPSHOT_FILE,
]);

/** blobs/<first-two-hash-chars>/<full-sha256> — the ONLY blob path shape. */
const BLOB_PATH_PATTERN = /^blobs\/[0-9a-f]{2}\/[0-9a-f]{64}$/;

/**
 * Fixed, conservative maximum reader bounds for the two B3 canonical
 * manifest classes (§R2 remediation Blocker 2). Corrupted storage must never
 * be able to force unbounded buffering of a manifest before it is parsed.
 *
 * 64 MiB is a fixed B4 fail-closed reader ceiling chosen to prevent
 * unbounded manifest ingestion — it is not a claim about what B3 could have
 * legitimately produced (§R3 comment correction). `HostConfig.Memory` in
 * {@link buildEvidenceReaderSpec} bounds only THIS reader's own read-only
 * helper container; it says nothing about the memory available to the B3
 * producer that originally wrote the evidence, so it does not prove a
 * legitimate manifest could never exceed this size. Fixed here, not
 * caller-configurable.
 */
export const MAX_ARTIFACT_MANIFEST_BYTES = 64 * 1024 * 1024;
export const MAX_SNAPSHOT_MANIFEST_BYTES = 64 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Read-only access to a B3 evidence volume. Path is volume-relative and MUST
 * be a fixed manifest filename or a validated content-addressed blob path.
 * Implementations must never expose arbitrary caller-controlled reads.
 *
 * `maxBytes` (§R2 remediation Blocker 2) is a hard bound the implementation
 * MUST enforce WHILE consuming the underlying read (not only by checking the
 * final buffer length after fully accumulating it): once cumulative bytes
 * read for this call exceed `maxBytes`, the implementation must stop
 * accepting further content and fail closed rather than keep buffering.
 */
export interface ReadonlyEvidenceSource {
  readFile(relPath: string, maxBytes: number): Promise<Buffer>;
  close?(): Promise<void>;
}

/**
 * Immutable job facts the reader cross-checks against the verified manifest.
 * All values come from the trusted AgentJobRow, never from caller input.
 * Nullable cached fields are cross-checked only when present.
 */
export interface ExpectedArtifactBinding {
  jobId: string;
  principalId: string;
  projectId: string;
  backend: string;
  profile: string;
  /** job.artifactHash — the SHA-256 the artifact manifest bytes MUST hash to. */
  expectedArtifactHash: string;
  baseCommit: string | null;
  changeSetHash?: string | null;
  contentComplete?: boolean | null;
  applicable?: boolean | null;
  reason?: string | null;
  opCount?: number | null;
  artifactBytes?: number | null;
}

/**
 * A fully verified artifact ready to drive deterministic rendering.
 *
 * Bounded-memory contract (A6-B4 R1 remediation): this object retains ONLY
 * verified manifests/snapshots/indexes — never blob content. Regular-file
 * blob bytes are read lazily via {@link readVerifiedBlob}, on demand, by the
 * renderer, and are never cached here. Each call performs an actual read
 * against the trusted evidence source and independently re-verifies exact
 * size + SHA-256 — there is deliberately no artifact-wide `Map<hash, Buffer>`.
 */
export interface VerifiedArtifact {
  /** == expected.expectedArtifactHash == sha256(artifact-manifest bytes). */
  artifactHash: string;
  manifest: ArtifactManifest;
  before: SnapshotManifest;
  post: SnapshotManifest;
  beforeMap: Map<string, SnapshotEntry>;
  postMap: Map<string, SnapshotEntry>;
  /**
   * Lazily read + verify ONE regular-file blob by its validated content
   * hash. Never caches: every call re-reads the evidence source and
   * re-verifies exact size + SHA-256 before returning. `expectedSize` MUST
   * come from the verified snapshot entry (`SnapshotFileEntry.sizeBytes`),
   * never from caller/display input. Storage failures (missing blob, size
   * mismatch, hash mismatch, transport failure) throw
   * ARTIFACT_STORAGE_INTEGRITY_FAILED — never a fake/partial success.
   */
  readVerifiedBlob(hash: string, expectedSize: number): Promise<Buffer>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function integrity(message: string): never {
  throw new BridgeError('ARTIFACT_STORAGE_INTEGRITY_FAILED', message, 500);
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** Content-addressed blob path from a validated SHA-256 identity ONLY. */
export function blobPath(hash: string): string {
  if (!isValidSha256(hash)) integrity(`invalid blob hash: ${hash}`);
  return `blobs/${hash.slice(0, 2)}/${hash}`;
}

/**
 * Guard the ONLY evidence paths a reader may ever request: the three fixed
 * canonical manifest filenames and hash-derived blob paths. A caller `path`
 * filter never reaches here (it is matched against canonical path identity,
 * not used as a storage location).
 */
export function assertAllowedEvidencePath(relPath: string): void {
  if (FIXED_EVIDENCE_FILES.has(relPath)) return;
  if (BLOB_PATH_PATTERN.test(relPath)) return;
  integrity(`evidence read path not allowed: ${relPath}`);
}

/**
 * Consume an async byte-chunk source, enforcing `maxBytes` WHILE consuming —
 * never after fully buffering (§R2 remediation Blocker 2). Aborts as soon as
 * the running total exceeds the bound and stops pulling further chunks: for
 * a Node.js `Readable`, throwing out of a `for await` loop invokes the
 * stream's `Symbol.asyncIterator` `return()`, which destroys the stream, so
 * no additional bytes are read from the underlying source past the
 * violation. Pure/generic so it is directly unit-testable against a
 * synthetic chunk source without Docker.
 */
export async function readBounded(chunks: AsyncIterable<Buffer>, maxBytes: number): Promise<Buffer> {
  const parts: Buffer[] = [];
  let total = 0;
  for await (const c of chunks) {
    total += c.length;
    if (total > maxBytes) {
      throw new Error(`evidence exceeds maximum allowed size of ${maxBytes} bytes`);
    }
    parts.push(c);
  }
  return Buffer.concat(parts);
}

async function readEvidence(source: ReadonlyEvidenceSource, relPath: string, maxBytes: number): Promise<Buffer> {
  assertAllowedEvidencePath(relPath);
  try {
    return await source.readFile(relPath, maxBytes);
  } catch (e) {
    if (e instanceof BridgeError && e.code === 'ARTIFACT_STORAGE_INTEGRITY_FAILED') throw e;
    // Absence where required / volume unavailable / transport failure /
    // maxBytes-exceeded are all canonical evidence failures — fail closed
    // (never fake success).
    integrity(`cannot read evidence '${relPath}': ${e instanceof Error ? e.message : String(e)}`);
  }
}

function parseArtifactManifest(bytes: Buffer): ArtifactManifest {
  let obj: unknown;
  try {
    obj = JSON.parse(bytes.toString('utf8'));
  } catch {
    integrity('artifact manifest is not valid JSON');
  }
  try {
    return validateArtifactManifest(obj);
  } catch (e) {
    integrity(`artifact manifest failed strict validation: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function parseSnapshotManifest(bytes: Buffer, which: 'BEFORE' | 'POST'): SnapshotManifest {
  let obj: unknown;
  try {
    obj = JSON.parse(bytes.toString('utf8'));
  } catch {
    integrity(`${which} snapshot manifest is not valid JSON`);
  }
  try {
    return validateSnapshotManifest(obj);
  } catch (e) {
    integrity(`${which} snapshot manifest failed strict validation: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Cross-check the immutable fields that MUST be identical between the trusted
 * job row and the verified artifact manifest. Nullable cached row fields are
 * compared only when present; required identity fields are always compared.
 */
function crossCheckManifest(m: ArtifactManifest, e: ExpectedArtifactBinding): void {
  if (m.jobId !== e.jobId) integrity(`manifest jobId mismatch: ${m.jobId} != ${e.jobId}`);
  if (m.principalId !== e.principalId) integrity('manifest principalId mismatch');
  if (m.projectId !== e.projectId) integrity(`manifest projectId mismatch: ${m.projectId} != ${e.projectId}`);
  if (m.backend !== e.backend) integrity('manifest backend mismatch');
  if (m.profile !== e.profile) integrity('manifest profile mismatch');
  if (e.baseCommit != null && m.baseCommit !== e.baseCommit) integrity('manifest baseCommit mismatch');
  if (e.changeSetHash != null && m.changeSetHash !== e.changeSetHash) integrity('manifest changeSetHash mismatch');
  if (e.contentComplete != null && m.contentComplete !== e.contentComplete) integrity('manifest contentComplete mismatch');
  if (e.applicable != null && m.applicable !== e.applicable) integrity('manifest applicable mismatch');
  if (e.opCount != null && m.opCount !== e.opCount) integrity('manifest opCount mismatch');
  if (e.artifactBytes != null && m.artifactBytes !== e.artifactBytes) integrity('manifest artifactBytes mismatch');
  if (e.reason !== undefined && (m.reason ?? null) !== (e.reason ?? null)) integrity('manifest reason mismatch');
}

// ---------------------------------------------------------------------------
// Verification (the full B3 identity chain — performed on EVERY diff call)
// ---------------------------------------------------------------------------

/**
 * Lazily read + verify ONE regular-file blob (§17/§18: required blobs must
 * verify by exact size + SHA-256 even for a legitimately incomplete
 * artifact). Performed on demand, per call, against the trusted evidence
 * source — never cached, never batched across the whole artifact.
 */
async function readVerifiedBlobFromSource(
  source: ReadonlyEvidenceSource,
  hash: string,
  expectedSize: number,
): Promise<Buffer> {
  // The read bound is the already-verified snapshot sizeBytes for this exact
  // blob (§R2 remediation Blocker 2) — corrupted storage claiming a larger
  // object than the trusted size is rejected while streaming, before it can
  // be fully buffered.
  const buf = await readEvidence(source, blobPath(hash), expectedSize);
  if (buf.length !== expectedSize) {
    integrity(`blob size mismatch for ${hash}: actual=${buf.length} expected=${expectedSize}`);
  }
  const computed = sha256(buf);
  if (computed !== hash) {
    integrity(`blob hash mismatch: computed=${computed} expected=${hash}`);
  }
  return buf;
}

/**
 * Verify the complete canonical artifact identity chain and return a
 * VerifiedArtifact. Order (fail closed at every step):
 *   1-6  artifact manifest bytes → hash == job.artifactHash → strict validate → cross-check
 *   7-11 before snapshot bytes → strict validate → hash == manifest.beforeIdentity
 *   12-16 post snapshot bytes → strict validate → hash == manifest.postIdentity
 *   17   regular-file blobs are verified lazily via {@link
 *        VerifiedArtifact.readVerifiedBlob} — each call independently reads
 *        the trusted evidence source and checks exact size + SHA-256; no
 *        blob is read here, and none is cached on the returned object.
 */
export async function verifyCanonicalArtifact(
  source: ReadonlyEvidenceSource,
  expected: ExpectedArtifactBinding,
): Promise<VerifiedArtifact> {
  // --- Artifact manifest (steps 1-6) ---
  const artifactBytes = await readEvidence(source, ARTIFACT_MANIFEST_FILE, MAX_ARTIFACT_MANIFEST_BYTES);
  const artifactHash = sha256(artifactBytes);
  if (artifactHash !== expected.expectedArtifactHash) {
    integrity(`artifact manifest hash mismatch: computed=${artifactHash} expected=${expected.expectedArtifactHash}`);
  }
  const manifest = parseArtifactManifest(artifactBytes);
  crossCheckManifest(manifest, expected);

  // --- BEFORE snapshot (steps 7-11) ---
  const beforeBytes = await readEvidence(source, BEFORE_SNAPSHOT_FILE, MAX_SNAPSHOT_MANIFEST_BYTES);
  const before = parseSnapshotManifest(beforeBytes, 'BEFORE');
  const beforeHash = sha256(beforeBytes);
  if (beforeHash !== manifest.beforeIdentity) {
    integrity(`before snapshot identity mismatch: computed=${beforeHash} expected=${manifest.beforeIdentity}`);
  }

  // --- POST snapshot (steps 12-16) ---
  const postBytes = await readEvidence(source, POST_SNAPSHOT_FILE, MAX_SNAPSHOT_MANIFEST_BYTES);
  const post = parseSnapshotManifest(postBytes, 'POST');
  const postHash = sha256(postBytes);
  if (postHash !== manifest.postIdentity) {
    integrity(`post snapshot identity mismatch: computed=${postHash} expected=${manifest.postIdentity}`);
  }

  const beforeMap = new Map<string, SnapshotEntry>(before.entries.map((e) => [e.path, e]));
  const postMap = new Map<string, SnapshotEntry>(post.entries.map((e) => [e.path, e]));

  return {
    artifactHash,
    manifest,
    before,
    post,
    beforeMap,
    postMap,
    readVerifiedBlob: (hash, expectedSize) => readVerifiedBlobFromSource(source, hash, expectedSize),
  };
}

// ---------------------------------------------------------------------------
// Trusted Docker evidence reader (short-lived, read-only helper)
// ---------------------------------------------------------------------------

export interface EvidenceReaderSpec {
  Image: string;
  User: string;
  Cmd: string[];
  Labels: Record<string, string>;
  NetworkDisabled: boolean;
  HostConfig: {
    AutoRemove: boolean;
    Privileged: boolean;
    ReadonlyRootfs: boolean;
    CapDrop: string[];
    SecurityOpt: string[];
    NetworkMode: string;
    Mounts: Array<{ Type: string; Source: string; Target: string; ReadOnly: boolean }>;
    Tmpfs: Record<string, string>;
    Memory: number;
    PidsLimit: number;
  };
}

/**
 * Construct the trusted read-only evidence-reader Docker spec. Production MUST
 * use this exact builder (test seam). The evidence volume is mounted READ-ONLY;
 * there is no host project mount, no docker.sock, no network, no privileges.
 * `volume` comes only from AgentJobRow.artifactVolume; `image` is trusted
 * executor configuration; neither is ever caller-controlled.
 */
export function buildEvidenceReaderSpec(volume: string, image: string, jobId: string): EvidenceReaderSpec {
  if (!image) integrity('no trusted evidence reader image is configured');
  if (!volume) integrity('no trusted artifact volume for job');
  return {
    Image: image,
    User: '0:0',
    Cmd: ['true'],
    Labels: { [LABEL_MANAGED]: 'true', [LABEL_RESOURCE]: 'evidence-read', [LABEL_JOB]: jobId },
    NetworkDisabled: true,
    HostConfig: {
      AutoRemove: false,
      Privileged: false,
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'],
      NetworkMode: 'none',
      Mounts: [{ Type: 'volume', Source: volume, Target: EVIDENCE_MOUNT, ReadOnly: true }],
      Tmpfs: { '/tmp': 'rw,nosuid,nodev,size=1m' },
      Memory: 64 * 1024 * 1024,
      PidsLimit: 8,
    },
  };
}

/**
 * Extract the first regular file's content from a Docker archive tar stream,
 * bounded by `maxBytes` (§R2 remediation Blocker 2, §R3 remediation).
 *
 * Two layered checks enforce the bound:
 *   1. `header.size > maxBytes` (§R3) rejects immediately from the tar
 *      header, before any content is read, when the archive up front claims
 *      an oversized entry. This is a pure optimization of the same
 *      fail-closed rule, not a new trust source — the header is untrusted
 *      metadata from the same corruptible archive and is never treated as
 *      proof of correctness.
 *   2. {@link readBounded} remains the authoritative streaming enforcement
 *      layer regardless: it bounds actual bytes read WHILE streaming the tar
 *      entry, not only after the entry has been fully buffered, so a header
 *      that understates the true size is still caught.
 *
 * §R3 remediation: every terminal path — success, maxBytes overflow (from
 * either check above), a tar parser/entry error, or an error from the outer
 * archive transport itself — explicitly destroys the COMPLETE read chain:
 * the current entry stream, the tar `Extract`, and the outer `tarStream`
 * (the Docker archive response body). `.pipe()` alone does not destroy a
 * readable source when its writable destination is destroyed, so relying on
 * it would strand the Docker/undici response on every failure; destroying
 * `ex` here cascades to the live entry stream (`Extract._destroy` destroys
 * `this._stream`), and `tarStream` is always destroyed alongside it,
 * including after a clean success — no archive body is ever abandoned
 * either way. The returned Promise settles exactly once (`settled` guard);
 * an explicit, error-less `destroy()` never re-emits 'error', so tearing
 * down after settling can never surface as an unhandled error event.
 */
export async function extractSingleFile(tarStream: Readable, maxBytes: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    let settled = false;
    const ex = tarExtract();

    const teardown = (): void => {
      if (!ex.destroyed) ex.destroy();
      if (!tarStream.destroyed) tarStream.destroy();
    };
    const settleResolve = (buf: Buffer): void => {
      if (settled) return;
      settled = true;
      teardown();
      resolve(buf);
    };
    const settleReject = (err: unknown): void => {
      if (settled) return;
      settled = true;
      teardown();
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    let found = false;
    ex.on('entry', (header, stream, next) => {
      if (found || header.type !== 'file') { stream.resume(); next(); return; }
      found = true;

      // §R3: header-declared size is untrusted archive metadata, never proof
      // — but rejecting an over-claimed size before reading is a cheap,
      // safe optimization of the same fail-closed rule readBounded enforces.
      if ((header.size ?? 0) > maxBytes) {
        settleReject(new Error(`evidence exceeds maximum allowed size of ${maxBytes} bytes (tar header)`));
        return;
      }

      readBounded(stream, maxBytes).then(settleResolve, settleReject);
    });
    ex.on('finish', () => { if (!found) settleReject(new Error('no file in tar')); });
    ex.on('error', settleReject);
    tarStream.on('error', settleReject);
    tarStream.pipe(ex);
  });
}

const nsPrefix = (): string => SANDBOX_LABEL_NS.replace(/\./g, '-');

/**
 * Create a Docker-backed read-only evidence source. A single short-lived
 * hardened helper container (evidence volume mounted READ-ONLY) is created
 * lazily on first read and reused for all reads within one diff call, then
 * force-removed by {@link ReadonlyEvidenceSource.close}. The container command
 * is fixed (`true`); evidence bytes are pulled purely via the Docker archive
 * API. Caller input never influences the image, command, volume, or path.
 */
export function createDockerEvidenceReader(volume: string, image: string, jobId: string): ReadonlyEvidenceSource {
  const spec = buildEvidenceReaderSpec(volume, image, jobId);
  const name = `${nsPrefix()}-evread-${jobId}-${randomBytes(6).toString('hex')}`;
  let containerId: string | undefined;

  const ensure = async (): Promise<string> => {
    if (!containerId) {
      containerId = await createContainer(name, spec as unknown as Record<string, unknown>);
      await startContainer(containerId);
      // Cmd is `true`: the container exits immediately; its RO mount remains
      // attached (and archive-readable) until the container is removed.
      await waitContainer(containerId, { timeoutMs: 10_000 });
    }
    return containerId;
  };

  return {
    async readFile(relPath: string, maxBytes: number): Promise<Buffer> {
      assertAllowedEvidencePath(relPath);
      const cid = await ensure();
      const { body } = await getArchive(cid, `${EVIDENCE_MOUNT}/${relPath}`);
      return extractSingleFile(body, maxBytes);
    },
    async close(): Promise<void> {
      if (containerId) {
        await removeContainer(containerId, true).catch(() => {});
        containerId = undefined;
      }
      await removeContainer(name, true).catch(() => {});
    },
  };
}
