import { AUTHORITATIVE_ROUTES } from './routes.mjs';

export const P10V_SCHEMA_VERSION = 1;

export const P10V_REQUIRED_ROUTE_IDS = Object.freeze(AUTHORITATIVE_ROUTES.map((route) => route.id));

export const P10V_REQUIRED_DEMO_IDS = Object.freeze([
  'install-first-run',
  'console-tour',
  'governed-task',
  'ide-session',
  'github-workflow',
  'failure-recovery',
  'backup-recovery',
]);

export const P10V_REQUIRED_EVIDENCE_FILES = Object.freeze([
  'identity/source.json',
  'identity/runtime.json',
  'identity/browser.json',
  'playwright/results.json',
  'visual/summary.json',
  'accessibility/report.json',
  'observability/console-summary.json',
  'observability/network-summary.json',
  'security/public-media-scan.json',
]);

export function validateP10vRuntimeUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('QG_P10V_BASE_URL is required');
  let url;
  try { url = new URL(raw); } catch { throw new Error('QG_P10V_BASE_URL must be an absolute URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('P10-V runtime must use http or https');
  if (url.username || url.password) throw new Error('P10-V runtime URL must not embed credentials');
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)) {
    throw new Error('P10-V automatic capture is restricted to localhost/127.0.0.1; non-local recording requires a separate owner-authorized gate');
  }
  if (url.pathname !== '/console/' || url.search || url.hash) {
    throw new Error('P10-V runtime URL must target the exact /console/ root without query/hash state');
  }
  return url.href;
}

export function p10vContract() {
  return {
    schemaVersion: P10V_SCHEMA_VERSION,
    authority: 'REAL_QUARANGATE_RUNTIME_ONLY',
    syntheticDisposableDataOnly: true,
    mockServerAcceptedAsAuthority: false,
    routeIds: [...P10V_REQUIRED_ROUTE_IDS],
    demoIds: [...P10V_REQUIRED_DEMO_IDS],
    requiredEvidenceFiles: [...P10V_REQUIRED_EVIDENCE_FILES],
    safety: {
      automaticCaptureTarget: 'LOCALHOST_ONLY',
      externalPrivateEvidenceDirectory: true,
      publicMediaManualReviewRequired: true,
      publicMediaSecretScanRequired: true,
      piiScanRequired: true,
      privatePathScanRequired: true,
      failedQualificationTracesRetained: true,
      snapshotAutoUpdateForbidden: true,
      toleranceWeakeningForbidden: true,
      authorityRegionMaskingForbidden: true,
    },
  };
}
