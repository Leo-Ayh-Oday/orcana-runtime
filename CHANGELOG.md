# Changelog

All notable changes to Orcana Runtime.

## [0.5.10] — 2026-08-05

### Added (Tool Runtime 2.0, RT-1)
- **Standard tool error codes** — canonical 26-code list (`TOOL_ERROR_CODES`), `ToolError` throwable + `toolError` info builder with per-code category/retryability defaults (`src/harness/capabilities/errors.ts`).
- **Structured execution results** — `ToolExecutionResult` with 6 statuses (`succeeded` / `domain_failed` / `execution_failed` / `blocked` / `cancelled` / `timed_out`), artifact/evidence refs, diagnostics, metrics; `domain_failed` (domain said NO) vs `execution_failed` (could not run) explicitly distinct; `resultHelpers` constructors.
- **Retry policy** — code-scoped `shouldRetry` + exponential backoff with cap (`retry.ts`).
- **ToolExecutionContext type** — explicit run-scoped context contract (roots/signal/budget/approval/sandbox/artifactStore/evidenceLedger/trace/fileState/ripple/patchStore/clock) with `buildExecutionContext` / `contextFromRunScope` (RT-3 wiring target).
- **Shared schema validator** — `validateJsonSchema` extracted to `capabilities/schema-validator.ts` (executor + interrupt manager + human node share one; `response-validator.ts` re-exports, zero behavior change).

## [0.5.9] — 2026-08-04

### Fixed (Graph Readiness G0-4)
- **Completion Gate hardened — tracker-less write claims need evidence** — the orchestrator evidence gate now supplies explicit `["typecheck"]` required kinds when a run performed writes without a task tracker (previously `canClaimDone` had no required kinds on that path, so any write-then-claim completed with zero verification). **HR-031 flips to `blocked`** (R1 calibrated it as `completed` with the gap recorded; the regression probe now locks the hardened behavior — verified by A/B: with the fix reverted HR-031 is `completed` again). Graph Readiness Gate G0-4 — completion decisions are sound before Graph commits build on them.

## [0.5.8] — 2026-08-04

### Added (Graph Readiness G0-3)
- **Artifact content persists with the run** — `SerializableRun` gains `artifactState` (artifact entities + resolved content); `collectArtifacts` gathers metadata AND content map at terminal save, `createArtifactStore` hydrates synchronously on restore. A restored run can now read artifact content back via its hash ref (was: *"artifact content is not restored, refs are"* — `serialization.ts` comment, removed). Old pre-G0-3 files hydrate an empty store, unchanged. End-to-end: a real run writing `.ts` files persists its `typecheck_result` artifacts and a fresh harness reads them after restore. Graph Readiness Gate G0-3 — restored evidence chains are provable.

## [0.5.7] — 2026-08-04

### Fixed (Graph Readiness G0-2)
- **Trace write failures are now fail-loud** — `TraceWriter` counts failed batch writes (`writeFailures()` / `pendingEvents()`); `createJsonlTraceWriter` accepts an `onWriteFailure` observer and the RunController warns once when a run ended with lost events. Writes still never fail the run (audit stream policy unchanged — the Run/Snapshot JSON remain the restore source), but a gap is no longer silent.
- **Restore trace integrity check** — `HarnessStore.traceIntegrity(runId)` reports event-file existence + count; `AgentHarness` restore/inspect paths surface a missing or incomplete audit stream as a warning. Graph Readiness Gate G0-2 — observability step toward Event Sourcing for Graph checkpoints.

## [0.5.6] — 2026-08-04

### Fixed (Graph Readiness G0-1)
- **Terminal vs stopped status semantics** — new `STOPPED_RUN_STATUSES` (`blocked`/`waiting`/`paused`) alongside `TERMINAL_RUN_STATUSES`: terminal means finished forever (no transitions out), stopped means not auto-advancing but resumable (`blocked → running`, `waiting → resuming`). `isStoppedRunStatus()` covers both. Replay/HR invariants now check "stopped" instead of treating `blocked` as a terminal status; every stopped run must carry an outcome. RunController comments corrected (waiting/blocked/paused are not terminal events). Graph Readiness Gate G0-1 — pre-requisite for Graph scheduler node-terminal decisions.

