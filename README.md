# Orcana Runtime

<p align="center">
  <strong>Making coding-agent execution more controllable, and completion claims more verifiable.</strong><br>
  An open-source, model-agnostic Agent Runtime for long-horizon coding tasks.
</p>

<p align="center">
  State consistency · Controlled execution · Change impact · Evidence constraints · Interrupt recovery
</p>

<p align="center">
  <a href="https://github.com/Leo-Ayh-Oday/orcana-runtime/actions/workflows/ci.yml"><img src="https://github.com/Leo-Ayh-Oday/orcana-runtime/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/orcana-runtime"><img src="https://img.shields.io/npm/v/orcana-runtime" alt="npm"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/runtime-Node.js-339933" alt="Node.js"></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/dev-Bun-%23f9f1e4" alt="Bun"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/lang-TypeScript-%233178c6" alt="TypeScript"></a>
</p>

<p align="center">
  <a href="./README.zh.md">中文</a>
</p>

> [!IMPORTANT]
> Orcana Runtime is currently a runnable, research-grade Coding Agent Runtime — not a mature general-purpose agent platform. The project first converges the state, execution, verification and recovery semantics of a single agent, then gradually extends to Durable Execution, Typed Graph and constrained Multi-Agent.

## What is Orcana Runtime?

Orcana Runtime is an open-source, model-agnostic, constraint-first Coding Agent execution runtime.

It sits between the model and the real development environment, coordinating in one place:

- Model calls and context;
- Plans, tasks and run state;
- File reads, code edits and shell tools;
- Permissions, budgets, cancellation and human interrupts;
- Change impact analysis;
- Typecheck, tests, builds and other verification;
- Evidence, traces, snapshots and recovery;
- Final completion decisions.

Orcana does not treat a model's "it's done" as sufficient. It tries to make code changes, verification results and completion claims traceable against the current workspace state, and lets the runtime decide whether to accept a completion.

Orcana's long-term goal is to become the execution and governance layer connecting models, tools and real compute environments; Coding Agent is its first validation scenario.

## Quickstart

### Requirements

- Node.js 20+
- npm
- An API key for a supported provider
- Bun is only required for source development, testing and builds

### Install

```bash
npm install -g orcana-runtime
```

### Configure a provider

This quickstart uses DeepSeek as an example:

```bash
# Linux / macOS / Git Bash
export DEEPSEEK_API_KEY="sk-your-key-here"

# Windows PowerShell
$env:DEEPSEEK_API_KEY="sk-your-key-here"

# Windows CMD
set DEEPSEEK_API_KEY=sk-your-key-here
```

For advanced configuration — providers, models, budgets, permissions, sandbox and MCP — see:

- [ORCANA.md](./ORCANA.md)
- [settings.example.json](./settings.example.json)
- [.env.example](./.env.example)

### Run

```bash
# Interactive TUI
orcana

# One-shot task
orcana "fix the failing tests"

# List saved sessions
orcana list

# Environment diagnostics
orcana doctor
```

> [!NOTE]
> The legacy commands `deepseek-orcana`, `deepseek-code` and `deepseek` remain only as migration-period compatibility aliases and will be removed in later releases. New scripts and documentation should use `orcana` uniformly.

## Why Orcana?

Modern coding agents can already read repos, call tools, modify code and run tests — but once a task gets long, the runtime hits problems that prompt engineering alone cannot solve.

### 1. The model's context can go stale

After the agent reads a file, the workspace may have been changed by other tools, by the user, or by earlier rounds.

If the runtime does not track file state, the model may keep reasoning and writing against stale content.

### 2. Verification results can stop matching the current code

Tests once passing does not mean the workspace still passes after later modifications.

Orcana tries to associate verification results with write generations, transactions, artifacts and file state, so historical results are not mistaken for current evidence.

### 3. "The model says done" is not the same as done

A final answer may claim:

- All requirements are implemented;
- Tests pass;
- No callers were missed;
- The change is safe to ship.

The runtime needs to check whether those claims have corresponding plan state, verification records and unresolved obligations — rather than accepting a natural-language conclusion.

### 4. Long tasks must be governable

Long-running agents need explicit:

- Lifecycle;
- Budgets;
- Cancellation propagation;
- Human approval;
- Persistence;
- Traces;
- Recovery boundaries;
- Side-effect control.

Orcana is extracting these capabilities from inside the agent loop into explicit runtime semantics.

## Core runtime model

