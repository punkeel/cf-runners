# Cloudflare Containers GitHub Actions Runner

[![CI](https://badgen.net/github/checks/punkeel/cf-runners)](https://github.com/punkeel/cf-runners/actions)
[![npm version](https://badgen.net/npm/v/cloudflare-github-actions-runner)](https://www.npmjs.com/package/cloudflare-github-actions-runner)
[![npm downloads](https://badgen.net/npm/dt/cloudflare-github-actions-runner)](https://www.npmjs.com/package/cloudflare-github-actions-runner)

Run GitHub Actions jobs in an ephemeral [Cloudflare Containers](https://developers.cloudflare.com/containers/). A signed GitHub App `workflow_job` webhook provisions a repository-scoped GitHub [just-in-time runner](https://docs.github.com/en/actions/reference/security/secure-use#using-just-in-time-runners).

## Deployment

This fork is deployed from the repository with `cloudflare.config.ts`:

```sh
pnpm install --frozen-lockfile
CLOUDFLARE_ACCOUNT_ID=<account-id> pnpm run deploy
```

The same commands run in GitHub Actions from `.github/workflows/deploy.yml`. The workflow receives only the Cloudflare API token and account ID; GitHub App credentials remain Worker secrets and are never committed or printed by the build.

## Private repositories only

Cloudflare runners run jobs only when GitHub reports the repository's current visibility as exactly **private**. Public and GitHub Enterprise internal repositories cannot use the runner, even when the GitHub App is installed for **All repositories**.

For a job whose resolved `runs-on` labels include the reserved `cloudflare-` prefix, the Worker checks visibility before machine validation or scheduling and again immediately before creating a just-in-time runner. An unsupported or unverifiable repository starts no runner or Cloudflare Container. The App instead reports a failed **Cloudflare runner eligibility** Check on the associated commit when GitHub permits it.

Jobs using GitHub-hosted runners or unrelated self-hosted labels are ignored and receive no eligibility Check. GitHub does not expose an API for failing only the unsupported queued job, so it may remain queued until GitHub's self-hosted runner timeout; use another `runs-on` label or make the repository private.

The GitHub App holds its configured permissions in every repository where it is installed. Runtime visibility enforcement disables Cloudflare compute in public and internal repositories; it does not narrow the App installation itself or change GitHub's contributor approval policies.

## Choose a runner

Use one label directly in a workflow:

| `runs-on` label                | Machine type  | vCPU |  Memory |  Disk |
| ------------------------------ | ------------- | ---: | ------: | ----: |
| `cloudflare-lite`              | `linux/amd64` | 1/16 | 256 MiB |  2 GB |
| `cloudflare-basic`             | `linux/amd64` |  1/4 |   1 GiB |  4 GB |
| `cloudflare-standard-1`        | `linux/amd64` |  1/2 |   4 GiB |  8 GB |
| `cloudflare-standard-2`        | `linux/amd64` |    1 |   6 GiB | 12 GB |
| `cloudflare-standard-3`        | `linux/amd64` |    2 |   8 GiB | 16 GB |
| **`cloudflare-ubuntu-latest`** | `linux/amd64` |    2 |   8 GiB | 16 GB |
| `cloudflare-standard-4`        | `linux/amd64` |    4 |  12 GiB | 20 GB |

All profiles use the same managed Ubuntu 24.04 LTS runner image. Values come from the [Cloudflare Containers instance types](https://developers.cloudflare.com/containers/platform-details/limits/).

### Custom Machines Sizes

Preset labels are convenient, but custom machines let each job request exactly the compute it needs. Put the vCPU, memory, and disk allocation directly in `runs-on`; there is no per-size Cloudflare setup and no additional runner image to build. The account scheduler reserves capacity, configures an idle custom slot, and starts a fresh disposable runner with the same managed Ubuntu image.

```yaml
jobs:
  build:
    runs-on: "cloudflare-vcpu:2-memory_mib:6144-disk_mb:12000"
```

The label is self-contained, so different jobs—even in the same workflow—can choose different shapes:

| `runs-on` label                                    | vCPU | Memory | Disk  |
| -------------------------------------------------- | ---: | ------ | ----- |
| `cloudflare-vcpu:1-memory_mib:4096-disk_mb:8000`   |    1 | 4 GiB  | 8 GB  |
| `cloudflare-vcpu:2-memory_mib:6144-disk_mb:12000`  |    2 | 6 GiB  | 12 GB |
| `cloudflare-vcpu:4-memory_mib:12288-disk_mb:20000` |    4 | 12 GiB | 20 GB |

- Custom values use 1–4 whole vCPUs, up to 12,288 MiB memory, and up to 20,000 MB disk
- Memory must provide at least 3,072 MiB per vCPU, and disk cannot exceed 2 GB per GiB of memory.
- Invalid requests fail visibly in the **Set up runner** GitHub runner step before repository code executes.
- The first job for a new shape may remain queued for a few minutes while Cloudflare rolls that configuration onto an idle custom slot. The runner image is reused rather than rebuilt.

## Caching

The Worker backs `actions/cache` with a private Cloudflare R2 bucket. JavaScript actions, including `actions/cache` and `actions/setup-node`, use that cache transparently; artifact uploads and job results continue to use GitHub. Pull request caches are scoped to their merge ref and can fall back to the default branch cache.

```yaml
jobs:
  ci:
    runs-on: cloudflare-ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v6
      - run: corepack enable
      - uses: actions/setup-node@v7
        with:
          node-version: 24
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm run check
```

## Required secrets

Configure these five Worker secrets once with the Cloudflare dashboard or `wrangler secret put`: `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_WEBHOOK_SECRET`, `RESOURCE_TRACE_SIGNING_KEY`, and `RUNNER_CACHE_SIGNING_KEY`. The deployment workflow updates code and container images while preserving those secrets.

Install the GitHub App for the configured `GITHUB_RUNNER_OWNER` and enable `workflow_job` webhooks. The app needs Actions read, Administration write, and Checks write permissions so the Worker can create just-in-time runners and report eligibility failures.

## License

MIT
