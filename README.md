# DeepSeek Orcana

<p align="center">
  <strong>The coding agent that refuses to ship broken code.</strong><br>
  28 safety gates across the execution lifecycle. 7-layer change-impact analysis. Evidence-backed completion.
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

## What is Orcana?

Orcana is a **constraint-first terminal coding agent**. It reads, writes, and reasons about code — but unlike a generic LLM-with-shell, every action passes through independent safety gates, every edit is checked for downstream impact, and completion requires verifiable evidence.

```
You: "add a logout button"
Orcana: reads files → traces callers → writes code → runs typecheck → runs tests → Flash Judge verifies → done
         ↑                ↑              ↑            ↑              ↑              ↑
      Permission       Ripple        Sandbox      Evidence        Flash        Completion
       Gate            Engine        Guard        Ledger         Judge          Gate
```

> **Orcana** = Orca + Arcana + NA (Native Agent). Moves through deep code like an orca — understands hidden currents, turns complexity into results.

## Install

```bash
npm install -g deepseek-orcana
```

Set your API key:

**macOS / Linux / Git Bash**
```bash
export DEEPSEEK_API_KEY="sk-your-key-here"
```

**Windows PowerShell**
```powershell
$env:DEEPSEEK_API_KEY="sk-your-key-here"
```

**Windows CMD**
```cmd
set DEEPSEEK_API_KEY=sk-your-key-here
```

Then start:

```bash
orcana
```

Also available as `deepseek-orcana`, `deepseek-code`, `deepseek`.

```bash
orcana "refactor the auth module"     # One-shot task
orcana --cli                          # Classic CLI mode
orcana list                           # Saved sessions
orcana last                           # Resume latest
```

## Why Orcana

Most coding agents have 3–5 guardrails. Orcana has **28 distinct safety mechanisms** — distributed across the execution lifecycle. No single mechanism is trusted alone.

| When | Mechanism | What it prevents |
|------|-----------|-----------------|
| **Before the model speaks** | Context Budget Gate | Silent context overflow (WARN 524K / BLOCK 629K) |
| | Flash Triage | Wrong task classification (1 call replaces 4 keyword classifiers) |
| | Thinking Escalation | Stubborn retries — auto-upgrades to 32K max thinking on ≥3 errors |
| **Before tools execute** | Permission Gate | Unauthorized tool use (category-based + project-level control) |
| | Ripple Block Gate | Broken callers — blocks writes until every affected call site is handled |
| | ContextReadiness Gate | Editing before reading — blocks writes if project context isn't acquired yet |
| | Rate Limiter | Tool spam — per-category caps per round (shell=5, file=10, network=3) |
| | Mode Contract | Role violations — planner can't write code, reviewer can't execute |
| **After tools execute** | Error Tracker | Blind retries — 2 repeated failures → forced web search, 4 → admit defeat |
| | Parallel Readonly Execution | Slow info-gathering — all readonly calls in a round run concurrently via `Promise.all` |
| | Shell Side-Effect Guard | Dangerous commands — 18 patterns detect recursive rm, force push, system mutation |
| | Write Guard | Un-read file edits — strict mode blocks writes to files never read |
| | Journal Veto | Iron-law violations — meta-agent veto on write operations |
| **Before claiming "done"** | Ripple Exit Gate | Unresolved cascade — won't finish with pending ripple obligations |
| | Task Tracker Gate | Incomplete work — blocks completion when checklist items remain |
| | Quality Gate | Low-confidence delivery — blocks when confidence < threshold |
| | Flash Judge | False completion — independent Flash model verifies claims |
| | Evidence Gate | Unverified claims — `canClaimDone()` returns false without typecheck/test/build proof |
| | Truthfulness Gate | Lying about verification — cross-checks final text claims against Evidence Ledger |
| **Emergency** | Gate Overflow | Infinite loops — 3 blocks → strategy switch prompt, 5 → hard BLOCKED |

Not all 28 gates fire every round — they're distributed by lifecycle: ~7 pre-round, ~7 during tool execution, ~6 at completion, ~7 periodic/historical. Each gate activates only when its phase is reached.

