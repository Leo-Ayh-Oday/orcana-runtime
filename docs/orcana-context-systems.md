# Orcana Context Systems

This document covers the context memory, context map, and evolution protocol modules added
after the replay harness baseline. The intent is to make long-running work reproducible while
incrementally wiring the contracts into the live agent loop.

## Scope

The implementation is split by maturity:

- It defines typed contracts, validation, persistence shapes, and deterministic replay cases.
- It avoids live network calls and provider calls in the core modules.
- It exposes explicit evidence fields that can be attached to `TaskPacket`.
- `ContextMap` is now wired into `agentLoop()` for automatic context acquisition.
- `Context Memory OS` and `Evolution OS` remain protocol-level surfaces.

Keeping the core modules pure still matters: `agentLoop()` consumes their outputs, but the
map/memory/evolution modules stay deterministic and replayable.

## Context Memory OS

Source: `src/memory/context-memory-os.ts`

The memory system builds a four-layer context pack:

| Layer | Role |
|-------|------|
| Stable prefix | Repo instructions and project facts that should stay cache-friendly |
| Plan state | Current plan, active step, and verification commitments |
| Task epoch | Current task-local context and recent evidence |
| Volatile tail | Fresh observations and short-lived notes |

Capsules carry status (`active`, `stale`, `superseded`, `archived`) and evidence metadata.
Retrieval filters out stale or superseded records by default, scores relevance deterministically,
and returns explicit reasons for selected files. Update proposals reject short-term operational
notes and sensitive content unless there is durable evidence.

## Context Map Pipeline

Source: `src/context/context-map.ts`

The context map combines three inputs:

- Project constitution files such as `.orcana/memory/MEMORY.md`, `ORCANA.md`, `AGENTS.md`,
  `CLAUDE.md`, `README.md`, and `ARCHITECTURE.md`.
- Repository structure signals such as source roots, test roots, config files, lockfiles,
  entrypoints, package manager, and module hints.
- Targeted locating through text search plus TypeScript AST symbol extraction.

The output is a `ContextMap` with readiness status. `agentLoop()` builds one automatically for
long, high-risk, or explicit-file coding work (`DEEPSEEK_CONTEXT_MAP=off|auto|always`; default
`auto`). The formatted map is injected into the stable provider context so the first coding round
has repository, locate, and verification evidence before edits.

Task packets reference that map through `contextMapId` and `requiredContextEvidence`. `MasterPlan`
now creates packet-backed nodes for initial plans, dynamic `addNode()` calls, and `revisePlan()`
replacement nodes, then serializes packet scope, verification, context evidence, and validation.

For high-risk tasks, incomplete readiness activates the `ContextReadiness` gate. Pre-round tool
disclosure hides write tools, and the tool execution policy also blocks non-readonly tools until
more locate/read/search context has been acquired.

## Evolution OS

Source: `src/evolution/evolution-os.ts`

The evolution module models controlled self-improvement as data:

1. Detect a capability gap from failures, missing evidence, or repeated validation issues.
2. Generate a knowledge capsule from memory, repository evidence, or supplied web findings.
3. Propose an upgrade with expected impact, risk, affected files, and validation commands.
4. Evaluate policy before implementation.
5. Create a sandbox plan and failure replay case when the change is allowed.

Policy currently blocks high-risk self patches unless approval is present, and rejects proposals
that weaken existing gates or replay coverage.

## Replay Coverage

The replay harness now includes:

- `context_memory` cases in `tests/replay/context-memory/`
- `context_map` cases in `tests/replay/context-map/`

These join the existing protocol domains so the contract layer can be exercised without starting
the full TUI or making provider calls.

## Verification

The current gate for this PR is:

```bash
bun test tests/context_memory_os.test.ts
bun test tests/context_map.test.ts
bun test tests/context_map_runtime.test.ts
bun test tests/evolution_os.test.ts
bun test tests/replay_harness.test.ts
bun test tests/tool_policy.test.ts
bun test tests/pre_round_context_readiness.test.ts
bun test tests/task_packet.test.ts
bun run test
bun run typecheck
bun run build
```

At the time the protocol layer was added, the original command set passed locally. Runtime
integration PRs should rerun the focused tests above plus `bun run typecheck`, `bun run test`,
and `bun run build` before landing.
