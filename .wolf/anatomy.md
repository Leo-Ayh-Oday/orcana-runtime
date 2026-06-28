# Anatomy

> **Current version**: v0.3.0 (2026-06-28). Phase 0-6 complete. See .wolf/memory.md for full changelog.

## runtime/ (NEW — PR-0.1)
- `bootstrap.ts` — Shared runtime factory `createRuntime()`. Single assembly point for provider registry, ModelRouter, MultiProvider, MCP tools, HookSystem, StagedContextManager, SessionManager, ThinkingStore, KnowledgeBase, CompactionState, LSP client, run trace factory, version reader. Both CLI and TUI consume this — no more per-UI drift. Exports `Runtime` interface, `RuntimeBootstrapOptions`, `AgentOptions` builder, meta-tools (TASK_TOOL, REQUEST_DEEPER_THINKING).

## hooks/ (Phase 1 PR-1.1/1.2 upgraded)
- `index.ts` — HookSystem with priority-based semantics: blocked > replace > warn. return types: BeforeHookResult {blocked, replaceParams, warnings[], trace[]}, AfterHookResult {blocked, replaceResult, warnings[], trace[]}. Multiple handlers accumulate warnings, last replace wins. HookOutput: blocked/replace/result/warn/source fields. beforeCount/afterCount getters.
- `builtin.ts` — writeGuardBefore (onToolBefore, checks read-set, strict mode blocks via DEEPSEEK_WRITE_GUARD_MODE=strict), writeGuardAfter (onToolAfter, tracks successful reads). JournalVeto with source:"journalGuard". Deprecated combined writeGuard kept for backward compat.
- `safety-policy.ts` — All block outputs carry source:"safety-policy".
- `pre-loop.ts` (round/) — runToolBeforeHook returns replaceParams. runToolAfterHook uses replaceResult. executeToolWithHooks: execute(params) receives effectiveParams (replaceParams applied). Streaming tool path also applies replaceParams (HIGH fix).

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

## patch-transaction.ts (PR 5 + PR-4.1)
- `PatchTransaction` — txId/baseHash/diff/scope/verification/forbiddenCheck/fileTransaction
- `computeBaseHash` / `readFileHash` / `checkBaseHash` — SHA256 (16-char hex) pre-image verification
- `checkForbiddenFile` — blocks .git/.deepseek-code/node_modules/.codegraph/.wolf + path escape
- `generateLineDiff` / `formatDiff` — Set-based line diff (Phase 1; full Myers diff → PR 8)
- `setActivePatchContext` / `getActivePatchContext` — module-level context set by loop.ts at node activation
- `preWriteCheck` — single entry point: forbidden check → base hash check → create PatchTransaction
- `createPatchTransaction` — full transaction with scope/verification from active context or override
- `serializePatchTransaction` — compact JSON for tool result metadata
- **PR-4.1 State Machine:**
  - `PatchState` — "proposed" | "applied_to_temp" | "verified" | "committed" | "rolled_back"
  - `ManagedPatchTransaction` — wraps PatchTransaction with state + per-file entries + temp paths
  - `ManagedFileEntry` — relativePath/absolutePath/oldContent/newContent/expectedBaseHash/tempPath
  - `initManagedTransaction` — creates in "proposed" state; forbidden-file gate rejects before any disk write
  - `applyToTemp` — writes all files to .deepseek-code/patches/<txId>/; transitions → applied_to_temp
  - `verifyManagedTransaction` — marks verified; transitions → verified
  - `commitManagedTransaction` — atomic renameSync temp→target per file; base-hash TOCTOU guard before each rename; auto-purges from registry; transitions → committed
  - `rollbackManagedTransaction` — cleans temp dir from any state; idempotent; auto-purges registry; transitions → rolled_back
  - `applyAndCommit` — full lifecycle with verify callback (must be read-only)
  - `getManagedTransaction` / `getAllManagedTransactions` / `clearTransactionRegistry` — registry ops
  - `serializeManagedTransaction` — compact JSON for session persistence
  - VALID_TRANSITIONS enforced at each step; illegal transitions throw
  - Temp dir: .deepseek-code/patches/<txId>/<relativePath> (same filesystem → atomic rename)

