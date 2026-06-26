# Anatomy

## gates/
- `types.ts` — Gate, GateResult, GateTrace interfaces
- `chain.ts` — GateChain.pipe([...]), evaluate/evaluateSync/evaluateWithTrace, optional GateTelemetry
- `contexts.ts` — PreRoundContext, ToolContext, CompletionContext (mutable)
- `context-budget.ts` — ContextBudgetGate (warn/block ratio from env)
- `pre-round.ts` — ToolDisclosureGate, ReadonlyPlanGate, RippleToolFilterGate + createPreRoundChain()
- `completion.ts` — RippleExitGate, PlanningArtifactGate, TaskTrackerCompletionGate, QualityGate + createCompletionChain()
- `overflow.ts` — processGateOverflow() pure function (count=3 warn, count>=5 BLOCKED)
- `telemetry.ts` — GateTelemetry class (record, markFalsePositive, markMissed, report, toJSON/fromJSON, merge, saveToFile, loadFromFile)
- `manifest.ts` — generateManifest(telemetry) + manifestReport() → decision matrix applied

## tool-execution/
- `policy.ts` — evaluateToolPolicy() with 6 gates: rate_limit, permission, readonly_intent, ripple_block, planning_phase, web_search_failed

## round/
- `helpers.ts` — buildAgentContractContext, formatQualityGatePrompt, compactAssistantContext
- `pre-loop.ts` — ErrorTracker, withToolTimeout, hook helpers, context building, typecheck helpers, runtime self-edit gate, file requirement helpers
- `post-loop.ts` — runPostEditDiagnostics, runRippleVerification, collectThinkingRounds, microcompact, state machine update
- `request-builder.ts` — buildContextMessages, buildRoundProviderRequest, cacheStableProviderTools, estimateRoundTokens

## Gate chains (4 phases)
1. Pre-round: 4 gates via createPreRoundChain() → evaluateSync
2. Per-tool: 6 gates via evaluateToolPolicy() → pure function
3. Completion: 4 gates via createCompletionChain() → evaluateSync (+ FlashJudge inline in loop.ts)
4. Overflow: processGateOverflow() → pure function

## Entry points
- `src/ui/cli.ts` — wire: `gateTelemetryFile: ".wolf/gate-telemetry.json"`
- `src/tui/main.tsx` — wire: `gateTelemetryFile: ".wolf/gate-telemetry.json"`
- `src/agent/loop-types.ts` — AgentOptions: gateTelemetry, gateTelemetryFile, modelRouter, initialPlanState, flashTriagePolicy
- `src/agent/loop.ts` — planApproved from options.initialPlanState (no more [PLAN_APPROVED] message parsing); Flash Triage policy overridable via options.flashTriagePolicy
- `src/tools/search.ts` — web_search: Exa semantic search (REST API + MCP fallback), drops SearXNG Docker + DuckDuckGo
- `src/tools/webfetch.ts` — web_fetch: Jina Reader (r.jina.ai) for Markdown extraction, direct HTTP fallback with legacy stripHtml

## tool-execution/
- `policy.ts` — evaluateToolPolicy() with 6 gates: rate_limit, permission, readonly_intent, ripple_block, planning_phase, web_search_failed. Covered by tests/tool_policy.test.ts (21 tests).

## gates/
- `overflow.ts` — processGateOverflow(): 3 blocks → strategy switch, 5 → BLOCKED. Covered by tests/gate_overflow.test.ts (17 tests).

## task-tracker / task-packet
- `task-tracker.ts` — revisePlan(): stuck detection → push back to planning. Covered by tests/revise_plan.test.ts (15 tests).
  - `createTaskTracker` — @deprecated PR 2. keyword-based tracker with hardcoded file paths. Kept for backward compat.
  - `updateTaskTrackerAfterTools` — `skipLegacyStepIds` param gates legacy step-ID matching when MasterPlan is active.
- `task-packet.ts` — PR 2: TaskPacket-driven tracker factory. Replaces keyword templates.
  - Types: TaskPacket, VerificationRequirement, RipplePolicy, ContextBudget
  - `extractScopeFromLine` — heuristic file path + verification hint extraction from plan text
  - `buildPacketFromLine` — plan line → TaskPacket (with command-populated verification)
  - `createTaskTrackerFromPacket` — TaskPacket → TaskTracker conversion (backward compatible)
  - Runtime context fields: `contextMapId` + `requiredContextEvidence` can be attached when loop builds a ContextMap.

