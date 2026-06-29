# Architecture — DeepSeek Orcana

## Design Philosophy

> Every design decision answers one question: **"Does this make it harder for AI to write bad code?"**

Orcana is a single-agent terminal coding assistant. Its core differentiator is not feature count — it's the depth and diversity of constraints enforced per round.

### Module Status Legend

| Label | Meaning |
|-------|---------|
| 🟢 **stable** | Implemented, tested, wired, production-facing |
| 🟡 **partial** | Implemented but not fully wired, tested, or Phase 1 only |
| 🔵 **planned** | Documented but not yet implemented |

### Module Status Overview

| Module | Status | Notes |
|--------|--------|-------|
| Loop / Gate Chain (28 gates) | 🟢 stable | Core orchestrator, all gates wired and tested |
| Flash Triage | 🟢 stable | Semantic entrance classification, Flash model |
| Flash Judge | 🟢 stable | Independent completion verifier, circuit breaker |
| Ripple Engine 2.0 | 🟢 stable | 7 layers, 212 tests, 8.5/10 score |
| Context Budget / Epoch | 🟢 stable | 4-layer context, tool chain guard |
| Sandbox (Windows) | 🟢 stable | Job Object, PathGuard, env filtering, timeout |
| Sandbox (macOS/Linux) | 🟡 partial | Degraded to env filtering + timeout only |
| MasterPlan / TaskPacket | 🟡 partial | Wired but node→mode transition still stub |
| ModeContract | 🟡 partial | 5 modes defined, shouldTransitionMode stub |
| PatchTransaction | 🟡 partial | Phase 1 complete, Phase 2 atomics pending |
| EvidenceLedger | 🟡 partial | Phase 1, dual-write with legacy verification |
| Completion Gates | 🟡 partial | Gates inline in loop, not single-path yet |
| HookSystem | 🟡 partial | PreTool/PostTool only, lifecycle events planned |
| Checkpoint / Rewind | 🟡 partial | SHA + SQLite base, missing CLI /rewind UX |
| MCP Bridge | 🟡 partial | Tools only, resources/prompts deferred |
| Skills Registry | 🟡 partial | Trigger-based prompt append, no lifecycle stats |
| ModelRouter (purpose routing) | 🟡 partial | Session model pinning, cheap subcall routing off |
| FIM Editor | 🟡 partial | DeepSeek beta API, pending tx protection |
| State Machine | 🟡 partial | Monitoring layer, not primary behavioral driver |
| TUI | 🟡 partial | Core working, missing plan approval/evidence/rewind UX |
| Secret Redaction | 🟡 partial | Trace only, not unified across all paths |
| Context Map Pipeline | 🔵 planned | Interfaces exist, not fully wired |
| Context Memory OS | 🔵 planned | Protocol-level, separate integration PR |
| Recursive Evolution OS | 🔵 planned | Protocol-level, separate integration PR |
| Multi-Agent (T3R) | 🔵 planned | Post-v1.0, single-agent first |

---

## Loop Anatomy — Per-Round Gate Chain

Each round of `agentLoop()` in [`src/agent/loop.ts`](src/agent/loop.ts) passes through this sequence:

