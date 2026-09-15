/** Pure production backend-factory composition with intact A8 session context. */
import type { AgentResourcePolicy } from '../../shared/agents.js';
import type { AgentBackendAdapter, ResolvedSessionContext } from './jobEngine.js';
import type { AgentJobRow } from './jobStore.js';

export type RuntimeBackendFactory = (
  job: AgentJobRow,
  policy: AgentResourcePolicy,
  session?: ResolvedSessionContext,
) => AgentBackendAdapter | null;

export function composeRuntimeBackendFactories(
  factories: readonly RuntimeBackendFactory[],
): RuntimeBackendFactory {
  return (job, policy, session) => {
    for (const factory of factories) {
      const backend = factory(job, policy, session);
      if (backend !== null) return backend;
    }
    return null;
  };
}
