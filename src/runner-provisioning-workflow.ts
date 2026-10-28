import { NonRetryableError } from "cloudflare:workflows";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

import type { RunnerProvisioningPlan, SchedulerAdmission } from "./account-runner-scheduler";
import type { WorkerEnvironment } from "./environment";
import { githubTokenForRunner } from "./github-app";
import { provisionRunner } from "./provision";
import { runnerEligibilityFor, type RunnerEligibilityInput, type RunnerEligibilityResult } from "./runner-eligibility";
import { createResourceTraceContainerConfiguration } from "./resource-traces";
import { createRunnerCacheContainerConfiguration } from "./runner-cache";
import { runnerContainerFor } from "./runner-container-router";

export interface RunnerProvisioningWorkflowParameters {
  jobId: string;
  runnerName?: string;
}

const provisionStepConfig = {
  retries: {
    limit: 3,
    delay: "10 seconds",
    backoff: "exponential",
  },
  timeout: "5 minutes",
} as const;

function schedulerFor(env: WorkerEnvironment) {
  return env.RUNNER_SCHEDULER.getByName(env.CLOUDFLARE_ACCOUNT_ID);
}

interface EligibilityReleaseScheduler {
  provisioningFailed(jobId: string, reason: string, runnerName: string): Promise<{ admissions: SchedulerAdmission[] }>;
}

export interface EligibilityReleaseDependencies {
  authorize(env: WorkerEnvironment, input: RunnerEligibilityInput): Promise<RunnerEligibilityResult>;
  startProvisioning(env: WorkerEnvironment, admissions: readonly SchedulerAdmission[]): Promise<void>;
}

const eligibilityReleaseDependencies: EligibilityReleaseDependencies = {
  authorize: runnerEligibilityFor,
  startProvisioning: startRunnerProvisioningWorkflows,
};

export async function releaseIfRepositoryIsIneligible(
  env: WorkerEnvironment,
  scheduler: EligibilityReleaseScheduler,
  plan: RunnerProvisioningPlan,
  dependencies: EligibilityReleaseDependencies = eligibilityReleaseDependencies,
): Promise<boolean> {
  const eligibility = await dependencies.authorize(env, {
    jobId: plan.jobId,
    headSha: plan.headSha,
    target: plan.target,
    installationId: plan.installationId,
  });
  if (eligibility.kind === "private") {
    return false;
  }

  const released = await scheduler.provisioningFailed(
    plan.jobId,
    `Repository visibility is ${eligibility.visibility}`,
    plan.runnerName,
  );
  await dependencies.startProvisioning(env, released.admissions);
  console.log("Cloudflare runner provisioning rejected by repository eligibility", {
    jobId: plan.jobId,
    repository: `${plan.target.owner}/${plan.target.repository}`,
    visibility: eligibility.visibility,
    checkReported: eligibility.checkReported,
  });
  return true;
}

export type RunnerProvisioningWorkflowResult =
  | { kind: "cancelled" }
  | { kind: "missing" }
  | { kind: "started"; runnerName: string; runnerId: number }
  | { kind: "already-active"; runnerName: string };

export async function startRunnerProvisioningWorkflows(
  env: WorkerEnvironment,
  admissions: readonly SchedulerAdmission[],
): Promise<void> {
  for (const admission of admissions) {
    try {
      // eslint-disable-next-line no-await-in-loop -- duplicate IDs are handled before the next job is scheduled.
      await env.RUNNER_PROVISIONING_WORKFLOW.create({
        id: admission.workflowId,
        params: { jobId: admission.jobId, runnerName: admission.runnerName },
        retention: { successRetention: "1 day", errorRetention: "7 days" },
      });
    } catch {
      // Workflow creation can race the control-plane's instance index during
      // a fresh deployment. Retry the idempotent create before inspecting the
      // existing handle.
      try {
        // eslint-disable-next-line no-await-in-loop -- preserve admission ordering.
        await new Promise((resolve) => setTimeout(resolve, 1000));
        // eslint-disable-next-line no-await-in-loop -- preserve admission ordering.
        await env.RUNNER_PROVISIONING_WORKFLOW.create({
          id: admission.workflowId,
          params: { jobId: admission.jobId, runnerName: admission.runnerName },
          retention: { successRetention: "1 day", errorRetention: "7 days" },
        });
        continue;
      } catch {
        // The workflow may already exist; inspect it below.
      }
      // eslint-disable-next-line no-await-in-loop -- verify a deterministic workflow ID before continuing.
      const existing = await env.RUNNER_PROVISIONING_WORKFLOW.get(admission.workflowId);
      // eslint-disable-next-line no-await-in-loop -- the status belongs to the workflow just looked up.
      const status = await existing.status();
      if (status.status === "unknown") {
        throw new Error(`Could not create provisioning workflow for ${admission.runnerName}`);
      }
    }
  }
}