## loop.ts
- History loading: replaced hardcoded slice(-24) with 150K token budget (~15% of 1M context), char-based token estimation, max 60 messages.
- AgentOptions imported from loop-types (no local duplicate).
- PR 1: MasterPlan lifecycle — `activateMasterPlan` + `tryNodeTransition` helpers, 3 plan-accept paths, 2 node-transition points.
- PR 2: `updateTaskTrackerAfterTools` call passes `skipLegacyStepIds: !!masterPlan` — legacy step-ID matching gated when MasterPlan active.
- ContextMap runtime: `contextMapPolicy` (`off|auto|always`) builds ContextMap for long/high-risk/explicit-file coding work, injects summary into stable prefix, attaches context evidence to MasterPlan/TaskPacket, and blocks write tools for high-risk readiness gaps.

## master-plan.ts
- `PlanNode._packet` — PR 2: source TaskPacket stored for serialization/resume.
- `createMasterPlan` — PR 2: per-node trackers created via `buildPacketFromLine` + `createTaskTrackerFromPacket`.
- `addNode` — PR 2: same packet-driven path.
- `serializePlan` — PR 2: includes packet-derived `scope` and `verification` per node.
- ContextMap evidence propagates through initial plans, force-pass packets, dynamic `addNode()`, and `revisePlan()` replacement nodes; serialized plans include packet context evidence and validation.

## plan-validator.ts (PR 3)
- `validatePlan` — pure function: 6 structural checks (cycles/DFS, uniqueness, tracker existence, doneCriteria, verification, scope)
- `validateNode` — single-node fast check for pre-transition use
- `evaluatePlanForcePass` — replaces bare `forcePlanningPassAfterLimit`; creates minimal viable TaskPacket at threshold
- `createMinimumViablePacket` — extracts files from rejected plan text, adds typecheck verification
- `formatValidationReport` — model-injectable error/warning report for review prompts
- `createMasterPlanFromPacket` (in master-plan.ts) — single-node plan factory for force-pass MVP

## context-epoch.ts (PR 4)
- `EpochThresholds` — compressChars/forceCompressChars/rolloverChars (default 120k/220k/300k, env-overridable)
- `EpochState` — currentEpochIndex, rolloverCount, snapshots, totalCharsTrimmed
- `createEpochState` — factory with optional threshold overrides
- `msgCharLen` / `totalMessageChars` — character estimation (÷3 ≈ token estimate), exported for reuse
- `buildPlanStateContext` — Layer 2: MasterPlan/TaskTracker/Ripple/decisions snapshot that survives rollover
- `classifyEpochAction` — none/compress/forceCompress/rollover based on total chars vs thresholds
- `hasUnclosedToolChain` — guards rollover against pending tool_use (DeepSeek HTTP 400)
- `epochRollover` — archives old messages, keeps min 2 retained, prepends plan state + epoch preamble
- `formatEpochBudgetWarning` — model-facing instruction at force-compress threshold
- `formatEpochStatus` — compact one-line status for yield
- **Safety invariants**: min 2 messages retained, unclosed-tool-chain block, preamble preserves plan state

## loop.ts (PR 4 wiring)
- `epochState` — created at agentLoop start with default thresholds
- Plan state context built each round from `planRef.current` (not local `masterPlan` — avoids TS CFA generator narrowing)
- Epoch action classified each round from `totalMessageChars(contextMessages) + totalMessageChars(rawMessages)`
- Epoch rollover: on "rollover" action, calls `epochRollover(rawMessages, 3, planStateText, epochState, round)`, replaces rawMessages
- Force-compress warning: one-shot injection (`announcedEpochForceCompress` flag)
- Microcompact/thinking-compaction/historical-compaction triggers extended with `epochAction`
- `saveCheckpoint` pre-existing bug fixed: `masterPlan` (TS `never`) → `planRef.current`

## round/request-builder.ts (PR 4)
- `ContextMessageInput.planStateContext` — new field, placed after stablePrefixContext (cache-safe), before volatileContext
- `msgCharLen` import from context-epoch (was duplicate, now shared)

