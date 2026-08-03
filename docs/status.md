# Orcana Strong Single v1.0 Status Matrix

Updated: 2026-08-03

Snapshot: `codex/transaction-evidence-binding` → v0.4.0 (ALK 减重 L0–L7 + Harness 2.0 H0–H8 landed). Published npm baseline was `0.3.4`.

This matrix maps the Strong Single v1.0 seed plan to the current codebase. It is intentionally conservative: a module is `Done` only when the code, tests, and runtime wiring are present.

## Summary

| Area | Status | Current evidence | Gap |
|------|--------|------------------|-----|
| Runtime bootstrap | Done | `src/runtime/bootstrap.ts`, shared CLI/TUI runtime assembly | Keep future UI entrypoints on this path |
| Runtime event boundary | Partial | `src/runtime/event-bus.ts`, `src/runtime/controller.ts`, `src/runtime/control-plane.ts`, `tests/runtime_event_bus.test.ts` | Slash parsing/resolution is shared; command execution still needs full CLI/TUI runtime controller wiring |
| File state / Freshness | Done | `src/file-state/*`, `src/tools/registry.ts`, managed file-tool transactions, `tests/file_state.test.ts`, `tests/file_tools_file_state.test.ts` | Keep future write tools on the contract preflight plus approved-snapshot transaction boundary; `rollback_transaction` remains a dedicated recovery policy |
| HookSystem 2.0 | Done | `src/hooks/index.ts` accumulates warnings, chains replacements, fail-closes handler exceptions, and supports lifecycle events | Keep future hook events on this shared implementation |
| Default hooks | Done | `src/hooks/defaults.ts` creates safety, side-effect, write-observation, and journal hooks; the public factory keeps its strict default, while runtime bootstrap explicitly selects warn mode because FreshnessGate owns enforcement | Keep noncanonical callers on strict unless they install the contract gate |
| TaskPacket / MasterPlan | Partial | `src/agent/task-packet.ts`, `src/agent/master-plan.ts`, `src/agent/plan-validator.ts`, `tests/task_packet.test.ts` | Zod adapter is intentionally deferred while the project has no Zod dependency; keep future packet changes on the validated schema path |
| ModeContract | Done | `src/agent/mode-contract.ts`, `src/agent/runtime-context.ts`, `src/agent/loop.ts`, `tests/mode_contract.test.ts`, `tests/runtime_agent_context.test.ts` | Active mode and adjacent runtime state are isolated per concurrent agent run; keep future mode changes routed through shared transition context |
| Completion / Evidence | Partial | `src/agent/completion-orchestrator.ts`, `src/agent/evidence-ledger.ts`, `src/agent/evidence-staleness.test.ts`, `tests/completion_orchestrator.test.ts` | Latest-result, write-generation freshness, fixed built-in verifier identity, unmanaged-write invalidation, and authoritative commit-history identity are enforced; command-to-file coverage, rollback-aware invalidation, and finer-grained invalidation remain incomplete |
| PatchTransaction / Rewind | Partial | `src/agent/patch-transaction.ts`, `src/tools/transaction.ts`, `src/agent/rewind.ts`, related tests | Approved base hashes, new-file absence, non-file targets, symlink parents, partial-conflict rollback, and committed transaction evidence snapshots are guarded; `rollback_transaction` can still leave pre-rollback evidence eligible because it advances neither write generation nor history fingerprint, so rollback-aware invalidation is a hard SS-Next-2B gap |
| Tool contract / Risk / Permission | Partial | `src/tools/tool-contract.ts`, `src/tools/builtins.ts`, `src/agent/tool-risk.ts`, `src/agent/permission.ts`, `tests/tool_contract.test.ts`, `tests/tool_policy.test.ts` | The immutable ToolDef-derived projection now drives freshness preflight; broader ToolPolicy migration and permission UX remain incomplete |
| Provider / ModelRouter | Partial | `src/provider/router.ts`, `src/provider/capabilities.ts`, `src/provider/stream-lifecycle.ts`, runtime model config and provider tests | Built-in metadata now derives from the config catalog and provider aborts close safely; complete purpose/cost trace coverage is still pending |
| Replay harness | Partial | `src/agent/replay-harness.ts`, `tests/replay_harness.test.ts`, 70 deterministic replay fixtures, CI core gate | E2E replay and mini benchmark are not complete |
| TUI / CLI operator UX | Partial | TUI tests, command dispatcher, command shelf, composer, runtime panels | Plan approval and evidence report UX still need completion checks |
| Observability | Partial | `AgentRunTrace`, gate telemetry, runtime panels | RunTrace event taxonomy is not fully standardized |
| Docs / release | Planned | `README.md`, `ARCHITECTURE.md`, `SECURITY.md` exist | v1.0 architecture/status/security docs need synchronization |