## [0.5.5] — 2026-08-04

### Docs (Harness Closure R1 · freeze)
- `docs/harness-2.0-plan.md` §27 — Harness Closure R1 实施记录：六项逐条 + HR-031 校准结论（False-done 门当前放行，已知加固缺口）+ **冻结声明**（H0–H12 + R1 冻结，禁止非 Graph 前置结构改动，Execution Graph GEP-1.0 启动）。
- `ARCHITECTURE.md` 状态表：Node Runtime (H11) → 🟢 stable（强制 Policy + 证据链已落地；scheduler/Graph deferred）。

## [0.5.4] — 2026-08-04

### Added (Harness Closure R1)
- **Rubric wired into the eval CLI** — `run-replay-cli.ts` evaluates the §18.4/18.5 rubric over every replay result: 8-dimension scores per case, quality-floor report (correctness/safety/truthfulness), warnings and P0 violations printed, `rubric` block in per-case JSON and an aggregated `summary.json` under `--report`.
- **Non-required rubric checks are real warnings** — `RubricEvaluation.warnings` separate from `failures`; a non-required failure no longer vetoes the run (was: pushed into `failures` with `passed` requiring an empty list, contradicting the "warnings only" comment).
- **Shared-process dual-run policy isolation test** — two run scopes in one process sharing one projectRoot permission file: the R1 run-scope-derived gate honors the shared deny rule for both runs, per-run allow overrides don't leak, and different project roots load different permission files. (hr-dual stays as honest independent-harness sanity; real plan/mode/cancel isolation remains H3.)
- **HR-031 False-done calibration scenario** — write tool executed + completion claim with no verification evidence. Calibrated against the real orchestrator: it **accepts** the completion (no task tracker → `canClaimDone` has no required evidence kinds). Recorded as a known Completion Gate hardening gap — the scenario is a regression probe that flips to `blocked` when the gate hardens. HR-004 retitled to match its actual semantics.

## [0.5.3] — 2026-08-04

### Fixed (Harness Closure R1)
- **Replay events carry the real sequence** — `RunReplayResult.events`/`ReplayEvent` keep the envelope `sequence` (was dropped before, making HR-025 sequence continuity vacuous); synthetic `interrupt.answered` events carry no sequence so resume scenarios can't fake continuity.
- **Tool-call termination pairs by `toolCallId`** — `batch-executor` `tool_result` now carries `tc.id`; the bridged `tool.call.completed` event carries `toolCallId` (contract field added). HR-026 asserts exactly one terminal per requested call: no terminal (unless a policy-block trace exists), duplicate terminals, and out-of-order terminals all fail; legacy events without a callId fall back to name pairing.
- **Node artifact paths resolve against the run scope's `projectRoot`** — artifact tracker relative paths (complements the VerificationNode fix in 0.5.2); loop keeps the cwd fallback.

## [0.5.2] — 2026-08-04

### Added (Harness Closure R1, P0-2)
- **NodeResult.evidence chain landed** — `NodeResult.evidence` is now the ledger diff of the node run: `snapshotEvidence`/`diffEvidence` helpers, wired into ToolNode, VerificationNode and LlmAgentNode. `AgentNodeOutput` carries `artifactIds` / `patchTransactionIds` (from patch artifacts, new `txId` field on `HarnessArtifact`) / `unresolvedRippleObligations` (honest `unknown[]` until the typed trace) / `resultingWorkspaceDigest` (run scope `projectRoot` hash). VerificationNode's ingested entries now appear in its `evidence`, bound to artifacts.
- **Single authoritative evidence ledger** — the kernel now accepts an injected `options.evidenceLedger` (same single-ownership pattern as sandbox/artifactStore); `buildLoopOptions` passes `run.scope.evidenceLedger`, so kernel verification and node diffs share ONE instance. Absent the option, the kernel creates its own (unchanged behavior).
- VerificationNode resolves relative modified files against `runScope.projectRoot` instead of `process.cwd()`.

## [0.5.1] — 2026-08-04