export class RunnerProvisioningWorkflow extends WorkflowEntrypoint<
  WorkerEnvironment,
  RunnerProvisioningWorkflowParameters
> {
  async run(
    event: Readonly<WorkflowEvent<RunnerProvisioningWorkflowParameters>>,
    step: WorkflowStep,
  ): Promise<RunnerProvisioningWorkflowResult> {
    const scheduler = schedulerFor(this.env);
    let plan: RunnerProvisioningPlan | undefined;
    for (let attempt = 1; attempt <= 120; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop -- a queued job may still be awaiting FIFO admission.
      const claim = await scheduler.claimProvisioning(event.payload.jobId, event.payload.runnerName);
      if (claim.kind === "provision") {
        plan = claim;
        break;
      }
      if (claim.kind === "cancelled" || claim.kind === "missing") {
        return claim;
      }
      // eslint-disable-next-line no-await-in-loop -- wait rather than racing the job's FIFO admission.
      await step.sleep(`wait for scheduler reservation ${attempt}`, "10 seconds");
    }

    if (plan === undefined) {
      throw new NonRetryableError("Scheduler did not make a reservation available within 20 minutes");
    }

    try {
      if (await releaseIfRepositoryIsIneligible(this.env, scheduler, plan)) {
        return { kind: "cancelled" };
      }

      const mayStart = await scheduler.canStart(plan.jobId, plan.runnerName);
      if (!mayStart) {
        const released = await scheduler.provisioningFailed(
          plan.jobId,
          "GitHub completed before runner provisioning",
          plan.runnerName,
        );
        await startRunnerProvisioningWorkflows(this.env, released.admissions);
        return { kind: "cancelled" };
      }

      if (await releaseIfRepositoryIsIneligible(this.env, scheduler, plan)) {
        return { kind: "cancelled" };
      }

      const result = await step.do("create JIT runner and start Container", provisionStepConfig, async () => {
        const runner = runnerContainerFor(this.env, plan.runnerName);
        const token = await githubTokenForRunner(this.env, plan.installationId);
        if (token === undefined) {
          throw new NonRetryableError(`No GitHub App installation token is available for ${plan.target.owner}`);
        }
        const started = await provisionRunner(
          this.env,
          { ...plan.target, token },
          runner,
          plan.runnerName,
          plan.profile,
          {
            fetch: (input, init) => fetch(input, init),
            onJitRunnerCreated: (runnerId) => scheduler.runnerProvisioned(plan.jobId, plan.runnerName, runnerId),
            resourceTrace: await createResourceTraceContainerConfiguration(this.env, {
              workerOrigin: plan.workerOrigin,
              runnerName: plan.runnerName,
              jobId: plan.jobId,
              target: plan.target,
            }),
            runnerCache:
              plan.cacheScope === undefined
                ? undefined
                : await createRunnerCacheContainerConfiguration(this.env, {
                    workerOrigin: plan.workerOrigin,
                    runnerName: plan.runnerName,
                    jobId: plan.jobId,
                    target: plan.target,
                    cacheScope: plan.cacheScope,
                  }),
          },
        );
        if (started.kind === "started" || started.kind === "already-active") {
          return started;
        }
        if (started.kind === "invalid-runner-group") {
          throw new NonRetryableError("GITHUB_RUNNER_GROUP_ID must be a positive integer");
        }
        throw new Error(`Runner provisioning failed: ${started.kind}`);
      });
      await scheduler.runnerStarted(plan.runnerName);
      return result;
    } catch (error) {
      const released = await scheduler.provisioningFailed(
        plan.jobId,
        error instanceof Error ? error.message : "Runner provisioning failed",
        plan.runnerName,
      );
      await startRunnerProvisioningWorkflows(this.env, released.admissions);
      throw error;
    }
  }
}
