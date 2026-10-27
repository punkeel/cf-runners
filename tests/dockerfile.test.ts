import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vite-plus/test";

describe("runner image", () => {
  it("assembles the image from the pinned CI-built runner layout", async () => {
    const dockerfile = await readFile("docker/Dockerfile", "utf8");

    // The layout tarball is a release asset built by the GitHub Actions
    // workflow, never compiled here. Its digest must be pinned.
    expect(dockerfile).not.toContain("dev.sh");
    expect(dockerfile).not.toContain("actions-runner-results-proxy.patch");
    expect(dockerfile).toContain(
      "https://github.com/punkeel/cf-runners/releases/download/runner-layout-v${RUNNER_VERSION}",
    );
    expect(dockerfile).toMatch(/ARG RUNNER_LAYOUT_SHA256=[0-9a-f]{64}/);
    expect(dockerfile).toContain(
      'echo "${RUNNER_LAYOUT_SHA256}  /tmp/runner-layout.tar.gz" | sha256sum --check --status',
    );

    // The pinned layout ships only the Node copies reachable from linux-x64
    // steps; Alpine-only copies are pruned in the layout workflow.
    expect(dockerfile).toContain("test -x /home/runner/actions-runner/externals/node20/bin/node");
    expect(dockerfile).toContain("test -x /home/runner/actions-runner/externals/node24/bin/node");
    expect(dockerfile).toContain("FORCE_JAVASCRIPT_ACTIONS_TO_NODE24=true");
    expect(dockerfile).not.toContain("ln --symbolic node24 /home/runner/actions-runner/externals/node20");
    expect(dockerfile).toContain("chown runner:runner /home/runner/actions-runner");
    expect(dockerfile).toContain('chown --recursive runner:runner "${RUNNER_TOOL_CACHE}"');
    expect(dockerfile).not.toContain('chown --recursive runner:runner /home/runner "${RUNNER_TOOL_CACHE}"');
  });

  it("installs Git from git-core for GitHub-hosted runner parity", async () => {
    const dockerfile = await readFile("docker/Dockerfile", "utf8");

    const repository = dockerfile.indexOf("add-apt-repository --yes ppa:git-core/ppa");
    const gitInstall = dockerfile.indexOf("apt-get install --yes --no-install-recommends git git-lfs", repository);

    expect(repository).toBeGreaterThan(0);
    expect(gitInstall).toBeGreaterThan(repository);
  });
});
