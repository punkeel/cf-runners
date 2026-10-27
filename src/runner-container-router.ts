import { getContainer } from "@cloudflare/containers";

import type { WorkerEnvironment } from "./environment";
import type { RunnerContainer } from "./provision";

/**
 * Every runner — any preset size, any custom shape, and the diagnostic
 * `cf-validation-job-*` runners — is one named instance of the single
 * `GitHubActionsRunner` container class. The instance shape is chosen per
 * start() call (see provision.ts), so no slot-to-application routing is
 * needed anymore.
 */
export function runnerContainerFor(env: WorkerEnvironment, runnerName: string): RunnerContainer {
  return getContainer(env.RUNNER, runnerName);
}
