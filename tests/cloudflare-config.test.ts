import { convertToWranglerConfig, loadAndParseConfig } from "@cloudflare/config";
import { describe, expect, it } from "vite-plus/test";

const configPath = new URL("../cloudflare.config.ts", import.meta.url).pathname;

describe("cloudflare.config.ts Durable Object bindings", () => {
  it("keeps same-script Durable Object bindings typed and script-name aware", async () => {
    const { result } = await loadAndParseConfig(configPath, { isPreview: false, mode: undefined });
    expect(result.success).toBe(true);
    if (!result.success) return;

    const config = convertToWranglerConfig(result.data);
    expect(config.name).toBe("cloudflare-github-actions-runner");
    expect(config.durable_objects?.bindings).toEqual([
      {
        name: "RUNNER",
        class_name: "GitHubActionsRunner",
        script_name: config.name,
      },
      {
        name: "RUNNER_SCHEDULER",
        class_name: "AccountRunnerScheduler",
        script_name: config.name,
      },
      {
        name: "RUNNER_ELIGIBILITY_CHECK",
        class_name: "RunnerEligibilityCheck",
        script_name: config.name,
      },
      {
        name: "RUNNER_CACHE_QUOTA",
        class_name: "RunnerCacheQuota",
        script_name: config.name,
      },
    ]);
  });

  it("keeps the Container attached to the Durable Object export", async () => {
    const { result } = await loadAndParseConfig(configPath, { isPreview: false, mode: undefined });
    expect(result.success).toBe(true);
    if (!result.success) return;

    const config = convertToWranglerConfig(result.data);
    expect(config.exports?.GitHubActionsRunner).toMatchObject({
      type: "durable-object",
      storage: "sqlite",
      container: "cloudflare-github-actions-runner-githubactionsrunner",
    });
    expect(config.containers).toEqual([
      expect.objectContaining({
        name: "cloudflare-github-actions-runner-githubactionsrunner",
        scheduling_policy: "durable_object",
      }),
    ]);
  });
});
