import { bindings, defineConfig, defineContainer, exports, type UnsafeBinding } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

const durableObjectBinding = (className: string): UnsafeBinding => ({
  type: "unsafe:durable_object_namespace",
  class_name: className,
});

const runnerContainer = defineContainer({
  name: "cloudflare-github-actions-runner-githubactionsrunner",
  schedulingPolicy: "durable-object",
  images: { runner: { dockerfile: "./docker/Dockerfile", buildContext: "." } },
});

export default defineConfig({
  containers: [runnerContainer],
  worker: {
    name: "cloudflare-github-actions-runner",
    compatibilityDate: "2026-08-12",
    compatibilityFlags: ["nodejs_compat"],
    entrypoint,
    workersDev: true,
    observability: {
      enabled: true,
    },
    env: {
      CLOUDFLARE_ACCOUNT_ID: bindings.text("6be2041a37d48a9799c686434f1709f9"),
      GITHUB_RUNNER_OWNER: bindings.text("punkeel"),
      GITHUB_RUNNER_GROUP_ID: bindings.text("1"),
      RUNNER_CACHE_ENABLED: bindings.text("true"),
      RUNNER_CACHE_MAX_BYTES: bindings.text("100000000000"),
      RUNNER_CACHE_PREFIX: bindings.text("cloudflare-github-actions-runner"),
      RESOURCE_METRICS: bindings.d1({
        name: "cloudflare-github-actions-runner-metrics",
        id: "d0833fd7-b3fd-4cb1-ab07-d8e0847172c2",
      }),
      RUNNER_CACHE: bindings.r2({
        name: "cloudflare-github-actions-runner-cache",
      }),
      RUNNER: durableObjectBinding("GitHubActionsRunner"),
      RUNNER_SCHEDULER: durableObjectBinding("AccountRunnerScheduler"),
      RUNNER_ELIGIBILITY_CHECK: durableObjectBinding("RunnerEligibilityCheck"),
      RUNNER_CACHE_QUOTA: durableObjectBinding("RunnerCacheQuota"),
      RUNNER_PROVISIONING_WORKFLOW: bindings.workflow({
        name: "cloudflare-github-actions-runner-provisioning-v2",
        worker: "cloudflare-github-actions-runner",
        exportName: "RunnerProvisioningWorkflow",
      }),
    },
    exports: {
      GitHubActionsRunner: exports.durableObject({ storage: "sqlite", container: runnerContainer }),
      AccountRunnerScheduler: exports.durableObject({ storage: "sqlite" }),
      RunnerEligibilityCheck: exports.durableObject({ storage: "sqlite" }),
      RunnerCacheQuota: exports.durableObject({ storage: "sqlite" }),
      RunnerProvisioningWorkflow: exports.workflow({
        name: "cloudflare-github-actions-runner-provisioning-v2",
        limits: {
          steps: 300,
        },
      }),
    },
  },
});
