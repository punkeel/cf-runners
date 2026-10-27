# Fork notes: punkeel/cf-runners

Fork of [biw/cloudflare-github-actions-runner](https://github.com/biw/cloudflare-github-actions-runner)
with exactly one functional delta: **the managed runner image can build and
run Docker containers**, so jobs can do `wrangler deploy` (which builds and
pushes Cloudflare container images) and any other Docker-based CI.

Everything else — GitHub App with just-in-time runners, workflow-driven
scale-to-zero, size labels, R2 caching, remote image builder — is upstream.
Rebase regularly; the delta is intentionally tiny.

## What changed

- `docker/Dockerfile`: install `docker.io` (dockerd + containerd + runc),
  add the `runner` user to the `docker` group, and switch the image to run
  as root so the entrypoint can start dockerd.
- `docker/start-runner-root.sh` (new): root prelude that enables
  `net.ipv4.ip_forward` (nested-container egress), starts dockerd with
  default configuration, waits for it, then `runuser`s into the unchanged
  upstream `start-runner.sh` as the unprivileged `runner` user.
- `src/runner-image.ts`: the new script is part of `RUNNER_IMAGE_INPUT_PATHS`
  so changes to it rebuild the managed runner image.
- `wrangler.jsonc`: `RUNNER_IMAGE_SOURCE_REPOSITORY` points at this fork so
  the remote builder fetches `docker/` from `punkeel/cf-runners@main`, and
  pushes to this fork rebuild the image automatically.

## Security trade-off

Upstream deliberately runs the runner process as a non-root user and has no
Docker daemon. This fork runs the _entrypoint_ as root (to start dockerd and
write `ip_forward`) but still runs the actions/runner itself as the
unprivileged `runner` user. Job steps gain the ability to use `docker`, which
on a runner machine is equivalent to root on that disposable microVM. Only
install the GitHub App for repositories whose workflows you already trust
with CI code execution — the same trust GitHub-hosted runners require.

## Environment validation

Docker-in-Docker on the `cloudflare-microvm` kernel was validated
end-to-end by the `badbois/ac-model-max` probe worker (`ac-docker-probe`,
2026-10-27, see `badbois/cf-docker-probe` in the local Monorepo mirror):

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
corepack enable
pnpm install
pnpm run setup   # interactive: Cloudflare account, GitHub App creation, R2
```

The deployed resources keep upstream's `cloudflare-github-actions-runner*`
names so `pnpm run setup`/`teardown` stay compatible.