## rewind.ts (PR-4.3)
- `saveRewindPoint` — per-user-prompt auto-save: computes fileSHAs from actual content, stores snapshot + checkpoint
- `listRewindPoints` — returns checkpoints newest-first with file count, token count, summary
- `executeRewind` — restores files from snapshots + FileTransaction rollback; 3 modes: code/conversation/both
- `formatRewindList` / `formatRewindResult` — CLI display helpers
- Integrity check after code rewind: verifies restored files match stored SHAs (skips sentinel "deleted"/"error" hashes)
- Rewind dir: .deepseek-code/rewind/<sessionId>/round-<n>.json
- **Wired into CLI**: `/rewind list | /rewind <round> [code|conv|both]` command in definitions.ts
- Auto-save on each user prompt in cli.ts (non-critical; failure doesn't block the turn)

## checkpoint.ts (PR-4.4)
- `SessionCheckpoint.checkpointId` — unique 12-char hex ID (generated via `generateCheckpointId()`)
- `generateCheckpointId()` — `timestamp36_random6` format
- `CheckpointRecord.checkpointId` — optional field in SQLite schema (backward compatible)
- `recordToCheckpoint` — generates fallback checkpointId from sessionId + roundNum if missing

## rewind-stubs.ts (PR-4.4 TUI preparation)
- `TuiRewindEntry` / `TuiRewindListState` / `TuiRewindConfirmState` / `TuiRewindProgressState` — type stubs
- `createRewindListState` / `createRewindConfirmState` / `createRewindProgressState` — factory functions
- `formatTuiRewindEntry` — single-line TUI display formatter
- `TuiRewindAction` — discriminated union for TUI keybinding dispatch
- Actual rendering in Phase 9 (PR-9.4)

## tools/file.ts (PR-4.2 wiring)
- write_file / edit_file / multi_edit — use `applyAndCommit` (state machine) instead of direct writeFile
- Atomic write: temp→verify→commit (renameSync on same filesystem)
- Forbidden file guard: enforced in `initManagedTransaction` → rejects before any disk write
- Transaction ID: returns `mpt.patch.fileTransaction.id` (txn_* format, compatible with rollback_transaction)
- Partial multi_edit commits reverted via FileTransaction snapshots before rollback
- edit_fim still uses legacy createTransaction/writeFile (not yet migrated)
- rollback_transaction still functional with returned txn_* IDs

## master-plan.ts (PR 5)
- `revisePlan` new nodes include `_packet` (buildPacketFromLine) — prevents stale patch context after plan revision

## loop.ts (PR 5 wiring)
- setActivePatchContext called at 3 node activation points (activateMasterPlan x2, tryNodeTransition)
- Scope/verification from node._packet → active patch context → PatchTransaction metadata
- **ShellSideEffectGuard wired (2026-06-28)**: import analyzeSideEffects/formatSideEffectReport, pre-execution danger check in streaming + non-streaming exec paths, post-execution report injection for warning severity

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

## docs/
- `v1.0-roadmap.md` — 2026-06-27: v1.0 完整路线图，基于 Deep Research 绝对性审查报告 × Strong Single v1.0 实行计划。v0.2.2 基线，10 Phase/32+ PR/8-10 周。含模块逐项审查表、P0/P1/P2 优先级矩阵、PR 模板、TUI 专项、Orcana 风格保留、里程碑时间表、验收标准、排除项与接口依赖。

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

## completion-orchestrator.ts (PR-3.1 — NEW)
- `CompletionOrchestrator` — unified final gate evaluation. Single `evaluate()` method replaces ~180 lines of scattered completion logic in loop.ts.
- Gate evaluation order: 1) Sync chain (RippleExit→Planning→TaskTracker→Quality), 2) External completion gate, 3) FlashJudge, 4) Evidence hard gate (canClaimDone), 5) Truthfulness gate (finalText vs Evidence).
- Returns `CompletionOrchestratorResult` with decision ("done"|"continue"|"break_blocked"|"plan_ready") + all side effects collected (injectMessages, statusMessages, yieldTexts, traceEvents).
- `CompletionOrchestratorInput` — all completion-relevant state. loop.ts builds this from its local variables and applies results via switch statement.
- `checkNarrowEditCompletion()` — extracted from loop.ts post-round, now in orchestrator file as standalone helper. Still called from loop.ts for now (full integration deferred).
- `evaluateSyncChain()` — wraps `createCompletionChain().evaluateSync()`, collects side effects from CompletionContext mutations.
- `evaluateExternalGate()` — calls `needsExternalCompletionGate()` + `evaluateCompletionGate()`. Blocked with rounds left → continue; blocked at final round → break_blocked.
- `evaluateFlashJudge()` — async FlashJudge call. SATISFIED → tryNodeTransition flag; IMPOSSIBLE → break_blocked; NOT_SATISFIED → continue with gap injection.
- `evaluateEvidenceGate()` — calls `canClaimDone()`. Blocked with rounds left → continue; final round → break_blocked with `formatCanClaimDoneBlocked`.
- `evaluateTruthfulnessGate()` — extracts truth claims from finalText (typecheck/test/build/lint/no-errors), cross-references with EvidenceLedger. Contradictions at non-final round → continue; final round → noted but allowed.
- Design invariants: single done decision path, fail-closed (any unhandled state → continue), side effects collected not executed.