```
ROUND START
  │
  ├─ [1] Context Budget Gate          — WARN at 50% / BLOCK at 60% (env-configurable)
  ├─ [2] Dynamic Tool Disclosure      — selectTools() drops irrelevant tools to save tokens
  ├─ [3] Intent Gate                  — readonly mode disables write tools
  ├─ [4] ContextReadiness Gate        — high-risk missing context → write tools disabled
  ├─ [5] Ripple Block Gate            — structural issues → write tools disabled
  ├─ [6] Permission Gate              — three-tier allow/deny rules, deny always hard-blocks
  ├─ [7] Rate Limiter                 — shell ≤5, file ≤10, network ≤3 per round
  │
  ▼ PROVIDER STREAM
  │
  ├─ [8] Provider Stream Recovery     — long-task vs generic recovery prompts on error
  │
  ▼ NO TOOL CALLS? → Final Text Gates
  │
  ├─ [9] Ripple Exit Gate             — unresolved cascade obligations → continue
  ├─ [10] Planning Gate                — plan quality eval (missing items, score)
  ├─ [11] Task Tracker Completion      — all steps done? verification evidence present?
  ├─ [12] Quality Gate                 — confidence + contracts + typecheck → retry/accept
  ├─ [13] External Completion Gate     — regex-based evidence checklist
  ├─ [14] Flash Judge                  — independent Flash model evaluates completion
  │
  ▼ TOOL EXECUTION
  │
  ├─ [15] Self-Learning Error Tracker  — repeated failures → escalating system prompts
  ├─ [16] Smart Truncation             — head+tail with error-aware allocation
  ├─ [17] Parallel Readonly Execution  — all readonly tool calls in a round run concurrently
  ├─ [18] Ripple Verification          — LSP fast path / tsc ground truth per modified file
  ├─ [19] Microcompact (forward)       — trim large tool results before history
  ├─ [20] Gate Overflow Tracker        — 3 blocks → strategy switch, 5 blocks → BLOCKED
  ├─ [21] Post-Round Batch TypeCheck   — tsc once per round, not per file
  │
  ▼ HISTORICAL (periodic)
  │
  ├─ [22] Microcompact (retrospective) — compact historical results every 10 rounds
  ├─ [23] Thinking Compaction          — compress chains at 40% context budget
  ├─ [24] Semantic Recall              — L3 volatile context via Flash-scored similarity
  ├─ [25] Knowledge Distillation       — web_search results → knowledge base
  ├─ [26] Knowledge Reconciliation     — prune + FTS5 rebuild every 50 rounds
  ├─ [27] Adaptive Checkpoint          — density-aware snapshot (complexity × budget)
  └─ [28] Revise Plan                  — stuck detection → push back to planning
```

> **28 distinct safety mechanisms per round.** Most coding agents have 3-5.

---

## Deep Dives

### 1. Gate Overflow — Cumulative Block Escalation

`loop.ts:1562-1607`

When any gate blocks the agent, a counter increments. At **3 blocks**, the system injects a targeted strategy-switch prompt (plain text `<system-reminder>` — the model can still choose to ignore it). At **5 blocks**, the agent enters `BLOCKED` state — game over, human must intervene. **Limitation:** the 3→5 window is only 2 chances via natural-language prompts; there is no structural enforcement until the hard BLOCKED state.

```
Gate-specific escalation messages:
  ripple → "停止逐文件编辑，用 multi_edit 级联修复所有调用方"
  ripple_obligations → "读取被影响的调用方文件并级联修复"
  planning → "缩小任务范围，列出最小可交付单元"
  completion → "检查是否缺少外部验证证据"
  required_files → "立即创建缺失的必需文件"
```

### 2. Self-Learning Error Tracker

`loop.ts:96-123`

No LLM call needed. Pure pattern-matching state machine:

```
count=1: silently record
count=2: inject system prompt → "工具重复失败，请用 web_search 搜索此错误并学习正确用法"
count≥4: inject system prompt → "已失败 N 次，放弃当前方案，向用户承认困难"
```

Key: the same error key (`toolName + content[:80]`) must match across rounds, preventing false positives on different errors from the same tool.

### 3. Flash Judge — Independent Completion Verifier

`src/agent/flash-judge.ts`

A completely separate model call (always `deepseek-v4-flash`, ~1/10 cost of Pro) that reads the conversation tail and evaluates whether the task is truly complete.

**Design invariants:**
- **Reduced identity bias**: Flash runs in separate stateless API calls — it has no "skin in the game" from generating the output it evaluates. However, it shares the same base model training distribution as the main agent, so systematic biases from that distribution are not eliminated — only self-justification of its own outputs is blocked.
- **Circuit breaker**: max 3 evaluations per task
- **Three verdicts**: SATISFIED / NOT_SATISFIED / IMPOSSIBLE
- **Testimony Ledger**: tracks agent promises vs evidence across rounds, detects circular promises ("I'll test next round" × N never delivered)

```
Judge flow:
  agent claims done → Flash reads conversation tail →
    SATISFIED → break (task complete)
    NOT_SATISFIED → inject gaps as user message → agent must fix
    IMPOSSIBLE → terminal message → agent must admit defeat
```

### 4. Flash Triage — Semantic Entrance Classification

`src/agent/flash-triage.ts`

One Flash model call at session start replaces 4 keyword-based classifiers:
- `classifyIntent` → `triageModeToIntent`
- `classifyResearchRoute` → `triage.needsWeb + researchQueries`
- `activateSkills` → `triage.relevantSkillNames`
- `createTaskTracker` → `buildTrackerFromTriage`

```
Input: user prompt + project file tree
Output: {mode, needsWeb, researchQueries, planSteps, requiredVerification, riskLevel}
Fallback: keyword classifiers (graceful degradation)
```

