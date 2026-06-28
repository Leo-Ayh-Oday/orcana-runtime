# Gate Scenario Matrix — v0.3.0 (Audited 2026-06-28)

> **Verification**: `bun test tests/gate_scenario_audit.test.ts` — 53 pass, 0 fail. Real gate logic exercised with realistic inputs.

How gate behavior changes across 5 agent usage scenarios. Validates the loop is NOT heavy by default — cost scales with risk.

## Verified Data (from `tests/gate_scenario_audit.test.ts`)

### classifyIntent() — 11 real prompts tested

| Prompt | Expected | Actual | Correct? |
|--------|----------|--------|----------|
| "你觉得我的 Agent 架构怎么样？要不要做多 Agent？" | readonly | `readonly` | ✅ |
| "先分析一下原因，别改代码" | readonly | `readonly` | ✅ |
| "帮我设计 Context Map Pipeline 的技术方案，不需要实现" | readonly | `readonly` | ✅ (fixed) |
| "帮我评估 HookSystem 的设计缺陷和改进方向" | readonly | `readonly` | ✅ |
| "看看 loop.ts 的 gate 接线，只读不写" | readonly | `readonly` | ✅ |
| "找一下没被调用的函数，只分析不改代码" | readonly | `readonly` | ✅ |
| "改版本号成 v0.3.0" | narrow_edit | `narrow_edit` | ✅ |
| "修复 needsExternalCompletionGate 的 bug" | narrow_edit | `narrow_edit` | ✅ |
| "帮我跑一下 bun test 看看哪些测试挂了" | narrow_edit | `narrow_edit` | ✅ (fixed) |
| "git add -A && git commit" | narrow_edit | `narrow_edit` | ✅ |
| "rm -rf node_modules" | narrow_edit | `narrow_edit` | ✅ |

**0 classification bugs** (2 fixed in v0.3.0):
1. ~~Architecture prompts without explicit NO_WRITE words~~ → fixed: added `/不(?:需要|必|用|打算)(?:实现|写|修改|执行|改|做|动)/i` negation pattern
2. ~~Execution prompts with "看看"~~ → fixed: added `/跑(?:一下|一次|个)?/i` and `/运行/i` to EXECUTE_PATTERNS

**Semantic triage now default**: `shouldUseFlashTriage` auto-policy widened — fires for ALL meaningful prompts, not just trigger-word matches. Keyword classifier is now true fallback (circuit-breaker open / network error / trivial continuations like "好"/"继续").

### Gate telemetry — verified counts

| Phase | Gates | Always runs? | Measured |
|-------|-------|--------------|----------|
| Pre-round | 5 (context_budget, tool_disclosure, readonly_plan, context_readiness_filter, ripple_tool_filter) | ✅ Every round | 5 gateNames in telemetry |
| Tool policy | 9 sequential checks | ✅ Per tool call | Verified in evaluateToolPolicy |
| Completion sync | 4 (ripple_exit, planning_artifact, task_tracker, quality) | ✅ Every completion | 4 gateNames in telemetry |

### Completion chain: readonly vs write behavior

| Scenario | ripple_exit | planning_artifact | task_tracker | quality |
|----------|-------------|-------------------|--------------|---------|
| **Discuss (readonly)** | 1 trigger, **0 blocks** | 1 trigger, 0 blocks | 1 trigger, 0 blocks | 1 trigger, 0 blocks |
| **Write + ripple obligations** | 1 trigger, **1 block** | — | — | — |
| **Write + typecheck failed** | — | — | — | 1 trigger, **1 block** |

### ShellSideEffectGuard: verified detection

| Command | Category | Detected |
|---------|----------|----------|
| `rm -rf node_modules .cache` | destructive_delete | ✅ |
| `git reset --hard && git stash drop` | git_destructive | ✅ (2 findings) |
| `chmod -R 755 /proj/build` | permission_change | ⚠️ (0 findings — within project root) |
| `bun test` | none | ✅ safe |
| `npm install @foo/bar` | none | ✅ safe |

### ShellSideEffectGuard: wired in v0.3.0

- **ShellSideEffectGuard**: 18 patterns, 29 tests, **2 wire-points in loop.ts** (pre-execution danger block + post-execution report injection)

---

## Intent Classification (Entry Point)

