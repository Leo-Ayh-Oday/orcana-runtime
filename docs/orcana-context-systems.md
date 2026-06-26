# Orcana Context Systems

This document covers the context memory, context map, and evolution protocol modules added
after the replay harness baseline. The intent is to make long-running work reproducible before
wiring every policy into the live agent loop.

## Scope

The implementation is protocol-level:

- It defines typed contracts, validation, persistence shapes, and deterministic replay cases.
- It avoids live network calls and provider calls in the core modules.
- It exposes explicit evidence fields that can be attached to `TaskPacket`.
- It does not yet claim that every protocol is enforced inside `agentLoop()`.

Runtime enforcement belongs in a follow-up integration PR. Keeping these modules pure first
makes failures easier to replay and keeps the loop change small.

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

The output is a `ContextMap` with readiness status. A task packet can reference that map through
`contextMapId` and `requiredContextEvidence`, which gives downstream gates a structured way to
check that the agent read the right context before editing.

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
bun test tests/evolution_os.test.ts
bun test tests/replay_harness.test.ts
bun run test
bun run typecheck
bun run build
```

At the time this document was added, all of the above commands passed locally.