## patch-transaction.ts (PR 5)
- `PatchTransaction` — txId/baseHash/diff/scope/verification/forbiddenCheck/fileTransaction
- `computeBaseHash` / `readFileHash` / `checkBaseHash` — SHA256 (16-char hex) pre-image verification
- `checkForbiddenFile` — blocks .git/.deepseek-code/node_modules/.codegraph/.wolf + path escape
- `generateLineDiff` / `formatDiff` — Set-based line diff (Phase 1; full Myers diff → PR 8)
- `setActivePatchContext` / `getActivePatchContext` — module-level context set by loop.ts at node activation
- `preWriteCheck` — single entry point: forbidden check → base hash check → create PatchTransaction
- `createPatchTransaction` — full transaction with scope/verification from active context or override
- `serializePatchTransaction` — compact JSON for tool result metadata

## tools/file.ts (PR 5 wiring)
- write_file / edit_file / multi_edit / edit_fim — all call preWriteCheck before disk mutation
- `checkpointMetadata` now uses computeBaseHash (no duplicate hash logic)
- Removed unused `createHash` import from node:crypto
- multi_edit creates per-file PatchTransactions in batch

## master-plan.ts (PR 5)
- `revisePlan` new nodes include `_packet` (buildPacketFromLine) — prevents stale patch context after plan revision

## loop.ts (PR 5 wiring)
- setActivePatchContext called at 3 node activation points (activateMasterPlan x2, tryNodeTransition)
- Scope/verification from node._packet → active patch context → PatchTransaction metadata

## evidence-ledger.ts (PR 6)
- `EvidenceKind` — "typecheck" | "test" | "build" | "manual" (4 types, narrower than VerificationKind)
- `EvidenceEntry` — id/kind/command/output/passed/timestamp/txId
- `EvidenceLedger` — { entries: EvidenceEntry[] }
- `toEvidenceKind` — maps VerificationKind→EvidenceKind: lint→typecheck, smoke→test, unknown→null
- `requiredEvidenceKinds` — dedup with Set, derived from TaskTracker.requiredVerificationKinds
- `canClaimDone()` — comprehensive hard check: steps done + files exist + evidence present. NOT used in loop.ts completion flow directly — integrated into evaluateCompletionGate instead.
- `createEvidenceLedger` / `addEvidence` / `hasEvidence` / `getEvidence` / `latestPassedEvidence` — CRUD
- `ingestVerificationResult` / `ingestVerificationResults` — VerificationResult→EvidenceEntry batch conversion
- `addManualEvidence` — human review/QA sign-off (advisory only, never required)
- `formatEvidenceLedgerStatus` / `formatCanClaimDoneBlocked` — model-facing formatting
- `serializeLedger` / `deserializeLedger` — checkpoint persistence
- **Known Phase 1 limitations**: no freshness tracking (additive ledger), dual-write with verificationEvidence (backward compat), manual evidence advisory-only

## completion-gate.ts (PR 6 wiring)
- `CompletionGateInput.evidenceLedger` — optional, consulted in evaluateCompletionGate
- Evidence ledger check runs alongside legacy verificationEvidence check (reinforcement, not replacement)

## loop.ts (PR 6 wiring)
- `evidenceLedger` created at agentLoop start
- Passed to `updateTaskTrackerAfterTools` for ingestion
- Passed to `evaluateCompletionGate` for evidence validation
- No separate evidence gate — integrated into existing completion gate chain

## task-tracker.ts (PR 6 wiring)
- `updateTaskTrackerAfterTools` accepts optional `evidenceLedger` param
- When provided, `ingestVerificationResults` called at function end

## ripple/api-diff.ts (PR 2)
- `SymbolShape` — lightweight serializable symbol snapshot (name/kind/exported/header/async/returnType/fields[]/line + precision positions)
- `ApiChangeKind` — 8 change kinds: export_removed, export_added, signature_changed, async_boundary_changed, return_type_changed, interface_field_removed, interface_field_added, kind_changed
- `ApiChange` — structured change entry: kind/symbol/oldShape?/newShape?/severity/detail. Severity pre-computed from kind + exported status.
- `diffApiSurface(oldShapes, newShapes)` — structured diff engine replacing engine.ts's `changedSymbols(): string[]`. Detection order: removed→added→kind→async→signature→return_type→field_changes. Multiple changes per symbol possible.
- `toSymbolShapes(Map<string, SymbolInfo>)` — converts engine.ts internal SymbolInfo to serializable SymbolShape[]
- `changedSymbolNames(ApiChange[])` — extracts unique symbol names (backward compat with changedSymbols consumers)
- `hasSeverity(changes, severity)` — checks if any change meets or exceeds given severity

