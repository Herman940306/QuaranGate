/**
 * Central Docker image reference parser and validator (H1-1).
 *
 * Correctness requirement: a colon in an image reference does NOT reliably
 * indicate an explicit tag is present. The known failure class is:
 *
 *   registry:5000/repository
 *
 * The colon separates the registry host+port from the repository path. There
 * is NO explicit tag here; the implicit tag is :latest. A naïve
 * string.includes(':') or endsWith(':latest') check would wrongly accept this.
 *
 * This module provides ONE reusable parser/validator for the entire codebase.
 * It must be used anywhere an image reference is validated. All callers must
 * be migrated to it; scattered ad-hoc checks must be removed.
 *
 * Policy (enforced here, never caller-configurable):
 *   implicit :latest  → REFUSED  (no tag or digest at all)
 *   explicit :latest  → REFUSED  (tag is exactly "latest")
 *   malformed         → REFUSED  (parse failed)
 *   explicit non-latest tag → allowed where existing policy permits
 *   digest (@sha256:…) → allowed where existing policy permits
 *
 * Grammar subset implemented (Docker distribution spec):
 *
 *   reference  := name [ ":" tag ] | name "@" digest
 *   name       := [ domain "/" ] path-component [ "/" path-component ]*
 *   domain     := host [ ":" port ]
 *   host       := hostname | ip-address
 *   port       := /[0-9]+/
 *   tag        := /[\w][\w.-]{0,127}/   (simplified; Docker allows [A-Za-z0-9_.-])
 *   digest     := algorithm ":" hex
 *   algorithm  := "sha256" | "sha512" (extensible but we only allow sha256/sha512)
 *
 * We do NOT attempt full spec compliance; the goal is to correctly distinguish
 * the domain:port/repo pattern from the repo:tag pattern, and to enforce the
 * policy above.
 */

/** All possible outcomes of parsing an image reference. */
export type ImageRefKind =
  | 'implicit-latest'    // no tag, no digest → policy: REFUSE
  | 'explicit-latest'    // tag === "latest"  → policy: REFUSE
  | 'explicit-tag'       // named non-latest tag
  | 'digest'             // @sha256:<hex> or @sha512:<hex>
  | 'malformed';         // cannot parse

export interface ParsedImageRef {
  kind: ImageRefKind;
  /** Full original input, untouched. */
  raw: string;
  /** Registry host (with port if present), or null for Docker Hub implicit. */
  registry: string | null;
  /** Repository path (without registry prefix, without tag/digest). */
  repository: string | null;
  /** Tag string (only set for explicit-tag or explicit-latest). */
  tag: string | null;
  /** Digest string (only set for digest kind, e.g. "sha256:abc…"). */
  digest: string | null;
  /** If kind === 'malformed', a human-readable reason. */
  malformedReason: string | null;
}

/** Allowed digest algorithms. SHA-256 is the only commonly used one in Docker. */
const ALLOWED_DIGEST_ALGORITHMS = new Set(['sha256', 'sha512']);

/**
 * A "domain" component starts with a hostname that contains a dot, starts
 * with "localhost", or has a colon (port). This is the Docker distribution
 * spec heuristic for distinguishing registry prefixes from image names.
 *
 * Examples:
 *   docker.io/library/ubuntu → domain = docker.io
 *   registry:5000/myapp     → domain = registry:5000
 *   ubuntu                  → no domain
 *   library/ubuntu          → no domain (no dot/colon/localhost in first segment)
 */
function looksLikeDomain(segment: string): boolean {
  return (
    segment.includes('.') ||
    segment.startsWith('localhost') ||
    segment.includes(':')
  );
}

/**
 * Parse a Docker image reference string into its components.
 *
 * This function never throws. All error conditions produce kind='malformed'.
 */
