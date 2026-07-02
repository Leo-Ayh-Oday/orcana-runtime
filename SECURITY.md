# Security Policy

## Reporting a Vulnerability

**Do not open a public issue.** Send details to the project maintainer via GitHub Security Advisory or the repository's private vulnerability reporting channel.

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.3.x   | ✅ Yes    |
| 0.2.x   | ✅ Critical fixes only |
| < 0.2.0 | ❌ No     |

## Security Model

DeepSeek Orcana is a local-first terminal agent. Key security boundaries:

### 1. API Key Management

API keys are read from environment variables (`DEEPSEEK_API_KEY`) or `.env` files. **Never commit `.env` to version control.** The `.gitignore` excludes `.env` by default, but verify before pushing.

### 2. Sandbox

The sandbox uses defense-in-depth with platform-specific capabilities:

**Windows** (strong):
- **Job Object** — kernel32 `CreateJobObject`, process tree kill-on-close, memory limits
- **Path Guard** — post-exec file change detection (audit, not real-time prevention)
- **Env Filtering** — whitelist-only environment variables (42 vars)
- **Timeout** — hard cap on shell execution time
- **Ripple Blocks** — shell commands writing to ripple-blocked files are denied

**macOS / Linux** (degraded):
- **Env Filtering** — whitelist-only environment variables (42 vars) ✅
- **Timeout** — hard cap on shell execution time ✅
- **Path Guard** — post-exec file change detection ✅
- **No Job Object** — no kernel-level process containment ❌
- **No Network Isolation** — requires admin/root ❌
- **No Filesystem Interception during execution** — requires kernel driver ❌

> ⚠️ **macOS/Linux users**: the sandbox is degraded to env filtering + timeout + post-hoc path audit. For production use on these platforms, consider running Orcana inside a container or VM. The sandbox capability is printed at startup — always verify it matches your expectations.

**Honest limitations** (all platforms):
- Path Guard is post-hoc, not real-time
- No network isolation (requires admin)
- No filesystem interception during execution (requires kernel driver)

### 3. Permission System

Three-tier permission enforcement:
1. **Global Deny** — hard blocks (system paths, destructive commands)
2. **User Config** — `~/.deepseek-code/permissions.json`
3. **Project Config** — `.deepseek-code/permissions.json`

Configure via `settings.json` or the `permissions.json` files directly.

### 4. MCP Server Isolation

MCP servers run as child processes with their own environment. Server configs are stored in `~/.deepseek-code/mcp.json`.

**Risks**:
- **RCE via server command**: `mcp.json` `command` and `args` fields execute arbitrary binaries. Only add servers from trusted sources.
- **Tool shadowing**: MCP tools are registered as `mcp__<name>__<tool>`. A malicious server could register tools that shadow or interfere with built-in tools.
- **Resources/prompts not yet isolated** (🟡 partial): Currently only MCP tools are registered. Resources and prompts are planned for a future release and will have separate isolation rules.

**Recommendations**:
- Set `DEEPSEEK_MCP_ALLOWLIST=1` to only enable explicitly allowlisted MCP servers
- Review MCP server source code before adding them to `mcp.json`
- Keep MCP server binaries updated to their latest versions
- All MCP-discovered tools are `isReadonly: true` by default — write tools must be explicitly opted in

### 5. Network Safety

- `web_fetch` blocks all private IP ranges (RFC 1918, loopback, link-local)
- `web_search` goes through configurable provider endpoints only

### 6. Tool Risk Taxonomy 🟡 partial

Tools are classified into 5 risk levels:
- **Risk 0** — Read-only, auto-allow (read_file, grep, codegraph)
- **Risk 2** — File write, policy decision (write_file, edit_file)
- **Risk 4-5** — Git mutation, external effects — require user confirmation, no session allow

Risk 4-5 tools never receive session-level auto-approval.

### 7. Secret Redaction 🟡 partial

AgentRunTrace JSONL files redact key-like secrets (API keys, tokens). However, secret redaction is not yet unified across all output paths — checkpoint snapshots, evidence ledger entries, and tool output metadata may contain sensitive content. Avoid running Orcana on repositories with hardcoded secrets. Full chain redaction is scheduled for v1.0.

### 8. Ripple Obligation Gate

When the Ripple Engine detects that a code change has unresolved cascading effects on other files, writes are blocked until all affected callers are handled. This prevents partial refactors that leave the codebase in a broken state. Waivers require explicit reasons and are logged to the gate telemetry.

### 9. Runtime Self-Edit Gate

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
- Secret redaction failures (secrets appearing in trace/checkpoint/evidence output)

## Acknowledgments

We appreciate responsible disclosure. Critical security issues will be addressed within 48 hours.
