# Fork notes: punkeel/cf-runners

Fork of [biw/cloudflare-github-actions-runner](https://github.com/biw/cloudflare-github-actions-runner)
with two functional deltas:

1. **The managed runner image can build and run Docker containers**, so jobs
   can do `wrangler deploy` (which builds and pushes Cloudflare container
   images) and any other Docker-based CI.
2. **One runner container class instead of sixteen.** Upstream deploys a
   separate container application per size label (lite, basic,
   standard-1..4, custom-1..10, validation). This fork deploys a single
   `GitHubActionsRunner` class whose vCPU/memory/disk is chosen at `start()`
   time from the job's `runs-on` label — one DO per queued job, one container
   app per pool (~1,900 lines removed).

Everything else — GitHub App with just-in-time runners, workflow-driven
scale-to-zero, size labels, and R2 caching — follows the upstream design.

## What changed

### 1. Docker-in-Docker runner image

- `docker/Dockerfile`: install `docker.io` (dockerd + containerd + runc),
  add the `runner` user to the `docker` group, and switch the image to run
  as root so the entrypoint can start dockerd.
- `docker/Dockerfile` pins the runner version and all downloaded artifacts.
  Cloudflare builds this Dockerfile during `cf deploy`, then assigns the
  resulting immutable image to the runner Container application.
- `docker/start-runner-root.sh` (new): root prelude that enables
  `net.ipv4.ip_forward` (nested-container egress), starts dockerd with
  default configuration, waits for it, then `runuser`s into the unchanged
  upstream `start-runner.sh` as the unprivileged `runner` user.
- `cloudflare.config.ts` declares the Dockerfile as the runner image source.

### 2. Instance-sized single runner class

- `src/instance-sized-container.ts` (new): thin base class that wraps the
  raw `ctx.container.start()` handle so a per-start `instance`
  (`{ vcpu, memoryMib, diskMb }`) is merged into the start configuration —
  `@cloudflare/containers` 0.3.x only exposes envVars/entrypoint/
  enableInternet/labels overrides. All SDK lifecycle machinery (monitor,
  hibernation recovery, `sleepAfter`, `getState`) is kept.
- `src/index.ts`: sixteen per-size subclasses plus the separate validation
  class collapse into one `GitHubActionsRunner` (DO policy scheduling);
  diagnostic runners use the same class at the basic size.
- `src/provision.ts` passes the size profile's instance spec at `start()`.
- `src/account-runner-scheduler.ts`, `src/scheduler-policy.ts`,
  `src/runner-provisioning-workflow.ts`: delete slot routing, custom-slot
  reconfiguration, retained-ceiling accounting, capacity PATCH scheduling,
  and configuration-wait machinery. Admission stays FIFO gated by
  `fitsAccountCapacity` on total reserved resources.
- `src/cloudflare-containers.ts`: drop per-app shape/ceiling PATCH helpers.
- `scripts/deploy.ts`: deploy directly from `cloudflare.config.ts`.
- `cloudflare.config.ts`: one runner Container application with durable-object
  scheduling and one `RUNNER` binding.

## Security trade-off (delta 1)

Upstream deliberately runs the runner process as a non-root user and has no
Docker daemon. This fork runs the _entrypoint_ as root (to start dockerd and
write `ip_forward`) but still runs the actions/runner itself as the
unprivileged `runner` user. Job steps gain the ability to use `docker`, which
on a runner machine is equivalent to root on that disposable microVM. Only
install the GitHub App for repositories whose workflows you already trust
with CI code execution — the same trust GitHub-hosted runners require.

## Environment validation (delta 1)

Docker-in-Docker on the `cloudflare-microvm` kernel was validated
end-to-end by a dedicated probe worker (2026-10-27):

- `dockerd` default config ready in ~2s; storage driver auto-selects the
  **containerd overlayfs snapshotter** (not vfs), so multi-GB layer commits
  stay cheap — a 3-layer build with ~600 MB of writes completed in 10s and
  reclaimed fully after prune.
- iptables/NAT bridge setup does **not** wedge the VM (one early probe
  assumed it would; forced testing disproved it).
- Nested containers reach the internet after `sysctl net.ipv4.ip_forward=1`
  (writable as root in the microVM).
- Direct nft/iptables _probing_ commands once hung a probe in D-state;
  dockerd's own usage is unaffected. Avoid running `iptables`/`nft`
  commands in job steps out of caution.

## Deploying this fork

```sh
pnpm install --frozen-lockfile
CLOUDFLARE_ACCOUNT_ID=<account-id> pnpm run deploy
```

Deployment is driven only by `cloudflare.config.ts`. It builds the single
runner image from `docker/Dockerfile`, deploys the Worker, and updates the
durable-object workflow. GitHub App credentials and signing keys stay in
Worker secrets and are preserved by code-only deployments.
