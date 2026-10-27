import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import {
  CloudflareContainersApiError,
  createContainerRegistryPushCredentials,
  getContainerRolloutStatus,
  rolloutRunnerApplicationImages,
  rolloutRunnerImageBuilderApplication,
  runnerImageBuilderApplicationHasLiveInstances,
  runnerImageBuilderApplicationRolloutsAreActive,
  type ContainersApiDependencies,
} from "../src/cloudflare-containers";

const env = {
  CLOUDFLARE_ACCOUNT_ID: "account-id",
  CLOUDFLARE_CONTAINERS_API_TOKEN: "cloudflare-token",
  RUNNER_APPLICATION_PREFIX: "runner",
  RUNNER_IMAGE_BUILDER_APPLICATION: "runner-image-builder",
};

const runnerApplicationName = "runner-githubactionsrunner";

const resources = { vcpu: 2, memoryMib: 6_144, diskMb: 12_000 };

function configuration(values = resources) {
  return {
    image: "registry.cloudflare.com/runner-image:deployment-id",
    vcpu: values.vcpu,
    memory_mib: values.memoryMib,
    disk: { size_mb: values.diskMb },
  };
}

function application(values = resources, name = runnerApplicationName) {
  return {
    id: "application-id",
    name,
    max_instances: 1,
    scheduling_policy: "regional",
    rollout_active_grace_period: 300,
    configuration: configuration(values),
  };
}

function rollout(status = "progressing", values = resources) {
  return {
    id: "rollout-id",
    status,
    target_configuration: configuration(values),
  };
}

function response(result: z.core.util.JSONType, init?: ResponseInit): Response {
  return Response.json({ success: true, result, errors: [] }, init);
}

function dependencies(...responses: Response[]): ContainersApiDependencies & { fetch: ReturnType<typeof vi.fn> } {
  const fetchMock = vi.fn<ContainersApiDependencies["fetch"]>(async () => {
    const next = responses.shift();
    if (next === undefined) {
      throw new Error("Unexpected Containers API request");
    }
    return next;
  });
  return { fetch: fetchMock };
}

