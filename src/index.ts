import { ContainerProxy } from "@cloudflare/containers";

import { InstanceSizedContainer } from "./instance-sized-container";
import { z } from "zod";

import { AccountRunnerScheduler } from "./account-runner-scheduler";
import {
  githubInstallationFromWebhook,
  githubTokenForRunner,
  githubWorkflowRunCacheScope,
  hasGitHubAppWebhookSecret,
} from "./github-app";
import {
  githubRepositoryName,
  runnerPoolAcceptsGitHubRepository,
  type GitHubRepositoryTarget,
} from "./github-repository";
import { provisionRunner } from "./provision";
import { RunnerProvisioningWorkflow, startRunnerProvisioningWorkflows } from "./runner-provisioning-workflow";
import type { WorkerEnvironment } from "./environment";
import {
  assignResourceTraceRunner,
  parseResourceTracePayload,
  persistResourceTraceSamples,
  verifyResourceTraceAuthorization,
} from "./resource-traces";
import { handleRunnerCacheV2Request, runnerCacheEnabled } from "./runner-cache";
import { RunnerCacheQuota } from "./runner-cache-quota";
import { runnerContainerFor } from "./runner-container-router";
import {
  RunnerEligibilityCheck,
  runnerEligibilityFor,
  type RunnerEligibilityInput,
  type RunnerEligibilityResult,
} from "./runner-eligibility";
import { RUNNER_PROFILES } from "./runner-profiles";
import {
  classifyAuthorizedQueuedWebhook,
  classifyGitHubWebhookIntent,
  githubRepositoryFromWebhook,
  hasValidGitHubSignature,
  type WebhookDecision,
} from "./webhook";

export { AccountRunnerScheduler, ContainerProxy, RunnerCacheQuota, RunnerEligibilityCheck, RunnerProvisioningWorkflow };

function json<const Body>(body: Body, status = 200): Response {
  return Response.json(body, { status });
}

/**
 * The one runner container class. The instance resources (vCPU/memory/disk)
 * are chosen per queued job from its `runs-on` label, at `start()` time, via
 * InstanceSizedContainer — one container application serves every preset
 * and custom size. Diagnostic runners (`cf-validation-job-*`, used to fail
 * jobs whose `runs-on` labels are invalid) use the same class with the
 * `basic` instance size; the pre-job hook exits before workflow code runs,
 * so they
 * never idle long enough for `sleepAfter` to matter.
 */
export class GitHubActionsRunner extends InstanceSizedContainer<WorkerEnvironment> {
  sleepAfter = "1h";
  enableInternet = true;

  private runnerName(): string | undefined {
    return this.ctx.id.name;
  }

  override async onStart(): Promise<void> {
    const runnerName = this.runnerName();
    if (runnerName === undefined) {
      return;
    }
    await this.env.RUNNER_SCHEDULER.getByName(this.env.CLOUDFLARE_ACCOUNT_ID).runnerStarted(runnerName);
  }

  override async onStop({ exitCode, reason }: { exitCode: number; reason: string }): Promise<void> {
    const runnerName = this.runnerName();
    if (runnerName === undefined) {
      return;
    }
    const result = await this.env.RUNNER_SCHEDULER.getByName(this.env.CLOUDFLARE_ACCOUNT_ID).runnerStopped(runnerName, {
      exitCode,
      reason,
    });
    await startRunnerProvisioningWorkflows(this.env, result.admissions);
    console.log("Cloudflare GitHub Actions runner stopped", { runnerName, exitCode, reason });
  }

  override onError(cause: unknown): never {
    console.error("Cloudflare GitHub Actions runner failed to start", {
      runnerName: this.runnerName(),
      error: cause instanceof Error ? cause.message : String(cause),
    });
    throw cause;
  }
}

type InvalidRunnerDecision = Extract<WebhookDecision, { kind: "invalid-runner" }>;

function invalidRunnerMessage(decision: InvalidRunnerDecision): string {
  return decision.errors.map((error) => `- ${error}`).join("\n");
}

export interface InvalidRunnerEligibilityDependencies {
  authorize(env: WorkerEnvironment, input: RunnerEligibilityInput): Promise<RunnerEligibilityResult>;
}

const invalidRunnerEligibilityDependencies: InvalidRunnerEligibilityDependencies = { authorize: runnerEligibilityFor };