Config: `DEEPSEEK_FLASH_TRIAGE=off|auto|always` (default: auto — short prompts <240 chars auto-skip)

### 5. Ripple Engine 2.0 — TypeScript-Aware Dependency Analysis

`src/ripple/` · 7 layers · 8.5/10 · 212 tests · [Full docs →](docs/ripple-engine.md)

When the agent edits a TypeScript file, Ripple traces how the change propagates through the entire codebase and blocks the write until every affected caller is handled.

```
old + new content
  → L1 API Diff (8 change kinds, pre-computed severity)
  → L2 Semantic Reference (PRIMARY caller discovery via TypeChecker)
  → L7 AstGrep Provider (ENRICH — 6 pattern types per symbol, graceful degrade)
  → L3 Usage Classifier (14 usage kinds → 500+ concrete required actions)
  → L4 Verification Map (auto-discovers test files, estimates coverage, rates strictness)
  → L5 Obligation Gate (hard exit gate — non-waived obligations block completion)
  → RippleReport → Gate decision (allow / warn / block)
```

**7 source files**: `api-diff.ts` · `program.ts` · `semantic-reference-provider.ts` · `usage-classifier.ts` · `obligations.ts` · `verification-map.ts` · `astgrep-provider.ts` · `engine.ts` · `types.ts`

**Key features**: semantic-first caller discovery · 8 structured change kinds · 14 usage pattern classifier · waiver-with-reason obligation system · convention-based test file discovery · ast-grep external enrichment · zero-cost graceful degradation

### 6. Sandbox — Defense-in-Depth 🟢 stable / 🟡 partial

`src/sandbox/sandbox.ts`

| Layer | Mechanism | Scope |
|-------|-----------|-------|
| **Job Object** | kernel32 `CreateJobObject` — process tree kill-on-close | Windows only |
| **Path Guard** | Post-exec file change detection (audit, not prevention) | Cross-platform |
| **Env Filtering** | Whitelist-only environment variables (42 vars) | Cross-platform |
| **Timeout** | Hard cap on shell execution time | Cross-platform |
| **Ripple Blocks** | Shell commands that write to ripple-blocked files are denied | Cross-platform |

**Honest limitations documented in code:**
- Path Guard is post-hoc, not real-time
- No network isolation (requires admin)
- No filesystem interception during execution (requires kernel driver)
- macOS/Linux: degraded to env filtering + timeout only

### 7. Context Budget — Three-Tier Token Management

`loop.ts:294-315`

```
normal   (<50%): full tools, all features
degraded (50-60%): finish current atomic stage, no new exploration
block    (>60%):  stop, must compact or start fresh continuation
```

Both thresholds are `DEEPSEEK_CONTEXT_WARN_RATIO` / `DEEPSEEK_CONTEXT_BLOCK_RATIO` env-configurable.

When degraded, `buildContextBudgetMessage()` injects a guard message: "Continue only the current atomic stage. Do not expand scope."

### 8. Microcompact — Two-Phase Token Conservation

`loop.ts:2114-2195`

**Forward pass** (fresh results, every round at ≥35% budget): trims oversized `read_file`/`shell`/`web_fetch` results to configurable thresholds, replacing body with a `[Microcompact: ...]` placeholder.

**Retrospective pass** (historical results, every 10 rounds after round 15): compacts old tool results, preserving only the last N rounds of conversation.

Configurable thresholds:
- `DEEPSEEK_READFILE_COMPACT_CHARS` (default: 0 = off)
- `DEEPSEEK_SHELL_COMPACT_CHARS` (default: 3000)
- `DEEPSEEK_WEBFETCH_COMPACT_CHARS` (default: 5000)

### 9. Smart Truncation — Error-Aware Content Preservation

`loop.ts:1357-1376`

When tool output exceeds thresholds (60 lines / 12KB), instead of blind head truncation:

```
has errors in tail? → 70% head, 30% tail (preserve error context)
no errors?         → 85% head, 15% tail (preserve more content)
```

Marker changes: `"... [N lines trimmed — errors detected in tail] ..."` vs `"... [N lines trimmed] ..."`

### 10. Frozen Stable Prefix — Anthropic Cache Optimization

`loop.ts:733-742`

The system prompt, project context kernel, cold memory, and skill prompts are computed once in round 0 and frozen. All subsequent rounds reuse this byte-identical prefix, preserving Anthropic's server-side prefix cache. Context mutations are injected as **volatile messages** appended after the prefix, never modifying it.

