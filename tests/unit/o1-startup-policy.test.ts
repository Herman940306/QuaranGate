/**
 * O1 Startup Policy Tests — Fail-closed stager validation.
 *
 * These tests prove the fail-closed validation for the AGENT_STAGER_IMAGE
 * requirement when Ollama is enabled, covering all scenarios:
 *
 * 1. Missing stager when Ollama enabled → throws
 * 2. :latest stager rejected → throws
 * 3. Runner cannot substitute for stager (separate field required)
 * 4. Helper cannot substitute for stager (separate field required)
 * 5. Disabled Ollama doesn't require stager → succeeds
 * 6. All three images validated together (:latest check covers all)
 */
import { describe, it, expect } from 'vitest';
import {
  isApprovedOllamaLocalHost,
  isExplicitO1ImageReference,
  isExplicitOllamaModelQualifier,
  resolveExecutorStartupPolicy,
} from '../../src/executor/startupPolicy.js';

describe('O1 startup policy — stager validation', () => {
  // Test 1: Missing stager when Ollama enabled → throws 'AGENT_STAGER_IMAGE is not set'
  it('enabled Ollama with missing AGENT_STAGER_IMAGE is refused', () => {
    expect(() =>
      resolveExecutorStartupPolicy(true, {
        ollamaHost: 'http://ollama:11434',
        ollamaModelQualifier: 'llama3.2:1b',
        agentHelperImage: 'helper:v1.0.0',
        // agentStagerImage intentionally missing
      })
    ).toThrow(/AGENT_STAGER_IMAGE is not set/);
  });

  it('enabled Ollama with all required vars except stager throws before other checks', () => {
    expect(() =>
      resolveExecutorStartupPolicy(true, {
        agentRunnerImage: 'runner:v1.0.0',
        ollamaHost: 'http://ollama:11434',
        ollamaModelQualifier: 'llama3.2:1b',
        agentHelperImage: 'helper:v1.0.0',
        // agentStagerImage missing
      })
    ).toThrow(/AGENT_STAGER_IMAGE is not set/);
  });

  // Test 2: :latest stager rejected → throws ':latest tags not allowed'
  it('enabled Ollama with :latest AGENT_STAGER_IMAGE is refused', () => {
    expect(() =>
      resolveExecutorStartupPolicy(true, {
        ollamaHost: 'http://ollama:11434',
        ollamaModelQualifier: 'llama3.2:1b',
        agentHelperImage: 'helper:v1.0.0',
        agentStagerImage: 'stager:latest', // :latest tag forbidden
      })
    ).toThrow(/uses the explicit :latest tag \(refused\)/);
  });

  it('enabled Ollama rejects :latest in stager even with valid qualifier and helper', () => {
    expect(() =>
      resolveExecutorStartupPolicy(true, {
        ollamaHost: 'http://ollama:11434',
        ollamaModelQualifier: 'llama3.2:1b', // valid
        agentHelperImage: 'helper:v1.0.0', // valid
        agentStagerImage: 'quarangate/stager:latest', // :latest forbidden
      })
    ).toThrow(/uses the explicit :latest tag \(refused\)/);
  });

  // Test 3: Runner cannot substitute for stager
  it('enabled Ollama with AGENT_RUNNER_IMAGE only (no stager) is refused', () => {
    expect(() =>
      resolveExecutorStartupPolicy(true, {
        agentRunnerImage: 'runner:v1.0.0', // runner present
        ollamaHost: 'http://ollama:11434',
        ollamaModelQualifier: 'llama3.2:1b',
        agentHelperImage: 'helper:v1.0.0',
        // agentStagerImage missing — runner CANNOT substitute
      })
    ).toThrow(/AGENT_STAGER_IMAGE is not set/);
  });

  it('stagerImage is a separate required field, not defaulting to runnerImage', () => {
    // This test proves stager does not fall back to runner
    expect(() =>
      resolveExecutorStartupPolicy(true, {
        agentRunnerImage: 'runner:v1.0.0',
        ollamaHost: 'http://ollama:11434',
        ollamaModelQualifier: 'llama3.2:1b',
        agentHelperImage: 'helper:v1.0.0',
        // Explicitly not providing agentStagerImage
      })
    ).toThrow(/AGENT_STAGER_IMAGE is not set/);
  });

  // Test 4: Helper cannot substitute for stager
  it('enabled Ollama with AGENT_HELPER_IMAGE only (no stager) is refused', () => {
    expect(() =>
      resolveExecutorStartupPolicy(true, {
        ollamaHost: 'http://ollama:11434',
        ollamaModelQualifier: 'llama3.2:1b',
        agentHelperImage: 'helper:v1.0.0', // helper present
        // agentStagerImage missing — helper CANNOT substitute
      })
    ).toThrow(/AGENT_STAGER_IMAGE is not set/);
  });

  it('stagerImage is required even when helperImage is set', () => {
    // This test proves stager is a distinct required field
    expect(() =>
      resolveExecutorStartupPolicy(true, {
        agentRunnerImage: 'runner:v1.0.0',
        ollamaHost: 'http://ollama:11434',
        ollamaModelQualifier: 'llama3.2:1b',
        agentHelperImage: 'helper:v1.0.0', // helper present
        // agentStagerImage missing
      })
    ).toThrow(/AGENT_STAGER_IMAGE is not set/);
  });

  // Test 5: Disabled Ollama doesn't require stager → succeeds, ollama.enabled=false
  it('disabled Ollama with no AGENT_STAGER_IMAGE succeeds', () => {
    const policy = resolveExecutorStartupPolicy(false, {
      ollamaHost: 'http://ollama:11434',
      ollamaModelQualifier: 'llama3.2:1b',
      agentHelperImage: 'helper:v1.0.0',
      // agentStagerImage missing — allowed because Ollama is disabled
    });

    expect(policy.ollama.enabled).toBe(false);
  });

  it('disabled Ollama with missing stager returns valid policy', () => {
    const policy = resolveExecutorStartupPolicy(false, {
      agentRunnerImage: 'runner:v1.0.0',
      // All Ollama vars missing
    });

    expect(policy).toEqual({
      runnerImage: 'runner:v1.0.0',
      kiroHelperImage: 'runner:v1.0.0', // fallback to runner
      ollama: { enabled: false },
    });
  });

  it('disabled Ollama ignores stager validation entirely', () => {
    // Even with :latest stager, disabled Ollama succeeds
    const policy = resolveExecutorStartupPolicy(false, {
      agentRunnerImage: 'runner:v1.0.0',
      agentHelperImage: 'helper:latest', // :latest allowed when Ollama disabled
      agentStagerImage: 'stager:latest', // :latest allowed when Ollama disabled
      ollamaHost: 'http://ollama:11434',
      ollamaModelQualifier: 'llama3.2:latest', // :latest allowed when Ollama disabled
    });

    expect(policy.ollama.enabled).toBe(false);
  });

  // Test 6: All three images validated together (:latest check covers modelQualifier, helperImage, AND stagerImage)
  it('enabled Ollama checks :latest in all three images', () => {
    // :latest in modelQualifier
    expect(() =>
      resolveExecutorStartupPolicy(true, {
        ollamaHost: 'http://ollama:11434',
        ollamaModelQualifier: 'llama3.2:latest', // :latest forbidden
        agentHelperImage: 'helper:v1.0.0',
        agentStagerImage: 'stager:v1.0.0',
      })
    ).toThrow(/:latest tag not allowed for OLLAMA_MODEL_QUALIFIER/);

    // :latest in helperImage
    expect(() =>
      resolveExecutorStartupPolicy(true, {
        ollamaHost: 'http://ollama:11434',
        ollamaModelQualifier: 'llama3.2:1b',
        agentHelperImage: 'helper:latest', // :latest forbidden
        agentStagerImage: 'stager:v1.0.0',
      })
    ).toThrow(/uses the explicit :latest tag \(refused\)/);

    // :latest in stagerImage
    expect(() =>
      resolveExecutorStartupPolicy(true, {
        ollamaHost: 'http://ollama:11434',
        ollamaModelQualifier: 'llama3.2:1b',
        agentHelperImage: 'helper:v1.0.0',
        agentStagerImage: 'stager:latest', // :latest forbidden
      })
    ).toThrow(/uses the explicit :latest tag \(refused\)/);
  });

  it('enabled Ollama with all images explicitly versioned succeeds', () => {
    const policy = resolveExecutorStartupPolicy(true, {
      agentRunnerImage: 'runner:v1.0.0',
      ollamaHost: 'http://ollama:11434',
      ollamaModelQualifier: 'llama3.2:1b', // explicit version
      agentHelperImage: 'helper:v1.0.0', // explicit version
      agentStagerImage: 'stager:v1.0.0', // explicit version
    });

    expect(policy.ollama).toEqual({
      enabled: true,
      host: 'http://ollama:11434',
      modelQualifier: 'llama3.2:1b',
      helperImage: 'helper:v1.0.0',
      stagerImage: 'stager:v1.0.0',
    });
  });

  it(':latest check is comprehensive across all Ollama image parameters', () => {
    // Verify the error message identifies the specific image parameter
    expect(() =>
      resolveExecutorStartupPolicy(true, {
        ollamaHost: 'http://ollama:11434',
        ollamaModelQualifier: 'llama3.2:1b',
        agentHelperImage: 'helper:v1.0.0',
        agentStagerImage: 'stager:latest',
      })
    ).toThrow(/AGENT_STAGER_IMAGE.*uses the explicit :latest tag \(refused\)/);
  });

  // Additional edge cases for comprehensive coverage
  it('empty stagerImage string is treated as missing', () => {
    expect(() =>
      resolveExecutorStartupPolicy(true, {
        ollamaHost: 'http://ollama:11434',
        ollamaModelQualifier: 'llama3.2:1b',
        agentHelperImage: 'helper:v1.0.0',
        agentStagerImage: '', // empty string
      })
    ).toThrow(/AGENT_STAGER_IMAGE is not set/);
  });

  it('undefined stagerImage is treated as missing', () => {
    expect(() =>
      resolveExecutorStartupPolicy(true, {
        ollamaHost: 'http://ollama:11434',
        ollamaModelQualifier: 'llama3.2:1b',
        agentHelperImage: 'helper:v1.0.0',
        agentStagerImage: undefined, // explicitly undefined
      })
    ).toThrow(/AGENT_STAGER_IMAGE is not set/);
  });

  it('stagerImage validation happens after all other required vars are checked', () => {
    // Missing host should throw before stager check
    expect(() =>
      resolveExecutorStartupPolicy(true, {
        // ollamaHost missing
        ollamaModelQualifier: 'llama3.2:1b',
        agentHelperImage: 'helper:v1.0.0',
        agentStagerImage: 'stager:v1.0.0',
      })
    ).toThrow(/OLLAMA_HOST is not set/);

    // Missing modelQualifier should throw before stager check
    expect(() =>
      resolveExecutorStartupPolicy(true, {
        ollamaHost: 'http://ollama:11434',
        // ollamaModelQualifier missing
        agentHelperImage: 'helper:v1.0.0',
        agentStagerImage: 'stager:v1.0.0',
      })
    ).toThrow(/OLLAMA_MODEL_QUALIFIER is not set/);

    // Missing helper should throw before stager check
    expect(() =>
      resolveExecutorStartupPolicy(true, {
        ollamaHost: 'http://ollama:11434',
        ollamaModelQualifier: 'llama3.2:1b',
        // agentHelperImage missing
        agentStagerImage: 'stager:v1.0.0',
      })
    ).toThrow(/AGENT_HELPER_IMAGE is not set/);
  });

  it('stagerImage is populated in enabled Ollama policy', () => {
    const policy = resolveExecutorStartupPolicy(true, {
      ollamaHost: 'http://ollama:11434',
      ollamaModelQualifier: 'llama3.2:1b',
      agentHelperImage: 'helper:v1.0.0',
      agentStagerImage: 'quarangate/stager:sha256-abcdef',
    });

    expect(policy.ollama.enabled).toBe(true);
    if (policy.ollama.enabled) {
      expect(policy.ollama.stagerImage).toBe('quarangate/stager:sha256-abcdef');
    }
  });

  it('runnerImage and kiroHelperImage are populated independently of Ollama', () => {
    const policy = resolveExecutorStartupPolicy(true, {
      agentRunnerImage: 'runner:v2.0.0',
      agentHelperImage: 'helper:v1.0.0',
      ollamaHost: 'http://ollama:11434',
      ollamaModelQualifier: 'llama3.2:1b',
      agentStagerImage: 'stager:v1.0.0',
    });

    expect(policy.runnerImage).toBe('runner:v2.0.0');
    expect(policy.kiroHelperImage).toBe('helper:v1.0.0'); // explicit helper takes precedence
  });

  it('kiroHelperImage falls back to runnerImage when helper not specified', () => {
    const policy = resolveExecutorStartupPolicy(false, {
      agentRunnerImage: 'runner:v1.0.0',
      // agentHelperImage not specified
    });

    expect(policy.runnerImage).toBe('runner:v1.0.0');
    expect(policy.kiroHelperImage).toBe('runner:v1.0.0'); // fallback to runner
  });

  it('Ollama stagerImage does not affect Kiro helper fallback logic', () => {
    const policy = resolveExecutorStartupPolicy(true, {
      agentRunnerImage: 'runner:v1.0.0',
      // agentHelperImage not specified — should fall back to runner for Kiro
      ollamaHost: 'http://ollama:11434',
      ollamaModelQualifier: 'llama3.2:1b',
      agentHelperImage: 'ollama-helper:v1.0.0', // Ollama helper
      agentStagerImage: 'ollama-stager:v1.0.0', // Ollama stager
    });

    expect(policy.kiroHelperImage).toBe('ollama-helper:v1.0.0'); // explicit helper takes precedence
    if (policy.ollama.enabled) {
      expect(policy.ollama.helperImage).toBe('ollama-helper:v1.0.0');
      expect(policy.ollama.stagerImage).toBe('ollama-stager:v1.0.0');
    }
  });
});