### Fixed (Harness Closure R1, P0-1)
- **ToolNode Policy Gate is now mandatory** — `executeCapability` no longer has a silent skip path: when neither `policyDecision` nor `policyContext` is supplied, the conservative default context is itself evaluated as a policy. `ToolNode` derives its policy context from the run scope (`createNodePolicyContextFromRunScope`), loading project permission rules under `scope.projectRoot/.orcana/permissions.json` — node-mode executions now obey the same permission surface as the loop, and strict mode fails closed (no interactive confirm channel in node mode).
- **Gate 2 name-only fallback** — `evaluateToolPolicy` now runs the permission gate when a concrete tool name exists even without a resolved tool descriptor, so unknown write-class capabilities are blocked by category inference instead of passing unexamined (loop mode always passes a descriptor — unchanged).
- **Rate-limit counter fix** — node-mode round usage counters were `Infinity`, which saturated Gate 1 and blocked every call; they now start at zero (run-level call budgets stay on the BudgetLedger).
- Tool calls carry `toolCallId` through policy/events; artifact tracker resolves relative paths against `projectRoot` when provided.

## [0.5.0] — 2026-08-04

### Added
- **Capability Registry / CapabilityExecutor (H9)** — `src/harness/capabilities/*`: unified Tool/Model/Verifier capability descriptions (§15); Tool→Capability projection over the canonical ToolContract (no second tool system); 8-step execution chain (Budget Reserve → Policy → Before Hook → Handler → After Hook → Schema Validation → Artifact/Evidence → Budget Commit); the normal loop and the future Node Runtime share one execution entry (`executeCapability`). Loop tool executions now route through it; write/external_action budgets are enforced (H4 debt cleared); patch/plan/ripple artifacts wired into the run flow (H8 debt cleared).
- **Context Provider Pipeline (H10)** — `src/harness/context/*`: 13 context providers (§16) layered stable/plan/node/volatile; pipeline (collect → dedupe → freshness → sort → budget → trim → ContextSlice); the loop no longer assembles context sources inline (byte-frozen parity with the legacy assembly).
- **Unified Node Runtime (H11)** — `src/harness/nodes/*`: `HarnessNode` primitives (function/tool/llm_agent/verification/human) + sequential `runNode` (no scheduler); **a single agent is now formally one `LlmAgentNode`** (reuses the LegacyLoopAdapter with byte-parity verified three ways); NodeEvent side stream (nodeRunId-stamped envelopes); run-level budget/cancellation/artifact governance throughout.
- **Eval Harness 2.0 (H12)** — `evals/harness/*` + `tests/harness-replay/*`: `RunReplayCase` contracts (§18.2) with ScriptedProvider (purpose routing, round_end boundaries, idle-timeout hang semantics) and scripted tools; `runReplayCase` hermetic executor (temp workspace, always-on trace invariants: sequence continuity / tool-call termination / terminal outcome); §18.4/18.5 multidimensional rubric (8 dimensions, quality floors, Safety/Truthfulness P0 veto — never a plain pass-rate); HR scenario matrix batch A — 11 scenarios green (readonly no-write, false-done blocking, typecheck repair, stream-interrupt recovery, plan approval / clarification resume, idempotent re-resume, context budget degrade/pause, permission deny, tool-call termination, secret redaction) + 3 dual-run isolation cases; Tier-1 replay assertion extensions (nested paths, regex, array length, not-exists, set containment); run-replay CLI (`bun run eval:replay --report`); CI tiers documented (§18.1); BudgetGuard cumulative-token double-count fixed (delta accounting) and `LEGACY_CONTEXT_MAX_TOKENS` plumbed for context-budget scenarios.
- **Rename leftovers fixed (H12)** — legacy eval paths migrated from `~/.deepseek-code/evals` to `~/.orcana/`.

## [0.4.0] — 2026-08-03