## ripple/engine.ts (PR 1+2 foundation)
- `SymbolInfo` — now includes nameStart/nameEnd/declStart/declEnd for precise AST positions (was: line only)
- `extractSymbols()` — populates nameStart/nameEnd from `node.name.getStart()/getEnd()`, declStart/declEnd from `node.getStart()/getEnd()`. All 6 symbol types covered.
- `findCallers()` — parseCache now caches SourceFile+lines (was: mtime-only skip that missed unchanged caller files). Always walks AST regardless of cache hit.
- `verifyCallersSemantically()` — uses `oldSym.nameStart` for precise position (was: `findLineStart(absTarget, oldSym.line)` which pointed to line-start, not identifier)
- `findLineStart()` — removed. No longer needed.
- `changedSymbols()` — replaced by `diffApiSurface` in api-diff.ts
- `previewEdit()` — now uses `diffApiSurface` + `ApiChange[]` to drive finding generation. Finding switch on `change.kind` instead of re-deriving from SymbolInfo fields.
- `formatRippleBlock()` — uses `apiChanges` for change summary (kind-annotated)
- `tightenRippleDecision()` — uses `hasSeverity(report.apiChanges, "block")` instead of `report.changedSymbols.length`
- `invalidateFileListCache()` — exported; forces refresh of project file list on next call
- `resetRippleProgram()` — now calls invalidateFileListCache() + parseCache.clear()

## ripple/types.ts (PR 2)
- `RippleReport.apiChanges: ApiChange[]` — new field, structured API surface changes
- `RippleReport.changedSymbols` — @deprecated, kept for backward compat, computed from apiChanges
- Export re-exports `ApiChange`, `ApiChangeKind` from api-diff.ts
- **Phase 1 limitation**: `waiveObligation` has no production caller — waivers created only via `resolveObligations` (caller file modified). Tool/prompt pathway deferred.

## ripple/semantic-reference-provider.ts (PR 3)
- `SemanticReferenceProvider` — wraps ProjectProgram as the PRIMARY caller discovery path
- `findCallers(targetFile, changedSymbols, oldSymbols)` → `SemanticFindResult { references, semanticPathUsed }`
  - Semantic path: uses `program.findReferences(absTarget, position)` with TypeChecker resolution
  - Skips non-exported symbols (semantic path only tracks exported)
  - Deduplicates references by `file:line` key across symbols
  - Returns `semanticPathUsed: false` when program not yet ready (callers fall back to text scan)
  - **Known limitation**: first call always returns empty — `ensureProgram()` builds the TS program asynchronously. On the next call, semantic path activates.
- `resolveSymbol(fileName, position)` → canonical name via alias resolution
- `ready` / `invalidate()` — lifecycle matching ProjectProgram
- `getSemanticReferenceProvider()` / `resetSemanticReferenceProvider()` — global singleton (lazy, cached)
- `SemanticReference` / `SemanticFindResult` types exported

## ripple/engine.ts (PR 3 wiring)
- previewEdit: semantic path becomes PRIMARY (was: text scan → semantic verify)
  - New flow: `semanticProvider.findCallers()` → if ready, use semantic results + supplement same-file text callers
  - Fallback: when program not ready, preserve existing text-scan + verifyCallersSemantically path
  - Import: `getSemanticReferenceProvider`, `resetSemanticReferenceProvider`
- resetRippleProgram: now also calls `resetSemanticReferenceProvider()`

