import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it, vi } from "vite-plus/test";

import {
  githubInstallationAccessToken,
  githubInstallationFromWebhook,
  githubTokenForRunner,
  githubWorkflowRunCacheScope,
  hasGitHubAppWebhookSecret,
} from "../src/github-app";

const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({
    type: "pkcs8",
    format: "pem",
  })
  .toString();
const pkcs1PrivateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({
    type: "pkcs1",
    format: "pem",
  })
  .toString();
const environment = {
  GITHUB_APP_ID: "123",
  GITHUB_APP_PRIVATE_KEY: privateKey,
  GITHUB_APP_WEBHOOK_SECRET: "app-webhook-secret",
};

describe("GitHub App authentication", () => {
  it("exchanges a signed App JWT for an installation access token", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ token: "installation-token" }));

    await expect(githubInstallationAccessToken(environment, 42, { fetch, now: () => 1_700_000_000_000 })).resolves.toBe(
      "installation-token",
    );
    expect(fetch).toHaveBeenCalledWith(
      "https://api.github.com/app/installations/42/access_tokens",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: expect.stringMatching(/^Bearer ey/u) }),
      }),
    );
  });

  it("accepts GitHub's PKCS#1 RSA private-key format", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ token: "installation-token" }));

    await expect(
      githubInstallationAccessToken({ ...environment, GITHUB_APP_PRIVATE_KEY: pkcs1PrivateKey }, 42, {
        fetch,
        now: () => 1_700_000_000_000,
      }),
    ).resolves.toBe("installation-token");
  });

  it("uses an App installation token", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ token: "installation-token" }));

    await expect(
      githubTokenForRunner(environment, 42, {
        fetch,
        now: () => 1_700_000_000_000,
      }),
    ).resolves.toBe("installation-token");
    await expect(githubTokenForRunner(environment, null)).resolves.toBeUndefined();
  });

  it("extracts installation IDs and requires an App webhook secret", () => {
    expect(githubInstallationFromWebhook(JSON.stringify({ installation: { id: 42 } }))).toBe(42);
    expect(githubInstallationFromWebhook("{}")).toBeUndefined();
    expect(hasGitHubAppWebhookSecret(environment)).toBe(true);
    expect(hasGitHubAppWebhookSecret({ GITHUB_APP_WEBHOOK_SECRET: "" })).toBe(false);
  });

  it("gives pull requests an isolated merge-ref cache with a default-branch fallback", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      Response.json({
        event: "pull_request",
        head_branch: "feature/cache",
        pull_requests: [{ number: 42 }],
      }),
    );

    await expect(
      githubWorkflowRunCacheScope({ owner: "biw", repository: "runner" }, 123, "main", "installation-token", {
        fetch,
        now: () => 1_700_000_000_000,
      }),
    ).resolves.toEqual({
      scope: "refs/pull/42/merge",
      fallbackScope: "refs/heads/main",
      writeAllowed: true,
    });
  });

  it("does not let pull_request_target runs write to the shared cache", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      Response.json({
        event: "pull_request_target",
        head_branch: "main",
        pull_requests: [{ number: 42 }],
      }),
    );

    await expect(
      githubWorkflowRunCacheScope({ owner: "biw", repository: "runner" }, 123, "main", "installation-token", {
        fetch,
        now: () => 1_700_000_000_000,
      }),
    ).resolves.toEqual({
      scope: "refs/heads/main",
      writeAllowed: false,
    });
  });

  it("does not allow a failed workflow-run lookup to write a shared cache", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null, { status: 404 }));

    await expect(
      githubWorkflowRunCacheScope({ owner: "biw", repository: "runner" }, 123, "main", "installation-token", {
        fetch,
        now: () => 1_700_000_000_000,
      }),
    ).resolves.toEqual({ scope: "refs/heads/main", writeAllowed: false });
  });
});