### 11. Post-Round Batch TypeCheck

`loop.ts:1652-1670`

Instead of running `tsc` on every file write (potentially N redundant calls per round), the loop collects all modified `.ts`/`.tsx` files and runs `tsc --noEmit` **once** after all tool results. Diagnostics are filtered to only the round's modified files and appended to the last tool result for the next round.

### 12. Provider Stream Recovery

`loop.ts:949-1001`

Two distinct recovery paths when the provider stream fails:
- **Long task** (task tracker active): checks `missingTaskRequirements`, retries if items remain
- **Generic** (no tracker): simpler retry with "interrupted round" prompt

Both paths have a max round guard — if at `maxRounds`, blocked rather than infinite loop.

### 13. Parallel Readonly Execution — "Greedy Tools"

`loop.ts:1225-1249`

When all tool calls in a round are readonly, concurrency-safe, and not `web_search`, they execute in parallel via `Promise.all`. Reduces wall-clock time for information-gathering rounds.

### 14. Rate Limiter

`loop.ts:1259-1274`

Per-round hard caps prevent tool-spam loops:
- `shell`: 5 calls/round
- `file`: 10 calls/round
- `network`: 3 calls/round

### 15. Hook System 🟡 partial

`loop.ts:167-225`

Before/after hooks per tool. Hooks can:
- **Block** a tool call (return blocked ToolResult)
- **Warn** (warning appended to tool output)
- **Modify** the result (after-hook can transform ToolResult)

Custom hooks are registered via `HookSystem` and injected at agent construction — user scripts, policy enforcement, logging, etc.

### 16. State Machine — Explicit Lifecycle 🟡 partial

`src/agent/state-machine.ts`

```
IDLE → UNDERSTAND → SEARCH ⇄ PLAN → CODE → VERIFY → DONE
                                           ↑        ↓
                                           └─ REPAIR ←┘
  Any state → BLOCKED (fatal)
```

**Transition validation**: `StateMachine.transition()` throws on illegal transitions. The map of `ALLOWED_TRANSITIONS` is explicit — every possible state change is enumerated.

**State-based tool filtering**: `READ_ONLY_STATES` = {IDLE, UNDERSTAND, SEARCH, PLAN, VERIFY}; `WRITE_STATES` = {CODE, REPAIR}.

**Current status**: State machine is a **monitoring layer**. Transitions are eagerly attempted in `updateStateMachine()`, but ad-hoc flags (`intentPolicy`, `rippleBlockActive`, `taskTracker`) remain the primary behavioral drivers. Failed transitions are caught silently (line 2231-2233).

### 17. Contracts — Pre/Post Conditions

`src/agent/contracts.ts`

Checked at state transitions:
- **Preconditions**: what must be true to ENTER a state (e.g., "must have read files before CODE")
- **Postconditions**: what must be true to LEAVE a state (e.g., "VERIFY → DONE: typecheck must have passed")
- **Invariants**: continuous checks each round

Violations produce a `ContractViolation` with `fatal` flag and optional `repair` suggestion. Non-fatal violations feed into the Quality Gate; fatal violations force `repair()`.

### 18. Cost Policy — Budget Control

`src/provider/cost-policy.ts`

Two modes: `normal` / `strict`.

**Strict mode disables 10 optional provider calls:**
```
chat_lite, thinking_compaction, semantic_recall_score,
knowledge_distill, flash_triage, completion_judge,
plan_judge, ambiguity_detector, cold_memory_audit
```

Set via `DEEPSEEK_COST_MODE=strict`.

### 19. Thinking Compaction — Long-Session Memory

`loop.ts:1744-1817`

At 40% context budget, compresses accumulated thinking chains using the Flash model:
1. Collect all assistant thinking blocks from history
2. Call compaction agent: extract key_insights, discarded, verified, open
3. Merge into stable cold memory (dedup + semantic merge)
4. Inject compacted insights as user message (preserves prefix cache)

**One-shot per session** — only fires once, regardless of budget.

### 20. Knowledge Distillation — Web Search → Memory

`loop.ts:1969-1986`

When `web_search` succeeds, results are distilled into the knowledge base:
- Triggered by error-context searches
- Uses Flash model for extraction
- Best-effort (`.catch(() => {})`) — doesn't block next round

### 21. Semantic Recall — Historical Context Injection

`loop.ts:1819-1861`

