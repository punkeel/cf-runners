import { z } from "zod";

import type { GitHubRepositoryTarget } from "./github-repository";

const githubApiVersion = "2022-11-28";

export interface GitHubAppEnvironment {
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_APP_WEBHOOK_SECRET?: string;
}

export interface GitHubAppDependencies {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  now: () => number;
}

/**
 * The cache visibility rules GitHub applies to one workflow run. A pull
 * request receives its own merge-ref namespace and may fall back to the
 * repository default branch; it never writes into that shared namespace.
 */
export interface GitHubWorkflowRunCacheScope {
  scope: string;
  fallbackScope?: string;
  writeAllowed: boolean;
}

const defaultDependencies: GitHubAppDependencies = {
  fetch: (input, init) => fetch(input, init),
  now: () => Date.now(),
};

const nonEmptyStringSchema = z.string().trim().min(1);
const optionalNonEmptyStringSchema = nonEmptyStringSchema.optional().catch(undefined);
const positiveIntegerSchema = z.number().int().positive();
const optionalPositiveIntegerSchema = positiveIntegerSchema.optional().catch(undefined);
const workflowRunSchema = z.object({
  event: z.string().optional().catch(undefined),
  head_branch: optionalNonEmptyStringSchema,
  pull_requests: z
    .array(z.object({ number: optionalPositiveIntegerSchema }))
    .optional()
    .catch(undefined),
});
const installationAccessTokenSchema = z.object({ token: nonEmptyStringSchema });
const installationWebhookSchema = z.object({ installation: z.object({ id: positiveIntegerSchema }) });

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function derLength(length: number): Uint8Array {
  if (length < 128) {
    return Uint8Array.of(length);
  }
  const octets = [];
  for (let value = length; value > 0; value >>>= 8) {
    octets.unshift(value & 0xff);
  }
  return Uint8Array.of(0x80 | octets.length, ...octets);
}

function der(tag: number, contents: Uint8Array): Uint8Array {
  const result = new Uint8Array(1 + derLength(contents.length).length + contents.length);
  result[0] = tag;
  result.set(derLength(contents.length), 1);
  result.set(contents, 1 + derLength(contents.length).length);
  return result;
}

function concat(...values: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(values.reduce((length, value) => length + value.length, 0));
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.length;
  }
  return result;
}

function pkcs1ToPkcs8(privateKey: Uint8Array): Uint8Array {
  const rsaAlgorithm = Uint8Array.of(
    0x30,
    0x0d,
    0x06,
    0x09,
    0x2a,
    0x86,
    0x48,
    0x86,
    0xf7,
    0x0d,
    0x01,
    0x01,
    0x01,
    0x05,
    0x00,
  );
  return der(0x30, concat(Uint8Array.of(0x02, 0x01, 0x00), rsaAlgorithm, der(0x04, privateKey)));
}

