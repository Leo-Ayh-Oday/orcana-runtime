# Project Cerebrum

Durable decisions only. Detailed implementation and optimization proposals
belong in `docs/`.

## Confirmed Working Rules

- Linux `/home/fuqiang/projects/orcana` is authoritative for builds, tests,
  runtime probes, and Git evidence.
- A strict isolation claim requires a real backend lane. Mock coverage and
  conditional skips may test logic but cannot satisfy Bubblewrap, Podman, or
  cgroup enforcement acceptance.
- Unit tests must inject fake capabilities and cgroup managers explicitly.
  Ordinary unit runs must not attach to the host's real cgroup hierarchy.
- Every run owns cleanup of its process tree, cgroup run directory, container,
  port lease, service state, and temporary workspace. Empty residue is still a
  failed cleanup contract.
- Completion status must separate local test success, real Linux capability,
  live-provider validation, CI execution, mainline landing, and release.
- Provider/live tests may run only in an explicit lane with configured secrets.
  Missing credentials stay `QUARANTINED` or `ENV_BLOCKED`, never simulated;
  provider-generated code never executes in a process holding those secrets.
- Preserve unrelated long-running business workloads. Process cleanup is based
  on verified ownership, not broad name or PID-range killing.
- Implementation and independent audit remain separate. Audit reports are
  evidence; the primary owner verifies findings, fixes, tests, commits, and
  final cleanliness.

## Do Not Repeat

- Never migrate the controlling test or CLI process into a disposable cgroup
  during capability probing. Use a short-lived child probe.
- Never let CI announce a real cgroup lane when only mock tests ran or the host
  was merely probed as non-writable.
- Never treat an Actions job with zero executed steps as a code failure; inspect
  check-run annotations for account, billing, or runner-level blocks.
- Do not call `podman ps` as the final cleanup proof: rootless Podman may create
  its pause process during that read. Inspect containers first, stop the pause
  process with Podman's supported migration command when safe, then use the
  system process table for the final check.
- Do not merge main, publish packages, configure secrets, or alter billing
  settings without explicit owner authority.

## Pending Owner or External Gates

- GitHub account billing lock must be cleared before hosted Actions can execute.
- Six live/provider tests require an explicitly configured protected
  `live-provider` environment and `DEEPSEEK_LIVE_API_KEY` secret.
- `code_as_action.test.ts` remains blocked pending credential-free,
  network-isolated generated-code execution.
- Mainline landing and package release remain separate owner decisions.
- A future Linux sandbox optimization plan will be evaluated separately and
  must not retroactively change the evidence recorded here.