## Strong Single PR Mapping

| PR | Status | Notes |
|----|--------|-------|
| PR-0.1 Status Matrix | Done | This document is the baseline status matrix. |
| PR-0.2 Baseline CI | Done | CI is split into `typecheck`, `core`, `test`, and `build`; `test:core` runs hook/runtime plus 70-case replay gates. |
| PR-0.3 Runtime control boundary | Done | Runtime control-plane parsing/resolution is shared by controller, TUI dispatcher, and CLI command registry; unknown slash commands pass to the agent and unsafe local commands are blocked while running. |
| SS-Next-1A Canonical ToolContract projection | Done | `buildTool()` derives one immutable, handler-free contract from each existing `ToolDef`; the frozen 24-tool catalog has full-contract fingerprints, MCP provenance defaults conservatively, and runtime order/behavior remain unchanged. This slice is descriptive only. |
| SS-Next-1B Canonical FreshnessGate enforcement | Done | `buildTool()` fail-closes malformed/unread/partial/truncated/stale/deleted targets, carries an async approved content/hash snapshot into managed writes, blocks unsupported streaming freshness tools, and emits structured gate metadata into ToolExecutionLedger. `edit_fim` now enters PatchTransaction before disk commit. |
| SS-Next-2A Authoritative transaction identity binding | Done | Successful `PatchTransaction` commits update a constant-size, runtime-owned history fingerprint in the per-run execution context. Only untampered descriptors backed by the fixed built-in verifier allowlist can emit verification; the runtime parses their core result and overwrites all authority stamps. Any observed runtime write requires the exact commit-history snapshot, including shell/shadow writes that bypass PatchTransaction. Command-to-file coverage and rollback-aware invalidation are intentionally deferred to SS-Next-2B. |
| Harness PR-2.1 FileState/Freshness core | Done | `FileStateLedger`, file fingerprinting, and `validateFreshnessForEdit()` cover fresh/full/partial/truncated/deleted/create cases without touching TUI. |
| Harness PR-2.2 FileState tool observation | Done | `read_file` records full/partial/truncated baselines; `write_file`, `edit_file`, `multi_edit`, and `edit_fim` record fresh agent-write baselines after successful disk commits. |
| Harness PR-2.3 FileState runtime isolation | Done | `agentLoop` binds its async generator lifecycle to a per-run file-state context; concurrent runs no longer share ledgers or write generations, while direct tool calls retain compatibility fallback state. |
| Runtime active-state isolation | Done | A neutral async runtime context isolates ModeContract, shell sandbox, patch context, context-budget mode, cascade files, and checkpoint scheduling; early iterator close disposes the run sandbox through a single `finally` cleanup path. |
| Runtime cancellation | Done | Run-level abort reaches providers and tools; pre-aborted runs skip work, legacy Promise/stream tools cannot retain the loop, shell abort kills its process tree, TUI cleanup actively aborts, and Stop hooks receive one terminal reason. Third-party tools should cooperatively consume `ToolExecutionContext.abortSignal` to release their own resources. |
| Harness PR-2.x FileState/Freshness enforcement | Done | Canonical contract requirements now enforce stale/partial/truncated/deleted/unread targets through one shared preflight; approved snapshots are re-bound at managed write/commit boundaries, fresh rereads recover stale state, and runtime bootstrap explicitly places legacy writeGuard in observe mode. |
| PR-1.1 HookOutput semantics | Done | `HookSystem` supports warning accumulation, block/replace priority, chained Pre/Post replacements, fail-closed handler exceptions, and dedicated regressions. |
| PR-1.2 writeGuard before/after | Done | The public hook factory retains strict compatibility semantics; canonical runtime bootstrap explicitly uses warn/observe mode and delegates the actual block to FreshnessGate. |
| PR-1.3 CLI/TUI default hooks | Done | `createDefaultHookSystem()` exists and runtime bootstrap uses it. Future CLI/TUI entrypoints should keep using runtime bootstrap instead of manual hook assembly. |
| PR-1.4 Side-effect policy hook | Done | Shell side-effect detection now runs through `hooks:side-effect-policy` in the default hook stack instead of ad hoc loop preflight code. |
| PR-2.1 TaskPacket schema | Done | `TASK_PACKET_JSON_SCHEMA` and `parseTaskPacketJson()` validate unknown JSON fail-closed before TaskPacket execution; invalid verification kinds now block. |
| PR-2.2 MasterPlan mode auto-flow | Done | `loop.ts` feeds MasterPlan node status, error count, ripple obligations, evidence presence, and plan completion into `shouldTransitionMode()`; completed plans now synchronize to report mode before final delivery. |
| PR-2.x MasterPlan / TaskPacket / ModeContract | Done | TaskPacket schema validation, MasterPlan packet wiring, plan validation, and ModeContract auto-flow are present. Zod adapter remains intentionally deferred because the project does not depend on Zod. |
| PR-3.1 Final truthfulness gate | Done | `CompletionOrchestrator` now fail-closes final-round truthfulness contradictions and checks implementation claims against write/changed-file evidence. |
| PR-3.2 narrow_edit evidence path | Done | Verified-write auto-complete now checks structured evidence inside `checkNarrowEditCompletion()` before returning completion text; `loop.ts` no longer has a separate `canClaimDone()` handoff. |
| PR-3.x Completion / Evidence | Partial | Final completion routes through `CompletionOrchestrator`; latest failed re-verification, post-verification writes, unmanaged observed writes, and commit-history fingerprint mismatches invalidate old evidence. Fixed built-in verifier identity and conservative shell command recognition are enforced; command-to-file coverage, rollback-aware invalidation, and scoped invalidation remain incomplete. |
| PR-4.x Patch / Rewind | Partial | State machine and rewind modules exist, and successful commits feed the authoritative evidence snapshot; end-user rewind flows and rollback-aware evidence invalidation remain incomplete. |
| PR-5.x Safety | Partial | Secret-path rules now share the transaction-layer canonical patterns and risk messages omit sensitive payloads. Permission UX, redaction persistence coverage, and sandbox capability still need unification. |
| PR-6.x Provider | Partial | Registry metadata derives from the canonical config catalog and provider streams close cleanly on abort. Structured output, transcript, and purpose/cost trace enforcement remain incomplete. |
| PR-7.x Replay / CI | Partial | 70-case deterministic replay exists and CI has a core gate; E2E replay and mini benchmark remain planned. |
| PR-8.x TUI / CLI | Partial | Large TUI surface exists and has high targeted test coverage; final plan/evidence UX still needs acceptance gates. |
| PR-9.x Observability | Planned | Gate/runtime telemetry exists, but a standard event taxonomy and failure taxonomy report are not complete. |
| PR-10.x Docs / Release | Planned | Update architecture, roadmap, security, and `orcana doctor` after the runtime gates are stable. |