### Added
- **Harness 2.0 (H0–H8)** — `src/harness/`: `AgentHarness` facade is now the single production entry (CLI/TUI run through `AgentHarness.run()` → `LegacyLoopAdapter` → `agentLoop`; direct `agentLoop()` calls removed). Typed `HarnessEvent` contracts, `RunLifecycleMachine` + exhaustive `LoopDecision → RunOutcome` mapping, per-run isolation via `AgentRunScope`, `BudgetLedger` + cancellation policy (model/tool/token/wall-time budgets with a wall-time watchdog), typed JSONL event trace with legacy migration, `HarnessStore` persistence (sessions/runs/snapshots + workspace hash), persistent interrupt/resume for plan approval and clarification (cross-instance), artifact/evidence integration with freshness (workspace + file-hash drift → stale detection, `CompletionOrchestrator` derives completion facts from `EvidenceLedger`).

### Changed
- **Agent Loop Kernel slimming (ALK-1.0, L0–L7 complete)** — `src/agent/loop.ts` reduced from **2077 → 132 lines** (stage orchestrator only). Phase bodies moved into `src/agent/kernel/` (prepare / round / finalize) and the L3–L6 coordinators (`ProviderRoundRunner`, `ToolBatchExecutor`, `VerificationCoordinator`, `MaintenanceCoordinator`). All phase exits unified as `LoopDecision` (continue/break/return); stream/trace/state emission unified as `RunEffect` with field-level `AgentRunStatePatch`; single terminal switch + `finalizeRun()` + unified `finally` lifecycle. `loop.ts` no longer executes tools, parses provider streams, or performs verification/checkpoint/file-system work itself. L0 Golden Trace preserved.

## [0.3.0] — 2026-06-28

### Added
- **Phase 6 — ModelRouter / Provider**: purpose routing (cheap sub-calls → flash, same-provider preference), ProviderCapabilities (8-field per-model capability declarations), DeepSeekTranscriptManager (unclosed chain + adjacency + tool limit validation), unified structured output (fail-closed `callWithStructuredOutput` + `zodToJsonSchema`), FIM safety constraints (`checkFimSafety` with forbidden/scope/TOCTOU guard).
- **Phase 5 — Tool Risk / Permission / Sandbox**: ToolRiskTaxonomy (Risk 0-5, 40 tests), Permission UX (9-gate source/priority trace, confirm-stubs), ShellSideEffectGuard (18 patterns, 29 tests), SecretRedaction full pipeline (unified redactor, run-trace integration, 38 tests), SandboxCapability visibility (6 features, OS banner).
- **Phase 4 — PatchTransaction + Rewind**: PatchTransaction state machine (proposed→committed→rolled_back), atomic file writes (temp→verify→commit), `/rewind` command (3 modes: code/conv/both), Checkpoint UUID.
- **Phase 3 — Completion Orchestrator + Evidence**: CompletionOrchestrator unified final gate evaluation (loop.ts ~180→~50 lines), `canClaimDone()` single evidence entry point, FinalTruthfulnessGate future-tense filtering.
- **Phase 2 — MasterPlan / ModeContract / TaskPacket**: TaskPacket validation (9-field checks), ModeContract auto-transition (4 rules), TaskPacket takeover for long tasks, PlanValidator enhancements.
- **Phase 1 — Single Agent Long-Runtime Skeleton**: MasterPlan→TaskPacket→ContextEpoch→PatchTransaction→Evidence→Ripple→ModeContract→Replay Harness (9 PRs).
- **Phase 0 — Runtime Bootstrap**: unified `createRuntime()` for CLI/TUI, architecture docs truthfulness fix, v0.2.2 version baseline.
- **Ripple Engine 2.0**: ApiChange structured diff (8 change kinds), SemanticReferenceProvider (TypeScript type-checker based caller discovery), UsageImpact classifier (14 usage kinds), VerificationMap (convention-based test discovery), AstGrep fallback provider (6 pattern types).

### Fixed
- `.key$` false-positive on i18n/keyboard layout files → narrowed to SSH private key filenames.
- `tool_risk` gate invisible to telemetry → added to `toolGateNames` array.
- Scope matching bypass in FIM guard (substring/suffix overscope) → path-boundary-aware matching.
- Divergent forbidden-file lists across 3 modules → canonical `forbidden-patterns.ts`.
- Duplicate `hasUnclosedToolChain` across context-epoch + transcript-manager → single canonical source.
- 3 pre-existing test regressions from ModeContract shouldTransitionMode.