Every user prompt is classified by `classifyIntent()` (keyword) or `FlashTriage` (semantic, optional).
This single 3-way split controls which downstream gates matter:

| Intent Mode | Trigger | Risk Level | Write Tools |
|-------------|---------|------------|-------------|
| `readonly` | 讨论/评估/审查/只读请求 | 零风险 | ❌ Blocked by Gate 3 |
| `narrow_edit` | 实现/修复/写代码 | 中风险 | ✅ Allowed |
| `long_task` | 从零/全栈/多页面 | 高风险 | → planning phase |

---

## Scenario 1: 普通讨论 / 架构聊天

**Intent**: `readonly` (matches DISCUSSION_PATTERNS, no EXECUTE_PATTERNS match)

### Pre-Round Gates (always run, all O(1))

| Gate | Behavior | Cost |
|------|----------|------|
| ContextBudgetGate | WARN/BLOCK at thresholds | ~1 comparison |
| ToolDisclosureGate | Narrows tools by context keywords | ~pattern match |
| **ReadonlyPlanGate** | intentReadonly=true → ALL tools filtered to readonly only | ~array filter |
| ContextReadinessFilterGate | Typically false for discussion → pass | ~1 check |
| RippleToolFilterGate | No ripple reports for discussion → pass | ~1 check |

### Tool Policy Gates (per tool call)

| Gate | Behavior |
|------|----------|
| 1. Rate Limit | Checks per-category caps |
| 2. Permission | Deny/ask check |
| **3. Readonly Intent** | **BLOCKS any non-readonly tool** ← primary safety guard |
| 4. Ripple Block | Pass (no ripple) |
| 5. Planning Phase | Pass (no taskTracker / phase=building) |
| 6. ContextReadiness | Pass (typically not blocked) |
| 7. Web Search Failed | Pass (unless search failed) |
| 7. ModeContract | Pass (coder mode allows all) |
| 8. ToolRisk | Pass (no writes anyway) |

### Completion Gates

| Phase | Gate | Behavior | Cost |
|-------|------|----------|------|
| 1. Sync Chain | RippleExitGate | **Early-exit**: `intentPolicy.mode === "readonly"` → pass | 1 comparison |
| 1. Sync Chain | PlanningArtifactGate | **Early-exit**: no taskTracker or phase≠planning | 2 checks |
| 1. Sync Chain | TaskTrackerCompletionGate | **Early-exit**: no taskTracker | 1 check |
| 1. Sync Chain | QualityGate | **Early-exit**: `intentPolicy.mode === "readonly"` → pass | 1 comparison |
| 2. External | needsExternalCompletionGate | **Skipped**: taskHadWrite=0 → returns false | 1 check |
| 3. Async | FlashJudge | **Skipped**: `shouldEvaluate()` returns false (no writes) | ~3 checks |
| 4. Evidence | canClaimDone | Runs but returns true (no tracker) | ~2 checks |
| 5. Truthfulness | claim extraction | Always runs — regex patterns on finalText | ~10 regex |

**Token cost: ~0 extra tokens for completion.** Only pre-round + tool-policy gates run, all synchronous O(1) logic. No Flash API calls.

**⚠️ Gap**: If agent claims "已实现" in discussion context, TruthfulnessGate won't catch it — it only checks typecheck/test/build/log claims against evidence ledger, not generic "implemented" statements.

---

## Scenario 2: 架构计划 / 方案设计

**Intent**: `readonly` (DISCUSSION_PATTERNS match, no EXECUTE_PATTERNS match)

**Gate profile: IDENTICAL to Scenario 1.** Architecture planning gets the same lightweight treatment as casual chat.

### What runs
- All pre-round filters (tool disclosure, readonly guard)
- All tool policy gates (writes blocked by readonly intent)
- Lightweight completion (4/5 phases early-exit)

### What does NOT run
- ❌ PlanningArtifactGate (no TaskTracker with phase=planning)
- ❌ PlanValidator structure checks
- ❌ Risk/dependency analysis
- ❌ "Implemented" vs "planned" claim detection

### Gap Analysis

| Concern | Status |
|---------|--------|
| Planning structure check | ❌ Not run — TaskTracker never created for readonly |
| Risk/dependency check | ❌ No dedicated gate for architecture plans |
| Roadmap consistency | ❌ Not in scope |
| "Planned→Implemented" false claim | ❌ TruthfulnessGate only checks typecheck/test/build |
| Write DecisionRecord | ✅ Agent can write files if explicitly asked (narrow_edit override) |