function pemBytes(privateKey: string): Uint8Array | undefined {
  const pkcs1 = /-----BEGIN RSA PRIVATE KEY-----/u.test(privateKey);
  const encoded = privateKey
    .replace(/-----BEGIN (?:RSA )?PRIVATE KEY-----/gu, "")
    .replace(/-----END (?:RSA )?PRIVATE KEY-----/gu, "")
    .replace(/\s/gu, "");
  if (encoded === "") {
    return undefined;
  }
  try {
    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return pkcs1 ? pkcs1ToPkcs8(bytes) : bytes;
  } catch {
    return undefined;
  }
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function appCredentials(env: GitHubAppEnvironment): { id: string; privateKey: string } | undefined {
  const id = optionalNonEmptyStringSchema.safeParse(env.GITHUB_APP_ID);
  const privateKey = optionalNonEmptyStringSchema.safeParse(env.GITHUB_APP_PRIVATE_KEY);
  return id.success && id.data !== undefined && privateKey.success && privateKey.data !== undefined
    ? { id: id.data, privateKey: privateKey.data }
    : undefined;
}

async function githubAppJwt(
  env: GitHubAppEnvironment,
  dependencies: GitHubAppDependencies = defaultDependencies,
): Promise<string | undefined> {
  const credentials = appCredentials(env);
  if (credentials === undefined) {
    return undefined;
  }
  const privateKey = pemBytes(credentials.privateKey);
  if (privateKey === undefined) {
    return undefined;
  }

  const issuedAt = Math.floor(dependencies.now() / 1_000) - 60;
  const encodedHeader = base64Url(new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const encodedPayload = base64Url(
    new TextEncoder().encode(JSON.stringify({ iat: issuedAt, exp: issuedAt + 540, iss: credentials.id })),
  );
  const unsigned = `${encodedHeader}.${encodedPayload}`;
  try {
    const key = await crypto.subtle.importKey(
      "pkcs8",
      arrayBuffer(privateKey),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
    return `${unsigned}.${base64Url(new Uint8Array(signature))}`;
  } catch {
    return undefined;
  }
}

function githubHeaders(token: string): HeadersInit {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "cloudflare-github-actions-runner",
    "X-GitHub-Api-Version": githubApiVersion,
  };
}

function defaultBranchCacheScope(defaultBranch: string | undefined): string | undefined {
  const parsed = optionalNonEmptyStringSchema.safeParse(defaultBranch);
  return parsed.success && parsed.data !== undefined ? `refs/heads/${parsed.data}` : undefined;
}

function branchCacheScope(branch: string | undefined): string | undefined {
  return branch === undefined ? undefined : `refs/heads/${branch}`;
}

function pullRequestCacheScope(number: number | undefined): string | undefined {
  return number === undefined ? undefined : `refs/pull/${number}/merge`;
}

const trustedCacheWriteEvents = new Set([
  "delete",
  "page_build",
  "push",
  "registry_package",
  "repository_dispatch",
  "schedule",
  "workflow_dispatch",
]);

/**
 * Mirrors GitHub Actions cache scoping using the App's Actions: Read
 * permission. If GitHub cannot confirm the run, use the default branch only
 * as a read-only fallback rather than risking a shared-cache write.
 */
export async function githubWorkflowRunCacheScope(
  target: GitHubRepositoryTarget,
  workflowRunId: number | undefined,
  defaultBranch: string | undefined,
  token: string | undefined,
  dependencies: GitHubAppDependencies = defaultDependencies,
): Promise<GitHubWorkflowRunCacheScope | undefined> {
  const defaultScope = defaultBranchCacheScope(defaultBranch);
  if (defaultScope === undefined) {
    return undefined;
  }
  if (
    token === undefined ||
    workflowRunId === undefined ||
    !Number.isSafeInteger(workflowRunId) ||
    workflowRunId <= 0
  ) {
    console.log("Cloudflare runner cache scope fell back to read-only default branch", {
      repository: `${target.owner}/${target.repository}`,
      reason: token === undefined ? "missing-installation-token" : "missing-workflow-run-id",
    });
    return { scope: defaultScope, writeAllowed: false };
  }

  try {
    const response = await dependencies.fetch(
      `https://api.github.com/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repository)}/actions/runs/${workflowRunId}`,
      { headers: githubHeaders(token) },
    );
    if (!response.ok) {
      console.log("Cloudflare runner cache scope fell back to read-only default branch", {
        repository: `${target.owner}/${target.repository}`,
        workflowRunId,
        reason: "workflow-run-request-failed",
        status: response.status,
        acceptedPermissions: response.headers.get("X-Accepted-GitHub-Permissions") ?? undefined,
      });
      return { scope: defaultScope, writeAllowed: false };
    }
    const parsedRun = workflowRunSchema.safeParse(await response.json());
    if (!parsedRun.success) {
      return { scope: defaultScope, writeAllowed: false };
    }
    const run = parsedRun.data;
    if (run.event === "pull_request") {
      const scope = pullRequestCacheScope(run.pull_requests?.[0]?.number);
      if (scope === undefined) {
        console.log("Cloudflare runner cache scope fell back to read-only default branch", {
          repository: `${target.owner}/${target.repository}`,
          workflowRunId,
          reason: "missing-pull-request-number",
        });
      }
      return scope === undefined
        ? { scope: defaultScope, writeAllowed: false }
        : { scope, fallbackScope: defaultScope, writeAllowed: true };
    }
    const scope = branchCacheScope(run.head_branch);
    if (scope === undefined || run.event === undefined || !trustedCacheWriteEvents.has(run.event)) {
      console.log("Cloudflare runner cache scope fell back to read-only default branch", {
        repository: `${target.owner}/${target.repository}`,
        workflowRunId,
        reason: scope === undefined ? "missing-workflow-branch" : "untrusted-workflow-event",
        event: run.event,
      });
      return { scope: defaultScope, writeAllowed: false };
    }
    return scope === defaultScope
      ? { scope, writeAllowed: true }
      : { scope, fallbackScope: defaultScope, writeAllowed: true };
  } catch (error) {
    console.log("Cloudflare runner cache scope fell back to read-only default branch", {
      repository: `${target.owner}/${target.repository}`,
      workflowRunId,
      reason: "workflow-run-request-threw",
      error: error instanceof Error ? error.message : String(error),
    });
    return { scope: defaultScope, writeAllowed: false };
  }
}

export async function githubInstallationAccessToken(
  env: GitHubAppEnvironment,
  installationId: number,
  dependencies: GitHubAppDependencies = defaultDependencies,
): Promise<string | undefined> {
  if (!Number.isSafeInteger(installationId) || installationId <= 0) {
    return undefined;
  }
  const jwt = await githubAppJwt(env, dependencies);
  if (jwt === undefined) {
    return undefined;
  }
  try {
    const response = await dependencies.fetch(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      {
        method: "POST",
        headers: githubHeaders(jwt),
      },
    );
    if (!response.ok) {
      return undefined;
    }
    const parsedBody = installationAccessTokenSchema.safeParse(await response.json());
    if (!parsedBody.success) {
      return undefined;
    }
    return parsedBody.data.token;
  } catch {
    return undefined;
  }
}

export function hasGitHubAppWebhookSecret(env: GitHubAppEnvironment): boolean {
  return optionalNonEmptyStringSchema.safeParse(env.GITHUB_APP_WEBHOOK_SECRET).data !== undefined;
}

export function githubInstallationFromWebhook(body: string): number | undefined {
  try {
    const parsed = installationWebhookSchema.safeParse(JSON.parse(body));
    return parsed.success ? parsed.data.installation.id : undefined;
  } catch {
    return undefined;
  }
}

export async function githubTokenForRunner(
  env: GitHubAppEnvironment,
  installationId: number | null,
  dependencies: GitHubAppDependencies = defaultDependencies,
): Promise<string | undefined> {
  return installationId === null ? undefined : githubInstallationAccessToken(env, installationId, dependencies);
}