Every 3 rounds, the thinking store finds semantically similar past records using a Flash-scored similarity ranking. Relevant historical context is injected as L3 volatile context — does not affect prefix cache.

**Fallback**: keyword-based overlap if semantic scoring fails or is disabled by cost policy.

### 22. Runtime Self-Edit Gate

`loop.ts:357-395, 1869-1890`

Detects when the agent edits its own source files (any file under `src/agent/`, `src/tools/`, `src/ui/`, etc.). Response:
1. Run root project typecheck
2. If passes → tell user to restart DeepSeek Code
3. If fails → inject gate message: "You changed runtime source… must verify then restart"
4. If both fail at maxRounds → break

### 23. Clarification Gate

`loop.ts:592-649`

Before any planning, evaluates whether the user's request is ambiguous. If yes:
1. Calls the Pro model with a structured clarification prompt
2. Parses the model response into structured questions
3. Yields `clarification_ready` event → CLI presents questions to user
4. `return` (stops the loop, waits for user response)

### 24. Research Router

`loop.ts:651-676`

Decides whether the task needs web research:
- Flash Triage result → `needsWeb` + `researchQueries`
- Fallback: keyword-based `classifyResearchRoute`
- If research needed: auto-collects evidence via `collectResearchEvidence()` (up to 3 queries)
- Inserts research context before raw messages

### 25. Adaptive Checkpoint

`loop.ts:1928-1966`

Checkpoint density adapts to both context pressure and task complexity:
```
adaptiveCheckpointThreshold(contextBudget%, complexityMetrics)
  complexityMetrics = {filesPerRound, errorRate, round}
```

Saves structured snapshot: session ID, master plan, task steps, changed files, verification results, conversation token count.

## DeepSeek V4 — Unique Mechanisms

Orcana's entire multi-tier reasoning architecture depends on capabilities that only DeepSeek V4 provides. These are not generic LLM features — they are DeepSeek-specific APIs and model behaviors that the codebase is architected around.

### 1. Thinking / Reasoning Tokens (V4 Proprietary)

`src/provider/deepseek.ts:145-184`

DeepSeek V4 emits `thinking_delta` stream events — the model's internal reasoning chain exposed as a separate content block type with its own signature. Orcana captures, stores, and operationalizes these:

```
stream event → content_block_start(type="thinking") →
  thinking_delta → accumulate → content_block_stop →
    thinkingBlocks[] → ThinkingStore.persist()
```

**Downstream uses of thinking chains:**

| Use | Where | Mechanism |
|-----|-------|-----------|
| **Thinking Store** | `memory/thinking-store.ts` | JSONL-persisted reasoning records with tags + query hashes |
| **Compaction** | `loop.ts:1744-1817` | At 40% budget, Flash model compresses chains into `key_insights/verified/discarded/open` → merged into cold memory |
| **Semantic Recall** | `loop.ts:1819-1861` | Every 3 rounds, Flash-scored similarity search over historical chains → inject relevant context |
| **Token Accounting** | `loop.ts:1196` | thinking blocks counted separately from output tokens for budget tracking |
| **Cache Anatomy** | `context/cache-anatomy.ts` | Thinking overhead monitored; >40% of budget triggers thinking compaction |

**Why this matters**: No other provider exposes reasoning chains at the protocol level with this granularity. OpenAI's "reasoning" is a black-box mode toggle. Anthropic doesn't expose it at all.

### 2. Flash Model as Multi-Purpose Sub-Processor

`src/provider/registry.ts:52-60`

DeepSeek V4 Flash (`deepseek-v4-flash`) — ~1/10 cost, ~1/3 latency, no thinking overhead. Orcana uses it as a **sub-processor** in 6 independent roles:

| Role | Module | Purpose |
|------|--------|---------|
| **Flash Judge** | `agent/flash-judge.ts:56` | Independent completion verifier — reads conversation, returns SATISFIED/NOT_SATISFIED/IMPOSSIBLE |
| **Flash Triage** | `agent/flash-triage.ts:35` | One-call semantic classification replacing 4 keyword classifiers |
| **Thinking Compaction** | `loop.ts:1762` | Compresses accumulated thinking chains into structured insights |
| **Semantic Recall** | `loop.ts:1834` | Scores historical thinking chain relevance to current query |
| **Knowledge Distillation** | `memory/distiller.ts:92` | Extracts structured knowledge from web search results |
| **Plan Judging** | `evaluator/plan-judge.ts` | Cold model evaluates the agent's plan from outside the conversation |

