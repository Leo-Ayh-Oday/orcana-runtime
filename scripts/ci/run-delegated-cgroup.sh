#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <command> [args...]" >&2
  exit 64
fi

if ! command -v systemd-run >/dev/null 2>&1; then
  echo "CGROUP_DELEGATION_REQUIRED: systemd-run is unavailable" >&2
  exit 78
fi

run_user="$(id -un)"
run_group="$(id -gn)"
run_home="${HOME:?HOME is required}"
run_workdir="$(pwd -P)"
unit_suffix="${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-0}-$$"
unit_suffix="$(printf '%s' "$unit_suffix" | tr -cd 'A-Za-z0-9_.-')"
unit_name="orcana-cgroup-${unit_suffix}"
runtime_max_sec=600

environment=(
  "-E" "HOME=$run_home"
  "-E" "PATH=$PATH"
  "-E" "CI=${CI:-}"
  "-E" "GITHUB_ACTIONS=${GITHUB_ACTIONS:-}"
  "-E" "BUN_INSTALL=${BUN_INSTALL:-}"
)

common=(
  --wait
  --pipe
  --collect
  "--unit=$unit_name"
  "--property=Type=exec"
  "--property=Delegate=yes"
  "--property=KillMode=control-group"
  "--property=RuntimeMaxSec=${runtime_max_sec}s"
  "--property=TimeoutStopSec=15s"
  "--property=WorkingDirectory=$run_workdir"
)

# GitHub-hosted Ubuntu runners provide passwordless sudo. A system service with
# User=/Group= and Delegate=yes gives that unprivileged user ownership of the
# transient service's cgroup subtree. Local WSL uses the existing user manager.
if sudo -n true >/dev/null 2>&1; then
  exec sudo -n systemd-run \
    "${common[@]}" \
    "--property=User=$run_user" \
    "--property=Group=$run_group" \
    "${environment[@]}" \
    -- "$@"
fi

if systemctl --user show-environment >/dev/null 2>&1; then
  exec systemd-run --user \
    "${common[@]}" \
    "${environment[@]}" \
    -- "$@"
fi

echo "CGROUP_DELEGATION_REQUIRED: neither passwordless systemd-run nor a user manager is available" >&2
exit 78