## loop.ts (PR-3.1 integration)
- Completion block (~180 lines) replaced with single `orchestrator.evaluate()` call (~50 lines).
- `checkNarrowEditCompletion` in post-round (line ~1335) replaces inline narrow_edit auto-complete logic.
- Narrow_edit completion now runs `canClaimDone` evidence check before breaking (PR-3.1 review fix HIGH-3).
- `collectRecentTurns` passed to orchestrator for FlashJudge context (PR-3.1 review fix HIGH-2).
- Removed imports: `createCompletionChain`, `evaluateCompletionGate`, `formatBlockedCompletion`, `formatCompletionEvidenceReport`, `formatCompletionGatePrompt`, `needsExternalCompletionGate`, `extractPromises`.
- Added imports: `CompletionOrchestrator`, `checkNarrowEditCompletion`, `canClaimDone`.

## mode-contract.ts (PR-3.1 fix)
- `shouldTransitionMode` Rule 4: node status mapping now skips when current mode is "repair" or "report" — prevents downgrading elevated modes back to "coder". Fixes 2 pre-existing test failures.

## tool-risk.ts (PR-5.1 ToolRiskTaxonomy)
- `RiskLevel` — 0-5 type: 0=SafeReadonly, 1=ReadWithContext, 2=FileWrite, 3=Network, 4=ShellExec/GitMutation, 5=Destructive
- `RiskProfile` — level/category/requiresConfirmation/sessionAllowable/description
- `TOOL_RISK_MAP` — explicit risk profiles for ~30 tools (read_file→0, write_file→2, shell→4, git_commit→4, etc.)
- `RISK_5_PARAM_PATTERNS` — destructive regex patterns (rm -rf /, fork bomb, mkfs, curl|sh, write .env/.pem) elevate tool to Risk 5
- `CATEGORY_DEFAULT_RISK` — safe→0, file→2, network→3, shell→4, git→1
- `getToolRisk(toolName, params, tool?)` → RiskProfile — priority: Risk-5 patterns → explicit map → category default → readonly fallback
- `isHighRisk(level)` — true for Risk 4-5
- `canAutoAllow(risk)` — false when sessionAllowable=false
- `formatRiskBlockMessage(toolName, risk, params)` — system-reminder block message with risk level
- **Wired into PermissionGate.check()**: `opts.riskLevel` param — session allow override (step 5) ignored for Risk 4-5 tools
- **Wired into policy.ts**: Gate 8 (last gate, after mode_contract) — Risk 4-5 tools blocked in full mode even when other gates pass. Gate ordering ensures more specific gates (readonly/ripple/planning/context/mode) take priority in block reasons.

## permission.ts (PR-5.1 change)
- `PermissionGate.check()` accepts optional `opts?: { riskLevel?: number }` param
- Step 5 (Session Allow Override): when `opts.riskLevel >= 4`, session allow is rejected → returns ask level instead