describe('O1 final production closeout — local endpoint and explicit reference gate', () => {
  const malformedImageReferences = [
    ':v1',
    '::v1',
    'image::v1',
    'image:v1:extra',
    'http://evil:v1',
    'https://evil:v1',
    'image',
    'image:',
    'image:latest',
    'image:LATEST',
    'image:Latest',
    'image:lAtEsT',
    '/repo:v1',
    'registry.internal:5000/repository',
    'registry.internal:5000/repository:latest',
    'registry:abc/repo:v1',
    'registry:0/repo:v1',
    'registry:65536/repo:v1',
    `@sha256:${'a'.repeat(64)}`,
    'image@sha256:',
    'image@md5:0123456789abcdef',
    `helper@sha512:${'b'.repeat(128)}`,
    ' image:v1',
    'image:v1 ',
    'image: v1',
    'image:v1\n',
    'image:v1\r\n',
    'image:\0v1',
    'registry.internal//repository:v1',
    `image@sha256:${'a'.repeat(63)}`,
    `image@sha256:${'g'.repeat(64)}`,
  ];

  const validImageReferences = [
    'helper:v1',
    'helper:v1.2.3',
    'registry.internal:5000/quarangate/helper:v1',
    'registry.internal/quarangate/helper:v1',
    `helper@sha256:${'a'.repeat(64)}`,
  ];

  const malformedModelQualifiers = [
    ':v1',
    '::v1',
    'qwen::v1',
    'http://evil:v1',
    'https://evil:v1',
    'qwen3.5',
    'qwen3.5:',
    'qwen3.5:latest',
    'qwen3.5:LATEST',
    '/qwen:v1',
    'namespace//model:v1',
    ' qwen3.5:4b',
    'qwen3.5:4b ',
    'qwen3.5:4 b',
    'qwen3.5:4b\n',
    'qwen3.5:4b\0',
    `qwen3.5@sha256:${'a'.repeat(64)}`,
  ];

  const validModelQualifiers = [
    'qwen3.5:4b-q4_K_M',
    'qwen3.5:4b',
    'gemma3:4b',
    'namespace/model:v1',
  ];

  it.each(malformedImageReferences)('rejects malformed image reference %j', (value) => {
    expect(isExplicitO1ImageReference(value)).toBe(false);
  });

  it.each(validImageReferences)('accepts explicit image reference %j', (value) => {
    expect(isExplicitO1ImageReference(value)).toBe(true);
  });

  it.each(['image:latest', 'image:LATEST', 'image:Latest', 'image:lAtEsT'])(
    'rejects latest case-insensitively through startup policy %j',
    (agentHelperImage) => {
      expect(() => resolveExecutorStartupPolicy(true, {
        ollamaHost: 'http://ollama:11434',
        ollamaModelQualifier: 'qwen3.5:4b-q4_K_M',
        agentHelperImage,
        agentStagerImage: 'quarangate-stager:v1',
      })).toThrow(/latest|explicit non-latest/);
    },
  );

  it.each(malformedModelQualifiers)('rejects malformed model qualifier %j', (value) => {
    expect(isExplicitOllamaModelQualifier(value)).toBe(false);
  });

  it.each(validModelQualifiers)('accepts explicit model qualifier %j', (value) => {
    expect(isExplicitOllamaModelQualifier(value)).toBe(true);
  });

  const refusedOllamaEndpoints = [
    ' http://ollama:11434',
    'http://ollama:11434 ',
    '\thttp://ollama:11434\n',
    'HTTP://OLLAMA:11434',
    'http://%6fllama:11434',
    'http://ollama:011434',
    'http://ollama:11434/%2e',
    'http://ollama:11434/%2e%2e',
    'http://ollama:11434/api',
    'http://ollama:11434?x=1',
    'http://ollama:11434#x',
    'http://user:pass@ollama:11434',
    'http://localhost:11434',
    'http://127.0.0.1:11434',
    'http://ollama:11435',
    'https://ollama:11434',
    'https://api.example.com',
  ];

  it.each(refusedOllamaEndpoints)('rejects non-exact Ollama endpoint %j', (ollamaHost) => {
    expect(isApprovedOllamaLocalHost(ollamaHost)).toBe(false);
    expect(() => resolveExecutorStartupPolicy(true, {
      ollamaHost,
      ollamaModelQualifier: 'qwen3.5:4b-q4_K_M',
      agentHelperImage: 'quarangate-helper:v1',
      agentStagerImage: 'quarangate-stager:v1',
    })).toThrow(/approved local endpoint/);
  });

  it('recognizes only the exact approved Ollama endpoint', () => {
    expect(isApprovedOllamaLocalHost('http://ollama:11434')).toBe(true);
  });

  it('accepts only the approved local Ollama service endpoint', () => {
    const policy = resolveExecutorStartupPolicy(true, {
      ollamaHost: 'http://ollama:11434',
      ollamaModelQualifier: 'qwen3.5:4b-q4_K_M',
      agentHelperImage: 'registry.internal:5000/quarangate/helper:v1',
      agentStagerImage: 'registry.internal:5000/quarangate/stager@sha256:' + 'a'.repeat(64),
    });
    expect(policy.ollama).toMatchObject({ enabled: true, host: 'http://ollama:11434' });
  });

  it('refuses implicit latest image references including registry-port syntax', () => {
    for (const [agentHelperImage, agentStagerImage] of [
      ['quarangate-helper', 'quarangate-stager:v1'],
      ['registry.internal:5000/quarangate/helper', 'quarangate-stager:v1'],
      ['quarangate-helper:v1', 'registry.internal:5000/quarangate/stager'],
    ]) {
      expect(() => resolveExecutorStartupPolicy(true, {
        ollamaHost: 'http://ollama:11434',
        ollamaModelQualifier: 'qwen3.5:4b-q4_K_M',
        agentHelperImage,
        agentStagerImage,
      })).toThrow(/explicit non-latest tags or sha256 digests/);
    }
  });

  it('refuses implicit-latest model qualifiers', () => {
    expect(() => resolveExecutorStartupPolicy(true, {
      ollamaHost: 'http://ollama:11434',
      ollamaModelQualifier: 'qwen3.5',
      agentHelperImage: 'quarangate-helper:v1',
      agentStagerImage: 'quarangate-stager:v1',
    })).toThrow(/explicit non-latest tag/);
  });
});
