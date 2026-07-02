# DeepSeek Orcana

<p align="center">
  <strong>The coding agent that refuses to ship broken code.</strong><br>
  Constraint-first runtime — every write checked for downstream impact, every completion backed by evidence.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/deepseek-orcana"><img src="https://img.shields.io/npm/v/deepseek-orcana" alt="npm"></a>
  <a href="https://github.com/Leo-Ayh-Oday/deepseek-orcana"><img src="https://img.shields.io/github/stars/Leo-Ayh-Oday/deepseek-orcana?style=flat" alt="stars"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="license"></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/runtime-Bun-%23f9f1e4" alt="Bun"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/lang-TypeScript-%233178c6" alt="TypeScript"></a>
</p>

<p align="center">
  <a href="./README.zh.md">中文</a>
</p>

---

## Install

```bash
npm install -g deepseek-orcana
```

Set your key:

```bash
# macOS / Linux / Git Bash
export DEEPSEEK_API_KEY="sk-your-key-here"

# Windows PowerShell
$env:DEEPSEEK_API_KEY="sk-your-key-here"

# Windows CMD
set DEEPSEEK_API_KEY=sk-your-key-here
```

```bash
orcana                          # interactive TUI
orcana "fix the failing test"   # one-shot task
orcana list                     # saved sessions
```

Also available as `deepseek-orcana`, `deepseek-code`, `deepseek`.

---

## How it works

Orcana doesn't treat every task the same. A simple question and a complex refactor go through different paths:

```
You: "what does this file do?"
  ──► read file ──► answer
       ↑
    Permission Gate (risk 0 — auto-allowed)
    That's ~3 gates. No writes, no ripple, no evidence needed.

You: "add a logout button"
  ──► read files ──► trace callers ──► write code ──► typecheck ──► tests ──► verify ──► done
       ↑               ↑                ↑              ↑             ↑           ↑
    Permission      Ripple           Sandbox       Evidence       Flash      Completion
    Gate            Engine           Guard         Ledger         Judge      Gate
    That's ~15 gates. Every write checked; completion requires proof.
```

**The gate system scales to the risk.** Read-only tasks breeze through. Code changes get progressively more scrutiny — write gates, ripple analysis, evidence collection, independent verification. Stuck-in-a-loop? The overflow gate hard-stops after 5 repeated blocks and asks for human help.

This is why we say "constraint-first." Not because every task is slow, but because the runtime knows the difference.

→ [ARCHITECTURE.md](./ARCHITECTURE.md) for the full 28-gate loop anatomy.

---

## Key capabilities

**Ripple Engine** — Before writing to any file, Orcana asks: *who calls this?* Traces TypeScript dependencies through 7 layers, from API surface diff to semantic references, and blocks the write until every affected caller is handled. 212 tests. → [docs/ripple-engine.md](./docs/ripple-engine.md)

**Evidence Ledger** — Completion isn't a claim, it's a record. Typecheck passed? Tests green? Build succeeded? The ledger tracks what was verified and cross-checks it against the final output. If the agent says "all tests pass" but the ledger shows none ran, the Truthfulness Gate blocks.

**Flash Judge** — An independent, cheaper model re-evaluates completion claims. If the main model confidently declares victory but the Judge says NOT_SATISFIED, the task continues. Circuit-breaks after 3 evaluations — won't silently accept unverified completion.

> **Sandbox note**: macOS/Linux runs in degraded mode (env filtering + timeout + post-hoc audit). Only Windows gets kernel-level Job Object isolation. See [SECURITY.md](./SECURITY.md) for platform-by-platform breakdown.

---

## Current limitations

Real trade-offs, not hidden:

- **Thinking Compaction** triggers once per session (at 40% context). On very long tasks, context can still grow to the 60% Budget Gate block with no second pass.
- **Flash Judge** stops after 3 evaluations per task. If still NOT_SATISFIED, the session blocks — it won't silently accept a bad result.
- **Sandbox on macOS/Linux** is env filtering + timeout only. No kernel-level containment. For production use, run inside a container.
- **Dual config**: `settings.json` `loop.maxSteps` takes priority over `DEEPSEEK_MAX_ROUNDS`. Both set → JSON wins.

---

## Project status

**v0.3.x** — single-agent runtime foundation complete. Some capabilities partial, none fake.

| Status | Meaning |
|--------|---------|
| 🟢 Stable | Wired into main loop, reliable for daily tasks |
| 🟡 Partial | Implemented but has gaps — platform limits, UX rough edges, narrow coverage |
| 🔵 Planned | On the roadmap |

→ [docs/v1.0-roadmap.md](./docs/v1.0-roadmap.md) — 10-Phase plan to v1.0.

---

## Uninstall

```bash
npm uninstall -g deepseek-orcana
```

---

## Docs

| Doc | What you'll learn |
|-----|-------------------|
| [docs/design-philosophy.md](./docs/design-philosophy.md) | Why constraint-first — from Tool Loop to Evidence Ledger |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Complete 28-gate loop, DeepSeek V4 mechanisms |
| [docs/v1.0-roadmap.md](./docs/v1.0-roadmap.md) | 10-Phase roadmap, P0/P1/P2 priorities |
| [docs/ripple-engine.md](./docs/ripple-engine.md) | 7-layer change-impact analysis deep-dive |
| [docs/gate-scenario-matrix.md](./docs/gate-scenario-matrix.md) | Every gate, every scenario, verified behavior |
| [docs/skill-template/](./docs/skill-template/) | Gold Standard Skill Template — for humans, AI, and Orcana Runtime |
| [SECURITY.md](./SECURITY.md) | Sandbox capabilities, vulnerability reporting |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | Setup, conventions, PR process |

## Development

```bash
bun install
bun run typecheck    # tsc --noEmit
bun test             # run test suite
bun run build        # tsc → dist/
```

## Built on

| Project | Role |
|---------|------|
| [OpenCode](https://github.com/anomalyco/opencode) (MIT) | Architecture — MCP bridge, config system, TUI patterns, agent loop |
| [CodeGraph](https://github.com/colbymchenry/codegraph) (MIT) | MCP code intelligence — symbol search, reference resolution |
| [Reasonix](https://github.com/esengine/reasonix) (MIT) | Cache-first context compaction — tiered thresholds, frozen stable prefix |

[ACKNOWLEDGMENTS.md](./ACKNOWLEDGMENTS.md) · [LICENSE](./LICENSE) (MIT)