export function parseImageRef(raw: string): ParsedImageRef {
  const base: Omit<ParsedImageRef, 'kind' | 'malformedReason'> = {
    raw,
    registry: null,
    repository: null,
    tag: null,
    digest: null,
  };

  if (!raw || typeof raw !== 'string') {
    return { ...base, kind: 'malformed', malformedReason: 'empty or non-string input' };
  }

  // Reject any whitespace (including leading/trailing) to prevent smuggling.
  if (/\s/.test(raw)) {
    return { ...base, kind: 'malformed', malformedReason: 'whitespace in image reference' };
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return { ...base, kind: 'malformed', malformedReason: 'blank input' };
  }

  // Split on '@' for digest references.
  const atIdx = trimmed.indexOf('@');
  if (atIdx !== -1) {
    const namePart = trimmed.slice(0, atIdx);
    const digestPart = trimmed.slice(atIdx + 1);

    if (!namePart) {
      return { ...base, kind: 'malformed', malformedReason: 'empty name before @' };
    }
    if (!digestPart) {
      return { ...base, kind: 'malformed', malformedReason: 'empty digest after @' };
    }

    const colonInDigest = digestPart.indexOf(':');
    if (colonInDigest === -1) {
      return { ...base, kind: 'malformed', malformedReason: 'digest missing algorithm:hex separator' };
    }
    const algorithm = digestPart.slice(0, colonInDigest).toLowerCase();
    const hex = digestPart.slice(colonInDigest + 1);

    if (!ALLOWED_DIGEST_ALGORITHMS.has(algorithm)) {
      return { ...base, kind: 'malformed', malformedReason: `unsupported digest algorithm: ${algorithm}` };
    }
    if (!/^[0-9a-f]{32,}$/.test(hex)) {
      return { ...base, kind: 'malformed', malformedReason: 'digest hex is not lowercase hexadecimal of sufficient length' };
    }

    const { registry, repository } = splitNameParts(namePart);
    return { raw, kind: 'digest', registry, repository, tag: null, digest: digestPart, malformedReason: null };
  }

  // No digest — must be name[:tag].
  // Find the tag by locating the LAST colon that is part of the tag, not part
  // of a registry:port prefix.
  //
  // Strategy: split on '/' to identify the domain component, then look for a
  // colon in the last path segment only.
  const slashIdx = trimmed.indexOf('/');

  let domainPart: string | null = null;
  let rest: string;

  if (slashIdx === -1) {
    // No slash at all: this is either "repo" or "repo:tag".
    // There is no domain. Any colon is a tag separator.
    rest = trimmed;
  } else {
    const firstSegment = trimmed.slice(0, slashIdx);
    if (looksLikeDomain(firstSegment)) {
      domainPart = firstSegment;
      rest = trimmed.slice(slashIdx + 1);
    } else {
      rest = trimmed;
    }
  }

  // In 'rest', find tag. The tag comes after the last colon in the LAST
  // path segment. But if there are multiple slashes, we only look in the last
  // segment. This handles: registry:5000/group/repo:tag correctly.
  const lastSlash = rest.lastIndexOf('/');
  const lastSegment = lastSlash === -1 ? rest : rest.slice(lastSlash + 1);
  const colonInLastSegment = lastSegment.indexOf(':');

  let repoPath: string;
  let tag: string | null = null;

  if (colonInLastSegment !== -1) {
    const tagCandidate = lastSegment.slice(colonInLastSegment + 1);
    if (!tagCandidate) {
      return { ...base, kind: 'malformed', malformedReason: 'colon at end of image name with no tag value' };
    }
    // Validate tag characters: [A-Za-z0-9_][A-Za-z0-9_.-]*  max 128 chars
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.:-]*$/.test(tagCandidate) || tagCandidate.length > 128) {
      return { ...base, kind: 'malformed', malformedReason: `invalid tag characters or length: ${tagCandidate.slice(0, 40)}` };
    }
    repoPath = (lastSlash === -1 ? '' : rest.slice(0, lastSlash + 1)) + lastSegment.slice(0, colonInLastSegment);
    tag = tagCandidate;
  } else {
    repoPath = rest;
  }

  if (!repoPath) {
    return { ...base, kind: 'malformed', malformedReason: 'empty repository path' };
  }

  // Validate repository path characters (simplified).
  if (!/^[a-z0-9._/-]+$/.test(repoPath)) {
    return { ...base, kind: 'malformed', malformedReason: `invalid characters in repository path: ${repoPath.slice(0, 60)}` };
  }

  const fullRepo = domainPart ? `${domainPart}/${repoPath}` : repoPath;
  const { registry, repository } = splitNameParts(fullRepo);

  if (tag === null) {
    // No tag, no digest → implicit latest.
    return { raw, kind: 'implicit-latest', registry, repository, tag: null, digest: null, malformedReason: null };
  }

  if (tag === 'latest') {
    return { raw, kind: 'explicit-latest', registry, repository, tag: 'latest', digest: null, malformedReason: null };
  }

  return { raw, kind: 'explicit-tag', registry, repository, tag, digest: null, malformedReason: null };
}

/** Split a full name (after removing tag/digest) into registry and repository. */
function splitNameParts(name: string): { registry: string | null; repository: string | null } {
  const slashIdx = name.indexOf('/');
  if (slashIdx === -1) {
    return { registry: null, repository: name };
  }
  const firstSegment = name.slice(0, slashIdx);
  if (looksLikeDomain(firstSegment)) {
    return { registry: firstSegment, repository: name.slice(slashIdx + 1) };
  }
  return { registry: null, repository: name };
}

// ---------------------------------------------------------------------------
// Policy enforcement
// ---------------------------------------------------------------------------

/**
 * Validate that an image reference meets the QuaranGate image policy:
 *
 *   - must be parseable
 *   - must NOT be implicit latest (no tag, no digest)
 *   - must NOT be explicit :latest
 *   - must be an explicit non-latest tag OR a digest reference
 *
 * Returns null on success. Returns a human-readable error string on failure.
 * Never throws.
 */
export function validateImageRef(raw: string): string | null {
  const parsed = parseImageRef(raw);
  switch (parsed.kind) {
    case 'explicit-tag':
    case 'digest':
      return null;
    case 'implicit-latest':
      return `image reference "${raw}" has no explicit tag or digest (implicit :latest is refused)`;
    case 'explicit-latest':
      return `image reference "${raw}" uses the explicit :latest tag (refused)`;
    case 'malformed':
      return `image reference "${raw}" is malformed: ${parsed.malformedReason}`;
  }
}

/**
 * Assert that an image reference is valid under QuaranGate policy.
 * Throws a TypeError with a descriptive message on violation.
 *
 * Use this at trusted startup/config-load sites where a thrown error
 * is appropriate.
 */
export function assertValidImageRef(raw: string, context?: string): void {
  const err = validateImageRef(raw);
  if (err) {
    const prefix = context ? `[${context}] ` : '';
    throw new TypeError(`${prefix}${err}`);
  }
}

/**
 * Convenience: returns true iff the reference is valid (explicit tag or digest,
 * not :latest, not malformed, not implicit latest).
 */
export function isValidImageRef(raw: string): boolean {
  return validateImageRef(raw) === null;
}
