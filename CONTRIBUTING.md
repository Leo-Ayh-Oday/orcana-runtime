# Contributing to Orcana Runtime

Thanks for your interest in contributing! This document outlines the process.

## Getting Started

```bash
# Clone and install
git clone https://github.com/Leo-Ayh-Oday/orcana-runtime.git
cd orcana-runtime
bun install
```

## Development Workflow

```bash
# Type check
bun run typecheck

# Run tests
bun run test

# Build
bun run build

# Run locally
bun run dev
```

## Project Structure

```
src/
├── agent/          # Loop controller, gates, task tracking
├── context/        # Context assembly, kernel files
├── evaluator/      # Confidence scoring, plan judging
├── hooks/          # Safety policy, permission enforcement
├── lsp/            # TypeScript LSP client
├── mcp/            # MCP bridge, config
├── memory/         # Hybrid memory (SQLite + compaction)
├── provider/       # DeepSeek/Anthropic API adapter
├── ripple/         # TypeScript-aware code intelligence
├── sandbox/        # Path guard, job object isolation
├── tools/          # Tool definitions (Bash, Read, Write, etc.)
├── tui/            # Terminal UI components
├── ui/             # Slash commands, startup screen
└── verification/   # Build/typecheck/lint collector
```

## Pull Request Process

1. Fork the repo and create a feature branch
2. Make your changes — keep them focused
3. Run `bun run typecheck && bun run test` — both must pass
4. Submit a PR with a clear description

Live/model-evaluation checks are available with `bun run test:live` when you have a configured provider key.

## Code Style

- TypeScript strict mode
- No `any` without a comment explaining why
- Prefer `interface` over `type` for object shapes
- Single-task modules over god-files
- Constraints inline in the loop, not in standalone modules

## Design Principles

> Every design decision answers one question: **"Does this make it harder for AI to write bad code?"**

- Infrastructure can be borrowed (provider/MCP/LSP/session), core architecture should not
- Single agent is the default mode, multi-agent is not
- "Discussion" and "execution" are strictly separated
- Constraints that work are hardwired into `loop.ts` — modules defined but not wired in have zero effect

## Reporting Bugs

Use GitHub Issues. Include:
- OS and Bun version (`bun --version`)
- Steps to reproduce
- Expected vs actual behavior
- Relevant error logs

## CI tiers (Harness 2.0, plan §18.1)

```text
每次提交：    typecheck + unit（bun run typecheck && bun run test）
每个 PR：     + function replay（bun run test:replay）+ run replay（bun run test:harness-replay）
发布候选：    + integration + live smoke（bun run eval:replay --report）
正式发布：    完整 live eval（bun run eval:live）+ RippleBench
```

Run replay suites live under `tests/harness-replay/` and are driven by the
scripted provider/tools executor in `evals/harness/`; the HR scenario matrix
(plan §18.6) is registered in `evals/harness/scenarios/`. Add new scenarios
as JSON cases there — every case asserts outcome/events/artifacts/workspace/
budget plus the always-on trace invariants.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