```
Human Intent
     │
     ▼
Agent Harness
     │
     ├── Lifecycle / Outcome
     ├── Budget / Cancellation
     ├── Interrupt / Resume
     ├── Persistence / Trace
     └── Run Scope / Sandbox
     │
     ▼
Agent Kernel
     │
     ├── Provider
     ├── Planning
     ├── Tool Execution
     ├── File State
     ├── Ripple Analysis
     ├── Verification
     └── Completion Gates
     │
     ▼
Files · Shell · Tests · Build · MCP · External Tools
```

> [!NOTE]
> Today the Harness is the unified control entry, while the Agent Kernel underneath still carries the main coding execution. Ownership of state, evidence, transactions and recovery semantics between the two is still converging.

### The ideal chain for a code change

```
Read workspace state
→ Check context freshness
→ Open a Patch Transaction
→ Apply controlled changes
→ Analyze downstream impact
→ Run available verification
→ Generate and bind Evidence
→ Check unresolved obligations
→ The runtime decides whether to accept completion
```

The goal of this chain is not to "prove the code is absolutely correct", but to reduce these inconsistencies:

- Changes based on stale state;
- Verification against an older version;
- Stale evidence reused after a rollback;
- Final claims exceeding what existing evidence can support.

## Core capabilities

### Agent Harness

The Harness provides an explicit control plane for one agent run:

- Typed lifecycle;
- Structured run outcome;
- Isolated run scope;
- Model, tool, token and wall-time budgets;
- Cancellation and timeouts;
- Event stream and JSONL trace;
- Snapshots and persistence;
- Plan approval and clarification interrupts;
- Cross-instance recovery after explicit wait points.

> [!NOTE]
> Recovery today is centered on explicit wait points and persisted state; it is not equivalent to arbitrary instruction-level breakpoints.

### File state and freshness

Orcana records file fingerprints and observed writes during the run, to detect:

- Files that changed after being read;
- Edits that may have been produced from stale state;
- Workspace changes caused by shell or external tools;
- New writes after verification.

### Patch Transaction

Code changes are gradually converging from "write the file directly" toward contextual transactions:

- Input state;
- Change scope;
- Transaction identity;
- Write generation;
- Rollback relationships;
- Associated evidence.

> [!NOTE]
> Transaction and rollback semantics are still being strengthened, with the goal of one shared source of truth for writes, verification, rollback and recovery.

### Ripple Engine

The Ripple Engine analyzes downstream impact for TypeScript changes, including:

- API surface changes;
- Symbol references;
- Callers;
- Usage patterns;
- Related tests;
- Obligations that must still be handled.

Its goal is not just "possibly affected" hints, but turning part of the change impact into runtime obligations that can block completion.

> [!NOTE]
> Ripple currently targets TypeScript primarily; false positives, missed detections and degraded paths remain possible.

### Evidence Ledger

The Evidence Ledger records verifiable execution results, for example:

- Typecheck;
- Tests;
- Builds;
- Commands and exit codes;
- Output summaries;
- Linked artifacts;
- Write generations;
- Transaction and file state;
- Fresh or stale status.

Evidence means "a check happened in some state" — it does not automatically mean "the code is completely correct".

### Completion Gates

The model can propose completion, but the runtime must check as a whole:

- Task and plan state;
- Unresolved Ripple obligations;
- Available verification;
- Whether evidence is still valid;
- Whether final claims have supporting basis;
- Whether budget, permission or failure boundaries were hit.

Unverifiable, failed and stale verification are different states and should not be flattened into "passed".

### Provider layer

Orcana Runtime is no longer defined by any single model vendor.

Models are integrated through a provider layer; the repo documents support and configuration paths for providers such as DeepSeek, Anthropic and OpenAI. Different providers may not have identical tool-call, context, streaming and error-recovery behavior — exact compatibility depends on the current version and test results.

### Context and memory

Orcana has multi-layer context management, including:

- Context budgets;
- Tool result trimming;
- History compaction;
- Context epochs;
- Local knowledge and memory storage;
- Context degradation and blocking strategies for long tasks.

> [!NOTE]
> These mechanisms bound context growth, but do not guarantee that arbitrarily long tasks run losslessly forever.

## Current project status