## tool-execution/policy.ts (PR-5.2 change)
- `ToolPolicyBlocked` now includes `source: string` (gate name) and `priority: number` (1-8)
- All 9 block returns set source and priority: rate_limit(1), permission(2), readonly_intent(3), ripple_block(4), planning_phase(5), context_readiness(6), web_search_failed(7), mode_contract(7), tool_risk(8)
- Policy trace is always available: every block has category + source + priority

## tui/confirm-stubs.ts (PR-5.2)
- `ConfirmRequest` — high-risk tool invocation awaiting confirmation (requestId, toolName, riskLevel, params, source, priority, timestamp)
- `formatCliConfirmPrompt(req)` → system-reminder block with "批准/拒绝" prompt
- `TuiConfirmDialogState` — visible + requests[] + focusedIndex
- `TuiConfirmAction` — SHOW_CONFIRM/APPROVE_CONFIRM/DENY_CONFIRM/DENY_ALL_CONFIRM/DISMISS_CONFIRM
- `ConfirmResult` — approved/denied/dismissed with formatConfirmResult
- Actual TUI rendering deferred to Phase 9 (PR-9.4)

## sandbox/side-effect-guard.ts (PR-5.3)
- `SideEffectCategory` — destructive_delete/destructive_move/git_destructive/permission_change/external_write/none
- `SideEffectFinding` — category/pattern/description/affectedPaths[]
- `SideEffectReport` — command/findings[]/outOfScopeFiles[]/severity
- `SIDE_EFFECT_PATTERNS` — 18 regex patterns: rm/del/rmdir/Remove-Item/git clean (delete), mv/Move-Item/rename (move), git reset --hard/stash drop/stash clear/checkout --/restore (git), chmod/chown/icacls/takeown (permission)
- `analyzeSideEffects(command, projectRoot)` → SideEffectReport — pure function, classifies command
- `hasSideEffects(command)` → boolean — quick pre-check
- `checkScopeViolations(changedFiles, expectedScope, projectRoot)` → string[] — post-exec scope check
- `formatSideEffectReport(report)` → CLI-formatted warning/danger message
- **Wired into loop.ts (2026-06-28)**: 2 injection points — pre-execution danger block (`analyzeSideEffects` called before `executeStream`/`execute`, danger severity → block) + post-execution report injection (warning severity → `formatSideEffectReport` appended to tool result)

## agent/secret-redactor.ts (PR-5.4)
- `redact(value, opts?)` → unknown — unified recursive redaction for all channels
- 16 SECRET_KEY_PATTERNS: api_key/token/secret/password/authorization/credentials/private_key/signing_key etc.
- 20 SECRET_CONTENT_PATTERNS: OpenAI/Anthropic/DeepSeek/AWS keys, GitHub PAT/OAuth, Slack tokens, JWTs, MongoDB/PostgreSQL/MySQL/Redis connection strings, private key blocks (RSA/EC/DSA/OpenSSH/PGP)
- Structural limits: maxDepth(4), maxStringLength(2000), maxArrayLength(50), maxObjectKeys(80)
- Channel-specific: `redactForTrace`, `redactForCheckpoint`, `redactForEvidence`, `redactForToolOutput`
- `containsSecret(value)` → boolean — pre-flight check
- **Wired into run-trace.ts**: replaced inline `sanitize()` with `redactForTrace()`
- Extra patterns support: `extraKeyPatterns` and `extraContentPatterns` in `RedactorOptions`

## sandbox/capability.ts (PR-5.5)
- `OSCapabilityMatrix` — platform/arch/osName/features[]/overallRating (0-10)
- `SandboxFeature` — name/tier(full|partial|none)/description/note
- `detectCapabilities()` — detects 6 features: process isolation (Job Object/cgroups/none), file guard (PathGuard), network isolation, env filtering, timeout guard, path guard
- `formatCapabilityBanner(cap)` → multi-line ANSI-colored startup banner with tier icons (●/◐/○)
- `formatCapabilitySummary(cap)` → compact one-line `[sandbox: +proc +file -net +env +timeout +path | 8/10]`
- `getCapabilityBanner()` → direct banner for current OS
- Overall rating: full=2pts, partial=1pt, none=0pt, normalized to 0-10
- Network isolation is "none" on all platforms without admin (honest degradation)

