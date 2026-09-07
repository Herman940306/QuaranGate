/**
 * H1-1: Central image reference parser/validator tests.
 *
 * Adversarial coverage of the known failure class (registry:port/repo without
 * explicit tag), plus policy enforcement for implicit latest, explicit :latest,
 * digests, and malformed inputs.
 */
import { describe, it, expect } from 'vitest';
import { parseImageRef, validateImageRef, isValidImageRef, assertValidImageRef } from '../../src/shared/imageRef.js';

// ---------------------------------------------------------------------------
// parseImageRef — structural parsing
// ---------------------------------------------------------------------------

describe('parseImageRef — implicit latest (no tag, no digest)', () => {
  const cases = [
    'ubuntu',
    'library/ubuntu',
    'docker.io/library/ubuntu',
    'myregistry.example.com/myapp',
    'myregistry.example.com/group/myapp',
  ];
  for (const raw of cases) {
    it(`"${raw}" → implicit-latest`, () => {
      const r = parseImageRef(raw);
      expect(r.kind).toBe('implicit-latest');
      expect(r.tag).toBeNull();
      expect(r.digest).toBeNull();
    });
  }

  // THE KNOWN FAILURE CLASS: registry:port/repo — colon is port, NOT tag
  it('registry:5000/repository → implicit-latest (colon is port, not tag)', () => {
    const r = parseImageRef('registry:5000/repository');
    expect(r.kind).toBe('implicit-latest');
    expect(r.registry).toBe('registry:5000');
    expect(r.repository).toBe('repository');
    expect(r.tag).toBeNull();
  });

  it('localhost:5000/myapp → implicit-latest', () => {
    const r = parseImageRef('localhost:5000/myapp');
    expect(r.kind).toBe('implicit-latest');
    expect(r.registry).toBe('localhost:5000');
    expect(r.repository).toBe('myapp');
    expect(r.tag).toBeNull();
  });

  it('192.168.1.10:5000/myapp → implicit-latest', () => {
    const r = parseImageRef('192.168.1.10:5000/myapp');
    expect(r.kind).toBe('implicit-latest');
    expect(r.registry).toBe('192.168.1.10:5000');
    expect(r.tag).toBeNull();
  });

  it('registry:5000/group/repo → implicit-latest (nested path)', () => {
    const r = parseImageRef('registry:5000/group/repo');
    expect(r.kind).toBe('implicit-latest');
    expect(r.registry).toBe('registry:5000');
    expect(r.tag).toBeNull();
  });
});

describe('parseImageRef — explicit :latest (refused)', () => {
  const cases = [
    'ubuntu:latest',
    'library/ubuntu:latest',
    'docker.io/library/ubuntu:latest',
    'myregistry.example.com/myapp:latest',
    'registry:5000/repository:latest',
    'registry:5000/group/repo:latest',
    'localhost:5000/myapp:latest',
  ];
  for (const raw of cases) {
    it(`"${raw}" → explicit-latest`, () => {
      const r = parseImageRef(raw);
      expect(r.kind).toBe('explicit-latest');
      expect(r.tag).toBe('latest');
    });
  }
});

