import type { GitHubRunnerEnvironment } from "./provision";
import type { GitHubAppEnvironment } from "./github-app";
import type { GitHubCredentialEnvironment } from "./github-repository";

export interface WorkerSecrets {
  /** GitHub App authentication and webhook credentials. */
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_APP_WEBHOOK_SECRET: string;
  /** HMAC key for the short-lived, runner-scoped trace ingestion capability. */
  RESOURCE_TRACE_SIGNING_KEY: string;
  /** HMAC key for short-lived, repository-scoped R2 cache capabilities. */
  RUNNER_CACHE_SIGNING_KEY: string;
}

export type WorkerEnvironment = Env &
  GitHubRunnerEnvironment &
  GitHubAppEnvironment &
  GitHubCredentialEnvironment &
  WorkerSecrets;