## ripple/usage-classifier.ts (PR 4)
- `UsageKind` — 14 usage patterns: call_expr, method_call, new_instance, type_ref, extends_clause, implements_clause, generic_arg, typeof_query, destructure, jsx_element, jsx_attr, re_export, spread_expr, plain_ref
- `UsageImpact` — { caller, usage, requiredAction, confidence }
- `classifyOneCaller(caller, symbol)` — regex-based heuristic classification ordered by specificity (extends/implements/typeof/re-export/new/generic_arg/jsx_element/spread/destructure/jsx_attr/method_call/call_expr/type_ref/plain_ref). Purely text-based; ApiChange context applied later by resolveAction.
- `classifyCallers(callers, apiChanges)` — batch classification + action resolution via `resolveAction(usage, changes)`
- `resolveAction` — combines UsageKind + ApiChangeKind → human-readable requiredAction (e.g. async_boundary_changed + call_expr → "add await to this call")
- **Audit fix**: removed unused `_change?` param from `classifyOneCaller` and dead `findPrimaryChange` function
- `formatUsageSummary(impacts)` — groups by action, lists files, truncates at 3 + "+N more"
- `urgencyLevel(impacts)` — "urgent" (await/remove/migrate) > "actionable" > "info"

## ripple/types.ts (PR 4)
- `RippleReport.usageImpacts: UsageImpact[]` — per-caller usage classification
- Re-exports `UsageImpact`, `UsageKind` from usage-classifier.ts

## ripple/engine.ts (PR 4 wiring)
- previewEdit: after caller discovery, runs `classifyCallers(callers, apiChanges)` → usageImpacts
- RippleReport includes `usageImpacts`
- Finding generation enriched: async_boundary_changed counts await-needing callers, signature_changed counts argument-update callers, export_removed appends per-caller action list
- `formatRippleBlock` annotates callers with usage kind + required action, appends `formatUsageSummary` block
- Import: `classifyCallers`, `formatUsageSummary`
- Test fixtures: 4 files updated (agent_loop, ripple (2 locations), obligations makeReport) with `usageImpacts: []`

## ripple/verification-map.ts (PR 6 — NEW)
- `VerificationStep` — type (typecheck/test/lint/custom), command, label, coverage (direct/indirect/none), priority (required/recommended/optional)
- `VerificationMap` — targetFile, steps[], affectedTestFiles[], uncoveredSymbols[], coverage (0-1)
- `buildVerificationMap(targetFile, callerFiles, apiChanges, usageImpacts, projectRoot)` — test file discovery + step generation
- `findTestFiles` — convention-based: tests/<name>.test.ts, tests/<subdir>/<name>.test.ts, __tests__/<name>.test.ts, index→parent
- `buildSteps` — always typecheck, individual test commands (≤3) or aggregate (>3), async/signature custom verify steps
- `formatVerificationMap(map)` — priority-grouped (Required→Recommended→Optional), coverage warning with uncovered symbols (truncated at 5)
- `primaryVerificationCommand(map)` — first required step command (fallback to first available, default "bun run typecheck")
- `mergeVerificationMaps(maps)` — union test files + uncovered symbols, deduplicate steps, average coverage
- `isShallowChange(changes)` — true for export_added/interface_field_added only
- `verificationStrictness(changes)` — strict (async/export_removed/signature) > normal (kind_changed/return_type) > relaxed (export_added only). Wired into engine.ts previewEdit — strict changes with uncovered symbols produce an info-severity advisory finding.
- **Known limitation**: `buildSteps` hardcodes `bun run typecheck` — does not detect project's actual typecheck tool.

## ripple/types.ts (PR 6)
- `RippleReport.verificationMap?: VerificationMap` — verification commands for the change (optional, backward compat)
- Re-exports `VerificationMap`, `VerificationStep` from verification-map.ts

## ripple/engine.ts (PR 6 wiring)
- previewEdit: after classifyCallers, builds `verificationMap` via `buildVerificationMap(targetFile, callerFiles, apiChanges, usageImpacts, projectRoot)`
- RippleReport includes `verificationMap`
- `formatRippleBlock` appends `formatVerificationMap` block between usage actions and finding reasons
- Import: `buildVerificationMap`, `formatVerificationMap`, `verificationStrictness`
- **Audit fix**: `verificationStrictness` wired — strict changes + uncovered symbols → info advisory finding
- **Audit fix**: `isShallowChange` import removed (was unused dead import)
- **Audit fix**: `cascadeAwareDecision` now filters out info-severity findings before evaluating cascade leniency