**Root cause**: `classifyIntent()` has only 3 modes. `DISCUSSION_PATTERNS` (讨论/评估/分析/方案/计划/架构) maps to `readonly` — indistinguishable from "just chatting." FlashTriage's `plan_before_code` detection maps to `narrow_edit` for task intent, `readonly` for tool intent — still no dedicated "architecture plan" lane.

**Recommended fix** (Phase 7):
1. Add a 4th gate lane: `plan_review` — between readonly and narrow_edit
2. When FlashTriage detects `plan_before_code`, create a lightweight PlanReviewTaskTracker (no PatchTransaction, but with structure/missing/consistency checks)
3. TruthfulnessGate: add "planned vs implemented" claim patterns (e.g., "已实现/已完成/已修复" vs no file evidence)

---

## Scenario 3: 读代码分析

**Intent**: `readonly` (explicit no-write request or discussion context)

**Gate profile: IDENTICAL to Scenario 1.** Readonly intent + no taskTracker.

### What runs
- Pre-round: ToolDisclosureGate filters tools to readonly subset
- Tool policy: **Gate 3 blocks all write attempts** ← primary safety
- SecretRedaction: Active for run-trace output
- Context budget control prevents context exhaustion during long read sessions

### What does NOT run
- ❌ PatchTransaction (no writes)
- ❌ EvidenceLedger deep checks (no tracker)
- ❌ CompletionGate heavy path
- ❌ FlashJudge (no writes → shouldEvaluate=false)

**Token cost: ~0 extra.** Read-only tools execute in parallel (Greedy Tools optimization).

---

## Scenario 4: 写代码 / 改文件

**Intent**: `narrow_edit` or `long_task` (EXECUTE_PATTERNS match)

**All 26 gates activate.** This is the full gate chain:

### Pre-Round Gates
All 5 gates run. ReadonlyPlanGate **does not filter** (intentReadonly=false).

### Tool Policy (per tool call)
All 9 gates evaluate fully. Key active gates:
- Gate 3 (readonly_intent): passes (mode ≠ readonly) → writes allowed
- Gate 5 (planning_phase): blocks writes before plan accepted (long_task only)
- Gate 6 (context_readiness): blocks writes if ContextMap readiness insufficient
- Gate 8 (tool_risk): blocks Risk 4-5 tools in full mode

### Completion (all 5 phases)

| Phase | Gate | Cost |
|-------|------|------|
| 1. Sync Chain | RippleExit → Planning → TaskTracker → Quality | Sync, ~pattern matching + 1 confidence eval |
| 2. External | CompletionGate evidence checklist | Sync, ~regex matching |
| **3. Async** | **FlashJudge** | **~1 Flash API call** (cheap, but a network round-trip) |
| 4. Evidence | canClaimDone | Sync, ~ledger traversal |
| 5. Truthfulness | Claim vs evidence cross-check | Sync, ~10 regex |

### Post-Round
- Ripple verification (LSP + tsc)
- Microcompact (forward)
- Gate overflow tracking
- Post-round batch typecheck
- Adaptive checkpoint

**Token cost: +1 FlashJudge call (~200-500 tokens) per completion attempt.** Rest is sync logic with negligible overhead.

---

## Scenario 5: 执行 shell / 安装依赖 / git 操作

**Intent**: `narrow_edit` (same as scenario 4)

### Tool Policy — Additional Risk Layer

| Gate | Shell-specific behavior |
|------|------------------------|
| 1. Rate Limit | shell capped at 5/round |
| 2. Permission | Shell typically requires "ask" level |
| 8. ToolRisk | Shell categorized as Risk 4; patterns like `rm -rf`, `curl\|sh`, `mkfs` elevate to Risk 5 |

### ShellSideEffectGuard: wired in v0.3.0

`src/sandbox/side-effect-guard.ts`:
- 18 regex patterns (rm/mv/git destructive/permission changes)
- `analyzeSideEffects()` → SideEffectReport
- `checkScopeViolations()` post-exec scope check
- 29 tests
- **2 wire-points in loop.ts**: pre-execution (danger→block) + post-execution (report injection)

