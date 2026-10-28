export interface GitHubRepositoryTarget {
  owner: string;
  repository: string;
}

export interface GitHubCredentialEnvironment {
  /** The sole GitHub account or organization served by this runner pool. */
  GITHUB_RUNNER_OWNER?: string;
}

function normalized(value: string): string {
  return value.trim().toLowerCase();
}

export function parseGitHubRepositoryTarget(value: string): GitHubRepositoryTarget | undefined {
  const [owner, repository, ...rest] = value.trim().split("/");
  if (owner === undefined || repository === undefined || rest.length > 0 || owner === "" || repository === "") {
    return undefined;
  }
  return { owner, repository };
}

export function githubRepositoryName(target: GitHubRepositoryTarget): string {
  return `${target.owner}/${target.repository}`;
}

export function sameGitHubRepository(left: GitHubRepositoryTarget, right: GitHubRepositoryTarget): boolean {
  return (
    normalized(left.owner) === normalized(right.owner) && normalized(left.repository) === normalized(right.repository)
  );
}

/** A Worker belongs to one GitHub account or organization. */
export function runnerPoolAcceptsGitHubRepository(
  env: Pick<GitHubCredentialEnvironment, "GITHUB_RUNNER_OWNER">,
  target: GitHubRepositoryTarget,
): boolean {
  const configuredOwner = env.GITHUB_RUNNER_OWNER?.trim();
  return (
    configuredOwner !== undefined && configuredOwner !== "" && normalized(configuredOwner) === normalized(target.owner)
  );
}
