import { describe, expect, it } from "vite-plus/test";

import {
  githubRepositoryName,
  parseGitHubRepositoryTarget,
  runnerPoolAcceptsGitHubRepository,
} from "../src/github-repository";

describe("GitHub repository credential routing", () => {
  it("limits a runner pool to its configured GitHub account or organization", () => {
    expect(
      runnerPoolAcceptsGitHubRepository(
        { GITHUB_RUNNER_OWNER: "ahoylabs" },
        { owner: "AhoyLabs", repository: "application" },
      ),
    ).toBe(true);
    expect(
      runnerPoolAcceptsGitHubRepository(
        { GITHUB_RUNNER_OWNER: "ahoylabs" },
        { owner: "biw", repository: "application" },
      ),
    ).toBe(false);
    expect(runnerPoolAcceptsGitHubRepository({}, { owner: "biw", repository: "application" })).toBe(false);
  });

  it("normalizes and validates repository targets", () => {
    expect(parseGitHubRepositoryTarget("octo-org/runner-poc")).toEqual({ owner: "octo-org", repository: "runner-poc" });
    expect(parseGitHubRepositoryTarget("octo-org")).toBeUndefined();
    expect(parseGitHubRepositoryTarget("octo-org/runner-poc/extra")).toBeUndefined();
    expect(githubRepositoryName({ owner: "octo-org", repository: "runner-poc" })).toBe("octo-org/runner-poc");
  });
});