## provider/types.ts (PR-6.2)
- `ModelCapabilities` — thinking/fim/contextCaching/vision/structuredOutput/toolUse/streaming/maxContextWindow
- `StructuredOutputRequest` (PR-6.4) — type(json_schema|json_object)/schema/name/strict
- `ProviderCallOptions.responseFormat` (PR-6.4) — optional API-level structured output
- `ProviderRegistration.capabilities` — optional provider-level capability union

## provider/registry.ts (PR-6.2)
- BUILTIN_MODELS now include `capabilities: ModelCapabilities` per model
- Capability presets: DEEPSEEK_CAPABILITIES (thinking+fim+caching), ANTHROPIC_CAPABILITIES (thinking+vision+caching), OPENAI_CAPABILITIES (vision+structuredOutput)
- `getCapabilities(modelId)` → ModelCapabilities | undefined
- `getProviderCapabilities(providerId)` → ModelCapabilities | undefined
- `listModelsByCapability(required)` → ModelID[] — models satisfying ALL requirements (AND logic)
- `modelHasCapability(modelId, required)` → boolean — single model check

## provider/router.ts (PR-6.1)
- `selectForPurpose(purpose)` — now actually routes cheap purposes (flash_triage/completion_judge/plan_judge/ambiguity_detector/thinking_compaction/semantic_recall_score/knowledge_distill/cold_memory_audit) to cheapest fast model; agent_main stays session-pinned
- `getSessionModel()` / `getCheapModel()` — explicit accessors
- `getCheapModel()` prefers same-provider cheap model (e.g. session=deepseek-v4-pro → cheap=deepseek-v4-flash)
- `resolveModel(modelId)` → ModelSpec | undefined — delegated to registry
- `isCheapPurpose(purpose)` — static helper
- `purposeRoutingEnabled` option in constructor (default true)
- **Wired into loop.ts**: FlashTriage receives `modelRouter.selectForPurpose("flash_triage")`, FlashJudge receives `modelRouter.selectForPurpose("completion_judge")`

## provider/transcript-manager.ts (PR-6.3)
- `DeepSeekTranscriptManager` — centralized transcript validation
  - `canEpochRollover(messages)` → boolean — blocks rollover if unclosed tool chains
  - `validateTranscript(messages)` → TranscriptValidation — checks unclosed chains, adjacency, tool limit
  - `computeStats(messages)` → TranscriptStats — message/block counts, tools in last turn
  - `checkToolLimit(messages)` → {ok, count, limit} — enforces DeepSeek 128 tools/turn
  - `formatStats(messages)` → compact one-line summary
- `hasUnclosedToolChain(messages)` → boolean — preserved from context-epoch.ts (canonical source now here)
- `hasAdjacencyViolation(messages)` → boolean — tool_use must be immediately followed by tool_result
- `countToolsInLastAssistantTurn(messages)` → number
- TranscriptValidation type: valid/reason/toolUseCount/toolResultCount/unclosedChain/adjacencyViolation
- TranscriptStats type: messageCount/assistantMessages/userMessages/toolUseBlocks/toolResultBlocks/thinkingBlocks/textBlocks/totalChars/toolsInLastTurn

## agent/structured-output.ts (PR-6.4)
- `callWithStructuredOutput<T>(options)` → StructuredOutputResult<T> — unified fail-closed structured output
  - Fallback chain: API format → prompt JSON → regex extraction → text fallback
  - Retry on parse failure (configurable maxRetries)
  - Optional Zod validator callback
  - Optional text fallback parser
- `zodToJsonSchema(schema)` → Record<string, unknown> — duck-typed Zod→JSON Schema converter
  - Covers: ZodString, ZodNumber, ZodBoolean, ZodEnum, ZodArray, ZodObject, ZodOptional, ZodNullable, ZodEffects, ZodDefault
  - Complex types (union/discriminated/intersection/tuple/record/literal) return minimal {type:"object"}