Each role has its own prompt template, circuit breaker, and graceful degradation path. The Flash model never touches the main conversation — it operates in **separate, stateless calls** preventing self-justification bias (the evaluator didn't write what it's judging). **Limitation:** all models share the same training distribution, so systemic biases from that distribution are not eliminated — only direct self-evaluation loops are broken.

### 3. Fill-in-the-Middle (FIM) — V4 Beta API

`src/provider/fim.ts` + `src/tools/file.ts:445`

DeepSeek V4 exposes a `/beta/completions` endpoint with FIM support — given `{prompt, suffix}`, the model fills the middle. Orcana exposes this as the `edit_fim` tool:

```
Agent: edit_fim { filePath, instruction, startLine, endLine }
  → FimEditor reads file, splits at line boundaries
  → POST /beta/completions { prompt: prefix, suffix: suffix }
  → Returns filled middle text
```

Also supports `editFunction(filePath, instruction, functionName)` — scans for function boundaries and fills within them. This is **not** a generic LLM feature — it's a DeepSeek-specific API endpoint.

**Risk note:** The `/beta` prefix on this endpoint means the API contract, pricing, and availability are not guaranteed stable. If DeepSeek changes this endpoint, both `edit_fim` and `editFunction` break — these are dependencies in the core editing toolchain. The fallback is the standard `edit_file` tool (search-and-replace), but for large refactors this degrades to significantly more API calls. Consider monitoring the `/beta` → stable transition timeline.

### 4. 1M Context Window + Budget Gating

`loop.ts:684` — `CONTEXT_MAX = 1_048_576`

The entire budget gating system is calibrated to a 1M token window:

```
normal   (<524K):  all features active
degraded (524K-629K): finish current stage, no new exploration
block    (>629K):   force compaction or fresh continuation
```

Thresholds are configurable via `DEEPSEEK_CONTEXT_WARN_RATIO` / `DEEPSEEK_CONTEXT_BLOCK_RATIO`.

### 5. Prefix Auto-Caching

`src/provider/deepseek.ts:42-58` + `src/provider/cache-tracker.ts`

DeepSeek V4 auto-caches prompt prefixes. Orcana explicitly marks cache breakpoints:

```typescript
// deepseek.ts:47-58
const cacheControl = { type: "ephemeral" }
system: [{ type: "text", text: options.system, cache_control: cacheControl }]
messages[0]: [{ type: "text", text: m.content, cache_control: cacheControl }]
```

The **Frozen Stable Prefix** pattern (`loop.ts:733-742`) exploits this: system prompt + project context kernel + cold memory + skill prompts are computed once in round 0 and frozen. All subsequent rounds keep this prefix byte-identical, so DeepSeek's server-side cache hits on every round.

`CacheTracker` (`provider/cache-tracker.ts`) models the real prefix shape (model + system + tools + messages), predicts hit/miss, and surfaces `firstChangedSection` for debugging.

### 6. Thinking Budget Auto-Escalation

`src/provider/router.ts:62-70`

V4 Pro supports two thinking effort tiers: `high` (16K tokens) and `max` (32K tokens). Orcana auto-escalates:

```
consecutiveErrors ≥ 3  →  max thinking (32K)
modifiedFiles ≥ 5      →  max thinking (32K)
readonly mode          →  high thinking (16K)
```

Additionally, the **agent itself** can request max thinking via the `request_deeper_thinking` meta-tool (`loop.ts:1383-1385`): when the model realizes it's stuck, it calls this tool and the next round gets a 32K thinking budget.

### 7. Cost Mode — Two-Tier Budget Control

`src/provider/cost-policy.ts`

```
normal: all 10 optional Flash calls enabled
strict: 10 optional calls disabled (chat_lite, thinking_compaction,
        semantic_recall_score, knowledge_distill, flash_triage,
        completion_judge, plan_judge, ambiguity_detector,
        cold_memory_audit)
```

Set via `DEEPSEEK_COST_MODE=strict`. In strict mode, the agent works with Pro-only calls — all Flash sub-processing is cut.

### Summary: What Orcana Gets From V4 That No Other Model Provides

| V4 Capability | Orcana Usage | Alternative on Other Models |
|---------------|-------------|----------------------------|
| **Thinking tokens** | Persist, compact, recall reasoning chains | ❌ Not available |
| **Flash model** | 6 independent sub-processor roles | Separate API key to another provider |
| **FIM endpoint** | `edit_fim` tool | ❌ Not available |
| **1M context** | 50-round loops with 28 gates | Smaller window → more compaction |
| **Prefix auto-cache** | Frozen stable prefix across all rounds | No cache → 5-10× cost increase |
| **Thinking budget tiers** | Auto-escalate to 32K on error cascades | ❌ Not available |
| **Cost mode** | Normal/strict toggle | No equivalent |