export async function startInvalidRunner(
  env: WorkerEnvironment,
  target: GitHubRepositoryTarget,
  decision: InvalidRunnerDecision,
  dependencies: InvalidRunnerEligibilityDependencies = invalidRunnerEligibilityDependencies,
): Promise<"rejected" | "started"> {
  const eligibility = await dependencies.authorize(env, {
    jobId: decision.jobId,
    headSha: decision.headSha,
    target,
    installationId: decision.installationId ?? null,
  });
  if (eligibility.kind === "rejected") {
    console.log("Cloudflare invalid runner diagnostic rejected by repository eligibility", {
      jobId: decision.jobId,
      repository: githubRepositoryName(target),
      visibility: eligibility.visibility,
      checkReported: eligibility.checkReported,
    });
    return "rejected";
  }

  const token = await githubTokenForRunner(env, decision.installationId ?? null);
  if (token === undefined) {
    throw new Error(`No GitHub App installation token is available for ${target.owner}`);
  }

  const result = await provisionRunner(
    env,
    { ...target, token },
    runnerContainerFor(env, decision.runnerName),
    decision.runnerName,
    RUNNER_PROFILES.basic,
    {
      fetch: (input, init) => fetch(input, init),
      jitLabels: decision.labels,
      jobStartedHookMessage: invalidRunnerMessage(decision),
    },
  );
  if (result.kind !== "started" && result.kind !== "already-active") {
    throw new Error(`Could not start the invalid-runner diagnostic: ${result.kind}`);
  }
  console.log("Cloudflare invalid runner diagnostic accepted", {
    jobId: decision.jobId,
    runnerName: decision.runnerName,
    repository: githubRepositoryName(target),
    errors: decision.errors,
  });
  return "started";
}