describe("Cloudflare Container configuration", () => {
  it("reads a full page of rollout history before deciding the builder image needs another rollout", async () => {
    const builder = application(resources, "runner-image-builder");
    const deps = dependencies(response([builder]), response([]), response(builder), response(rollout("completed")));

    await rolloutRunnerImageBuilderApplication(env, "registry.cloudflare.com/account/builder:new", deps);

    expect(String(deps.fetch.mock.calls[1]?.[0])).toContain("/rollouts?limit=100");
  });

  it("detects a deployment rollout on the temporary daemonless builder", async () => {
    const builder = application(resources, "runner-image-builder");
    const active = dependencies(response([builder]), response([rollout("progressing")]));
    const complete = dependencies(response([builder]), response([rollout("completed")]));

    await expect(runnerImageBuilderApplicationRolloutsAreActive(env, active)).resolves.toBe(true);
    await expect(runnerImageBuilderApplicationRolloutsAreActive(env, complete)).resolves.toBe(false);
  });

  it("detects whether the temporary daemonless builder still has a live instance", async () => {
    const busy = dependencies(
      response([{ ...application(resources, "runner-image-builder"), health: { instances: { active: 1 } } }]),
    );
    const idle = dependencies(
      response([{ ...application(resources, "runner-image-builder"), health: { instances: { active: 0 } } }]),
    );

    await expect(runnerImageBuilderApplicationHasLiveInstances(env, busy)).resolves.toBe(true);
    await expect(runnerImageBuilderApplicationHasLiveInstances(env, idle)).resolves.toBe(false);
  });

  it("does not treat an assigned slot for a stopped builder Container as live", async () => {
    const stopped = dependencies(
      response([
        {
          ...application(resources, "runner-image-builder"),
          health: {
            instances: {
              active: 0,
              assigned: 1,
              failed: 0,
              healthy: 0,
              scheduling: 0,
              starting: 0,
              stopped: 0,
            },
          },
        },
      ]),
    );

    await expect(runnerImageBuilderApplicationHasLiveInstances(env, stopped)).resolves.toBe(false);
  });

  it("returns rollout status and reports Cloudflare API failures", async () => {
    const statusDependencies = dependencies(response(rollout("completed")));
    await expect(getContainerRolloutStatus(env, "application-id", "rollout-id", statusDependencies)).resolves.toBe(
      "completed",
    );

    const failureDependencies = dependencies(
      Response.json(
        { success: false, result: null, errors: [{ message: "Containers Write is required" }] },
        { status: 403 },
      ),
    );
    await expect(
      rolloutRunnerImageBuilderApplication(env, "registry.cloudflare.com/account/builder:new", failureDependencies),
    ).rejects.toEqual(
      expect.objectContaining<Partial<CloudflareContainersApiError>>({
        name: "CloudflareContainersApiError",
        status: 403,
        message: "Cloudflare Containers API 403: Containers Write is required",
      }),
    );
  });

  it("creates a short-lived pull/push registry credential without returning the account token", async () => {
    const deps = dependencies(response({ username: "v1", password: "short-lived-password" }));

    await expect(createContainerRegistryPushCredentials(env, deps)).resolves.toEqual({
      username: "v1",
      password: "short-lived-password",
    });
    expect(deps.fetch).toHaveBeenCalledWith(
      "https://api.cloudflare.com/client/v4/accounts/account-id/containers/registries/registry.cloudflare.com/credentials",
      expect.objectContaining({ method: "POST" }),
    );
    expect(JSON.parse(String(deps.fetch.mock.calls[0]?.[1]?.body))).toEqual({
      expiration_minutes: 15,
      permissions: ["pull", "push"],
    });
  });

  it("rolls an idle runner image with a configuration-only PATCH", async () => {
    const idle = {
      ...application(resources, runnerApplicationName),
      max_instances: 16,
      health: { instances: { active: 0, assigned: 0, starting: 0, scheduling: 0 } },
    };
    const deps = dependencies(
      response([idle]),
      response([idle]),
      response([]),
      response(idle),
      // Cloudflare keeps returning the active image until a rollout applies
      // the accepted PATCH.
      response([idle]),
      response(rollout("completed", resources)),
    );
    const progress = vi.fn<(status: { processedApplications: number; totalApplications: number }) => Promise<void>>(
      async () => undefined,
    );

    await expect(
      rolloutRunnerApplicationImages(env, "registry.cloudflare.com/account/runner:new", deps, { onProgress: progress }),
    ).resolves.toEqual({
      updatedApplications: [runnerApplicationName],
      skippedApplications: [],
    });
    expect(JSON.parse(String(deps.fetch.mock.calls[3]?.[1]?.body))).toEqual({
      configuration: {
        image: "registry.cloudflare.com/account/runner:new",
        vcpu: 2,
        memory_mib: 6_144,
        disk: { size_mb: 12_000 },
      },
    });
    expect(JSON.parse(String(deps.fetch.mock.calls[5]?.[1]?.body))).toMatchObject({
      target_configuration: { image: "registry.cloudflare.com/account/runner:new" },
    });
    expect(progress).toHaveBeenNthCalledWith(1, { processedApplications: 0, totalApplications: 1 });
    expect(progress).toHaveBeenNthCalledWith(2, { processedApplications: 1, totalApplications: 1 });
  });

  it("does not echo read-only configuration metadata into an image update", async () => {
    const applicationWithReadOnlyMetadata = {
      ...application(resources, runnerApplicationName),
      configuration: { ...configuration(), location: "sjc", deployment_type: "regional" },
      health: { instances: { active: 0 } },
    };
    const deps = dependencies(
      response([applicationWithReadOnlyMetadata]),
      response([applicationWithReadOnlyMetadata]),
      response([]),
      response(applicationWithReadOnlyMetadata),
      response([
        {
          ...applicationWithReadOnlyMetadata,
          configuration: {
            ...applicationWithReadOnlyMetadata.configuration,
            image: "registry.cloudflare.com/account/runner:new",
          },
        },
      ]),
      response(rollout("completed", resources)),
    );

    await rolloutRunnerApplicationImages(env, "registry.cloudflare.com/account/runner:new", deps);

    const request = z
      .object({
        configuration: z.object({
          image: z.string(),
          vcpu: z.number(),
          memory_mib: z.number(),
          disk: z.object({ size_mb: z.number() }),
        }),
      })
      .parse(JSON.parse(String(deps.fetch.mock.calls[3]?.[1]?.body)));
    expect(request.configuration).not.toHaveProperty("location");
    expect(request.configuration).not.toHaveProperty("deployment_type");
    expect(request.configuration).toEqual({ ...configuration(), image: "registry.cloudflare.com/account/runner:new" });
  });

  it("does not fail an image rollout when setup progress reporting is unavailable", async () => {
    const idle = {
      ...application(resources, runnerApplicationName),
      health: { instances: { active: 0, assigned: 0, starting: 0, scheduling: 0 } },
    };
    const deps = dependencies(
      response([idle]),
      response([idle]),
      response([]),
      response(idle),
      response([idle]),
      response(rollout("completed", resources)),
    );
    const progress = vi.fn<() => Promise<void>>(async () => {
      throw new Error("Durable Object temporarily unavailable");
    });
    const progressError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      rolloutRunnerApplicationImages(env, "registry.cloudflare.com/account/runner:new", deps, { onProgress: progress }),
    ).resolves.toEqual({
      updatedApplications: [runnerApplicationName],
      skippedApplications: [],
    });
    expect(progress).toHaveBeenCalledTimes(2);
    expect(progressError).toHaveBeenCalledWith("Cloudflare runner image rollout progress reporting failed", {
      error: "Durable Object temporarily unavailable",
    });
    progressError.mockRestore();
  });

  it("uses the freshly read configuration rather than the stale application list during an image rollout", async () => {
    const listed = {
      ...application(resources, runnerApplicationName),
      health: { instances: { active: 0, assigned: 0, starting: 0, scheduling: 0 } },
    };
    const refreshedResources = { vcpu: 4, memoryMib: 12_288, diskMb: 20_000 };
    const refreshed = {
      ...application(refreshedResources, runnerApplicationName),
      max_instances: 3,
      health: { instances: { active: 0, assigned: 0, starting: 0, scheduling: 0 } },
    };
    const deps = dependencies(
      response([listed]),
      response([refreshed]),
      response([]),
      response(refreshed),
      response([
        {
          ...refreshed,
          configuration: {
            ...refreshed.configuration,
            image: "registry.cloudflare.com/account/runner:new",
            vcpu: 1,
            memory_mib: 6_144,
            disk: { size_mb: 12_000 },
          },
        },
      ]),
      response(rollout("completed", refreshedResources)),
    );

    await rolloutRunnerApplicationImages(env, "registry.cloudflare.com/account/runner:new", deps);

    expect(JSON.parse(String(deps.fetch.mock.calls[3]?.[1]?.body))).toEqual({
      configuration: {
        image: "registry.cloudflare.com/account/runner:new",
        vcpu: 4,
        memory_mib: 12_288,
        disk: { size_mb: 20_000 },
      },
    });
    expect(JSON.parse(String(deps.fetch.mock.calls[5]?.[1]?.body))).toMatchObject({
      target_configuration: {
        image: "registry.cloudflare.com/account/runner:new",
        vcpu: 1,
        memory_mib: 6_144,
        disk: { size_mb: 12_000 },
      },
    });
  });

  it("defers an image rollout while a runner or another rollout is active", async () => {
    const busy = {
      ...application(resources, runnerApplicationName),
      health: { instances: { active: 1 } },
    };
    const deps = dependencies(response([busy]), response([busy]), response([]));

    await expect(
      rolloutRunnerApplicationImages(env, "registry.cloudflare.com/account/runner:new", deps),
    ).resolves.toEqual({
      updatedApplications: [],
      skippedApplications: [runnerApplicationName],
    });
    expect(deps.fetch).toHaveBeenCalledTimes(3);
  });

  it("creates a missing rollout after a prior image PATCH reached Cloudflare", async () => {
    const targetImage = "registry.cloudflare.com/account/runner:new";
    const alreadyPatched = {
      ...application(resources, runnerApplicationName),
      configuration: { ...configuration(), image: targetImage },
      health: { instances: { active: 0 } },
    };
    const deps = dependencies(
      response([alreadyPatched]),
      response([alreadyPatched]),
      response([]),
      response([alreadyPatched]),
      response({ ...rollout("completed"), target_configuration: { ...configuration(), image: targetImage } }),
    );

    await expect(rolloutRunnerApplicationImages(env, targetImage, deps)).resolves.toEqual({
      updatedApplications: [runnerApplicationName],
      skippedApplications: [],
    });
    expect(deps.fetch).toHaveBeenCalledTimes(5);
    expect(deps.fetch.mock.calls[4]?.[1]).toMatchObject({ method: "POST" });
    expect(JSON.parse(String(deps.fetch.mock.calls[4]?.[1]?.body))).toMatchObject({
      target_configuration: { image: targetImage },
    });
  });

  it("reissues an interrupted A-to-B-to-A image transition despite an older matching rollout", async () => {
    const targetImage = "registry.cloudflare.com/account/runner:a";
    const previousImage = "registry.cloudflare.com/account/runner:b";
    const repatched = {
      ...application(resources, runnerApplicationName),
      configuration: { ...configuration(), image: targetImage },
      health: { instances: { active: 0 } },
    };
    const deps = dependencies(
      response([repatched]),
      response([repatched]),
      response([
        { ...rollout("completed"), target_configuration: { ...configuration(), image: previousImage } },
        { ...rollout("completed"), target_configuration: { ...configuration(), image: targetImage } },
      ]),
      response([repatched]),
      response({ ...rollout("progressing"), target_configuration: { ...configuration(), image: targetImage } }),
    );

    await expect(
      rolloutRunnerApplicationImages(env, targetImage, deps, { reissueMatchingImageRollouts: true }),
    ).resolves.toEqual({
      updatedApplications: [runnerApplicationName],
      skippedApplications: [],
    });
    expect(deps.fetch.mock.calls[4]?.[1]).toMatchObject({ method: "POST" });
  });

  it("does not repeat a completed rollout for an unchanged runner image", async () => {
    const targetImage = "registry.cloudflare.com/account/runner:new";
    const deployed = {
      ...application(resources, runnerApplicationName),
      configuration: { ...configuration(), image: targetImage },
      health: { instances: { active: 0 } },
    };
    const deps = dependencies(
      response([deployed]),
      response([deployed]),
      response([{ ...rollout("completed"), target_configuration: { ...configuration(), image: targetImage } }]),
    );

    await expect(rolloutRunnerApplicationImages(env, targetImage, deps)).resolves.toEqual({
      updatedApplications: [],
      skippedApplications: [],
    });
    expect(deps.fetch).toHaveBeenCalledTimes(3);
  });

  it("recovers a daemonless-builder image PATCH that did not create its rollout", async () => {
    const targetImage = "registry.cloudflare.com/account/builder:new";
    const alreadyPatched = {
      ...application(resources, "runner-image-builder"),
      configuration: { ...configuration(), image: targetImage },
      health: { instances: { active: 0 } },
    };
    const deps = dependencies(
      response([alreadyPatched]),
      response([]),
      response({ ...rollout("completed"), target_configuration: { ...configuration(), image: targetImage } }),
    );

    await expect(rolloutRunnerImageBuilderApplication(env, targetImage, deps)).resolves.toEqual({
      kind: "rollout",
      applicationId: "application-id",
      rolloutId: "rollout-id",
    });
    expect(deps.fetch.mock.calls[2]?.[1]).toMatchObject({ method: "POST" });
  });

  it("does not repeat a completed daemonless-builder rollout", async () => {
    const targetImage = "registry.cloudflare.com/account/builder:new";
    const deployed = {
      ...application(resources, "runner-image-builder"),
      configuration: { ...configuration(), image: targetImage },
      health: { instances: { active: 0 } },
    };
    const deps = dependencies(
      response([deployed]),
      response([{ ...rollout("completed"), target_configuration: { ...configuration(), image: targetImage } }]),
    );

    await expect(rolloutRunnerImageBuilderApplication(env, targetImage, deps)).resolves.toEqual({
      kind: "ready",
      applicationId: "application-id",
    });
    expect(deps.fetch).toHaveBeenCalledTimes(2);
  });

  it("recreates a verified daemonless-builder rollout even when its mutable tag is already configured", async () => {
    const targetImage = "registry.cloudflare.com/account/builder:new";
    const deployed = {
      ...application(resources, "runner-image-builder"),
      configuration: { ...configuration(), image: targetImage },
      health: { instances: { active: 0 } },
    };
    const deps = dependencies(
      response([deployed]),
      response([{ ...rollout("completed"), target_configuration: { ...configuration(), image: targetImage } }]),
      response({ ...rollout("progressing"), target_configuration: { ...configuration(), image: targetImage } }),
    );

    await expect(rolloutRunnerImageBuilderApplication(env, targetImage, deps, { force: true })).resolves.toEqual({
      kind: "rollout",
      applicationId: "application-id",
      rolloutId: "rollout-id",
    });
    expect(deps.fetch.mock.calls[2]?.[1]).toMatchObject({ method: "POST" });
  });
});