describe('parseImageRef — explicit non-latest tag (allowed)', () => {
  it('ubuntu:22.04 → explicit-tag', () => {
    const r = parseImageRef('ubuntu:22.04');
    expect(r.kind).toBe('explicit-tag');
    expect(r.tag).toBe('22.04');
    expect(r.registry).toBeNull();
    expect(r.repository).toBe('ubuntu');
  });

  it('registry:5000/myapp:v1.2.3 → explicit-tag, registry preserved', () => {
    const r = parseImageRef('registry:5000/myapp:v1.2.3');
    expect(r.kind).toBe('explicit-tag');
    expect(r.registry).toBe('registry:5000');
    expect(r.repository).toBe('myapp');
    expect(r.tag).toBe('v1.2.3');
  });

  it('registry:5000/group/repo:a5-prodtest → explicit-tag', () => {
    const r = parseImageRef('registry:5000/group/repo:a5-prodtest');
    expect(r.kind).toBe('explicit-tag');
    expect(r.registry).toBe('registry:5000');
    expect(r.repository).toBe('group/repo');
    expect(r.tag).toBe('a5-prodtest');
  });

  it('quarangate:gateway-abc123 → explicit-tag', () => {
    const r = parseImageRef('quarangate:gateway-abc123');
    expect(r.kind).toBe('explicit-tag');
    expect(r.tag).toBe('gateway-abc123');
    expect(r.registry).toBeNull();
  });

  it('mcp-ide-bridge-kiro-runner:a5-prodtest → explicit-tag', () => {
    const r = parseImageRef('mcp-ide-bridge-kiro-runner:a5-prodtest');
    expect(r.kind).toBe('explicit-tag');
    expect(r.tag).toBe('a5-prodtest');
  });

  it('docker.io/library/node:22-alpine → explicit-tag', () => {
    const r = parseImageRef('docker.io/library/node:22-alpine');
    expect(r.kind).toBe('explicit-tag');
    expect(r.registry).toBe('docker.io');
    expect(r.tag).toBe('22-alpine');
  });

  it('localhost:5000/myapp:dev → explicit-tag', () => {
    const r = parseImageRef('localhost:5000/myapp:dev');
    expect(r.kind).toBe('explicit-tag');
    expect(r.registry).toBe('localhost:5000');
    expect(r.tag).toBe('dev');
  });
});

describe('parseImageRef — digest references (allowed)', () => {
  const SHA = 'sha256:' + 'a'.repeat(64);
  const SHA512 = 'sha512:' + 'b'.repeat(128);

  it('ubuntu@sha256:<hex> → digest', () => {
    const r = parseImageRef(`ubuntu@${SHA}`);
    expect(r.kind).toBe('digest');
    expect(r.digest).toBe(SHA);
    expect(r.tag).toBeNull();
  });

  it('registry:5000/repo@sha256:<hex> → digest', () => {
    const r = parseImageRef(`registry:5000/repo@${SHA}`);
    expect(r.kind).toBe('digest');
    expect(r.registry).toBe('registry:5000');
    expect(r.repository).toBe('repo');
    expect(r.digest).toBe(SHA);
  });

  it('sha512 digest → digest', () => {
    const r = parseImageRef(`ubuntu@${SHA512}`);
    expect(r.kind).toBe('digest');
    expect(r.digest).toBe(SHA512);
  });

  it('registry:5000/repo@sha256:<hex> with path → digest', () => {
    const r = parseImageRef(`registry:5000/group/repo@${SHA}`);
    expect(r.kind).toBe('digest');
    expect(r.registry).toBe('registry:5000');
    expect(r.repository).toBe('group/repo');
  });
});

describe('parseImageRef — malformed inputs', () => {
  it('empty string → malformed', () => {
    expect(parseImageRef('').kind).toBe('malformed');
  });

  it('blank string → malformed', () => {
    expect(parseImageRef('   ').kind).toBe('malformed');
  });

  it('whitespace inside → malformed', () => {
    expect(parseImageRef('ubuntu :latest').kind).toBe('malformed');
  });

  it('trailing colon (no tag) → malformed', () => {
    expect(parseImageRef('ubuntu:').kind).toBe('malformed');
  });

  it('registry:5000/ (empty repo after slash) → malformed', () => {
    const r = parseImageRef('registry:5000/');
    expect(r.kind).toBe('malformed');
  });

  it('@sha256:abc (no name before @) → malformed', () => {
    expect(parseImageRef('@sha256:' + 'a'.repeat(64)).kind).toBe('malformed');
  });

  it('ubuntu@sha256 (no hex after algorithm) → malformed', () => {
    expect(parseImageRef('ubuntu@sha256').kind).toBe('malformed');
  });

  it('ubuntu@md5:abc (unsupported algorithm) → malformed', () => {
    expect(parseImageRef('ubuntu@md5:abcdef').kind).toBe('malformed');
  });

  it('ubuntu@sha256:UPPER (uppercase hex) → malformed', () => {
    expect(parseImageRef('ubuntu@sha256:' + 'A'.repeat(64)).kind).toBe('malformed');
  });

  it('ubuntu@sha256:tooshort → malformed', () => {
    expect(parseImageRef('ubuntu@sha256:abc').kind).toBe('malformed');
  });
});

