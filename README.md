# DeepSeek Orcana

<p align="center"><strong>A Bun-based terminal coding agent with constraint-first architecture and DeepSeek-powered runtime.</strong></p>

<p align="center">
  <a href="./README.zh.md">中文</a> | English
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/deepseek-orcana"><img src="https://img.shields.io/npm/v/deepseek-orcana" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/deepseek-orcana"><img src="https://img.shields.io/npm/dw/deepseek-orcana" alt="npm weekly downloads"></a>
  <a href="https://github.com/Leo-Ayh-Oday/deepseek-orcana"><img src="https://img.shields.io/github/stars/Leo-Ayh-Oday/deepseek-orcana?style=flat" alt="GitHub stars"></a>
  <a href="https://github.com/Leo-Ayh-Oday/deepseek-orcana/issues"><img src="https://img.shields.io/github/issues/Leo-Ayh-Oday/deepseek-orcana" alt="GitHub issues"></a>
  <br>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT"></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/runtime-Bun-f9f1e4" alt="Runtime: Bun"></a>
  <a href="./CONTRIBUTING.md"><img src="https://img.shields.io/badge/contributions-welcome-brightgreen.svg" alt="Contributions welcome"></a>
</p>

---

DeepSeek Orcana is a single-agent terminal coding assistant. It reads, writes, and reasons about code — with a **constraint-first design** that makes it actively harder for AI to produce bad code.

Built with Bun + TypeScript + Ink (React TUI). Uses DeepSeek's Anthropic-compatible API as the default provider.

What is Orcana?
Orcana = Orca + Arcana + NA.

Orca symbolizes intelligence, strength, and deep-sea navigation. Arcana represents deep knowledge hidden beneath the surface. NA stands for Native Agent.

Orcana is a native coding agent that moves through the deep ocean of code like an orca, understands the hidden currents of complex systems, and turns engineering complexity into executable results.

## Highlights

**26 safety mechanisms per round.** Every agent loop iteration passes through a chain of independent gates. No single mechanism is trusted alone. Built on **DeepSeek V4's unique capabilities** — thinking tokens, Flash sub-processing, FIM, 1M context, prefix caching — that no other model provides in combination.

| Layer | Mechanism | Source |
|-------|-----------|--------|
| **Thinking** | Reasoning chain capture → persist, compact, recall across sessions (V4 proprietary) | `deepseek.ts:145-184` |
| **Flash Sub-Processing** | 6 independent Flash roles: Judge, Triage, Compaction, Recall, Distill, Plan-Judge | `flash-judge.ts`, `flash-triage.ts` |
| **FIM** | Fill-in-the-Middle editing via V4 `/beta/completions` endpoint | `provider/fim.ts` |
| **Budget** | 1M context window: WARN at 524K, BLOCK at 629K | `loop.ts:684` |
| **Cache** | Prefix auto-caching → frozen stable prefix computed once, hits every round | `deepseek.ts:42`, `loop.ts:733` |
| **Thinking Escalation** | Auto-upgrade to 32K max thinking on error cascades (≥3) or broad edits (≥5) | `router.ts:62-70` |
| **Entrance** | Flash Triage — one Flash call replaces 4 keyword classifiers | `agent/flash-triage.ts` |
| **Safety** | Gate overflow: 3 blocks → strategy switch, 5 → BLOCKED | `loop.ts:1562-1607` |
| **Learning** | Error tracker: 2 repeated failures → web search prompt, 4 → admit defeat | `loop.ts:96-123` |
| **Verification** | Flash Judge — independent model evaluates completion (SATISFIED/NOT_SATISFIED/IMPOSSIBLE) | `agent/flash-judge.ts` |
| **Testimony** | Testimony Ledger — tracks promises vs delivery, detects circular promises | `flash-judge.ts:196-249` |
| **Dependency** | Ripple Engine — TypeScript-aware cascade detection, blocks writes until resolved | `src/ripple/` |
| **Sandbox** | Job Object (kernel32) + PathGuard + env whitelist + timeout | `src/sandbox/` |
| **Memory** | CJK bigram+trigram tokenizer, thinking compaction, knowledge reconciliation | `src/memory/` |

→ See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full 26-gate loop anatomy, DeepSeek V4 mechanism deep-dives, and anti-loop engineering.

## Quick Start

### Requirements
- **Bun** ≥ 1.3
- **Node.js** ≥ 18 (for npm shim)
- **DeepSeek API key** ([Get one here](https://platform.deepseek.com))

### Install

```bash
npm install -g deepseek-orcana
```

The package exposes these commands: `orcana`, `deepseek-orcana`, `deepseek-code`, `deepseek`.

> `deepseek-code` is occupied on npm. The package name is `deepseek-orcana`; `orcana` is the primary command.

### Configure

```bash
# Set your API key
export DEEPSEEK_API_KEY="sk-your-key-here"

# Or copy the example env file
cp .env.example .env   # then edit .env with your key
```

See [`.env.example`](./.env.example) for all configuration options.

### Usage

```bash
orcana                              # Start TUI
orcana "explain this codebase"      # One-shot prompt
orcana --cli                        # Classic CLI mode
orcana list                         # List saved sessions
orcana last                         # Resume latest session
```

## Configuration

Orcana uses `~/.deepseek-code/settings.json` for persistent configuration. Copy [`settings.example.json`](./settings.example.json) as a starting point:

```bash
mkdir -p ~/.deepseek-code
cp settings.example.json ~/.deepseek-code/settings.json
```

### Config Files

| File | Location | Purpose |
|------|----------|---------|
| `settings.json` | `~/.deepseek-code/` | Provider, TUI, memory, sandbox, MCP |
| `mcp.json` | `~/.deepseek-code/` | MCP server definitions |
| `permissions.json` | `~/.deepseek-code/` or `<project>/.deepseek-code/` | Tool access rules |
| `.env` | Project root | API keys (never committed) |

## Architecture

```
CLI/TUI (Ink React)
    │
    ▼
Loop Controller
    ├─ Permission Gate ── blocks unsafe calls pre-execution
    ├─ Flash Judge ────── completeness evaluation per step
    ├─ State Machine ──── enforces phase transitions
    ├─ Ripple Engine ──── TypeScript code intelligence
    ├─ Sandbox ────────── path-guard + job-object isolation
    └─ Memory ─────────── SQLite hybrid + compaction cycles
```

Read [ARCHITECTURE.md](./ARCHITECTURE.md) for design decisions, constraints philosophy, and the "Do-Not-Repeat" knowledge base.

## Development

```bash
bun install
bun run typecheck    # tsc --noEmit
bun run test         # run stable test suite
bun run build        # tsc → dist/
```

## Built On

| Project | Role |
|---------|------|
| [OpenCode](https://github.com/anomalyco/opencode) (MIT) | Architecture foundation — MCP bridge, config system, TUI patterns, agent loop |
| [CodeGraph](https://github.com/colbymchenry/codegraph) (MIT) | MCP-powered code intelligence — symbol search, references, project structure |
| [Reasonix](https://github.com/esengine/reasonix) (MIT) | Cache-first context compaction — tiered thresholds, frozen prefix, microcompact |

See [ACKNOWLEDGMENTS.md](./ACKNOWLEDGMENTS.md) for details.

## License

MIT — see [LICENSE](./LICENSE).

## Contributing

PRs welcome! See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines.

## Security

See [SECURITY.md](./SECURITY.md) for vulnerability reporting.
