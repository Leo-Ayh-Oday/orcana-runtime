# Changelog

All notable changes to Orcana Runtime.

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
