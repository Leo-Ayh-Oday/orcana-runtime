# Orcana Strong Single v1.0 Status Matrix

Updated: 2026-07-07

This matrix maps the Strong Single v1.0 seed plan to the current codebase. It is intentionally conservative: a module is `Done` only when the code, tests, and runtime wiring are present.

## Summary

| Area | Status | Current evidence | Gap |
|------|--------|------------------|-----|
| Runtime bootstrap | Done | `src/runtime/bootstrap.ts`, shared CLI/TUI runtime assembly | Keep future UI entrypoints on this path |
| Runtime event boundary | Partial | `src/runtime/event-bus.ts`, `src/runtime/controller.ts`, `tests/runtime_event_bus.test.ts` | Not yet the single control plane for all slash commands |
| HookSystem 2.0 | Partial | `src/hooks/index.ts` accumulates warnings and supports lifecycle events | Default hook factory added; write guard still defaults to warn mode |
| Default hooks | Partial | `src/hooks/defaults.ts` creates safety/write/journal hook stack | Shell side-effect guard still lives in loop preflight, not a hook |
| TaskPacket / MasterPlan | Partial | `src/agent/task-packet.ts`, `src/agent/master-plan.ts`, `src/agent/plan-validator.ts` | TaskPacket JSON/Zod schema is not implemented |
| ModeContract | Partial | `src/agent/mode-contract.ts`, `tests/mode_contract.test.ts` | Automatic MasterPlan mode transitions remain limited |
| Completion / Evidence | Partial | `src/agent/completion-orchestrator.ts`, `src/agent/evidence-ledger.ts` | Final truthfulness is not yet a fully enforced single path |
| PatchTransaction / Rewind | Partial | `src/agent/patch-transaction.ts`, `src/agent/rewind.ts`, related tests | Rewind UX and transaction evidence binding need hardening |
| Tool risk / Permission | Partial | `src/agent/tool-risk.ts`, `src/agent/permission.ts`, `tests/tool_policy.test.ts` | Permission UX is not yet complete for all high-risk flows |
| Provider / ModelRouter | Partial | `src/provider/router.ts`, `src/provider/capabilities.ts`, runtime model config tests | All model calls need complete purpose/cost trace coverage |
| Replay harness | Partial | `src/agent/replay-harness.ts`, `tests/replay_harness.test.ts`, replay fixtures | Core 50 and CI layering are not complete |
| TUI / CLI operator UX | Partial | TUI tests, command dispatcher, command shelf, composer, runtime panels | Plan approval and evidence report UX still need completion checks |
| Observability | Partial | `AgentRunTrace`, gate telemetry, runtime panels | RunTrace event taxonomy is not fully standardized |
| Docs / release | Planned | `README.md`, `ARCHITECTURE.md`, `SECURITY.md` exist | v1.0 architecture/status/security docs need synchronization |

## Strong Single PR Mapping

| PR | Status | Notes |
|----|--------|-------|
| PR-0.1 Status Matrix | Done | This document is the baseline status matrix. |
| PR-0.2 Baseline CI | Partial | `.github/workflows/ci.yml` runs typecheck, tests, build; replay/core layering still needs work. |
| PR-1.1 HookOutput semantics | Partial | `HookSystem` supports warning accumulation and block/replace priority. Needs dedicated regression coverage for exception handling and after-hook replacement chains. |
| PR-1.2 writeGuard before/after | Partial | Split before/after hooks exist. Existing-file edits still default to warn unless strict mode is enabled. |
| PR-1.3 CLI/TUI default hooks | Partial | `createDefaultHookSystem()` exists and runtime bootstrap uses it. Confirm any future CLI/TUI entrypoint does not assemble hooks manually. |
| PR-2.x MasterPlan / TaskPacket / ModeContract | Partial | Core modules exist; schema-first TaskPacket and mode auto-flow are remaining work. |
| PR-3.x Completion / Evidence | Partial | Orchestrator and ledger exist; final truthfulness must be tightened around evidence claims. |
| PR-4.x Patch / Rewind | Partial | State machine and rewind modules exist; end-user rewind flows and evidence binding remain incomplete. |
| PR-5.x Safety | Partial | Tool risk, permission, side-effect, redaction, and sandbox capability exist in pieces. Need unified UX. |
| PR-6.x Provider | Partial | Model routing and capabilities exist; structured output and transcript manager need complete enforcement coverage. |
| PR-7.x Replay / CI | Partial | 30-case replay exists; Core 50, mini benchmark, and CI split remain planned. |
| PR-8.x TUI / CLI | Partial | Large TUI surface exists and has high targeted test coverage; final plan/evidence UX still needs acceptance gates. |
| PR-9.x Observability | Planned | Gate/runtime telemetry exists, but a standard event taxonomy and failure taxonomy report are not complete. |
| PR-10.x Docs / Release | Planned | Update architecture, roadmap, security, and `orcana doctor` after the runtime gates are stable. |

## Current Validation Baseline

These commands were used while creating this matrix:

```bash
bun test tests/hooks_defaults.test.ts tests/safety_policy.test.ts tests/runtime_event_bus.test.ts
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
