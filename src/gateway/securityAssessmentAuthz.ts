import { BridgeError } from '../shared/errors.js';
import type { SecurityAssessmentOperationalBinding } from '../shared/securityAssessment.js';
import {
  principalCanTarget,
  principalHasScope,
  type Principal,
} from './config.js';
import { principalMayUseAgentProject } from './agentAuthz.js';

export type SecurityAssessmentAccessMode = 'read' | 'write';

export function authorizeSecurityAssessmentBinding(
  principal: Principal,
  binding: SecurityAssessmentOperationalBinding,
  mode: SecurityAssessmentAccessMode,
): void {
  const scope = mode === 'read' ? 'security:assessment:read' : 'security:assessment:write';
  if (!principal.enabled) {
    throw new BridgeError('CLIENT_DISABLED', 'security assessment principal is disabled', 403);
  }
  if (!principalHasScope(principal, scope)) {
    throw new BridgeError('FORBIDDEN_SCOPE', `missing scope ${scope}`, 403);
  }
  if (principal.id !== binding.principalRef) {
    throw new BridgeError('FORBIDDEN_PROJECT', 'security assessment Principal binding does not match current Principal', 403);
  }
  if (!principalMayUseAgentProject(principal, binding.projectId)) {
    throw new BridgeError('FORBIDDEN_PROJECT', 'security assessment project is not currently granted', 403);
  }
  if (binding.targetId && !principalCanTarget(principal, binding.targetId)) {
    throw new BridgeError('FORBIDDEN_TARGET', 'security assessment target is not currently granted', 403);
  }
  if (binding.networkClass !== 'NONE') {
    throw new BridgeError('FORBIDDEN_POLICY', 'BE9.2 assessment network class is not permitted', 403);
  }
  if (binding.credentialClass !== 'NONE') {
    throw new BridgeError('FORBIDDEN_POLICY', 'BE9.2 assessment credential class is not permitted', 403);
  }
}