### Changed
- `maxRounds` default now 50, env-overridable via `DEEPSEEK_MAX_ROUNDS`.
- Flash Triage default changed to `"auto"` (matches design intent).
- Search backend: SearXNG Docker + DuckDuckGo → Exa semantic search + Jina Reader (zero Docker).
- Replaced `[PLAN_APPROVED]` string protocol with `AgentOptions.initialPlanState`.

## [0.2.1] — 2026-06-24

### Fixed
- Remove dead `_usage` type-penetration code (`loop.ts:324`) — written but never read.
- Replace `[PLAN_APPROVED]` string protocol with `AgentOptions.initialPlanState` field. Plan approval now passes through typed options instead of synthetic message content.
- Flash Triage now defaults to `"auto"` instead of `"off"`, matching the design intent of replacing 4 keyword classifiers.
- Remove duplicate field assignments in `buildTrackerFromTriage` spread — `requiredFiles`, `requiredVerificationKinds`, `steps` were already provided by the spread.

### Changed
- `DEEPSEEK_MAX_ROUNDS` env var as fallback for `maxRounds` default (was hardcoded 50).
- Softened "zero identity bias" → "reduced identity bias" in ARCHITECTURE.md, with training-distribution limitation noted.
- Documented FIM `/beta/completions` endpoint risk and Gate Overflow prompt-only limitation.

### Removed
- `package-lock.json` — Bun-only project, no npm lockfile.
- `parse_trending.mjs` moved from root to `scripts/`.
- `Co-Authored-By: Claude` attribution disabled via `~/.claude/settings.json`.

## [0.2.0] — 2026-06-24

### Added
- **GateChain architecture**: 14 gates across 4 phases (pre-round, tool policy, completion, overflow). 3 pass-through filters, 4 guards, 3 verify gates, 4 safety nets.
- **GateTelemetry**: pure data collector with `record`, `markFalsePositive`, `markMissed`, `report`, `summary`, `toJSON`/`fromJSON`, `merge`, cross-session persistence via `saveToFile`/`loadFromFile`. Wired into `agentLoop` at all 3 exit points.
- **Gate Manifest**: decision matrix (`keep`/`tune`/`observe`/`delete`/`safety_net`/`pass_through`) encoded as code in `src/agent/gates/manifest.ts`, with `generateManifest` and `manifestReport`.
- `gateTelemetryFile` option auto-saved to `.wolf/gate-telemetry.json` on every agent run, with additive merge across runs.
- `--model` flag for CLI runtime model override.
- `modelRouter` field in `AgentOptions` for sub-purpose model selection.
- 46 gate tests (33 telemetry + 13 manifest).

### Changed
- Planning gate re-architecture: `forcePlanningPassAfterLimit` integrated into completion chain.
- `maxRounds` default now reads `DEEPSEEK_MAX_ROUNDS` env var, falls back to 50.

## [0.1.2] — 2026-06-23

### Added
- Auto-detect user language (Chinese/English/Japanese) from prompt text.
- All system prompts adapt to detected language.
- `UILanguage` type and `detectLanguage` / `languageInstruction` helpers.

## [0.1.1] — 2026-06-23

### Fixed
- User confirmation now bypasses the planning gate to prevent infinite re-planning loop.
- Block Unix system paths (`/System`, `/etc`, `/boot`, `/sys`, `/proc`) in safety policy.

## [0.1.0] — 2026-06-22

### Added
- Initial open-source release.
- CLI (`src/ui/cli.ts`) and TUI (`src/tui/main.tsx`, Ink React) entry points.
- Agent loop with staged context, thinking store, knowledge base, ripple engine.
- DeepSeek V4 provider with thinking tokens, Flash sub-processing, FIM endpoint, prefix caching.
- 26 safety mechanisms: permission gate, Flash Judge, state machine, ripple engine, sandbox, memory compaction.
- MCP server bridge, tool registry, hook system.
- Session checkpoint (save/resume).
- npm distribution (`orcana-runtime` package, `orcana` CLI command).
