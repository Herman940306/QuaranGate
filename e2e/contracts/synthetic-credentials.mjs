export const SYNTHETIC_BROWSER_CREDENTIALS = Object.freeze({
  ok: 'e2e-ok',
  persistence: 'e2e-mem',
  authFailure: 'e2e-401',
  scopeDenied: 'e2e-403',
  rateLimited: 'e2e-429',
  malformed: 'e2e-json',
  mismatchedId: 'e2e-id',
  offline: 'e2e-off',
  slow: 'e2e-slow',
  missingTool: 'e2e-miss',
  extraTool: 'e2e-extra',
});

export const SYNTHETIC_BROWSER_CREDENTIAL_VALUES = Object.freeze(
  Object.values(SYNTHETIC_BROWSER_CREDENTIALS),
);
