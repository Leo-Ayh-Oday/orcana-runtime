# Security Policy

## Reporting a Vulnerability

**Do not open a public issue.** Send details to the project maintainer via GitHub Security Advisory or the repository's private vulnerability reporting channel.

## Version Channels

This table is the authoritative version-truth for the repository; README and
status documents reference it instead of restating independent claims.

| Channel | Version | Security status |
|---|---:|---|
| npm / GitHub Latest Release | `0.8.30` | Current public baseline (2026-08-14; reconciled from `0.8.16` across the RC/LPIC/IC development line) |
| `origin/main` source | `0.8.30` | Released source — IC01..IC06 production-closure line merged (Gate A), audit-fix batch 2 applied |
| Active repair line | — | None unreleased at this time; future work opens new branches and follows the same gates |

The project does not currently promise long-term support for older minor
versions. Use the latest published package for ordinary installations and read
the release notes before upgrading. A version in `package.json` is not a
published or supported release until the tag, GitHub Release, npm package and
installation smoke test all exist.

## Security Model

Orcana Runtime is a local-first terminal agent. Key security boundaries:

### 1. API Key Management

API keys are stored in `~/.orcana/auth.json` (0600) or read from environment variables (`ORCANA_API_KEY` / legacy `DEEPSEEK_API_KEY` — mirrored at startup by `env-compat.ts`). **Never commit `.env` to version control.** The `.gitignore` excludes `.env` by default, but verify before pushing.

### 2. Sandbox

The sandbox is defense-in-depth and platform-specific. The authoritative
description is the [Linux sandbox current status and degradation matrix](./docs/linux-foundation/current-status.md).
`orcana doctor` and the startup capability banner are diagnostics, not proof
that a specific child process received a boundary. For an individual Linux
execution, use the selected backend and its `SandboxReceipt`.

**Linux short-process path**:

```text
ProcessExecutor → LinuxExecutionBroker → Host Audit | Bubblewrap | Rootless Podman
```

- **Host Audit (degraded)** — explicit environment, timeout/process-group
  handling and post-execution PathGuard. It does not prevent filesystem reads,
  filesystem writes or network access in real time.
- **Bubblewrap (namespace)** — can enforce mount, PID, IPC, UTS, user and
  network namespace boundaries, an empty Home and explicit workspace mounts.
  It is valid only when the real backend runs successfully.
- **Rootless Podman (container)** — can enforce a digest-approved image,
  explicit mounts, read-only container state, dropped capabilities and network
  isolation. A rootless container still shares the host kernel and is not a VM.
- **cgroup v2** — resource and process-tree claims require delegated cgroup
  authority, verified attachment and verified cleanup for that run.
- **seccomp** — applied as an additional hardening profile when supported; it
  is not a standalone sandbox.
- **Landlock** — currently probed/compiled only and not wired into production
  execution. It is unavailable on the current WSL2 development kernel.

`inspect` and `build` may explicitly degrade to Host Audit. Strict profiles
(`test`, `dependency`, `service`, `untrusted`, `evolution`) must reject an
unavailable required boundary. A zero-step CI job, conditional skip, mock test
or installed backend binary is not evidence of enforcement.

**Transitional process paths**:

- service/MCP/LSP use `ServiceCell` with sanitized environment and optional
  durable leases, but currently spawn outside the Linux Broker/cgroup path;
- `legacy-process` still has synchronous callers;
- therefore the repository cannot yet claim one production process-creation
  authority for every `src/` execution path.

**Windows**:

- environment filtering, timeout and post-execution PathGuard are available;
- Job Object code exists, but its production `track()` path is not wired, so
  process-tree control must be described as partial, not strong;
- no production filesystem or network sandbox is provided.

**macOS**:

- environment filtering, timeout and post-execution PathGuard are available;
- there is no integrated filesystem, network, cgroup or Job Object equivalent;
- use an external container/VM for untrusted execution.

**Honest limitations across the current source**:

- PathGuard is post-hoc detection, not real-time prevention;
- ordinary workspace file reads still need a unified secret-read policy and
  bounded reader; a secret stored inside the workspace must not be assumed
  protected merely because path traversal is blocked;
- strict filesystem TOCTOU protection is not yet closed with dirfd/openat2-like
  primitives;
- `proxy-allowlist` is not a complete production egress enforcement path;
- service readiness is not yet cryptographically/structurally bound to the
  listener owned by the Service Cell;
- cleanup, resource and isolation claims are invalid when the Receipt reports
  degradation or unverified cleanup.

### 3. Permission System