→ [ARCHITECTURE.md](./ARCHITECTURE.md) for the complete 28-gate loop anatomy and DeepSeek V4 mechanism deep-dives.

> **Sandbox note**: On macOS/Linux, the sandbox runs in degraded mode — PathGuard is post-execution audit (detects and records), not real-time prevention. Only Windows gets kernel-level Job Object isolation. The README table describes the *design intent*; see [SECURITY.md](./SECURITY.md) for platform-by-platform capabilities.

## Known Limitations

Real trade-offs we're tracking, not hiding:

- **Thinking Compaction** is one-shot per session (triggers once at 40% context). On very long tasks, context can still grow to the 60% Budget Gate block with no second compaction pass.
- **Flash Judge** circuit-breaks after 3 evaluations per task. If still NOT_SATISFIED after 3, the session blocks — it won't silently accept unverified completion.
- **Dual config**: `settings.json` `loop.maxSteps` takes priority over `DEEPSEEK_MAX_ROUNDS` env var. If both are set, the JSON value wins.

## Ripple Engine 2.0

**Before any file write, Orcana asks: "who calls this?"** The Ripple Engine traces TypeScript dependencies through 7 layers — from API surface diff to semantic reference resolution to obligation gate — and blocks the write until every affected caller is updated.

```
API change ──► L1 Diff (8 change kinds) ──► L2 TypeChecker.findReferences ──► L3 Classify (14 usage kinds)
                                                          │
                                                          ▼
                                              L4 Test Discovery ──► L5 Obligation Gate
                                                          │
                                              L7 AstGrep (enrichment)
                                                          │
                                                          ▼
                                                   allow / warn / block
```

212 tests. 8.5/10 self-assessed. → [docs/ripple-engine.md](docs/ripple-engine.md)

## Project Status

**v0.3.x** — single-agent runtime foundation is complete. Some capabilities are partial, none are fake.

| Status | Meaning |
|--------|---------|
| 🟢 Stable | Wired into main loop, reliable for daily tasks |
| 🟡 Partial | Implemented but has gaps — platform limitations, UX rough edges, or narrow coverage |
| 🔵 Planned | On the roadmap, not yet built |

See [docs/v1.0-roadmap.md](./docs/v1.0-roadmap.md) for the 10-Phase plan to v1.0.

## Document Map

**New here?** Start with Design Philosophy, then Architecture.

| Doc | What you'll learn |
|-----|-------------------|
| [docs/design-philosophy.md](./docs/design-philosophy.md) | Why constraint-first — from Tool Loop to Evidence Ledger |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Complete 28-gate loop, DeepSeek V4 mechanisms, anti-loop patterns |
| [docs/v1.0-roadmap.md](./docs/v1.0-roadmap.md) | 10-Phase roadmap to v1.0, P0/P1/P2 priorities |
| [docs/ripple-engine.md](./docs/ripple-engine.md) | 7-layer change-impact analysis deep-dive |
| [docs/gate-scenario-matrix.md](./docs/gate-scenario-matrix.md) | Every gate, every scenario, verified behavior |
| [SECURITY.md](./SECURITY.md) | Sandbox capabilities, vulnerability reporting |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | Setup, conventions, PR process |

## Development

```bash
bun install
bun run typecheck    # tsc --noEmit
bun test             # run test suite
bun run build        # tsc → dist/
```

## Built On

| Project | Role |
|---------|------|
| [OpenCode](https://github.com/anomalyco/opencode) (MIT) | Architecture foundation — MCP bridge, config system, TUI patterns, agent loop |
| [CodeGraph](https://github.com/colbymchenry/codegraph) (MIT) | MCP-powered code intelligence — symbol search, reference resolution |
| [Reasonix](https://github.com/esengine/reasonix) (MIT) | Cache-first context compaction — tiered thresholds, frozen stable prefix |

[ACKNOWLEDGMENTS.md](./ACKNOWLEDGMENTS.md) · [LICENSE](./LICENSE) (MIT)
