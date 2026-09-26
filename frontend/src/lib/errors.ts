export const errorCopy = {
  validation: "Check the highlighted fields and try again.",
  authentication: "Your session is unavailable. Sign in again when identity is configured.",
  authorization: "This operation is not permitted. Ask your administrator to review access.",
  unavailable: "The service is unavailable. Try again when it has recovered.",
  disconnected: "No connection is available. Reconnect before continuing.",
  conflict: "The information has changed. Refresh before trying again.",
  policy: "A server policy prevents this operation.",
  not_found: "This resource could not be found.",
  rate_limit: "Too many requests. Wait before trying again.",
  timeout: "The outcome is unknown. Refresh the current state before retrying.",
  partial: "Some information is unavailable. Check its source before acting.",
  server: "The operation could not be completed. Try again after checking service availability.",
  unknown: "The outcome could not be established. Check the current state before acting.",
} as const;
export type ErrorCategory = keyof typeof errorCopy;
