import { z } from "zod";

export interface ContainersApiEnvironment {
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_CONTAINERS_API_TOKEN: string;
  RUNNER_APPLICATION_PREFIX?: string;
  RUNNER_IMAGE_BUILDER_APPLICATION?: string;
}

export interface ContainersApiDependencies {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

const defaultDependencies: ContainersApiDependencies = {
  fetch: (input, init) => fetch(input, init),
};

export type ContainerRolloutStatus = "pending" | "progressing" | "completed" | "reverted" | "replaced";

const containerConfigurationSchema = z.object({
  image: z.string(),
  vcpu: z.number(),
  memory_mib: z.number(),
  disk: z.object({ size_mb: z.number() }),
});
const containerApplicationSchema = z.object({
  id: z.string(),
  name: z.string(),
  max_instances: z.number(),
  scheduling_policy: z.string(),
  rollout_active_grace_period: z.number().optional(),
  health: z.object({ instances: z.record(z.string(), z.number().optional()).optional() }).optional(),
  configuration: containerConfigurationSchema,
});
const rolloutStatusSchema = z.enum(["pending", "progressing", "completed", "reverted", "replaced"]);
const containerRolloutSchema = z.object({
  id: z.string(),
  status: rolloutStatusSchema,
  target_configuration: containerConfigurationSchema,
});
const registryPushCredentialsSchema = z.object({ username: z.string(), password: z.string() });
const containersApiResultSchema = z.json().optional();
const apiEnvelopeSchema = z.object({
  success: z.boolean().optional(),
  result: containersApiResultSchema,
  errors: z.array(z.object({ message: z.string().optional() })).optional(),
});

export type ContainerConfiguration = z.infer<typeof containerConfigurationSchema>;
export type ContainerApplication = z.infer<typeof containerApplicationSchema>;
type ContainerRollout = z.infer<typeof containerRolloutSchema>;
type ContainersApiResult = z.infer<typeof containersApiResultSchema>;

/**
 * The result of a daemonless builder image transition: either the target is
 * already live, or Cloudflare is applying it through the returned rollout.
 */
export type PrepareRunnerApplicationResult =
  | { kind: "ready"; applicationId: string }
  | { kind: "rollout"; applicationId: string; rolloutId: string };

export interface ContainerRegistryPushCredentials {
  username: string;
  password: string;
}

export interface RolloutRunnerApplicationImagesResult {
  updatedApplications: string[];
  skippedApplications: string[];
}

export interface RolloutRunnerApplicationImagesOptions {
  /**
   * A durable Workflow is retrying after an interrupted image transition.
   * Reissue matching targets because history alone cannot prove the most
   * recent PATCH reached its own rollout (for example A→B→A).
   */
  reissueMatchingImageRollouts?: boolean;
  /** Reports how many runner applications this rollout pass has inspected. */
  onProgress?: (progress: RunnerApplicationImageRolloutProgress) => Promise<void>;
}

export interface RunnerApplicationImageRolloutProgress {
  processedApplications: number;
  totalApplications: number;
}

export interface RolloutRunnerImageBuilderOptions {
  /**
   * Recreate a completed rollout after the Worker has independently verified
   * that a mutable private registry tag contains the pinned manifest.
   */
  force?: boolean;
}

export class CloudflareContainersApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "CloudflareContainersApiError";
  }
}

function apiErrorDetail(body: z.infer<typeof apiEnvelopeSchema>): string | undefined {
  if (body.errors === undefined) {
    return undefined;
  }
  for (const error of body.errors) {
    if (error.message !== undefined) {
      return error.message;
    }
  }
  return undefined;
}