export default {
  async fetch(request: Request, env: WorkerEnvironment, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/healthz") {
      return json({ ok: true });
    }

    if (request.method === "POST" && url.pathname === "/v1/resource-traces") {
      const claim = await verifyResourceTraceAuthorization(
        env.RESOURCE_TRACE_SIGNING_KEY,
        request.headers.get("Authorization"),
      );
      if (claim === undefined) {
        return json({ error: "Unauthorized" }, 401);
      }
      let payload: z.core.util.JSONType;
      try {
        const parsedPayload = z.json().safeParse(await request.json());
        if (!parsedPayload.success) {
          return json({ error: "Invalid resource trace payload" }, 400);
        }
        payload = parsedPayload.data;
      } catch {
        return json({ error: "Invalid resource trace payload" }, 400);
      }
      const trace = parseResourceTracePayload(payload);
      if (trace === undefined) {
        return json({ error: "Invalid resource trace payload" }, 400);
      }
      try {
        await persistResourceTraceSamples(env, claim, trace.samples);
      } catch (error) {
        console.error("Could not persist runner resource samples", {
          runnerName: claim.runnerName,
          jobId: claim.jobId,
          error: error instanceof Error ? error.message : String(error),
        });
        // Resource telemetry is best effort. A runner can stop between the
        // container hook and this request; never turn that lifecycle race into
        // a failed Actions job.
        return json({ accepted: 0, persisted: false }, 202);
      }
      return json({ accepted: trace.samples.length }, 202);
    }

    if (runnerCacheEnabled(env) && url.pathname.startsWith("/v1/runner-cache-v2/")) {
      return handleRunnerCacheV2Request(request, env, env.RUNNER_SCHEDULER.getByName(env.CLOUDFLARE_ACCOUNT_ID));
    }

    if (request.method !== "POST" || url.pathname !== "/webhooks/github") {
      return json({ error: "Not found" }, 404);
    }

    const rawBody = await request.arrayBuffer();
    const body = new TextDecoder().decode(rawBody);
    const target = githubRepositoryFromWebhook(body);
    const installationId = githubInstallationFromWebhook(body);
    const hasValidAppSignature =
      hasGitHubAppWebhookSecret(env) &&
      (await hasValidGitHubSignature(
        rawBody,
        request.headers.get("X-Hub-Signature-256"),
        env.GITHUB_APP_WEBHOOK_SECRET,
      ));
    if (hasValidAppSignature && request.headers.get("X-GitHub-Event") === "ping") {
      return json({ ok: true });
    }
    const githubEvent = request.headers.get("X-GitHub-Event");
    if (hasValidAppSignature && githubEvent !== "workflow_job") {
      return json({ accepted: false }, 202);
    }
    if (target === undefined) {
      return json({ error: "Invalid GitHub webhook payload" }, 400);
    }
    if (!hasValidAppSignature) {
      return json({ error: "Invalid webhook signature" }, 401);
    }
    if (!runnerPoolAcceptsGitHubRepository(env, target)) {
      const configuredOwner = env.GITHUB_RUNNER_OWNER;
      console.log("Cloudflare runner ignored a webhook outside its configured GitHub owner", {
        configuredOwner: env.GITHUB_RUNNER_OWNER,
        repository: githubRepositoryName(target),
      });
      return json(
        {
          accepted: false,
          reason:
            configuredOwner !== undefined && configuredOwner.trim() !== ""
              ? "github-owner-mismatch"
              : "github-owner-unconfigured",
        },
        202,
      );
    }
    if (hasValidAppSignature && installationId === undefined) {
      return json({ error: "GitHub App webhook has no installation ID" }, 400);
    }

    let decision = classifyGitHubWebhookIntent(
      request.headers.get("X-GitHub-Event"),
      body,
      githubRepositoryName(target),
    );
    if (decision.kind === "ping") {
      return json({ ok: true });
    }
    if (decision.kind === "ignored") {
      return json({ accepted: false }, 202);
    }
    if (decision.kind === "invalid") {
      return json({ error: "Invalid workflow_job payload" }, 400);
    }
    if (decision.kind === "cloudflare-job-queued") {
      const eligibility = await runnerEligibilityFor(env, {
        jobId: decision.jobId,
        headSha: decision.headSha,
        target,
        installationId: decision.installationId ?? null,
      });
      if (eligibility.kind === "rejected") {
        console.log("Cloudflare runner job rejected by repository eligibility", {
          jobId: decision.jobId,
          repository: githubRepositoryName(target),
          visibility: eligibility.visibility,
          checkReported: eligibility.checkReported,
        });
        return json(
          {
            accepted: false,
            reason: "repository-not-private",
            visibility: eligibility.visibility,
            checkReported: eligibility.checkReported,
          },
          202,
        );
      }
      decision = classifyAuthorizedQueuedWebhook(decision);
    }
    if (decision.kind === "invalid-runner") {
      ctx.waitUntil(
        startInvalidRunner(env, target, decision).catch((error) => {
          console.error("Could not start the Cloudflare invalid-runner diagnostic", {
            jobId: decision.jobId,
            repository: githubRepositoryName(target),
            error: error instanceof Error ? error.message : String(error),
          });
        }),
      );
      return json({ accepted: true, validation: "queued" }, 202);
    }

    const scheduler = env.RUNNER_SCHEDULER.getByName(env.CLOUDFLARE_ACCOUNT_ID);
    try {
      if (decision.kind === "job-queued") {
        const cacheToken = runnerCacheEnabled(env)
          ? await githubTokenForRunner(env, installationId ?? null)
          : undefined;
        const cacheScope = runnerCacheEnabled(env)
          ? await githubWorkflowRunCacheScope(target, decision.workflowRunId, decision.defaultBranch, cacheToken)
          : undefined;
        const result = await scheduler.submit({
          jobId: decision.jobId,
          headSha: decision.headSha,
          runnerName: decision.runnerName,
          target,
          installationId,
          profile: decision.profile,
          workerOrigin: url.origin,
          cacheScope,
        });
        ctx.waitUntil(startRunnerProvisioningWorkflows(env, result.admissions));
        console.log("Cloudflare runner job accepted", {
          jobId: decision.jobId,
          runnerName: decision.runnerName,
          repository: `${target.owner}/${target.repository}`,
          queueReason: result.queueReason,
          cacheScope: cacheScope?.scope,
          cacheFallbackScope: cacheScope?.fallbackScope,
          cacheWriteAllowed: cacheScope?.writeAllowed,
        });
        return json(
          { accepted: result.accepted, queued: result.admissions.length === 0, queueReason: result.queueReason },
          202,
        );
      }

      if (decision.kind === "job-started") {
        const result = await scheduler.workflowJobStarted({
          jobId: decision.jobId,
          runnerName: decision.runnerName,
          runnerId: decision.runnerId,
          target,
          profile: decision.profile,
        });
        if (result.accepted) {
          await assignResourceTraceRunner(env, {
            runnerName: decision.runnerName,
            jobId: decision.jobId,
            repository: `${target.owner}/${target.repository}`,
          });
        }
        ctx.waitUntil(startRunnerProvisioningWorkflows(env, result.admissions));
        console.log("Cloudflare runner GitHub assignment observed", {
          jobId: decision.jobId,
          runnerName: decision.runnerName,
          accepted: result.accepted,
        });
        return json({ accepted: result.accepted, queued: result.admissions.length !== 0 }, 202);
      }

      const result = await scheduler.workflowJobCompleted(decision.jobId);
      ctx.waitUntil(startRunnerProvisioningWorkflows(env, result.admissions));
      console.log("Cloudflare runner job completed", { jobId: decision.jobId });
      return json({ accepted: result.accepted }, 202);
    } catch (error) {
      console.error("Cloudflare runner scheduler error", {
        error: error instanceof Error ? error.message : String(error),
      });
      return json({ error: "Runner scheduling failed" }, 500);
    }
  },
} satisfies ExportedHandler<WorkerEnvironment>;