### What IS wired for shell safety

| Protection | Status |
|------------|--------|
| Permission gate (deny/ask) | ✅ Wired |
| ToolRisk classification (Risk 4-5 block) | ✅ Wired |
| Rate limiter (max 5 shell/round) | ✅ Wired |
| SandboxManager (Job Object + Path Guard) | ✅ Wired for Windows |
| Timeout (hard cap) | ✅ Wired |
| ShellSideEffectGuard (pattern classifier) | ✅ **Wired v0.3.0** — pre-execution danger block + post-execution report injection |
| Pre-snapshot / post-diff | ❌ Not implemented (only PathGuard as post-hoc audit) |
| Rollback suggestion | ❌ Not implemented for shell commands |

**✅ Fixed (v0.3.0)**: `analyzeSideEffects()` wired into loop.ts at 2 points: pre-execution danger check (danger severity → block before shell runs) and post-execution report injection (warning severity → inject report into tool result for agent awareness).

---

## Cost Gradient Summary

```
Scenario          Pre-Round  Tool Policy  Sync Chain  External  FlashJudge  Evidence  Truthfulness  POST
──────────────────────────────────────────────────────────────────────────────────────────────────────────
1. Discuss/Chat    ✅ O(1)    ✅ O(1)      early-exit  SKIP      SKIP        pass      ✅ regex       SKIP
2. Architecture    ✅ O(1)    ✅ O(1)      early-exit  SKIP      SKIP        pass      ✅ regex       SKIP
3. Read Code       ✅ O(1)    ✅ O(1)      early-exit  SKIP      SKIP        pass      ✅ regex       SKIP
4. Write Code      ✅ O(1)    ✅ O(1)      ✅ full     ✅ full    ✅ API      ✅ full   ✅ regex       ✅ full
5. Execute Shell   ✅ O(1)    ✅ O(1)      ✅ full     ✅ full    ✅ API      ✅ full   ✅ regex       ✅ full
```

### Token Cost Per Extra Gate

| Component | Tokens | Frequency |
|-----------|--------|-----------|
| Pre-round gates (all 5) | 0 (in-process logic) | Every round |
| Tool policy (all 9) | 0 (in-process logic) | Per tool call |
| Sync completion chain | 0 (in-process logic) | Per turn with no tool calls |
| FlashJudge | ~200-500 tokens (Flash API) | Per completion attempt (scenario 4/5 only) |
| Typecheck (tsc --noEmit) | 0 tokens (shell, not API) | Once per write round |
| Ripple verification | 0 tokens (LSP, not API) | Per modified file |

**Key insight**: 80% of the gate system is zero-token synchronous code. The only token costs come from FlashJudge (completion verification) and FlashTriage (session start) — both are cheap (~1/10 cost) Flash model calls. The loop is NOT "heavy by default" — it's lightweight for low-risk scenarios and escalates proportionally.

---

## Gaps to Close (Phase 7 candidates)

| # | Gap | Scenario | Priority |
|---|-----|----------|----------|
| 1 | Architecture plan gets same gates as casual chat | Scenario 2 | P1 |
| ~~2~~ | ~~ShellSideEffectGuard dead wiring~~ | ~~Scenario 5~~ | ~~Fixed v0.3.0~~ |
| 3 | TruthfulnessGate only checks typecheck/test/build claims | Scenario 2 | P1 |
| 4 | No pre-execution file snapshot for shell commands | Scenario 5 | P2 |
| 5 | No post-execution scope violation check wired | Scenario 5 | P1 |
| 6 | No dedicated "plan vs implemented" claim detection | Scenario 2 | P2 |
| ~~7~~ | ~~classifyIntent keyword blind spots~~ | ~~All~~ | ~~Fixed v0.3.0~~ |

---

## Design Principle

> **The loop is NOT heavy by default. Cost scales with risk.**

- 讨论/读代码 → near-zero token overhead (only sync gate logic)
- 写代码 → +1 FlashJudge call at completion (~200-500 Flash tokens)
- Shell execution → same as write + ShellSideEffectGuard (wired v0.3.0)

No scenario pays for PatchTransaction, EvidenceLedger, Sandbox, or CompletionGate heavy path unless writes actually occur. The `intentPolicy.mode` early-exit pattern ensures this.