describe('parseImageRef — adversarial malformed references', () => {
  const malformed = [
    'image:v1:extra',
    'image::v1',
    'registry:abc/repo:v1',
    'registry:0/repo:v1',
    'registry:65536/repo:v1',
    `registry:abc/repo@sha256:${'a'.repeat(64)}`,
    `registry:0/repo@sha256:${'a'.repeat(64)}`,
    `registry:65536/repo@sha256:${'a'.repeat(64)}`,
    'https://evil:v1',
    'http://evil:v1',
    'repo//image:v1',
    '/repo:v1',
    'repo/:v1',
    `name@@sha256:${'a'.repeat(64)}`,
    `name@sha256:${'a'.repeat(63)}`,
    `name@sha256:${'g'.repeat(64)}`,
  ];

  it.each(malformed)('rejects %j', (raw) => {
    expect(parseImageRef(raw).kind).toBe('malformed');
  });
});

describe('parseImageRef — raw is preserved', () => {
  it('raw field equals the exact input', () => {
    const raw = 'registry:5000/repo:v1';
    expect(parseImageRef(raw).raw).toBe(raw);
  });
});

// ---------------------------------------------------------------------------
// validateImageRef — policy enforcement
// ---------------------------------------------------------------------------

describe('validateImageRef — returns null for allowed references', () => {
  const allowed = [
    'ubuntu:22.04',
    'registry:5000/myapp:v1.2.3',
    'registry:5000/group/repo:a5-prodtest',
    'quarangate:executor-abc123',
    `ubuntu@sha256:${'a'.repeat(64)}`,
    `registry:5000/repo@sha256:${'b'.repeat(64)}`,
    'mcp-ide-bridge-kiro-runner:a4',
    'docker.io/library/node:22-alpine',
  ];
  for (const raw of allowed) {
    it(`allows: "${raw}"`, () => {
      expect(validateImageRef(raw)).toBeNull();
    });
  }
});

describe('validateImageRef — returns error string for refused references', () => {
  it('refuses implicit latest: ubuntu', () => {
    const err = validateImageRef('ubuntu');
    expect(err).toMatch(/implicit :latest/);
  });

  it('refuses implicit latest: registry:5000/repository (THE KNOWN FAILURE CLASS)', () => {
    const err = validateImageRef('registry:5000/repository');
    expect(err).toMatch(/implicit :latest/);
    expect(err).not.toBeNull();
  });

  it('refuses explicit :latest: ubuntu:latest', () => {
    const err = validateImageRef('ubuntu:latest');
    expect(err).toMatch(/:latest/);
  });

  it('refuses explicit :latest: registry:5000/repo:latest', () => {
    const err = validateImageRef('registry:5000/repo:latest');
    expect(err).toMatch(/:latest/);
  });

  it('refuses malformed: empty string', () => {
    const err = validateImageRef('');
    expect(err).toMatch(/malformed/);
  });

  it('refuses malformed: trailing colon', () => {
    const err = validateImageRef('ubuntu:');
    expect(err).toMatch(/malformed/);
  });
});

// ---------------------------------------------------------------------------
// isValidImageRef — boolean convenience
// ---------------------------------------------------------------------------