## Current Validation Baseline

These commands were used while creating this matrix:

```bash
bun test tests/hooks_defaults.test.ts tests/safety_policy.test.ts tests/runtime_event_bus.test.ts
bun test tests/hooks_system.test.ts
bun run test:core
bun run test:replay
bun test tests/runtime_model_config.test.ts tests/config/config-loader.test.ts
bun test tests/verification_result.test.ts tests/registry.test.ts tests/tool_contract.test.ts tests/evidence_ledger.test.ts tests/completion_orchestrator.test.ts tests/mode_contract.test.ts tests/file_tools_file_state.test.ts tests/patch_transaction.test.ts tests/agent_loop.test.ts
bun run typecheck
bun run build
bun run test
bun test tests/tui
bun test tests/config/auth-store.test.ts tests/config/config-loader.test.ts tests/runtime_model_config.test.ts tests/provider_capabilities.test.ts tests/provider_retry.test.ts
bun test tests/agent_loop.test.ts -t "non-retryable provider stream failure blocks instead of retrying|quota provider stream failure blocks once instead of retrying"
```

## Not In Scope

- Multi-agent/T3R split: Strong Single v1.0 must stabilize single-agent runtime first.
- SkillForge or plugin marketplace: defer until ToolPolicy, Evidence, Replay, and sandbox behavior are hard-gated.
- Separate ToolContractRegistry: do not add one; future consumers should use the immutable projection derived from the existing `ToolDef` catalog.
- Replacing the existing TUI track: current work should reuse the TUI command/composer/runtime-panel surface already in the codebase.