Three-tier permission enforcement:
1. **Global Deny** — hard blocks (system paths, destructive commands, secret files)
2. **User Config** — `~/.orcana/permissions.json`
3. **Project Config** — `.orcana/permissions.json`

Configure via `settings.json` or the `permissions.json` files directly.

### 4. MCP Server Isolation

MCP servers run as child processes with their own environment. Server configs are stored in `~/.orcana/mcp.json`. **The default trust policy is `untrusted`** — MCP-discovered tools are read-only unless explicitly opted in, and a deny/allowlist applies per server.

MCP process lifecycle currently uses the transitional `ServiceCell` path. Its
environment is sanitized and its lease can be recorded, but it does not yet
inherit Linux Broker/cgroup isolation. Treat the configured MCP executable as
trusted host code unless you place Orcana in an additional container or VM.

**Risks**:
- **RCE via server command**: `mcp.json` `command` and `args` fields execute arbitrary binaries. Only add servers from trusted sources.
- **Tool shadowing**: MCP tools are registered as `mcp__<name>__<tool>`. A malicious server could register tools that shadow or interfere with built-in tools.
- **Resources/prompts not yet isolated** (🟡 partial): Currently only MCP tools are registered. Resources and prompts are planned for a future release and will have separate isolation rules.

**Recommendations**:
- Review MCP server source code before adding them to `mcp.json`
- Keep MCP server binaries updated to their latest versions
- All MCP-discovered tools are `isReadonly: true` by default — write tools must be explicitly opted in

### 5. Network Safety

- `web_fetch` blocks all private IP ranges (RFC 1918, loopback, link-local) and is DNS-rebinding hardened
- `web_search` goes through configurable provider endpoints only

### 6. Tool Risk Taxonomy

Tools are classified into 5 risk levels:
- **Risk 0** — Read-only, auto-allow (read_file, grep, codegraph)
- **Risk 2** — File write, policy decision (write_file, edit_file)
- **Risk 4-5** — Git mutation, external effects — require user confirmation, no session allow

Risk 4-5 tools never receive session-level auto-approval. Every tool carries an immutable contract projection (`buildTool` → ToolContract) that drives freshness preflight and permission checks.

### 7. Secret Redaction

`redactForTrace` runs over trace JSONL, graph snapshots, result-cache files and checkpoints with a shared boundary: key-like secrets (API keys, tokens) are redacted, while token-metering fields are exempt via the `allowedKeyPatterns` whitelist (metadata stays usable for cost accounting). If you find a path where secrets leak into any persisted output, report it per the policy below.

### 8. Evidence Chain & Completion Gate (anti false-done)

The completion gate only trusts evidence that matches the CURRENT code state:
- **L1** — the latest result of a kind must be a pass;
- **L2** — the evidence must carry the current write-generation (any later write, managed or unmanaged, invalidates it);
- **L3** — the evidence must carry the authoritative commit-history binding (`PatchTransaction` chain);
- **Rollback-aware (SS-Next-2B, v0.7.4)** — rolling back a committed transaction advances both the write-generation and the history binding, so pre-rollback evidence can never satisfy the gate;
- **Command-to-file coverage (v0.7.6)** — a passing `run_targeted_verification` records the files it verified; the binding requirement is relaxed ONLY when every unmanaged (shell) write is covered, never otherwise.

### 9. Write Freshness (FreshnessGate)

Every managed file write is preflighted against the canonical tool contract: stale / partial / truncated / deleted / unread targets fail closed, and the write commits through `PatchTransaction` with an approved content snapshot — a file changed since it was read cannot be overwritten blind.

### 10. Ripple Obligation Gate

When the Ripple Engine detects that a code change has unresolved cascading effects on other files, writes are blocked until all affected callers are handled. This prevents partial refactors that leave the codebase in a broken state. Waivers require explicit reasons and are logged to the gate telemetry.

### 11. Runtime Self-Edit Gate

The agent is prevented from editing its own source files (`src/agent/`, `src/tools/`, `src/ui/`, etc.). If self-edits are detected:
1. Root project typecheck runs
2. If passes → agent is told to inform the user to restart
3. If fails → gate message instructs agent to revert and verify
4. Both fail at maxRounds → execution terminates

## What to Report

- API key leakage or insecure credential storage
- Sandbox bypass or path traversal
- Command injection in tool parameters
- Unsafe defaults that could cause data loss
- MCP server RCE vectors
- Secret redaction failures (secrets appearing in trace/checkpoint/evidence/cache output)
- Completion-gate bypass (false done: claiming completion without current-state evidence)

## Acknowledgments

We appreciate responsible disclosure. Reports are triaged as quickly as
maintainer capacity permits; the project does not currently publish a fixed
response-time SLA.