## ripple/astgrep-provider.ts (Ripple PR 7 — NEW)
- `AstGrepMatch` — file/line/pattern/text for individual pattern match
- `AstGrepStats` — available/version/lastMatchCount/matchedPatterns
- `AstGrepProvider` — external pattern-based caller discovery using ast-grep CLI
  - `isAvailable()` — cached availability check (sg --version)
  - `discoverCallers(targetFile, symbols)` — pattern-based caller discovery, dedup by file:line, skip self-references
  - `_execFn` — test-only dependency injection for execSync replacement
  - `_exec(cmd)` — wraps execSync (or test mock) with unified error handling
- `generatePatterns(symbol)` — 6 pattern types: import, re_export, new_instance, method_call, call_expr, identifier
  - Regex-special chars escaped in pattern literals
- `runQuery(pattern, excludeFile)` — sg scan --json --no-ignore, parses JSON output
  - Exit code 1 = no matches (sg convention, returns [])
  - Non-JSON output → returns []
  - Status > 1 errors → thrown (skipped by caller's try/catch per pattern)
- `getAstGrepProvider(projectRoot?)` / `resetAstGrepProvider()` — global singleton
- Degrades gracefully: isAvailable → false → discoverCallers returns []

## ripple/engine.ts (Ripple PR 7 wiring)
- `resetRippleProgram` includes `resetAstGrepProvider()`
- previewEdit: after caller discovery (semantic or text), runs ast-grep enrichment when relevantSymbols.length > 0
  - Only when `astGrep.isAvailable()` — zero overhead if sg not installed
  - Results merged with dedup (file:line) — supplements both semantic and text paths
- Import: `getAstGrepProvider`, `resetAstGrepProvider`

## gates/completion.ts (PR 7 wiring)
- `RippleExitGate.evaluate()` — now calls `getBlockingObligations(ctx.pendingRippleObligations)` instead of raw `.length`
- Only non-waived obligations trigger the exit gate block

## gates/pre-round.ts (PR 7 wiring)
- `strongestRippleDecision()` — now uses `getBlockingObligations(pending).length` instead of raw `pending.length`
- Waived obligations no longer trigger ripple warnings

## completion-gate.ts (PR 7 wiring)
- `evaluateCompletionGate` — ripple check now uses `getBlockingObligations()` instead of inline `filter(o => !o.waiver)`
- Updated import to include `getBlockingObligations`

## loop.ts (PR 7 wiring)
- Import: `getBlockingObligations` added to ripple/obligations imports
- `autoFinishOnVerifiedWrite` path (line 1334): now uses `getBlockingObligations(pendingRippleObligations).length === 0`
- `processGateOverflow` input (line 1360): now passes `getBlockingObligations(pendingRippleObligations).length`

## ripple/obligations.ts (audit fixes)
- **H1 fix**: `obligationsFromReport` now checks both `apiChanges.length` and `changedSymbols.length` (dual guard). Previously used only deprecated `changedSymbols`.
- **L4 fix**: Comment header changed from `PR 7` to `Ripple PR 5 (Orcana PR 7)` to disambiguate numbering schemes.
- `waiveObligation` has no production caller — waivers created only via `resolveObligations` (Phase 1 limitation).

## .wolf/
- `orcana-architecture.md` — T3R + Microagents 多 agent 架构最终方案。Planner/Coder/Reviewer 三常驻 + Locator/Verifier 按需微 agent。Event Bus + Context Epoch + Runtime Merger。14 PR 路线图。
- `orcana-next-phase.md` — 2026-06-24 决策：当前不做多 agent，先硬化单 agent 长程运行时。9 个 PR：MasterPlan接入→TaskPacket→Plan Validator→Context Epoch→PatchTransaction→Evidence→Ripple→ModeContract→Replay Harness。

## mode-contract.ts (PR 8)
- `ModeName` — "planner" | "coder" | "review" | "repair" | "report"
- `ModeContract` — mode/description/allowedTools/forbiddenTools/inputRequired/outputSchema/exitCriteria
- `ModeExitCriterion` — kind: no_tool_errors | output_not_empty | has_evidence
- `MODES` — 5 mode definitions. planner: read+git+network+meta, no writes/shell. coder: all tools. review: read+git+typecheck+meta, no writes/shell/network. repair: all tools, typecheck evidence required. report: read+git+meta, no writes/shell/network/typecheck
- `enforceModeTools(mode, toolName)` — forbiddenTools takes precedence. MCP tools (mcp__*) auto-allowed in non-empty allowedTools modes. `request_deeper_thinking` in META_TOOLS always allowed.
- `checkModeExitCriteria(mode, context)` — checks no_tool_errors/output_not_empty/has_evidence against completion state
- `formatModePrompt(mode)` — model-facing mode reminder injected each round
- `setActiveMode` / `getActiveMode` — module-level state (same pattern as patch-transaction PR 5)
- `shouldTransitionMode` — Phase 1 stub, returns null (mode transitions deferred)

## tool-execution/policy.ts (PR 8 wiring)
- `ToolPolicyInput.modeContract?` — optional ModeContract for tool enforcement
- Gate 7: mode enforcement — checks allowedTools/forbiddenTools via enforceModeTools(). Blocked reason: "mode_contract"

## completion-gate.ts (PR 8 wiring)
- `needsExternalCompletionGate` — PR 8: always returns true when mode contract has exit criteria (fixes HIGH-2 bypass)
- `evaluateCompletionGate` — mode exit criteria check via checkModeExitCriteria, generic empty-text check suppressed when mode already reports it (fixes MEDIUM-5)
- Import: checkModeExitCriteria, getActiveMode from mode-contract

## loop.ts (PR 8 wiring)
- `setActiveMode(options.activeMode ?? "coder")` — set at loop start (line 195)
- `getActiveMode()` passed to evaluateToolPolicy via modeContract field
- `formatModePrompt(getActiveMode())` injected into context messages each round
- `toolGateNames` array updated: +"mode_contract" (7 gates total)

## loop-types.ts (PR 8)
- `AgentOptions.activeMode?: ModeName` — optional mode override, defaults to "coder"

## replay-harness.ts (PR 9)
- `ReplayDomain` — "master_plan" | "context_epoch" | "false_done" | "ripple" | "patch_transaction"
- `ReplayExpected` — discriminated union: MasterPlanReplayExpected | ContextEpochReplayExpected | FalseDoneReplayExpected | RippleReplayExpected | PatchTransactionReplayExpected (each with domain-specific fields: success/allowed, nodeCount, action, obligationCount, diffStats, assertions)
- `ReplayCase` — { caseId, domain, description, targetFunction, input, fixture?, expected, tags? }
- `ReplayResult` / `ReplaySuite` — result and suite types
- `validateReplayCase` — structural validation of a ReplayCase
- `checkAssertions` — assertion engine supporting exists/equals/gt/gte/contains operators
- `DOMAIN_LABELS` — Chinese-friendly domain display names

## tests/replay/ (PR 9)
- 30 JSON case files across 5 domains (6 per domain):
  - `master-plan/`: create-plan, node-transition, plan-complete, blocked-node, force-pass, validation-cycle
  - `context-epoch/`: below-threshold, compress-threshold, force-compress, rollover, tool-chain-guard, plan-state-preserved
  - `false-done/`: missing-verification, ripple-blocking, tracker-incomplete, mode-exit-fail, typecheck-failed, clean-completion
  - `ripple/`: obligations-from-report, waive-lifecycle, blocking-filter, merge-overwrite-waiver, resolve-by-change, cascade-multiple-callers
  - `patch-transaction/`: write-allowed, forbidden-git, forbidden-node-modules, hash-mismatch, diff-generation, serialization-roundtrip

## tests/replay_harness.test.ts (PR 9)
- Loads all 30 JSON cases from tests/replay/
- `dispatchCase` — maps targetFunction strings to actual module function calls (master-plan, context-epoch, false-done, ripple, patch-transaction)
- `validateResult` — domain-specific validation logic comparing actual results to expected
- Handles: string returns (classifyEpochAction), boolean returns (hasUnclosedToolChain), object returns with nested structures
- Fixture system: creates temp dirs with specified file content for filesystem-dependent tests (checkBaseHash, createPatchTransaction)
- Module-level state reset before each case (setActiveMode("coder"), planRef.current = null)
- 37 tests total: 30 case tests + 1 load-count + 5 domain-count + 1 summary-structural