| Subsystem | Status | Notes |
|---|---|---|
| CLI / TUI | Runnable | Interactive and one-shot task entry points |
| Agent Kernel | Runnable, converging | Still carries the main coding execution |
| Agent Harness | Established, continuously improved | Lifecycle, outcome, budgets, cancellation, traces, persistence and interrupts wired in |
| Run Isolation | Core isolation implemented | Some authoritative state still needs migration from the Kernel ALS to the unified Run Scope |
| File State / Freshness | Implemented | Continuing to strengthen binding with transactions, shell writes and evidence |
| Patch Transaction | Partially implemented | Atomic commit, full rollback invalidation and Durable Steps still to be strengthened |
| Ripple Engine | Implemented | TypeScript is the primary validation scenario |
| Evidence Ledger | Implemented, integrity converging | Must ensure Harness and Kernel use one authoritative instance |
| Completion Gates | Implemented, entry convergence in progress | Goal is fail-closed, not pass-by-default when unverifiable |
| Interrupt / Resume | Explicit wait-point recovery implemented | Not arbitrary call-stack or instruction-level recovery |
| Trace / Snapshot | Implemented | Stable replay and Durable Execution semantics still being completed |
| Linux Sandbox | Partial execution | Not a complete security boundary — see below |
| Typed Execution Graph | Not implemented | Still centered on a single main execution node |
| Multi-Agent | Deferred | Constrained Subagent stage comes after single-agent runtime semantics stabilize |
| Recursive Self-Evolution | Research direction | Not to be treated as a capability stably delivered in v0.4 |

## What Orcana is not

To avoid writing research goals as shipped capabilities, Orcana today is not:

- A mature general-purpose agent platform;
- A system that can prove any code change absolutely correct;
- A complete Durable Execution Engine;
- A general Graph Runtime with arbitrary fan-out, fan-in and joins;
- A Multi-Agent Framework where multiple agents freely write to a shared workspace;
- A full replacement for Linux kernel-level security sandboxing;
- A finished recursive self-evolution system;
- A uniform interface with fully identical semantics across all model providers.

Orcana is best understood as:

> An open-source runtime researching state consistency, controlled execution, evidence, recovery and trustworthy completion semantics through real coding-agent scenarios.

## Linux-first development and sandbox status

Orcana's primary development and runtime environment is moving to Linux.

Current cross-platform sandbox capabilities include:

- Environment variable filtering;
- Command timeouts;
- Dangerous command and permission rules;
- Pre/post execution diff audits of the workspace;
- Process termination attempts on cancellation.

Windows additionally has Job Object process-tree control; Linux/macOS currently remain a degraded path and cannot claim full filesystem, network, process or resource isolation.

Until the Linux sandbox rework is complete:

- Do not run Orcana directly on host environments containing high-value credentials;
- Do not expose unrestricted Shell to untrusted repos or scripts;
- For high-risk scenarios, run inside an additional container or isolated environment;
- Sandbox degradation must be explicitly recorded in traces and evidence;
- When necessary isolation is missing, high-risk execution should fail closed rather than silently fall back to host execution.

Planned Linux sandbox directions include:

- A unified streaming and non-streaming shell execution pipeline;
- Process groups and full process-tree cleanup;
- Capability probing and `orcana doctor sandbox`;
- Read-only workspaces with declarative writable paths;
- Network off by default;
- cgroup v2 resource limits;
- A Bubblewrap low-latency isolation backend;
- A Rootless Podman strict execution backend;
- Later Landlock / seccomp native hardening layers.

See [SECURITY.md](./SECURITY.md) for the security model and known limitations.

## Config directory

The new default config directory:

```
~/.orcana/
```

Common files:

```
~/.orcana/settings.json
~/.orcana/mcp.json
~/.orcana/permissions.json
<project>/.orcana/
```

> [!NOTE]
> Old directories and old environment variables may remain compatible during the migration period, but new configuration should prefer the Orcana namespace.

Copy the config templates:

```bash
mkdir -p ~/.orcana
cp settings.example.json ~/.orcana/settings.json
```

## Developing from source

### Clone and install

```bash
git clone https://github.com/Leo-Ayh-Oday/orcana-runtime.git
cd orcana-runtime
bun install
```

### Run during development

```bash
bun run dev
```

### Typecheck

```bash
bun run typecheck
```

### Tests

```bash
# Default test gate
bun test

# Repo-defined test script
bun run test

# Integration tests
bun run test:integration

# Full test suite
bun run test:all
```

### Build and publish check

```bash
bun run build
npm pack --dry-run
```

> [!NOTE]
> Release contents, CI and test counts change as the repo evolves. The README does not make a permanent promise of a static "all green" or a fixed test count — check the current CI and the corresponding commit for actual results.

## Docs

