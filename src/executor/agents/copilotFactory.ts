/** Trusted Copilot backend factory. */
import type { AgentProfileId, AgentResourcePolicy } from '../../shared/agents.js';
import { BridgeError } from '../../shared/errors.js';
import type { AgentBackendAdapter, ResolvedSessionContext } from './jobEngine.js';
import type { AgentJobRow } from './jobStore.js';
import { CopilotBackend, type CopilotBackendOptions } from './copilotBackend.js';

export interface CopilotFactoryProject {
  id: string;
  hostPath: string;
}

export function createCopilotBackendFactory(
  projects: CopilotFactoryProject[],
  model: string,
  deps: CopilotBackendOptions,
): (job: AgentJobRow, policy: AgentResourcePolicy, session?: ResolvedSessionContext) => AgentBackendAdapter | null {
  const hostPathById = new Map(projects.map((project) => [project.id, project.hostPath]));
  return (job, policy, session) => {
    if (job.backend !== 'copilot') return null;
    if (session) {
      throw new BridgeError('SESSION_NOT_RESUMABLE', 'Copilot session resume is not qualified for this backend', 409);
    }
    const hostPath = hostPathById.get(job.project);
    if (!hostPath) throw new BridgeError('UNKNOWN_PROJECT', `no trusted host path for project ${job.project}`, 404);
    return new CopilotBackend({
      jobId: job.jobId,
      principalId: job.principalId,
      backend: 'copilot',
      project: job.project,
      profile: job.profile as AgentProfileId,
      prompt: job.prompt,
      hostPath,
      policy,
      model,
    }, deps);
  };
}
