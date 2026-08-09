# Project Anatomy

Last verified: 2026-08-09

## Authority

- Canonical Linux checkout: `/home/fuqiang/projects/orcana`.
- Active repair branch: `fix/gate-control-plane`.
- Repair-batch baseline head:
  `a379858b5ae3b3f3e27185a3bf0d02ca08b78764`.
- Remote: `https://github.com/Leo-Ayh-Oday/orcana-runtime.git`.
- `origin/main` is the review base. Do not merge, push, publish, or rewrite
  history without the corresponding owner authority.

## Repository Map

| Path | Purpose |
| --- | --- |
| `src/runtime/linux/` | Linux capability detection, policy, backends, cgroup, process and workspace control |
| `src/runtime/process-executor.ts` | Process facade and Linux broker entry |
| `src/execd/` | Durable execution daemon, state, recovery, logs and protocol |
| `evals/linux-sandbox-eval.ts` | Real Linux sandbox acceptance scenarios |
| `tests/runtime/linux/` | Unit, integration and true-kernel Linux coverage |
| `scripts/run-tests.cjs` | Official aggregate test gate and quarantine inventory |
| `.github/workflows/ci.yml` | General typecheck, core, test, eval and build jobs |
| `.github/workflows/linux-sandbox-lanes.yml` | Real Bubblewrap, Podman and delegated-cgroup lanes |
| `docs/linux-foundation/` | Linux runtime contracts, ADRs, security model and acceptance records |
| `.wolf/gate-telemetry.json` | Latest generated gate telemetry |

## Current Gate Boundary

- Local typecheck, build, official aggregate tests, real Bubblewrap, real
  rootless Podman, and delegated-cgroup evaluation have verified execution on
  the canonical WSL checkout.
- Seven provider/live tests remain explicitly quarantined. Six have a protected
  manual lane whose `DEEPSEEK_LIVE_API_KEY` secret is exposed to tests as
  `DEEPSEEK_API_KEY`; `code_as_action.test.ts` stays
  blocked until generated-code execution is credential-free and network-isolated.
- GitHub-hosted jobs are currently blocked before step execution by an account
  billing lock. Repository changes cannot clear that external lock.
- Landlock is unavailable on the current WSL kernel. Do not claim that boundary
  as enforced.