## Tool System

`src/tools/registry.ts` + individual tool files

### Built-in Tools (22 total)

| Category | Tools | Source |
|----------|-------|--------|
| **File** | `read_file`, `write_file`, `edit_file`, `multi_edit`, `edit_fim`, `rollback_transaction` | `tools/file.ts:466` |
| **Shell** | `shell` (with streaming via `executeStream`) | `tools/shell.ts:331` |
| **Git** | `git_status`, `git_diff`, `git_log`, `git_blame` | `tools/git.ts:118` |
| **Search** | `web_search` | `tools/search.ts:110` |
| **Web** | `web_fetch` (blocks all private IPs) | `tools/webfetch.ts:181` |
| **CodeGraph** | `find_symbol`, `find_references`, `project_structure` | `tools/codegraph.ts:179` |
| **LSP** | `lsp_diagnostics`, `lsp_hover`, `lsp_definition`, `lsp_references` | `tools/lsp.ts:291` |
| **TypeScript** | `typescript` (tsc --noEmit) | `tools/typescript.ts:57` |
| **Service** | `start_service` (health check + auto-kill) | `tools/service.ts:135` |
| **Meta** | `request_deeper_thinking` (model requests max thinking), `task` (task tracking) | `cli.ts:112,133` |
| **MCP** | Dynamically registered via bridge | `tools/mcp.ts` |

### Tool Architecture

- **Streaming**: Shell commands use `executeStream` — yields progress events during execution, final result on done
- **Parallel**: Readonly+concurrencySafe tools execute in parallel via `Promise.all`
- **Timeout**: Shell/multi_edit/edit tools 180s, others 60s
- **Confirmation**: Write tools require `confirm: true` in interactive mode; auto-allowed in non-interactive
- **Post-edit diagnostics**: ruff (Python) + LSP (TypeScript) run after each file write

## Memory System

`src/memory/`

| Component | File | Role |
|-----------|------|------|
| **Thinking Store** | `thinking-store.ts` | Persist + reuse reasoning chains (JSONL on disk) |
| **Knowledge Base** | `knowledge.ts` | SQLite-backed learned knowledge (FTS5 for search) |
| **Compactor** | `compactor.ts` | M0 checkpoints + delta memory + cold archive |
| **Distiller** | `distiller.ts` | Extract knowledge from web search results |
| **Hybrid Memory** | `hybrid.ts` | Unified interface over thinking + knowledge |
| **Tokenizer** | `tokenizer.ts` | CJK bigram+trigram + Latin word-split tokenizer |

### Tokenizer

`src/memory/tokenizer.ts`

Handles Chinese text correctly:
- **CJK**: character bigrams + trigrams (no space-based splitting)
- **Latin**: standard word-split
- Unified `tokenOverlap()` for fuzzy matching

## Provider Layer

`src/provider/`

- `deepseek.ts` — Primary: DeepSeek's Anthropic-compatible API
- `anthropic.ts` — Alternative: direct Anthropic API
- `openai.ts` — Alternative: OpenAI-compatible endpoints
- `multi.ts` — Round-robin multi-provider fallback
- `registry.ts` — Provider registration + duplicate guard
- `router.ts` — `ModelRouter.selectForPurpose()` — sub-purpose model selection
- `cost-policy.ts` — Two-tier cost mode (normal / strict)
- `cache-tracker.ts` — Prefix shape analysis for cache optimization
- `usage.ts` — Token usage merge + accumulation

## Configuration Files

| File | Location | Purpose |
|------|----------|---------|
| `settings.json` | `~/.deepseek-code/` | Provider, TUI, memory, sandbox, MCP |
| `mcp.json` | `~/.deepseek-code/` | MCP server definitions |
| `permissions.json` | `~/.deepseek-code/` or `<project>/.deepseek-code/` | Tool access rules |
| `.env` | Project root | API keys (never committed) |

Env-to-feature table (all with sensible defaults):

