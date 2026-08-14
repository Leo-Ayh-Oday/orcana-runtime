# Orcana Current Status

Updated: 2026-08-14
Source snapshot: `origin/main` @ `v0.8.30` (2026-08-14 release; IC01..IC06 production-closure line merged + audit-fix batch 2)

This file is the conservative current-status entry point. Historical plans and
completion records describe what was built at a point in time; they do not
override current code, current tests, real runtime evidence or a later audit.

## Version and publication state

| Surface | Version | Meaning |
|---|---:|---|
| npm `latest` | `0.8.30` | Current public package (2026-08-14) |
| GitHub Latest Release | `v0.8.30` | Current public Release/tag |
| `origin/main` | `0.8.30` | Released source — reconciled with npm / tag / GitHub Release |
| Active repair line | — | None unreleased at this time |

Version-truth source of record: [SECURITY.md Version Channels](../SECURITY.md#version-channels).

There is no automatic npm/GitHub Release workflow. A `package.json` version is
not a release until a clean candidate passes the release gates, receives owner
authorization, is tagged, published to npm, created as a GitHub Release and
installed back from the public registry for smoke verification.

## Status vocabulary

| Label | Meaning |
|---|---|
| `IMPLEMENTED` | Production code and focused tests exist |
| `PARTIAL` | Some production wiring or authority/lifecycle edge remains open |
| `LOCAL_REAL_VERIFIED` | A named local host executed the real backend/lane |
| `DEGRADED` | Work executed without the requested strong boundary |
| `ENV_BLOCKED` | Required host capability, credential or service is unavailable |
| `CI_BLOCKED_EXTERNAL` | Hosted job never started; no code verdict is possible |
| `RELEASED` | npm, tag, GitHub Release and public-install smoke all agree |

## Current subsystem matrix

| Subsystem | Status | Current truth / open boundary |
|---|---|---|
| CLI / TUI | `IMPLEMENTED`, baseline repair applied (2026-08-14) | Entry points exist; six high-impact TUI bugs fixed (bare-slash guard, auth-error mislabel, empty-round bubble, non-TTY crash, block-nav input hijack, duplicate transcript dispatch) plus the Node `bun:`-import crash; residual items (stdin TTY edge, quota-regex looseness) tracked in the Buglog |
| Agent Kernel / Harness | `IMPLEMENTED`, converging | Lifecycle, outcomes, budgets, traces, persistence and interrupts exist; authority is still split across several layers |
| Provider finish semantics | `PARTIAL` | Truncation/retry work exists, but finish-reason normalization, complete-vs-partial tool-call preservation and output/thinking reserve require current-code audit |
| Loop progress / retry | `PARTIAL` | ProgressGovernor and run-scoped retry ledger exist; the Infrastructure Closure plan still requires one physical-request budget and bounded no-progress/truncation ladders to be re-verified |
| Workspace file I/O | `PARTIAL` | Relative paths bind to `projectRoot`, cross-project and symlink escapes have tests; direct `TrustedExecutionAuthority.workspace.hostRoot` binding, secret-read policy and bounded large-file reads remain open |
| Patch / filesystem write | `PARTIAL` | Freshness and transaction guards exist; strict Linux TOCTOU closure still lacks dirfd/openat2/renameat2-like enforcement |
| Linux short-process authority | `IMPLEMENTED`, transaction gaps open | Normal Linux `ProcessExecutor` uses the Broker in enabled mode; acquisition/release before registry publication and some run-state identity/cleanup paths still require closure |
| Linux Bubblewrap backend | `LOCAL_REAL_VERIFIED`, host-dependent | Real local lane has run; every claim still requires the run Receipt and no relevant degradation |
| Linux Rootless Podman backend | `LOCAL_REAL_VERIFIED`, host-dependent | Real local lane has run; container is not a VM and depends on rootless/image policy readiness |
| Linux cgroup v2 | `LOCAL_REAL_VERIFIED`, host-dependent | Delegated local lane has run; configured limits do not prove attachment/cleanup for another run |
| Host Audit | `DEGRADED` | Explicit environment, timeout/process group and post-hoc PathGuard only; never a filesystem/network isolation boundary |
| Landlock | `PARTIAL` / unavailable on current WSL | Probe/rule interfaces exist, production enforcement is not wired, current WSL2 does not expose the LSM |
| seccomp | `IMPLEMENTED` hardening layer | BPF/OCI profiles can be materialized for real backends; not a standalone sandbox and generation/application must be observed |
| service / MCP / LSP | `PARTIAL` | Transitional ServiceCell sanitizes environment and records optional leases, but directly spawns outside Broker/cgroup; readiness is not bound to listener/Cell identity |
| Legacy process closure | `PARTIAL` | `legacy-process` still has sync callers; service/workspace/remote execution exceptions and static-Gate coverage still need a narrower, unified authority |
| Secret lifecycle | `PARTIAL` | Secret contracts and sealed-file cleanup exist; file-descriptor semantics must not be claimed until true FD delivery is implemented and recovery is proven |
| Evidence / Completion | `IMPLEMENTED`, frontier incomplete | Receipt/Evidence criteria exist; dependency-frontier invalidation and all external modification detection remain incomplete |
| Approval / Cache / Replay | `PARTIAL` | Implementations and deterministic harnesses exist; immutable approval grants, provenance-complete cache identity and zero-live-side-effect strict runtime replay remain closure work |
| Typed Execution Graph | `IMPLEMENTED`, authority closure remains | `src/workflow/` provides typed contracts, compiler/validation, DAG scheduling, read/write serialization, result cache/replay, repair loops, dynamic compilation, interrupts, agent/worktree coordination and Harness-node execution; strict replay, immutable approval, cache provenance and authoritative resource/retry/liveness integration remain partial |
| GitHub Actions | `LOCAL_REAL_VERIFIED` | Self-hosted runner (`orcana-linux-runtime`); triggers limited to `push → main` + `workflow_dispatch`; 2026-08-12 CI and Linux Sandbox Lanes all green |
| Release | `RELEASED` at `0.8.30` | npm + tag + GitHub Release reconciled 2026-08-14; release smoke (isolated global install + CLI probe) passed |

## Linux development-host observation

Read-only observation on 2026-08-10:

- WSL2 kernel `6.6.87.2-microsoft-standard-WSL2`;
- Bubblewrap `0.9.0` installed;
- Podman `4.9.3` installed;
- cgroup v2 mounted;
- the current process reports seccomp filter mode;
- Landlock LSM is not available through `/sys/kernel/security/lsm`.

Installed binaries are prerequisites, not acceptance. See
[`linux-foundation/current-status.md`](linux-foundation/current-status.md) for
the enforcement/degradation matrix.

## Current validation boundary

Facts must remain separated:

1. Historical component tests passed at their recorded commits.
2. Real Bubblewrap, Rootless Podman and delegated-cgroup lanes were verified on
   the canonical WSL host on 2026-08-09.
3. GitHub-hosted lanes have not executed while the billing lock is active.
4. The current source snapshot is a green release candidate: `bun run typecheck`
   reports 0 errors (the former `AgentRunStopReason "paused"` drift was closed by
   the RC/IC line); full test gate green at v0.8.30.
5. Uncommitted work in another worktree is not part of this status snapshot.

## Next acceptance order

1. ✅ Restore the clean TypeScript baseline (IC00 fix) — closed.
2. Re-audit each Infrastructure Closure item against current code; do not
   replay stale plans over functionality that already exists.
3. ✅ Complete IC01 through IC06 (Gate A) — merged into main at v0.8.30
   (2026-08-14), including audit-fix batch 2 from the independent review.
4. Complete service/process/secret/TOCTOU closure before strong Runtime
   isolation claims (Gate B) — still open.
5. Complete evidence/approval/cache/replay/durable-state closure before
   publishing Runtime research claims (Gate C) — still open.
6. ✅ Reconcile npm/tag/GitHub Release from a clean, audited candidate with
   explicit owner authorization — done at v0.8.30 (2026-08-14).

## Claim rules

Do not turn any of the following into a shipped-capability claim:

- a mock-only or conditionally skipped test;
- a backend binary being installed;
- a zero-step GitHub Actions job;
- a configured cgroup limit without verified membership;
- Host Audit execution;
- a historical completion report superseded by a later audit;
- an unreleased `package.json` version;
- uncommitted source or executor self-report.
