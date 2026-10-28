/** Resource and Durable Object bindings declared by cloudflare.config.ts. */
interface RunnerBindings {
  CLOUDFLARE_ACCOUNT_ID: string;
  GITHUB_RUNNER_OWNER: string;
  GITHUB_RUNNER_GROUP_ID: string;
  RUNNER_CACHE_ENABLED: string;
  RUNNER_CACHE_MAX_BYTES: string;
  RUNNER_CACHE_PREFIX: string;
  RESOURCE_METRICS: D1Database;
  RUNNER_CACHE: R2Bucket;
  RUNNER: DurableObjectNamespace<import("./index").GitHubActionsRunner>;
  RUNNER_SCHEDULER: DurableObjectNamespace<import("./account-runner-scheduler").AccountRunnerScheduler>;
  RUNNER_ELIGIBILITY_CHECK: DurableObjectNamespace<import("./runner-eligibility").RunnerEligibilityCheck>;
  RUNNER_CACHE_QUOTA: DurableObjectNamespace<import("./runner-cache-quota").RunnerCacheQuota>;
  RUNNER_PROVISIONING_WORKFLOW: Workflow<
    Parameters<import("./runner-provisioning-workflow").RunnerProvisioningWorkflow["run"]>[0]["payload"]
  >;
}

interface Env extends RunnerBindings {}

declare namespace Cloudflare {
  interface Env extends RunnerBindings {}
  interface GlobalProps {
    mainModule: typeof import("./index");
    durableNamespaces: "GitHubActionsRunner" | "AccountRunnerScheduler" | "RunnerEligibilityCheck" | "RunnerCacheQuota";
  }
}

declare module "cloudflare:test" {
  interface ProvidedEnv extends RunnerBindings {}
}