| Variable | Feature | Default |
|----------|---------|---------|
| `DEEPSEEK_FLASH_TRIAGE` | Semantic entrance classification | `auto` |
| `DEEPSEEK_CONTEXT_WARN_RATIO` | Context budget warning threshold | 0.5 |
| `DEEPSEEK_CONTEXT_BLOCK_RATIO` | Context budget block threshold | 0.6 |
| `DEEPSEEK_COST_MODE` | Disable optional calls | `normal` |
| `DEEPSEEK_PERMISSION_MODE` | Ask→allow auto-promotion | `full` |
| `DEEPSEEK_SANDBOX_TIMEOUT_SEC` | Shell timeout | 30 |
| `DEEPSEEK_SANDBOX_MEMORY_MB` | Job Object memory limit | 512 |

## Anti-Loop Engineering

The most distinguishing feature of Orcana is the **diversity of mechanisms** preventing infinite loops:

1. **Hard caps**: `maxRounds=50`, rate limits, tool timeouts, provider idle timeout
2. **Escalating signals**: Error tracker (2→4), gate overflow (3→5)
3. **Independent verifiers**: Flash Judge has no identity alignment with main agent
4. **Stuck detection**: Revise plan when no progress + 3 consecutive errors
5. **Context pressure**: Auto-compact at 40%, block at 60%
6. **Circuit breakers**: Flash Judge 3/task, Flash Triage 1/session, thinking compaction 1/session

## Anti-Patterns (Do-Not-Repeat)

These are hard-won lessons from development, recorded to prevent regression:

| # | Lesson | Source |
|---|--------|--------|
| 1 | Don't define constraints in standalone modules — wire them into `loop.ts` | 3 systems defined but unused found during audit. **Note:** for a "constraint-first" project, this is the most damaging type of failure — mechanisms that exist in code but don't execute. The GateChain refactor (2026-06-24) directly addresses this by making all gates pass through a single `evaluate()` path with telemetry verification. |
| 2 | Don't insert messages between `tool_use` and `tool_result` — DeepSeek API 400 | `loop.ts:750-752` |
| 3 | Don't use `split(/\s+/)` for Chinese — use CJK bigram+trigram | `memory/tokenizer.ts:6-7` |
| 4 | Don't run `tsc` per file — batch once per round | `loop.ts:1652` |
| 5 | Don't collect research evidence just once — it goes stale | `loop.ts:659` re-collects |
| 6 | Don't silently swallow rollback failures | `tools/file.ts:263-264` catches and reports |

## Infrastructure

| Layer | Technology |
|-------|-----------|
| Runtime | Bun ≥1.3 |
| TUI | Ink 7 (React for terminal) |
| Provider | Anthropic SDK (DeepSeek-compatible endpoint) |
| MCP | Custom bridge → `~/.deepseek-code/mcp.json` |
| LSP | TypeScript compiler API + `ts.createProgram` |
| Memory | SQLite (FTS5) + JSONL on disk |
| Sandbox | Win32 Job Objects + PathGuard |
| Config | JSON flat-files (settings.json, mcp.json, permissions.json) |

## Context Systems 🟡 partial / 🔵 planned

The current architecture has a protocol layer for long-running context, project maps, and
controlled self-evolution. The core modules remain pure TypeScript surfaces so they can be
replayed and validated without live model calls. `ContextMap` has now crossed into runtime:
`agentLoop()` can build a map before coding rounds, inject it into the stable provider context,
and attach its evidence to `TaskPacket`/`MasterPlan` nodes.

| Module | Purpose |
|--------|---------|
| `src/memory/context-memory-os.ts` | Four-layer context memory pack, capsule validation, retrieval, update proposals, and cache telemetry |
| `src/context/context-map.ts` | Project constitution loading, repository structure mapping, hybrid text/AST locating, context readiness checks, and TaskPacket evidence attachment |
| `src/evolution/evolution-os.ts` | Capability-gap detection, knowledge capsule generation, upgrade proposal validation, policy checks, sandbox planning, and failure replay case creation |
| `src/agent/replay-harness.ts` | Deterministic replay coverage for `context_memory` and `context_map` protocol cases |

Runtime `ContextMap` enforcement is conservative: `DEEPSEEK_CONTEXT_MAP=off|auto|always`
controls acquisition, `auto` targets long/high-risk/explicit-file coding work, and high-risk
readiness blockers disable write tools until more locate/read/search evidence exists. Context
Memory OS and Evolution OS are still protocol-level and should be wired in separate integration
PRs after their contracts stay stable under replay.

See [`docs/orcana-context-systems.md`](docs/orcana-context-systems.md) for the data flow,
boundaries, and verification commands.