| Doc | Contents |
|---|---|
| [ORCANA.md](./ORCANA.md) | Usage, configuration and project entry point |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Runtime, agent loop, gates and subsystem architecture |
| [SECURITY.md](./SECURITY.md) | Permissions, credentials, sandbox and security boundaries |
| [CHANGELOG.md](./CHANGELOG.md) | Version history |
| [CONTRIBUTING.zh.md](./CONTRIBUTING.zh.md) | 中文贡献指南 |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | English contribution guide |
| [ACKNOWLEDGMENTS.md](./ACKNOWLEDGMENTS.md) | Credits and reference projects |

## Roadmap

Orcana follows the path "converge execution semantics first, then add execution units."

### Now: Runtime Integrity

Focus areas:

- One shared source of truth between Harness and Kernel;
- A unified Evidence Ledger;
- Distinguishing passed / failed / unavailable / stale;
- Rollback correctly invalidating old evidence;
- Unified lifecycle, cancellation and cleanup;
- Baseline Linux shell and sandbox consistency;
- Runtime critical paths in stable CI.

### Next: Durable Execution

Focus areas:

- Stable step IDs;
- Side-effect declarations;
- Idempotency keys;
- Prepared / Executing / Committed states;
- Crash injection;
- Avoiding duplicate side-effect execution on recovery;
- Trace replay and a runtime evaluation lab.

### Later: Typed Execution Graph

Focus areas:

- Typed nodes and edges;
- A ready queue;
- Conditional routing;
- Explicit joins;
- Bounded loops;
- Node-level checkpoints;
- Read-only parallelism;
- A single write-commit channel.

### Further: Bounded Multi-Agent

Phase one considers only:

- A lead agent;
- Read-only or proposal-type subagents;
- Artifact communication;
- Independent contexts and independent budgets;
- Limited delegation depth;
- One global completion authority;
- One write channel.

The pattern of multiple peer agents freely writing to one workspace is not a priority.

### Long-term research directions

- Agent operating layer;
- Model-agnostic execution governance;
- Long-running and continuous tasks;
- Verifiable, controlled self-modification;
- Recursive evolution with regression gates;
- Multi-workspace and distributed execution.

These are research directions, not capabilities of the current version.

## Research and claim principles

Orcana is implementation-driven research:

```
Propose an architecture hypothesis
→ Implement
→ Write tests and failure injection
→ Inspect real runtime semantics
→ Publish limitations
→ Revise the design
```

The project documentation follows these principles:

- Do not write planned architectures as shipped capabilities;
- Do not write one passing test as a general proof of correctness;
- Do not equate model self-assessment with independent verification;
- Do not describe the degraded sandbox as a complete security boundary;
- Do not describe node dependency plans as a complete Graph Runtime;
- Do not describe multiple role prompts as mature Multi-Agent;
- Performance, quality and reliability conclusions come with reproducible evaluation conditions.

You are welcome to challenge Orcana's design directly from the source code, tests, traces and failure cases.

## Contributing

Orcana Runtime especially welcomes contributions in these areas:

- Agent Harness and runtime state models;
- Linux sandbox, process trees and cgroups;
- Durable Execution and idempotent recovery;
- TypeScript change impact analysis;
- Evidence and verification state modeling;
- Replay, traces and evaluation;
- Provider compatibility tests;
- TUI and developer experience;
- Documentation, examples and failure reproductions.

Please read before contributing:

- [CONTRIBUTING.md](./CONTRIBUTING.md)
- [SECURITY.md](./SECURITY.md)
- [ARCHITECTURE.md](./ARCHITECTURE.md)

When filing an issue, please include:

- Orcana version or commit SHA;
- OS and runtime version;
- Provider and model;
- Minimal reproduction steps;
- Expected vs actual behavior;
- Relevant traces, logs or test results;
- Whether it involves workspace writes, credentials or external side effects.

## Project positioning summary

> Orcana Runtime is a model-agnostic, trustworthy agent runtime for long-horizon autonomous tasks, letting AI execute, verify, recover and complete work in real codebases and compute environments under tighter control.

More strictly, Orcana is currently researching:

> How the runtime confirms that the state operations are based on is still valid, that verification results still match the current workspace, and that models are constrained from making completion claims beyond what existing evidence supports.

This remains an open research question that must keep being validated through real runs, failure injection and reproducible evaluation — not a final answer that has been proven.

## License

Orcana Runtime is open-sourced under the [MIT License](./LICENSE).
