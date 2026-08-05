# Security Policy

## Reporting a Vulnerability

**Do not open a public issue.** Send details to the project maintainer via GitHub Security Advisory or the repository's private vulnerability reporting channel.

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.7.x   | ✅ Yes    |
| 0.6.x   | ✅ Yes    |
| 0.5.x   | ✅ Critical fixes only |
| < 0.5.0 | ❌ No     |

## Security Model

Orcana Runtime is a local-first terminal agent. Key security boundaries:

### 1. API Key Management

API keys are stored in `~/.orcana/auth.json` (0600) or read from environment variables (`ORCANA_API_KEY` / legacy `DEEPSEEK_API_KEY` — mirrored at startup by `env-compat.ts`). **Never commit `.env` to version control.** The `.gitignore` excludes `.env` by default, but verify before pushing.

### 2. Sandbox

The sandbox uses defense-in-depth with platform-specific capabilities. Run `orcana doctor` to see the exact capability matrix of your platform.

**Windows** (strong):
- **Job Object** — kernel32 `CreateJobObject`, process tree kill-on-close, memory limits
- **Path Guard** — post-exec file change detection (audit, not real-time prevention)
- **Env Filtering** — whitelist-only environment variables
- **Timeout** — hard cap on shell execution time
- **Ripple Blocks** — shell commands writing to ripple-blocked files are denied

**macOS / Linux** (degraded):
- **Env Filtering** — whitelist-only environment variables ✅
- **Timeout** — hard cap on shell execution time ✅
- **Path Guard** — post-exec file change detection ✅
- **cgroups process isolation** (Linux, partial) — no Job Object equivalent on macOS ❌/🟡
- **No Network Isolation** — requires admin/root ❌
- **No Filesystem Interception during execution** — requires kernel driver ❌

> ⚠️ **macOS/Linux users**: the sandbox is degraded to env filtering + timeout + post-hoc path audit. For production use on these platforms, consider running Orcana inside a container or VM. The sandbox capability is printed at startup — always verify it matches your expectations.

**Honest limitations** (all platforms):
- Path Guard is post-hoc, not real-time
- No network isolation (requires admin)
- No filesystem interception during execution (requires kernel driver)

### 3. Permission System

Three-tier permission enforcement:
1. **Global Deny** — hard blocks (system paths, destructive commands, secret files)
2. **User Config** — `~/.orcana/permissions.json`
3. **Project Config** — `.orcana/permissions.json`

Configure via `settings.json` or the `permissions.json` files directly.

### 4. MCP Server Isolation

MCP servers run as child processes with their own environment. Server configs are stored in `~/.orcana/mcp.json`. **The default trust policy is `untrusted`** — MCP-discovered tools are read-only unless explicitly opted in, and a deny/allowlist applies per server.

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

We appreciate responsible disclosure. Critical security issues will be addressed within 48 hours.
