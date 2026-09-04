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
import { resolveExecutorStartupPolicy } from '../../src/executor/startupPolicy.js';

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
    ).toThrow(/:latest tags not allowed/);
  });

  it('enabled Ollama rejects :latest in stager even with valid qualifier and helper', () => {
    expect(() =>
      resolveExecutorStartupPolicy(true, {
        ollamaHost: 'http://ollama:11434',
        ollamaModelQualifier: 'llama3.2:1b', // valid
        agentHelperImage: 'helper:v1.0.0', // valid
        agentStagerImage: 'quarangate/stager:latest', // :latest forbidden
      })
    ).toThrow(/:latest tags not allowed/);
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
    ).toThrow(/:latest tags not allowed/);

    // :latest in helperImage
    expect(() =>
      resolveExecutorStartupPolicy(true, {
        ollamaHost: 'http://ollama:11434',
        ollamaModelQualifier: 'llama3.2:1b',
        agentHelperImage: 'helper:latest', // :latest forbidden
        agentStagerImage: 'stager:v1.0.0',
      })
    ).toThrow(/:latest tags not allowed/);

    // :latest in stagerImage
    expect(() =>
      resolveExecutorStartupPolicy(true, {
        ollamaHost: 'http://ollama:11434',
        ollamaModelQualifier: 'llama3.2:1b',
        agentHelperImage: 'helper:v1.0.0',
        agentStagerImage: 'stager:latest', // :latest forbidden
      })
    ).toThrow(/:latest tags not allowed/);
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
    // Verify the error message mentions all three image types
    expect(() =>
      resolveExecutorStartupPolicy(true, {
        ollamaHost: 'http://ollama:11434',
        ollamaModelQualifier: 'llama3.2:1b',
        agentHelperImage: 'helper:v1.0.0',
        agentStagerImage: 'stager:latest',
      })
    ).toThrow(/:latest tags not allowed for OLLAMA_MODEL_QUALIFIER, AGENT_HELPER_IMAGE, or AGENT_STAGER_IMAGE/);
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