describe('isValidImageRef', () => {
  it('returns true for explicit-tag', () => {
    expect(isValidImageRef('ubuntu:22.04')).toBe(true);
  });

  it('returns true for digest', () => {
    expect(isValidImageRef(`ubuntu@sha256:${'a'.repeat(64)}`)).toBe(true);
  });

  it('returns false for implicit latest (bare name)', () => {
    expect(isValidImageRef('ubuntu')).toBe(false);
  });

  it('returns false for registry:port/repo without tag — THE KNOWN FAILURE CLASS', () => {
    expect(isValidImageRef('registry:5000/myapp')).toBe(false);
  });

  it('returns false for explicit :latest', () => {
    expect(isValidImageRef('ubuntu:latest')).toBe(false);
  });

  it('returns false for malformed', () => {
    expect(isValidImageRef('')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// assertValidImageRef — throws on violation
// ---------------------------------------------------------------------------

describe('assertValidImageRef', () => {
  it('does not throw for a valid explicit-tag reference', () => {
    expect(() => assertValidImageRef('ubuntu:22.04')).not.toThrow();
  });

  it('throws TypeError for implicit latest', () => {
    expect(() => assertValidImageRef('ubuntu')).toThrow(TypeError);
  });

  it('throws TypeError for registry:port/repo without tag', () => {
    expect(() => assertValidImageRef('registry:5000/myapp')).toThrow(TypeError);
    expect(() => assertValidImageRef('registry:5000/myapp')).toThrow(/implicit :latest/);
  });

  it('throws with context prefix when provided', () => {
    expect(() => assertValidImageRef('ubuntu:latest', 'AGENT_RUNNER_IMAGE'))
      .toThrow(/\[AGENT_RUNNER_IMAGE\]/);
  });

  it('throws TypeError for explicit :latest', () => {
    expect(() => assertValidImageRef('ubuntu:latest')).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// Adversarial cases — bypass attempts
// ---------------------------------------------------------------------------

describe('parseImageRef — adversarial bypass attempts', () => {
  it('double colon does not bypass: ubuntu::latest → malformed or not explicit-tag "latest"', () => {
    const r = parseImageRef('ubuntu::latest');
    // The second colon is in the tag, which contains a colon — that should parse
    // as tag=":latest" (starts with colon, fails char validation) → malformed.
    expect(r.kind).toBe('malformed');
  });

  it('tag with newline → malformed (whitespace guard)', () => {
    expect(parseImageRef('ubuntu:22.04\n').kind).toBe('malformed');
  });

  it('tag with NUL byte → malformed', () => {
    expect(parseImageRef('ubuntu:22.04\x00').kind).toBe('malformed');
  });

  it('"latest" as the only input → implicit-latest (single token, no colon → no tag)', () => {
    // "latest" as a bare repo name with no tag — implicit latest, refused.
    const r = parseImageRef('latest');
    expect(r.kind).toBe('implicit-latest');
  });

  it('registry:latest/repo → malformed because registry ports must be numeric', () => {
    expect(parseImageRef('registry:latest/repo').kind).toBe('malformed');
  });

  it('"quarangate:latest" → explicit-latest (single component, colon IS tag separator)', () => {
    // No slash: no domain. Colon IS the tag separator.
    const r = parseImageRef('quarangate:latest');
    expect(r.kind).toBe('explicit-latest');
    expect(r.tag).toBe('latest');
  });

  it('very long tag (> 128 chars) → malformed', () => {
    const longTag = 'a'.repeat(129);
    expect(parseImageRef(`ubuntu:${longTag}`).kind).toBe('malformed');
  });

  it('sha1 digest (not in allowed algorithms) → malformed', () => {
    expect(parseImageRef('ubuntu@sha1:' + 'a'.repeat(40)).kind).toBe('malformed');
  });

  it('uppercase in repository path → malformed', () => {
    // Docker image names are lowercase. Uppercase is malformed.
    expect(parseImageRef('Ubuntu:22.04').kind).toBe('malformed');
  });
});
