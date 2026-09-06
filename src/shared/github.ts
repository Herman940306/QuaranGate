/** Shared bounded GitHub control-plane contracts. */

export const GITHUB_PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const GITHUB_OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
export const GITHUB_REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
export const GITHUB_REPOSITORY_KEY_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
export const GITHUB_BRANCH_PATTERN = /^(?!\/)(?!.*\.\.)(?!.*(?:^|\/)\.)(?!.*[~^:?*\[\\\s])(?!.*\/$)(?!.*\.lock(?:\/|$))[A-Za-z0-9._\/-]{1,255}$/;
export const GITHUB_COMMIT_PATTERN = /^[0-9a-f]{40}$/;

export const GITHUB_API_VERSION = '2026-03-10';
export const GITHUB_MAX_LIST_ITEMS = 100;
export const GITHUB_MAX_DISCOVERED_REPOSITORIES = 1000;
export const GITHUB_MAX_INSTALLATION_PAGES = 10;
export const GITHUB_MAX_BODY_CHARS = 65_536;
export const GITHUB_MAX_READ_BODY_CHARS = 8_192;
export const GITHUB_MAX_TITLE_CHARS = 256;
export const GITHUB_MAX_PUSH_RUNTIME_MS = 120_000;
export const GITHUB_MAX_PUSH_OUTPUT_BYTES = 32_768;
export const GITHUB_MAX_API_RESPONSE_BYTES = 4 * 1024 * 1024;

export type GitHubReviewEvent = 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';

export interface GitHubRepositorySummary {
  repository: string;
  owner: string;
  repo: string;
  private: boolean;
  archived: boolean;
  localProject?: string;
  protectedBranches: string[];
}

export interface GitHubRepoMetadata {
  repository: string;
  localProject?: string;
  fullName: string;
  defaultBranch: string;
  private: boolean;
  archived: boolean;
  disabled: boolean;
  pushedAt?: string;
}

export interface GitHubBranchSummary {
  name: string;
  sha: string;
  protected: boolean;
}

export interface GitHubCommitSummary {
  sha: string;
  message: string;
  authorName?: string;
  authoredAt?: string;
  htmlUrl?: string;
}

export interface GitHubPullSummary {
  number: number;
  title: string;
  state: string;
  draft: boolean;
  headRef: string;
  baseRef: string;
  author?: string;
  updatedAt?: string;
  htmlUrl?: string;
}

export interface GitHubPullFileSummary {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
}

export interface GitHubIssueSummary {
  number: number;
  title: string;
  state: string;
  author?: string;
  labels: string[];
  comments: number;
  updatedAt?: string;
  htmlUrl?: string;
}

export interface GitHubIssueDetail extends GitHubIssueSummary {
  body?: string;
  locked: boolean;
}

export interface GitHubCommentSummary {
  id: number;
  author?: string;
  body: string;
  createdAt?: string;
  updatedAt?: string;
  htmlUrl?: string;
}

export interface GitHubPullReviewSummary {
  id: number;
  user?: string;
  state: string;
  body?: string;
  submittedAt?: string;
  commitId?: string;
  htmlUrl?: string;
}

export interface GitHubPullReviewCommentSummary extends GitHubCommentSummary {
  path: string;
  line?: number;
  side?: string;
  commitId?: string;
}

export interface GitHubChecksSummary {
  ref: string;
  checkRuns: Array<{ name: string; status: string; conclusion?: string; htmlUrl?: string }>;
  statuses: Array<{ context: string; state: string; description?: string; targetUrl?: string }>;
}
