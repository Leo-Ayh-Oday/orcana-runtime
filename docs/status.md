# Orcana Strong Single v1.0 Status Matrix

Updated: 2026-07-08

This matrix maps the Strong Single v1.0 seed plan to the current codebase. It is intentionally conservative: a module is `Done` only when the code, tests, and runtime wiring are present.

## Summary

| Area | Status | Current evidence | Gap |
|------|--------|------------------|-----|
| Runtime bootstrap | Done | `src/runtime/bootstrap.ts`, shared CLI/TUI runtime assembly | Keep future UI entrypoints on this path |
| Runtime event boundary | Partial | `src/runtime/event-bus.ts`, `src/runtime/controller.ts`, `src/runtime/control-plane.ts`, `tests/runtime_event_bus.test.ts` | Slash parsing/resolution is shared; command execution still needs full CLI/TUI runtime controller wiring |
| HookSystem 2.0 | Done | `src/hooks/index.ts` accumulates warnings, chains replacements, fail-closes handler exceptions, and supports lifecycle events | Keep future hook events on this shared implementation |
| Default hooks | Done | `src/hooks/defaults.ts` creates safety, side-effect, write, and journal hook stack; unread existing-file edits strict-block by default | Keep future runtime safety policies on the default hook stack |
| TaskPacket / MasterPlan | Partial | `src/agent/task-packet.ts`, `src/agent/master-plan.ts`, `src/agent/plan-validator.ts` | TaskPacket JSON/Zod schema is not implemented |
| ModeContract | Partial | `src/agent/mode-contract.ts`, `tests/mode_contract.test.ts` | Automatic MasterPlan mode transitions remain limited |
| Completion / Evidence | Partial | `src/agent/completion-orchestrator.ts`, `src/agent/evidence-ledger.ts` | Final truthfulness is not yet a fully enforced single path |
| PatchTransaction / Rewind | Partial | `src/agent/patch-transaction.ts`, `src/agent/rewind.ts`, related tests | Rewind UX and transaction evidence binding need hardening |
| Tool risk / Permission | Partial | `src/agent/tool-risk.ts`, `src/agent/permission.ts`, `tests/tool_policy.test.ts` | Permission UX is not yet complete for all high-risk flows |
| Provider / ModelRouter | Partial | `src/provider/router.ts`, `src/provider/capabilities.ts`, runtime model config tests | All model calls need complete purpose/cost trace coverage |
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
| PR-1.1 HookOutput semantics | Done | `HookSystem` supports warning accumulation, block/replace priority, chained Pre/Post replacements, fail-closed handler exceptions, and dedicated regressions. |
| PR-1.2 writeGuard before/after | Done | Default runtime hook stack strict-blocks unread existing-file edits and `multi_edit`; warn mode remains available as an explicit compatibility option. |
| PR-1.3 CLI/TUI default hooks | Done | `createDefaultHookSystem()` exists and runtime bootstrap uses it. Future CLI/TUI entrypoints should keep using runtime bootstrap instead of manual hook assembly. |
| PR-1.4 Side-effect policy hook | Done | Shell side-effect detection now runs through `hooks:side-effect-policy` in the default hook stack instead of ad hoc loop preflight code. |
| PR-2.x MasterPlan / TaskPacket / ModeContract | Partial | Core modules exist; schema-first TaskPacket and mode auto-flow are remaining work. |
| PR-3.x Completion / Evidence | Partial | Orchestrator and ledger exist; final truthfulness must be tightened around evidence claims. |
| PR-4.x Patch / Rewind | Partial | State machine and rewind modules exist; end-user rewind flows and evidence binding remain incomplete. |
| PR-5.x Safety | Partial | Tool risk, permission, side-effect, redaction, and sandbox capability exist in pieces. Need unified UX. |
| PR-6.x Provider | Partial | Model routing and capabilities exist; structured output and transcript manager need complete enforcement coverage. |
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
- Full ToolContractRegistry: do after default hooks and writeGuard block semantics are stable.
- Replacing the existing TUI track: current work should reuse the TUI command/composer/runtime-panel surface already in the codebase.