async function containersApiRequest(
  env: ContainersApiEnvironment,
  path: string,
  init: RequestInit,
  dependencies: ContainersApiDependencies,
): Promise<ContainersApiResult> {
  const response = await dependencies.fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)}/containers${path}`,
    {
      ...init,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${env.CLOUDFLARE_CONTAINERS_API_TOKEN}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
    },
  );

  let rawBody;
  try {
    rawBody = await response.json();
  } catch {
    throw new CloudflareContainersApiError(
      `Cloudflare Containers API returned non-JSON status ${response.status}`,
      response.status,
    );
  }
  const parsedBody = apiEnvelopeSchema.safeParse(rawBody);
  if (!parsedBody.success) {
    throw new CloudflareContainersApiError(
      `Cloudflare Containers API returned invalid JSON status ${response.status}`,
      response.status,
    );
  }
  const body = parsedBody.data;

  if (!response.ok || body.success !== true) {
    const detail = apiErrorDetail(body);
    throw new CloudflareContainersApiError(
      `Cloudflare Containers API ${response.status}${detail === undefined ? "" : `: ${detail}`}`,
      response.status,
    );
  }
  return body.result;
}

export async function createContainerRegistryPushCredentials(
  env: ContainersApiEnvironment,
  dependencies: ContainersApiDependencies = defaultDependencies,
): Promise<ContainerRegistryPushCredentials> {
  const result = await containersApiRequest(
    env,
    "/registries/registry.cloudflare.com/credentials",
    {
      method: "POST",
      body: JSON.stringify({ expiration_minutes: 15, permissions: ["pull", "push"] }),
    },
    dependencies,
  );
  const credentials = registryPushCredentialsSchema.safeParse(result);
  if (!credentials.success) {
    throw new CloudflareContainersApiError("Cloudflare returned invalid registry push credentials", 502);
  }
  return credentials.data;
}

/**
 * The Containers GET response may include read-only configuration metadata.
 * Send only fields accepted by the PATCH and rollout APIs.
 */
function writableConfiguration(configuration: ContainerConfiguration): ContainerConfiguration {
  return {
    image: configuration.image,
    vcpu: configuration.vcpu,
    memory_mib: configuration.memory_mib,
    disk: { size_mb: configuration.disk.size_mb },
  };
}

export async function findRunnerApplication(
  env: ContainersApiEnvironment,
  applicationName: string,
  dependencies: ContainersApiDependencies = defaultDependencies,
): Promise<ContainerApplication> {
  const result = await containersApiRequest(
    env,
    `/applications?name=${encodeURIComponent(applicationName)}`,
    { method: "GET" },
    dependencies,
  );
  const applications = z.array(containerApplicationSchema).safeParse(result);
  if (!applications.success) {
    throw new CloudflareContainersApiError("Cloudflare returned an invalid Container application list", 502);
  }
  const application = applications.data.find((candidate) => candidate.name === applicationName);
  if (application === undefined) {
    throw new CloudflareContainersApiError(
      `Container application ${applicationName} was not found; deploy the Worker before using this runner label`,
      404,
    );
  }
  return application;
}

async function listRollouts(
  env: ContainersApiEnvironment,
  applicationId: string,
  dependencies: ContainersApiDependencies,
): Promise<ContainerRollout[]> {
  const result = await containersApiRequest(
    env,
    `/applications/${encodeURIComponent(applicationId)}/rollouts?limit=100`,
    { method: "GET" },
    dependencies,
  );
  const rollouts = z.array(containerRolloutSchema).safeParse(result);
  if (!rollouts.success) {
    throw new CloudflareContainersApiError("Cloudflare returned an invalid Container rollout list", 502);
  }
  return rollouts.data;
}

/**
 * The Container API accepts a partial PATCH, so an image update can send
 * only the configuration field and leave every other application setting
 * untouched server-side.
 */
async function patchApplicationImage(
  env: ContainersApiEnvironment,
  application: ContainerApplication,
  image: string,
  dependencies: ContainersApiDependencies,
): Promise<void> {
  await containersApiRequest(
    env,
    `/applications/${encodeURIComponent(application.id)}`,
    {
      method: "PATCH",
      body: JSON.stringify({
        configuration: writableConfiguration({ ...application.configuration, image }),
      }),
    },
    dependencies,
  );
}

/**
 * Begin an explicit image rollout after its desired configuration is present.
 * Keeping this separate from PATCH makes a retry safe when the PATCH succeeds
 * but the following rollout request is interrupted or rejected.
 */
async function createApplicationImageRollout(
  env: ContainersApiEnvironment,
  application: ContainerApplication,
  image: string,
  description: string,
  dependencies: ContainersApiDependencies,
): Promise<ContainerRollout> {
  const rollout = await containersApiRequest(
    env,
    `/applications/${encodeURIComponent(application.id)}/rollouts`,
    {
      method: "POST",
      body: JSON.stringify({
        description,
        strategy: "rolling",
        target_configuration: writableConfiguration({ ...application.configuration, image }),
        step_percentage: 100,
        kind: "full_auto",
      }),
    },
    dependencies,
  );
  const parsedRollout = containerRolloutSchema.safeParse(rollout);
  if (!parsedRollout.success) {
    throw new CloudflareContainersApiError("Cloudflare returned an invalid Container rollout", 502);
  }
  return parsedRollout.data;
}

function applicationHasLiveInstances(application: ContainerApplication): boolean {
  const instances = application.health?.instances;
  if (instances === undefined) {
    return false;
  }
  // Cloudflare can retain an assigned application slot after its Container
  // instance has stopped. Assignment alone therefore does not make the
  // application busy or prevent an image rollout.
  return ["active", "starting", "scheduling"].some((status) => (instances[status] ?? 0) > 0);
}

async function listApplications(
  env: ContainersApiEnvironment,
  dependencies: ContainersApiDependencies,
): Promise<ContainerApplication[]> {
  const result = await containersApiRequest(env, "/applications?per_page=100", { method: "GET" }, dependencies);
  const applications = z.array(containerApplicationSchema).safeParse(result);
  if (!applications.success) {
    throw new CloudflareContainersApiError("Cloudflare returned an invalid Container application list", 502);
  }
  return applications.data;
}

function runnerApplication(env: ContainersApiEnvironment, application: ContainerApplication): boolean {
  if (env.RUNNER_APPLICATION_PREFIX === undefined) {
    return false;
  }
  return (
    application.name.startsWith(`${env.RUNNER_APPLICATION_PREFIX}-`) &&
    application.name !== env.RUNNER_IMAGE_BUILDER_APPLICATION
  );
}

/**
 * Reconcile a stale runner-image rollout lease against Cloudflare before a
 * later build is allowed to take the builder slot. Durable Object lease time
 * alone is not proof that the external rollout request has finished.
 */
export async function runnerApplicationImageRolloutsAreActive(
  env: ContainersApiEnvironment,
  dependencies: ContainersApiDependencies = defaultDependencies,
): Promise<boolean> {
  const applications = (await listApplications(env, dependencies)).filter((application) =>
    runnerApplication(env, application),
  );
  for (const application of applications) {
    // eslint-disable-next-line no-await-in-loop -- each account application has an independent rollout history.
    const rollouts = await listRollouts(env, application.id, dependencies);
    if (rollouts.some((rollout) => rollout.status === "pending" || rollout.status === "progressing")) {
      return true;
    }
  }
  return false;
}

/**
 * A Worker deployment can roll the temporary public builder image before the
 * first Workflow has copied the pinned private image. Wait for that platform
 * rollout before forcing the verified private-builder rollout.
 */
export async function runnerImageBuilderApplicationRolloutsAreActive(
  env: ContainersApiEnvironment,
  dependencies: ContainersApiDependencies = defaultDependencies,
): Promise<boolean> {
  const applicationName = env.RUNNER_IMAGE_BUILDER_APPLICATION;
  if (applicationName === undefined || applicationName.trim() === "") {
    throw new CloudflareContainersApiError("RUNNER_IMAGE_BUILDER_APPLICATION is required", 500);
  }
  const application = await findRunnerApplication(env, applicationName, dependencies);
  const rollouts = await listRollouts(env, application.id, dependencies);
  return rollouts.some((rollout) => rollout.status === "pending" || rollout.status === "progressing");
}

/**
 * A bootstrap RPC can leave the temporary builder Container active briefly
 * after its private image has been copied. Image rollouts must wait for that
 * exact application to become idle instead of exhausting a retrying API step.
 */
export async function runnerImageBuilderApplicationHasLiveInstances(
  env: ContainersApiEnvironment,
  dependencies: ContainersApiDependencies = defaultDependencies,
): Promise<boolean> {
  const applicationName = env.RUNNER_IMAGE_BUILDER_APPLICATION;
  if (applicationName === undefined || applicationName.trim() === "") {
    throw new CloudflareContainersApiError("RUNNER_IMAGE_BUILDER_APPLICATION is required", 500);
  }
  return applicationHasLiveInstances(await findRunnerApplication(env, applicationName, dependencies));
}

/**
 * Starts an image rollout only for an idle runner application. Busy runners
 * keep their current image until the next source-image build request.
 */
export async function rolloutRunnerApplicationImages(
  env: ContainersApiEnvironment,
  image: string,
  dependencies: ContainersApiDependencies = defaultDependencies,
  options: RolloutRunnerApplicationImagesOptions = {},
): Promise<RolloutRunnerApplicationImagesResult> {
  const applications = (await listApplications(env, dependencies)).filter((application) =>
    runnerApplication(env, application),
  );
  const updatedApplications: string[] = [];
  const skippedApplications: string[] = [];
  const reportProgress = async (progress: RunnerApplicationImageRolloutProgress): Promise<void> => {
    try {
      await options.onProgress?.(progress);
    } catch (error) {
      // Progress is telemetry for the setup UI, not part of the Container API
      // transaction. A transient Durable Object error must not repeat a
      // successful rollout or abandon the build lease.
      console.error("Cloudflare runner image rollout progress reporting failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  await reportProgress({ processedApplications: 0, totalApplications: applications.length });

  for (const [index, listedApplication] of applications.entries()) {
    try {
      // Another actor can change a runner application's configuration while
      // an image build is finishing. Re-read it immediately before patching
      // so an image rollout never writes the stale values from the initial
      // list.
      // eslint-disable-next-line no-await-in-loop -- obtain the current configuration for this exact application.
      const application = await findRunnerApplication(env, listedApplication.name, dependencies);
      // eslint-disable-next-line no-await-in-loop -- a configuration rollout must be observed before the next application.
      const rollouts = await listRollouts(env, application.id, dependencies);
      if (rollouts.some((rollout) => rollout.status === "pending" || rollout.status === "progressing")) {
        skippedApplications.push(application.name);
        continue;
      }
      if (
        !options.reissueMatchingImageRollouts &&
        application.configuration.image === image &&
        rollouts.some((rollout) => rollout.status === "completed" && rollout.target_configuration.image === image)
      ) {
        continue;
      }
      if (applicationHasLiveInstances(application)) {
        skippedApplications.push(application.name);
        continue;
      }
      if (application.configuration.image !== image) {
        // eslint-disable-next-line no-await-in-loop -- serialize the image PATCH before the next application.
        await patchApplicationImage(env, application, image, dependencies);
      }
      // The configuration may have changed while the image-only PATCH was in
      // flight. Read it again so the full rollout target cannot restore a
      // stale configuration.
      // eslint-disable-next-line no-await-in-loop -- this exact application owns its next rollout body.
      const current = await findRunnerApplication(env, application.name, dependencies);
      if (applicationHasLiveInstances(current)) {
        skippedApplications.push(application.name);
        continue;
      }
      // PATCH acceptance does not make the requested image visible in the
      // application's active configuration until a rollout applies it. Build
      // the rollout target from this freshly read configuration so concurrent
      // configuration changes survive while the new image remains explicit
      // below.
      // If a prior PATCH made it through but its rollout call did not, the
      // application already has this image here. Still create the rollout: a
      // desired configuration alone does not prove live instances moved.
      // eslint-disable-next-line no-await-in-loop -- each explicit rollout belongs to this application.
      await createApplicationImageRollout(
        env,
        current,
        image,
        "Cloudflare GitHub Actions runner image update",
        dependencies,
      );
      updatedApplications.push(application.name);
    } finally {
      // eslint-disable-next-line no-await-in-loop -- progress must correspond to the application that just finished inspection.
      await reportProgress({ processedApplications: index + 1, totalApplications: applications.length });
    }
  }
  return { updatedApplications, skippedApplications };
}

/**
 * Switch the one-shot image builder to its account-private daemonless image.
 * This is isolated from runner rollouts because this builder never runs jobs
 * and must be idle before its image changes.
 */
export async function rolloutRunnerImageBuilderApplication(
  env: ContainersApiEnvironment,
  image: string,
  dependencies: ContainersApiDependencies = defaultDependencies,
  options: RolloutRunnerImageBuilderOptions = {},
): Promise<PrepareRunnerApplicationResult> {
  const applicationName = env.RUNNER_IMAGE_BUILDER_APPLICATION;
  if (applicationName === undefined || applicationName.trim() === "") {
    throw new CloudflareContainersApiError("RUNNER_IMAGE_BUILDER_APPLICATION is required", 500);
  }
  const application = await findRunnerApplication(env, applicationName, dependencies);
  const rollouts = await listRollouts(env, application.id, dependencies);
  const matchingActiveRollout = rollouts.find(
    (rollout) =>
      (rollout.status === "pending" || rollout.status === "progressing") &&
      rollout.target_configuration.image === image,
  );
  if (matchingActiveRollout !== undefined) {
    return { kind: "rollout", applicationId: application.id, rolloutId: matchingActiveRollout.id };
  }
  if (rollouts.some((rollout) => rollout.status === "pending" || rollout.status === "progressing")) {
    throw new CloudflareContainersApiError(
      "Another Container configuration is still rolling out; retry after it completes",
      409,
    );
  }
  if (
    !options.force &&
    application.configuration.image === image &&
    rollouts.some((rollout) => rollout.status === "completed" && rollout.target_configuration.image === image)
  ) {
    return { kind: "ready", applicationId: application.id };
  }
  if (applicationHasLiveInstances(application)) {
    throw new CloudflareContainersApiError("The Cloudflare runner image builder is still active", 409);
  }
  if (application.configuration.image !== image) {
    await patchApplicationImage(env, application, image, dependencies);
  }
  const rollout = await createApplicationImageRollout(
    env,
    application,
    image,
    "Cloudflare GitHub Actions private daemonless image builder",
    dependencies,
  );
  return { kind: "rollout", applicationId: application.id, rolloutId: rollout.id };
}

export async function getContainerRolloutStatus(
  env: ContainersApiEnvironment,
  applicationId: string,
  rolloutId: string,
  dependencies: ContainersApiDependencies = defaultDependencies,
): Promise<ContainerRolloutStatus> {
  const result = await containersApiRequest(
    env,
    `/applications/${encodeURIComponent(applicationId)}/rollouts/${encodeURIComponent(rolloutId)}`,
    { method: "GET" },
    dependencies,
  );
  const rollout = containerRolloutSchema.safeParse(result);
  if (!rollout.success) {
    throw new CloudflareContainersApiError("Cloudflare returned an invalid Container rollout", 502);
  }
  return rollout.data.status;
}