- `objectSchema(fields)` → Record<string, unknown> — convenience factory without Zod
- `StructuredOutputResult<T>` — data/rawText/parsed/retries/error/source
- `StructuredCallOptions<T>` — provider/model/purpose/system/prompt/schema/schemaName/maxTokens/maxRetries/abortSignal/validator/textFallback/useApiFormat
- tryParseStructuredResponse — strips markdown fences, JSON.parse, regex extraction

## sandbox/fim-guard.ts (PR-6.5)
- `FimSafetyContext` — scope/requiresVerification/verificationKinds
- `FimGuardResult` — allowed/reason/txId/preEditHash/requiredVerification
- `checkFimSafety(filePath, ctx)` → FimGuardResult — full safety check: forbidden files, scope validation, file existence, pre-edit hash, tx ID generation
- `verifyFimPreEditHash(filePath, expectedHash)` → {valid, currentHash?} — TOCTOU guard for post-edit verification
- `quickFimCheck(filePath, ctx)` → {allowed, reason?} — fast pre-check without hash computation
- `formatFimGuardResult(result)` → string — ✅/❌ user-visible message
- Forbidden patterns: .git, .env, .pem, id_rsa/id_ecdsa/id_ed25519, credentials.json, node_modules, .deepseek-code, .codegraph, .wolf
- Transaction ID format: txn_fim_<12-char-hex>
- Pre-edit hash: SHA256 first 16 chars for rollback

## loop.ts (PR-6.1 wiring)
- FlashTriage: receives routed model from `options.modelRouter?.selectForPurpose("flash_triage")`
- FlashJudge: receives routed model from `options.modelRouter?.selectForPurpose("completion_judge")`
- Gate telemetry: `tool_risk` added to toolGateNames (9 gates now), blockedGate normalization for tool_risk prefix

## tool-risk.ts (PR-5.1 post-review fix)
- Risk-5 param pattern for write_file: narrowed from `\.key$` to `id_rsa$|id_ecdsa$|id_ed25519$` — avoids false positives on i18n `.key` files

## sandbox/forbidden-patterns.ts (PR-6.5 post-review — NEW)
- `FORBIDDEN_SECRET_FILES` — 7 patterns: .env(.*), .pem, id_rsa, id_ecdsa, id_ed25519, credentials.json, .htpasswd, secret.yml/yaml
- `FORBIDDEN_RUNTIME_DIRS` — 4 patterns: .deepseek-code, .codegraph, .wolf, node_modules
- `FORBIDDEN_VCS_DIRS` — 1 pattern: .git
- `ALL_FORBIDDEN_PATTERNS` — aggregate: secret + runtime + vcs
- `isForbiddenPath(filePath)` → string | null — returns matching pattern source or null
- `isOutsideProjectRoot(filePath, projectRoot?)` → boolean — path escape detection
- Single source of truth — fim-guard, patch-transaction, tool-risk all reference these patterns

## sandbox/fim-guard.ts (PR-6.5 post-review fix)
- `isInScope` rewritten: path-suffix matching with "/" boundary anchors instead of substring `includes()`
  - File scopes (no trailing "/"): exact `endsWith` match
  - Directory scopes (trailing "/"): `includes` with "/" boundary → prevents overscope-by-substring
  - All paths prefixed with "/" to normalize absolute/relative path variants
- `isForbiddenFile` now delegates to `isForbiddenPath` from forbidden-patterns.ts
- Removed duplicate FORBIDDEN_PATTERNS list

## agent/patch-transaction.ts (PR-6.5 post-review fix)
- `checkForbiddenFile` now also checks `FORBIDDEN_SECRET_FILES` — blocks .env/.pem/SSH key writes at the transaction layer (was: only tool-risk gate, which could be bypassed)
- Import: `FORBIDDEN_SECRET_FILES` from `../sandbox/forbidden-patterns`

## agent/context-epoch.ts (PR-6.3 post-review wiring)
- `hasUnclosedToolChain` now imported from `../provider/transcript-manager` (canonical source)
- Re-exported for backward compatibility — all existing callers unchanged
- Removed inline implementation and zombie `isRecord` helper (was only used by removed inline)
