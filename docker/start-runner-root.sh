#!/bin/sh
# Root-level prelude for the runner container (fork: punkeel/cf-runners).
#
# The upstream image runs everything as the non-root `runner` user, which
# cannot start a Docker daemon. This prelude runs as PID 1 (under tini),
# brings up dockerd inside the Cloudflare microVM, then drops back to the
# unprivileged `runner` user for the actual actions/runner.
#
# Docker-in-Docker on the cloudflare-microvm kernel is validated by the
# environment notes in FORK.md: dockerd comes up in ~2s with the containerd
# overlayfs snapshotter, iptables/NAT setup does not wedge the VM, and nested
# egress works once net.ipv4.ip_forward is enabled.

set -eu

log_dir=/home/runner/.cf-runner
log_file="${log_dir}/dockerd.log"

mkdir --parents "${log_dir}"
touch "${log_file}"
chown runner:runner "${log_dir}" "${log_file}"

# Nested containers egress through the VM; the kernel default is off.
echo 1 > /proc/sys/net/ipv4/ip_forward

# dockerd with default configuration: the storage driver auto-selects the
# containerd overlayfs snapshotter on the btrfs microVM rootfs, and the
# daemon's own bridge/iptables/NAT setup is safe on this kernel.
dockerd >>"${log_file}" 2>&1 &
dockerd_pid=$!

i=0
while [ "${i}" -lt 60 ]; do
  if docker info >/dev/null 2>&1; then
    break
  fi
  kill -0 "${dockerd_pid}" 2>/dev/null || {
    echo "dockerd exited during startup; log tail:" >&2
    tail -20 "${log_file}" >&2
    exit 1
  }
  i=$((i + 1))
  sleep 1
done
if ! docker info >/dev/null 2>&1; then
  echo "dockerd did not become ready within 60s; log tail:" >&2
  tail -20 "${log_file}" >&2
  exit 1
fi

# The `runner` user is in the `docker` group, so job steps can use the
# docker CLI directly. Drop privileges and hand off to the upstream
# entrypoint unchanged.
exec runuser --user runner -- /usr/bin/tini -- /home/runner/start-runner.sh
