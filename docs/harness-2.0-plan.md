# Orcana Runtime Harness 2.0 整体实施方案

**方案版本：** H2.0
**适用阶段：** Loop 减重已完成约一半
**核心目标：** 把 Orcana 已有的权限、状态、工具、证据、事务、上下文和恢复机制，收敛为一套稳定、隔离、可恢复、可评测的 Agent Harness。
**后续承接：** Unified Node Runtime、Execution Graph、System Knowledge Graph、Multi-Agent。

## 实施进度

| PR | 状态 | 日期 | 备注 |
| --- | --- | --- | --- |
| H0 Contracts | 完成 | 2026-08-02 | `src/harness/contracts/*`（harness/session/run/outcome/events/interrupt/artifact/capability/budget/errors/schema/snapshot/lifecycle）+ `src/harness/index.ts`；类型完整、无 `any`、不依赖 UI/具体 Provider、不导入 `loop.ts`；`tests/harness_contracts.test.ts` / `harness_outcome.test.ts` / `harness_status_transition_types.test.ts` 共 17 项；门禁绿色。**技术债：** `AgentRunScope` 的 7 个字段（planStore/modeStore/patchContext/sandbox/rippleSession/evidenceLedger/artifactStore/cancellation/trace）与 `RunSnapshot` 的 plan/mode/budget/evidence state 当前以 `unknown` 占位——这是有意为之（避免触发 H0"停止条件"：Contract 引用遗留内部类型即停止接线），H3 Run Scope 时须替换为真实、可序列化类型 |
| H1 Facade / Adapter | 完成 | 2026-08-02 | `src/harness/runtime/{agent-harness,legacy-loop-adapter,run-registry}.ts`；CLI/TUI 生产入口改走 `AgentHarness.run()`（`agentLoop` 直接调用清零）；`cancel` 桥接 abortSignal、`inspect` 返回 RunSnapshot、`resume` H7 占位；`HarnessEvent` 契约扩展 4 个 bridge 变体（toolCall/display/planReady/clarification）；顺带修复 CLI plan 批准重跑 `planText` 未回传 bug；`tests/harness_legacy_adapter.test.ts` 8 项 + `harness_facade.test.ts` 5 项；全量 139 文件门禁绿色。**技术债：** 动态选项经 `AgentRunInput.metadata` 的 `LEGACY_*` key 传输（H1 过渡机制，H4/H7 正式化）；`AgentRunScope` 9 字段仍 `undefined` 占位（H3 替换）；run 终态仅 created→running→terminal 三档（H2 引入 LifecycleMachine） |
| H2 Lifecycle / Outcome | 完成 | 2026-08-02 | `agentLoop` 生成器返回值暴露 `LoopDecision`；新增 `src/harness/runtime/{outcome-mapper,lifecycle-machine,run-controller,cleanup}.ts`；`LoopDecision → RunOutcome` 穷尽映射（编译期保证无未分类退出）；`RunLifecycleMachine` 驱动 `run.status`（含 pausing 中间态）+ run.* 生命周期事件；事件流 sequence 统一（bridge 与 lifecycle 共享 `run.eventSequence`）；`tests/harness_lifecycle.test.ts` 7 场景 + `harness_lifecycle_machine.test.ts` 6 项；全量 141 文件门禁绿色。**技术债：** `completed.reportArtifactId`/`waiting.checkpointId` 仍占位（H7/H8 填充）；异常仍向调用方传播（outcome 已记录）；kernel 层 stopReason 与 harness outcome 并存（两层语义，行为冻结） |
| H3 Run Scope / Isolation | 完成 | 2026-08-02 | `AgentRunScope` 9 个 `unknown` 占位替换为真实类型（`contracts/scope.ts`：ModeStore/PatchContextStore/RippleSession/RunCancellation/TraceWriter + L2 的 PlanStore/EvidenceLedger/SandboxManager）；`run-registry` 每 run 装配完整 scope；**唯一所有权打通**：harness 的 planStore/sandbox 经 `AgentOptions.planStore/sandbox` 注入 kernel（同一实例）；`inspect` 返回可序列化 plan/mode 快照；`tests/harness_run_isolation.test.ts` 4 项 + `harness_scope.test.ts` 5 项（双 run 并行 plan/mode/patch/sandbox/cancel 不串）；全量 143 文件门禁绿色。**技术债：** mode/patch/ripple/budget 权威值仍在 kernel ALS（按 run 隔离），scope 快照为初始值——ALS→scope 迁移后续阶段；RunCancellation/TraceWriter 为桥接/占位（H4/H5 完整化）；`budgetState` 空（H4） |
| H4 Cancellation / Budget | 完成 | 2026-08-02 | `AgentRun.budget` 占位清除（真实 `BudgetLedger` Reserve-Commit 实现）；`runtime/{budget-ledger,budget-guard,cancellation}.ts`；超限产生明确原因并取消（model_call/tool_call/token/wall_time_budget → cancelled outcome reason）；wall-time 看门狗兜底卡死 run；`maxRounds → maxModelCalls` 映射；`AgentRunInput.budget` 限额入口；`inspect.budgetState` 真实快照；**零 kernel 改动**（行为冻结，预算治理在 harness 控制面 §3.4）；`tests/budget_ledger.test.ts` 6 项 + `harness_budget.test.ts` 6 场景（超限即停无后续事件）；全量 145 文件门禁绿色。**技术债：** write/external_action/repair 限额字段就绪但未挂接（kernel 事件无工具分类，H8/H9 接入） |
| H5 Typed Trace | 完成 | 2026-08-02 | **第一里程碑（H0–H5）收官。** `TraceWriter` 契约对齐 `EventEnvelope`；`src/harness/telemetry/{trace-writer,migration}.ts`：JSONL 类型化落盘（`.orcana/harness/events/<runId>.jsonl`，队列+节流批量写、写失败静默不影响 run、redactForTrace 统一遮蔽）+ 旧格式迁移（`migrateLegacyTraceLine` → Envelope）；事件流全部接入 trace（lifecycle + bridge，sequence 连续）；scorer `readRunEvents` 改共享类型解析（不再猜测字段）；`tests/harness_trace.test.ts` 6 项；全量 146 文件门禁绿色。**里程碑成果：** 正式 Harness API + 统一生命周期 + 明确 Outcome + 真正 Run 隔离 + 统一取消/预算 + 可重放类型化 Trace |
| H6 Store / Snapshot | 完成 | 2026-08-02 | `src/harness/persistence/{harness-store,file-harness-store,serialization,workspace-hash}.ts`：HarnessStore 契约（SerializableRun/Session/PlanState）+ FileHarnessStore（`.orcana/harness/{sessions,runs,snapshots,events}/`，损坏/版本拒绝返回 null）+ serialize/restore（scope→快照投影、plan 节点状态保留防重复执行、restoreAgentRun 重建 AgentRun）+ workspace hash（复用 fingerprintFile，排除 node_modules/.git/.orcana/dist）；run 终态自动 saveRun+saveSnapshot（best-effort）；inspect 内存 miss 回退 store（历史 run 跨实例可查）；`tests/harness_persistence.test.ts` 6 项；全量 147 文件门禁绿色。**技术债：** tracker/_packet 恢复为占位（H7 resume 完整化）；snapshot 时机仅终态（§13.3 完整时机表后续补）；workspace hash 计算由调用方提供（大项目性能） |
| H7 Interrupt / Resume | 完成 | 2026-08-02 | Plan Approval 与 Clarification 升级为**持久等待后恢复**：waiting 决策自动创建 pending `HarnessInterrupt`（kind/schema/prompt）+ `interrupt.created` 事件 + 落盘；`resume(runId, response)` 真实实现（校验链：waiting→pending→interruptId→schema→workspace hash；重复已答幂等拒绝；拒绝 `accepted:false` 形成 rejected→cancelled 正式分支）；续跑经 `waiting→resuming→running` + 响应应用（plan：initialPlanState/planText；clarification：history 注入标记+回答，kernel `findPendingClarification` 不再触发）；跨实例 resume（store restore + 新 controller）；`src/harness/interrupts/{response-validator,plan-approval,clarification,interrupt-manager}.ts`；`tests/harness_interrupt.test.ts` 8 项；全量 148 文件门禁绿色。**技术债：** CLI/TUI 仍走 do-while 重跑（legacy 模式），resume API 就绪后迁移为后续项；tool_approval/credential/manual_verification 未实现（第二批） |
| H8 Artifact / Evidence | 完成 | 2026-08-02 | Artifact 与 Evidence 统一（§14）：`src/harness/artifacts/{provenance,artifact-store,freshness,evidence-adapter}.ts` —— ArtifactStore 真实现（H3 占位升级：markSuperseded/findByKind/entries/storeContent 按 hash 去重）；`EvidenceEntry.artifactId/stale` + `markEvidenceStale`（§14.2 artifact=产物、evidence=声明，双向绑定）；新鲜度（§14.3：workspaceHash 漂移 + relevantFileHashes 逐文件比对 → artifact+evidence 同步 stale，`hasFreshPassingEvidence` L1 拒绝 stale）；注入链打通（`AgentOptions.artifactStore/runId` → RunPhaseContext → verificationCtx，L2 同模式）；coordinator 有 store 时验证结果经 adapter 产出绑定 artifact（batch tsc → typecheck_result）；**CompletionOrchestrator 消除 `lastTypecheck` input 字段**（验收达成：完成事实全部由 `deriveLastTypecheck(evidenceLedger)` 派生，gates ctx 同源）；序列化升级（evidenceState 从 count → `SerializedEvidenceEntry[]`，SerializableRun.artifactRefs，旧文件兼容）；inspect 返回真实 artifactRefs/evidence；`tests/harness_artifacts.test.ts` 12 项；全量 154 文件门禁绿色。**技术债：** patch/plan/ripple artifact 接线点为 adapter 函数（真接线在 H9 CapabilityExecutor After Hook §15.3）；content store 内存版（文件持久化后续）；freshness 周期刷新随 H11 |
| H9 Capability Registry | 完成 | 2026-08-03 | Capability Registry + CapabilityExecutor（§15）：`src/harness/capabilities/{descriptor,registry,tool-adapter,executor,policy-adapter,index}.ts` —— Tool→Capability 纯投影（复用 ToolContract，§23 风险控制：不建第二套工具系统）；8 步执行链（Budget Reserve → Policy → Before Hook → Handler → After Hook → Schema 验证 → Artifact/Evidence → Budget Commit）；**普通 Loop 与未来 Node Runtime 同一执行入口**（验收达成：batch-executor 两处工具调用改走 `executeCapability`，未迁移工具现场投影兜底，`tool_batch_executor.test.ts` 零改动全绿作冻结回归）；**H4 技术债清偿**：`BudgetRequest.kind` 补 `repair`，tool_call 事件携带 `sideEffect` 分类（`classifyToolSideEffect`），BudgetGuard 对 write/external_action 限额真实计数（write_budget/external_action_budget 取消）；**H8 技术债清偿**：patch artifact 经 executor After Hook tracker（前后快照算 diff，1MB 上限）、plan artifact 在 adapter plan_ready 桥接、ripple artifact 在 coordinator 验证阶段（均 best-effort）；`tests/harness_capabilities.test.ts` 25 项 + `harness_budget.test.ts` +2（write/external 限额）；全量 155 文件门禁绿色。**技术债：** repair 限额事件挂接留后（事件流无 repair-cycle 事实源）；patch artifact 的 workspaceHash/relevantFileHashes 未传（kernel 拿不到 harness workspace provider，H11 补）；node 模式策略默认值（rateLimits Infinity/taskTracker null）H11 Node 上下文富化；Result Schema 校验为子集（无 additionalProperties 强制），工具 output 验证近似 no-op（`TOOL_OUTPUT_SCHEMA` 占位，H11 细化） |

> 前置状态：ALK 减重 L0—L7 全部完成（2026-08-02）。Readiness Gate 复核：R1 统一清理 ✅（L7 统一 finally + `finalizeRun()`）；R2 RunState 集中 ✅（`AgentRunState` + `kernel/` RunPhaseContext）；R3 阶段边界 ✅（ProviderRoundRunner / ToolBatchExecutor / VerificationCoordinator / MaintenanceCoordinator 四个齐备）；R4 退出结构化 ✅（`LoopDecision` + 唯一终态 switch）；R5 全局状态消除 ✅（所有 legacy setter——mode/patch/sandbox/cascade/budget-mode——均为 deprecated 兼容层，底层写入 AsyncLocalStorage 的 RuntimeExecutionContext；L2 `AgentRunScope` 已隔离 Plan/Tool）。按 §4.2 结果表：R1–R5 全部完成，可直接开始 H0–H2。**H0–H7 已完成**（进度表见上：第一里程碑收官 + 第二里程碑过半），下一步为 **PR-H8 Artifact / Evidence Integration**（产物、证据、新鲜度统一；CompletionOrchestrator 不再依赖散落的 `lastTypecheck` 等重复事实）。详见 `docs/agent-loop-kernel-refactor-plan.md`（ALK 已收束，续作点指向 Graph Runtime G0，与 Harness H8–H11 并行不冲突）。

---

# 一、方案定位

## 1.1 Harness 在 Orcana 中是什么

Harness 不是某一个工具，也不是 Replay Harness 单个文件。

它是包裹模型并管理完整执行生命周期的运行系统：

```text
用户目标
  ↓
Agent Harness
  ├─ Session
  ├─ Run 生命周期
  ├─ Context
  ├─ Provider
  ├─ Capability
  ├─ Permission
  ├─ Budget
  ├─ Tool Execution
  ├─ Evidence
  ├─ Transaction
  ├─ Interrupt / Resume
  ├─ Trace
  └─ Outcome
        ↓
实际结果
```

Loop 减重之后：

```text
Harness
  └─ LLM Agent Executor
       └─ 轻量化 loop
```

Loop 不再代表完整 Orcana Runtime，只负责：

* 调用模型；
  -接收模型输出；
  -组织一轮或多轮 LLM—Tool 交互；
  -把结构化结果返回 Harness。

Harness 负责：

* 一次运行怎样开始；
  -状态属于谁；
  -上下文怎样准备；
  -能力怎样注入；
  -任务何时等待；
  -如何取消；
  -如何恢复；
  -如何记录；
  -什么叫最终完成。

---

# 二、目标与非目标

## 2.1 本轮必须实现

1. 建立稳定的 `AgentHarness` API；
2. 建立 `Session → Run → Round/Node` 生命周期；
3. 所有运行状态变为 Run Scope；
4. 统一取消、超时、预算和清理；
5. 建立统一 `RunOutcome`；
6. 建立类型化事件与 Trace Schema；
7. 支持持久化 Interrupt / Resume；
8. 建立 Artifact 与 Evidence 统一协议；
9. 建立 Capability Registry；
10. 建立 Context Provider Pipeline；
11. 建立 Unified Node Runtime 基础；
12. 升级 Replay、Eval 和 Live Eval；
13. 保持现有 CLI/TUI 行为兼容；
14. 为 Execution Graph 提供稳定接口。

## 2.2 本轮明确不做

* 不实现真正的多智能体；
  -不实现多个写 Agent 并行工作；
  -不实现分布式 Scheduler；
  -不上 Neo4j；
  -不构建 System Knowledge Graph；
  -不允许模型生成并执行任意 Workflow 代码；
  -不一次性删除现有 `agentLoop()`；
  -不同时维护 Harness 状态和旧全局状态；
  -不重新建立一套平行 Evidence 系统；
  -不为了架构纯洁重写全部工具；
  -不在首版引入远程数据库或服务端控制面。

---

# 三、实施总原则

## 3.1 唯一状态所有权

每一类状态必须只有一个权威来源：

| 状态                 | 唯一所有者                            |
| ------------------ | -------------------------------- |
| Session            | `AgentSession`                   |
| Run 生命周期           | `AgentRun`                       |
| 当前模式               | `RunScope.modeStore`             |
| 主计划                | `RunScope.planStore`             |
| Patch Context      | `RunScope.patchContext`          |
| Sandbox            | `RunScope.sandbox`               |
| Ripple Obligations | `RunScope.rippleSession`         |
| Evidence           | `ArtifactStore + EvidenceLedger` |
| Context Budget     | `BudgetLedger`                   |
| 取消状态               | `RunCancellation`                |
| 最终结果               | `RunOutcome`                     |

禁止同一事实同时由多个布尔变量、Store 和 Ledger 独立维护。

---

## 3.2 唯一执行入口

最终所有 UI、CLI、测试和未来 Graph 都必须通过：

```ts
AgentHarness.run()
```

禁止生产代码直接调用：

```ts
agentLoop(prompt, options)
```

过渡期间只允许：

```text
AgentHarness
  ↓
LegacyLoopAdapter
  ↓
agentLoop
```

---

## 3.3 唯一完成出口

任何运行都必须形成一个 `RunOutcome`：

```ts
type RunOutcome =
  | CompletedOutcome
  | WaitingOutcome
  | PausedOutcome
  | BlockedOutcome
  | CancelledOutcome
  | FailedOutcome
  | RestartRequiredOutcome
```

UI 不得通过解析文本判断任务是否完成。

---

## 3.4 概率智能与确定性控制分离

```text
模型
  → 理解、规划、生成候选行动

Harness
  → 权限、预算、调度、事务、验证、恢复
```

模型只能建议动作，Harness 决定动作是否发生。

---

## 3.5 行为保持优先

Harness 迁移期必须保持：

* 当前模型调用方式；
  -当前工具调用协议；
  -当前 Gate 顺序；
  -当前 Evidence 规则；
  -当前 CompletionOrchestrator；
  -当前 CLI/TUI 用户行为；
  -当前 Provider Cache 边界。

第一阶段只改变状态所有权和调用结构，不改变 Agent 策略。

---

# 四、Harness Readiness Gate

由于 Loop 减重目前只完成一半，在开始正式 Harness 改造前，先运行一次结构审查。

## 4.1 必须检查的五项条件

### R1：统一清理

完整运行是否已经被：

```ts
try {
  // run
} finally {
  // dispose
}
```

包围。

无论出现：

* clarification；
  -plan ready；
  -provider failure；
  -context block；
  -round budget；
  -runtime restart；
  -user cancellation；

都必须释放：

* Sandbox；
  -Provider Abort；
  -Hook；
  -临时文件；
  -全局兼容引用；
  -Telemetry Writer。

### R2：RunState 是否已出现

Loop 中运行级状态是否已经集中为：

```ts
AgentRunState
```

而不是几十个独立局部变量。

### R3：关键阶段是否已有边界

至少应具备以下三个中的两个：

* `ProviderRoundRunner`
* `ToolBatchExecutor`
* `VerificationCoordinator`

### R4：退出是否结构化

是否已经存在或接近：

```ts
LoopDecision
```

而不是所有分支直接 `break`、`continue`、`return`。

### R5：全局状态是否开始消除

检查：

* `planRef`
* Active Mode
* Active Patch Context
* Shell Sandbox
* Ripple Cascade
* Context Budget Mode

是否仍为模块级变量。

---

## 4.2 Readiness 结果

| 结果         | 可开始的 Harness 阶段            |
| ---------- | -------------------------- |
| R1–R5 全部完成 | 直接开始 H0–H2                 |
| R1、R2 完成   | 可开始 H0、H1                  |
| 只有 R1 完成   | 只能定义 Contract，不接生产链        |
| R1 未完成     | 先完成 Loop 清理，不进入 Harness 接线 |

---

# 五、目标架构

```text
┌──────────────────────────────────────────────┐
│                CLI / TUI / API               │
└──────────────────────┬───────────────────────┘
                       ▼
┌──────────────────────────────────────────────┐
│                 AgentHarness                 │
│ session / run / resume / cancel / inspect    │
└──────────────────────┬───────────────────────┘
                       ▼
┌──────────────────────────────────────────────┐
│             Harness Control Plane            │
│ lifecycle / policy / budget / interrupt      │
└────────────┬──────────────┬──────────────────┘
             │              │
             ▼              ▼
┌──────────────────┐  ┌───────────────────────┐
│ Context Pipeline │  │ Capability Registry   │
└─────────┬────────┘  └───────────┬───────────┘
          └────────────┬───────────┘
                       ▼
┌──────────────────────────────────────────────┐
│             Unified Node Runtime             │
│ Function / Tool / LLM / Verify / Human       │
└──────────────────────┬───────────────────────┘
                       ▼
┌──────────────────────────────────────────────┐
│       Artifact / Evidence / Transaction      │
└──────────────────────┬───────────────────────┘
                       ▼
┌──────────────────────────────────────────────┐
│ Trace / Snapshot / Checkpoint / Replay / Eval│
└──────────────────────────────────────────────┘
```

---

# 六、建议文件结构

```text
src/harness/
├── index.ts
│
├── contracts/
│   ├── harness.ts
│   ├── session.ts
│   ├── run.ts
│   ├── outcome.ts
│   ├── events.ts
│   ├── interrupt.ts
│   ├── artifact.ts
│   ├── capability.ts
│   ├── budget.ts
│   └── errors.ts
│
├── runtime/
│   ├── agent-harness.ts
│   ├── run-controller.ts
│   ├── run-registry.ts
│   ├── run-scope.ts
│   ├── lifecycle-machine.ts
│   ├── cancellation.ts
│   ├── cleanup.ts
│   └── legacy-loop-adapter.ts
│
├── persistence/
│   ├── harness-store.ts
│   ├── file-harness-store.ts
│   ├── snapshot-store.ts
│   ├── event-store.ts
│   ├── migration.ts
│   └── serialization.ts
│
├── interrupts/
│   ├── interrupt-manager.ts
│   ├── response-validator.ts
│   ├── plan-approval.ts
│   ├── clarification.ts
│   ├── tool-approval.ts
│   └── credential-required.ts
│
├── capabilities/
│   ├── registry.ts
│   ├── descriptor.ts
│   ├── executor.ts
│   ├── tool-adapter.ts
│   ├── model-adapter.ts
│   ├── verifier-adapter.ts
│   └── policy-adapter.ts
│
├── context/
│   ├── provider.ts
│   ├── pipeline.ts
│   ├── budget-allocator.ts
│   ├── dedupe.ts
│   ├── context-slice.ts
│   └── providers/
│       ├── stable-memory.ts
│       ├── project-kernel.ts
│       ├── context-map.ts
│       ├── plan-state.ts
│       ├── skills.ts
│       ├── research.ts
│       ├── knowledge.ts
│       └── mode-contract.ts
│
├── artifacts/
│   ├── artifact-store.ts
│   ├── evidence-adapter.ts
│   ├── freshness.ts
│   ├── content-store.ts
│   └── provenance.ts
│
├── nodes/
│   ├── node.ts
│   ├── node-context.ts
│   ├── node-result.ts
│   ├── node-runtime.ts
│   ├── function-node.ts
│   ├── tool-node.ts
│   ├── llm-agent-node.ts
│   ├── verification-node.ts
│   └── human-node.ts
│
└── telemetry/
    ├── trace-writer.ts
    ├── event-envelope.ts
    ├── event-schema.ts
    ├── metrics.ts
    └── redaction.ts
```

评测部分建议独立：

```text
evals/harness/
├── contracts.ts
├── fixture-provider.ts
├── fixture-tools.ts
├── run-replay.ts
├── trace-assertions.ts
├── rubric.ts
├── scorer.ts
├── baseline.ts
├── reporter.ts
└── scenarios/
```

---

# 七、核心数据模型

## 7.1 AgentHarness

```ts
export interface AgentHarness {
  createSession(
    input?: CreateSessionInput,
  ): Promise<AgentSession>

  run(
    sessionId: string,
    input: AgentRunInput,
  ): AsyncIterable<HarnessEvent>

  resume(
    runId: string,
    response: InterruptResponse,
  ): AsyncIterable<HarnessEvent>

  cancel(
    runId: string,
    reason?: string,
  ): Promise<void>

  inspect(
    runId: string,
  ): Promise<RunSnapshot>

  dispose(): Promise<void>
}
```

---

## 7.2 AgentSession

```ts
export interface AgentSession {
  sessionId: string
  createdAt: number
  updatedAt: number

  activeRunIds: string[]

  conversationRef?: string
  stableMemoryRef?: string
  projectRoot: string

  metadata: Record<string, unknown>
}
```

Session 保存长期会话关系，不拥有单次运行资源。

---

## 7.3 AgentRun

```ts
export interface AgentRun {
  runId: string
  sessionId: string

  status: RunStatus
  input: AgentRunInput

  scope: AgentRunScope
  budget: BudgetLedger

  createdAt: number
  startedAt?: number
  finishedAt?: number

  interrupt?: HarnessInterrupt
  outcome?: RunOutcome

  eventSequence: number
  schemaVersion: number
}
```

---

## 7.4 AgentRunScope

```ts
export interface AgentRunScope {
  runId: string
  sessionId: string
  projectRoot: string

  planStore: PlanStore
  modeStore: ModeStore
  patchContext: PatchContextStore

  sandbox: SandboxManager
  rippleSession: RippleSession

  evidenceLedger: EvidenceLedger
  artifactStore: ArtifactStore

  cancellation: RunCancellation
  trace: TraceWriter
}
```

任何工具、Gate 或节点只能从显式传入的 Scope 获取状态。

---

## 7.5 RunStatus

```ts
export type RunStatus =
  | "created"
  | "initializing"
  | "running"
  | "waiting"
  | "pausing"
  | "paused"
  | "resuming"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled"
  | "restart_required"
```

---

## 7.6 RunOutcome

```ts
export type RunOutcome =
  | {
      kind: "completed"
      reportArtifactId: string
      evidenceIds: string[]
    }
  | {
      kind: "waiting"
      interruptId: string
      checkpointId: string
    }
  | {
      kind: "paused"
      checkpointId: string
      reason: string
    }
  | {
      kind: "blocked"
      blocker: RunBlocker
    }
  | {
      kind: "cancelled"
      reason: string
    }
  | {
      kind: "failed"
      failure: RunFailure
    }
  | {
      kind: "restart_required"
      files: string[]
      verificationEvidenceIds: string[]
    }
```

---

# 八、生命周期状态机

## 8.1 合法转换

```text
CREATED
  ↓
INITIALIZING
  ├─→ FAILED
  └─→ RUNNING

RUNNING
  ├─→ WAITING
  ├─→ PAUSING
  ├─→ BLOCKED
  ├─→ COMPLETED
  ├─→ FAILED
  ├─→ CANCELLED
  └─→ RESTART_REQUIRED

WAITING
  ├─→ RESUMING
  ├─→ CANCELLED
  └─→ FAILED

RESUMING
  ├─→ RUNNING
  └─→ FAILED

PAUSING
  └─→ PAUSED

PAUSED
  ├─→ RESUMING
  └─→ CANCELLED
```

终态不得再次迁移：

* `completed`
* `failed`
* `cancelled`
* `restart_required`

---

## 8.2 状态机约束

1. 所有转换由 `LifecycleMachine.transition()` 执行；
2. 禁止直接赋值 `run.status`；
3. 每次转换必须生成事件；
4. 每次进入 WAITING、PAUSED 或终态必须保存 Snapshot；
5. 非法转换必须显式失败；
6. 重复的相同转换不得产生副作用。

---

# 九、Loop 与 Harness 的接线方式

## 9.1 过渡期

```text
AgentHarness
  ↓
LegacyLoopAdapter
  ↓
轻量 agentLoop
```

Adapter 负责把：

```ts
AgentRunScope
```

转换为当前 Loop 需要的输入。

---

## 9.2 LegacyLoopAdapter

```ts
export interface LegacyLoopAdapter {
  execute(
    run: AgentRun,
    input: AgentRunInput,
  ): AsyncIterable<HarnessEvent>
}
```

Adapter 负责：

* 构建 Loop Input；
  -转换 `LoopDecision → RunOutcome`；
  -转换 Loop Stream Event；
  -写入 Typed Trace；
  -处理兼容配置；
  -禁止 Loop 自己持久化 Run 终态。

---

## 9.3 Loop 最终职责

减重完成后，Loop 只保留：

```text
准备当前 LLM 回合
→ 调用 Provider
→ 收集文本与 Tool Calls
→ 请求 Tool Executor
→ 更新局部回合状态
→ 判断是否继续 LLM 回合
→ 返回 LoopDecision
```

以下职责应移交 Harness：

* Session；
  -Run 生命周期；
  -Interrupt；
  -取消；
  -全局预算；
  -Snapshot；
  -Artifact；
  -Trace Schema；
  -最终 Outcome；
  -跨节点调度。

---

# 十、统一取消与预算

## 10.1 Cancellation

```ts
export interface RunCancellation {
  signal: AbortSignal
  cancelled: boolean
  reason?: string

  cancel(reason: string): void
  throwIfCancelled(): void
}
```

以下组件必须接收相同 `AbortSignal`：

* Provider；
  -Tool；
  -Research；
  -Compaction；
  -Verification；
  -Checkpoint；
  -未来 Graph Node。

---

## 10.2 BudgetLedger

```ts
export interface RunBudget {
  maxWallTimeMs: number
  maxModelCalls: number
  maxToolCalls: number

  maxInputTokens: number
  maxOutputTokens: number
  maxCacheMissTokens: number

  maxWrites: number
  maxExternalActions: number
  maxRepairCycles: number
}
```

```ts
export interface BudgetLedger {
  limits: RunBudget
  used: BudgetUsage

  reserve(request: BudgetRequest): BudgetReservation
  commit(reservationId: string, actual: BudgetUsage): void
  release(reservationId: string): void
  remaining(): BudgetUsage
}
```

采用 Reserve—Commit，避免并发节点同时认为预算充足。

---

## 10.3 超预算结果

不同预算必须产生明确原因：

```text
model_call_budget
tool_call_budget
token_budget
wall_time_budget
write_budget
external_action_budget
repair_budget
```

禁止统一成模糊的“达到最大轮数”。

---

# 十一、Interrupt / Resume

## 11.1 Interrupt 类型

```ts
export type InterruptKind =
  | "plan_approval"
  | "clarification"
  | "tool_approval"
  | "credential_required"
  | "conflict_resolution"
  | "manual_verification"
```

---

## 11.2 HarnessInterrupt

```ts
export interface HarnessInterrupt {
  interruptId: string
  runId: string
  kind: InterruptKind

  prompt: string
  responseSchema: JsonSchema

  checkpointId: string
  createdAt: number
  expiresAt?: number

  status:
    | "pending"
    | "answered"
    | "rejected"
    | "expired"
}
```

---

## 11.3 Resume 规则

1. `resume()` 必须指定 `interruptId`；
2. 响应必须通过 JSON Schema；
3. 同一响应重复提交必须幂等；
4. 回答不同内容时拒绝覆盖；
5. Resume 前恢复 Snapshot；
6. 已提交 PatchTransaction 不得重复执行；
7. 先验证 Workspace Hash；
8. Workspace 变化时进入 conflict resolution；
9. 恢复后从确定的 Continuation Point 继续。

---

## 11.4 首批迁移顺序

第一批只迁移：

1. Plan Approval；
2. Clarification。

第二批再迁移：

3. Tool Approval；
4. Credential Required；
5. Manual Verification。

---

# 十二、Typed Event 与 Trace

## 12.1 Event Envelope

```ts
export interface EventEnvelope<T> {
  schemaVersion: 1

  eventId: string
  sequence: number

  runId: string
  sessionId: string
  nodeRunId?: string
  parentEventId?: string

  type: string
  timestamp: string
  payload: T
}
```

`sequence` 是 Run 内唯一递增序号。

---

## 12.2 标准事件

```text
run.created
run.initializing
run.started
run.waiting
run.resumed
run.paused
run.blocked
run.completed
run.failed
run.cancelled

round.started
round.completed

model.call.started
model.call.completed
model.call.failed
model.usage

tool.call.requested
tool.policy.allowed
tool.policy.blocked
tool.call.started
tool.call.completed
tool.call.failed

artifact.created
artifact.stale
evidence.recorded

transaction.started
transaction.committed
transaction.rolled_back

interrupt.created
interrupt.answered
checkpoint.saved
```

---

## 12.3 Trace Writer

```ts
export interface TraceWriter {
  append<T>(event: EventEnvelope<T>): Promise<void>
  flush(): Promise<void>
  close(): Promise<void>
}
```

首版可继续使用 JSONL，但必须：

* 使用类型化事件；
  -携带 Schema Version；
  -按 Sequence 排序；
  -异步批量写入；
  -写入失败不影响主要任务；
  -敏感信息统一 Redaction；
  -禁止 Scorer 自行猜测字段位置。

---

## 12.4 Trace 兼容

提供：

```ts
migrateLegacyTrace()
```

把旧格式：

```json
{
  "type": "gate_decision",
  "data": {}
}
```

迁移为新 Event Envelope。

---

# 十三、Persistence 与 Snapshot

## 13.1 首版存储选择

不引入远程数据库。

使用现有本地文件结构：

```text
.orcana/
└── harness/
    ├── sessions/
    ├── runs/
    ├── events/
    ├── snapshots/
    ├── artifacts/
    └── interrupts/
```

---

## 13.2 HarnessStore

```ts
export interface HarnessStore {
  saveSession(session: AgentSession): Promise<void>
  loadSession(sessionId: string): Promise<AgentSession | null>

  saveRun(run: SerializableRun): Promise<void>
  loadRun(runId: string): Promise<SerializableRun | null>

  appendEvent(event: HarnessEvent): Promise<void>

  saveSnapshot(snapshot: RunSnapshot): Promise<void>
  loadLatestSnapshot(runId: string): Promise<RunSnapshot | null>
}
```

---

## 13.3 Snapshot 时机

必须保存：

* 初始化完成；
  -计划接受；
  -进入 WAITING；
  -事务提交；
  -验证完成；
  -进入 PAUSED；
  -任何终态；
  -每 N 个关键事件的保护性快照。

---

## 13.4 Snapshot 内容

```ts
export interface RunSnapshot {
  schemaVersion: number
  runId: string
  sessionId: string
  sequence: number

  status: RunStatus
  input: AgentRunInput

  planState: SerializablePlanState
  modeState: SerializableModeState
  budgetState: SerializableBudgetState

  evidenceState: SerializableEvidenceState
  artifactRefs: string[]

  conversationRef: string
  workspaceHash?: string

  interrupt?: HarnessInterrupt
  outcome?: RunOutcome

  createdAt: number
}
```

不得直接序列化：

* Provider 实例；
  -工具函数；
  -AbortController；
  -Sandbox 实例；
  -文件句柄；
  -EventEmitter。

恢复时由 Runtime Bootstrap 重新注入这些依赖。

---

# 十四、Artifact 与 Evidence

## 14.1 Artifact

```ts
export interface HarnessArtifact {
  artifactId: string
  runId: string
  nodeRunId?: string

  kind:
    | "plan"
    | "patch"
    | "tool_result"
    | "test_result"
    | "typecheck_result"
    | "build_result"
    | "ripple_report"
    | "research_source"
    | "checkpoint"
    | "delivery_report"

  status:
    | "valid"
    | "failed"
    | "stale"
    | "superseded"

  contentRef: string
  contentHash: string

  workspaceHash?: string
  relevantFileHashes?: Record<string, string>

  producedBy: string
  createdAt: number
}
```

---

## 14.2 Evidence 与 Artifact 的关系

```text
Artifact
= 实际产物

Evidence
= 产物支持了什么声明
```

例如：

```text
Typecheck Artifact
  ↓ supports
Claim：当前修改通过类型检查
```

EvidenceLedger 不保存大段命令输出，只保存：

* Artifact ID；
  -Claim；
  -验证状态；
  -关联事务；
  -工作区状态。

---

## 14.3 新鲜度

任何 Evidence 必须绑定：

* Workspace Hash；
  -相关文件 Hash；
  -Transaction ID；
  -生成时间。

相关文件改变后：

```text
Artifact.status = stale
Evidence.status = stale
```

过期 Evidence 不能满足 Completion Gate。

---

# 十五、Capability Registry

## 15.1 CapabilityDescriptor

```ts
export interface CapabilityDescriptor {
  id: string
  kind:
    | "tool"
    | "model"
    | "skill"
    | "worker"
    | "verifier"
    | "human"
    | "external_service"

  inputSchema: JsonSchema
  outputSchema: JsonSchema

  sideEffect:
    | "none"
    | "read"
    | "write"
    | "external"

  concurrencyGroup: string

  permissions: string[]
  riskLevel: number

  retryable: boolean
  idempotent: boolean
  cancellable: boolean
  producesEvidence: boolean
}
```

---

## 15.2 Registry

```ts
export interface CapabilityRegistry {
  register(
    descriptor: CapabilityDescriptor,
    handler: CapabilityHandler,
  ): void

  resolve(id: string): RegisteredCapability
  list(filter?: CapabilityFilter): RegisteredCapability[]
}
```

---

## 15.3 CapabilityExecutor

所有工具最终统一经过：

```text
CapabilityExecutor
  ↓
Budget Reserve
  ↓
Permission / Mode / Risk Policy
  ↓
Before Hook
  ↓
Handler
  ↓
After Hook
  ↓
Result Schema Validation
  ↓
Artifact / Evidence
  ↓
Budget Commit
```

这条链是未来 Tool Node、Graph Node 和普通 Agent Tool Call 的共同执行入口。

---

## 15.4 迁移策略

不要一次改造所有工具。

第一批：

* `read_file`
* `find_symbol`
* `find_references`
* `write_file`
* `edit_file`
* `shell`
* `typecheck`

第二批：

* Git；
  -Web；
  -LSP；
  -CodeGraph；
  -MCP；
  -Start Service。

---

# 十六、Context Provider Pipeline

## 16.1 ContextProvider

```ts
export interface ContextProvider {
  id: string
  layer:
    | "stable"
    | "plan"
    | "node"
    | "volatile"

  priority: number
  cacheable: boolean

  provide(
    request: ContextRequest,
  ): Promise<ContextContribution>
}
```

---

## 16.2 ContextContribution

```ts
export interface ContextContribution {
  providerId: string
  layer: ContextLayer

  content: string
  estimatedTokens: number

  sourceRefs: string[]
  cacheKey?: string

  required: boolean
  freshness?: number
}
```

---

## 16.3 Pipeline

```text
收集 Context Contributions
  ↓
去重
  ↓
验证新鲜度
  ↓
按 Layer 排序
  ↓
预算分配
  ↓
裁剪
  ↓
生成 ContextSlice
```

---

## 16.4 首批 Provider

* Stable Memory；
  -Project Kernel；
  -ContextMap；
  -Plan State；
  -Mode Contract；
  -Skills；
  -Knowledge；
  -Research；
  -Conversation Tail。

---

## 16.5 预算分配建议

```text
Stable：固定上限
Plan：必须保留
Node：按任务动态分配
Volatile：优先裁剪
Conversation Tail：按剩余预算
```

禁止每个 Provider 自己向消息列表任意插入内容。

---

# 十七、Unified Node Runtime

这一阶段只建立统一执行接口，不立即实现 Graph Scheduler。

## 17.1 Node

```ts
export interface HarnessNode<I, O> {
  id: string
  kind: NodeKind

  execute(
    context: NodeExecutionContext,
    input: I,
  ): AsyncIterable<NodeEvent>

  getResult(): Promise<NodeResult<O>>
}
```

---

## 17.2 NodeKind

```ts
export type NodeKind =
  | "function"
  | "tool"
  | "llm_agent"
  | "verification"
  | "human"
```

后续再增加：

* Join；
  -Router；
  -Workflow；
  -Transaction。

---

## 17.3 NodeExecutionContext

```ts
export interface NodeExecutionContext {
  runId: string
  nodeRunId: string

  runScope: AgentRunScope
  capabilities: CapabilityRegistry

  context: ContextSlice
  budget: BudgetLedger
  cancellation: RunCancellation

  artifacts: ArtifactStore
  trace: TraceWriter
}
```

---

## 17.4 LlmAgentNode

轻量化 Loop 最终包装为：

```ts
export class LlmAgentNode
  implements HarnessNode<AgentNodeInput, AgentNodeOutput> {
  // 内部调用减重后的 LLM Tool Loop
}
```

这样：

```text
单 Agent
= 一个 LlmAgentNode

未来复杂工作流
= 多个 Node
```

---

# 十八、Eval Harness 2.0

## 18.1 分成四层

### Tier 0：Unit Tests

测试纯函数、State Machine、Policy、Budget、Schema。

每次提交执行。

### Tier 1：Function Replay

继续保留现有 JSON 驱动 Replay，但扩展：

* 嵌套路径断言；
  -数组长度；
  -不存在；
  -正则；
  -集合包含；
  -事件顺序；
  -错误类型；
  -快照比较。

### Tier 2：Run Replay

使用假的 Provider、Tool 和文件系统，重放完整 Harness 生命周期。

### Tier 3：Live Eval

真正调用模型，评估端到端任务。

---

## 18.2 Run Replay Case

```ts
export interface RunReplayCase {
  caseId: string

  input: AgentRunInput
  initialWorkspace: Record<string, string>

  providerScript: ProviderScriptEvent[]
  toolScript?: ToolScriptResult[]
  interruptResponses?: InterruptResponse[]

  expected: {
    outcome: RunOutcomeExpectation
    events: EventExpectation[]
    artifacts: ArtifactExpectation[]
    workspace: WorkspaceExpectation
    budget?: BudgetExpectation
  }
}
```

---

## 18.3 Provider Script

```ts
export type ProviderScriptEvent =
  | { type: "text"; data: string }
  | { type: "tool_call"; name: string; input: unknown }
  | { type: "usage"; input: number; output: number }
  | { type: "error"; errorType: string }
  | { type: "idle_timeout" }
```

这样可稳定测试：

* Provider 中断；
  -重复 Tool Call；
  -不完整 Stream；
  -模型虚假完成；
  -Plan Approval；
  -恢复执行。

---

## 18.4 多维 Rubric

```ts
export interface RubricCheck {
  id: string

  dimension:
    | "correctness"
    | "completeness"
    | "safety"
    | "truthfulness"
    | "efficiency"
    | "recovery"
    | "scope_control"
    | "isolation"

  weight: number
  required: boolean

  evaluator: RubricEvaluator
}
```

---

## 18.5 通过规则

```text
所有 required checks 通过
AND 每个 quality floor 达标
AND 无 Safety P0
AND 无 Truthfulness P0
```

不能再仅用“通过检查数除以总检查数”。

---

## 18.6 必备 Scenario Matrix

| ID     | 场景                             |
| ------ | ------------------------------ |
| HR-001 | Readonly 任务不写文件                |
| HR-002 | Narrow Edit 正确修改并验证            |
| HR-003 | 跨文件 Ripple 更新                  |
| HR-004 | 模型声称完成但没有证据                    |
| HR-005 | Typecheck 失败后定向修复              |
| HR-006 | Provider Stream 中断后恢复          |
| HR-007 | 非重试 Provider 错误正确终止            |
| HR-008 | Tool 超时并释放资源                   |
| HR-009 | Plan Approval 等待和恢复            |
| HR-010 | Clarification 等待和恢复            |
| HR-011 | 重复 Resume 幂等                   |
| HR-012 | Workspace 变化阻止旧 Resume         |
| HR-013 | Patch 失败自动回滚                   |
| HR-014 | Evidence 因文件变化而过期              |
| HR-015 | Context Budget 进入降级            |
| HR-016 | Context Budget 硬暂停             |
| HR-017 | Round Budget 形成 Paused Outcome |
| HR-018 | Runtime Self-edit 要求重启         |
| HR-019 | 权限拒绝高风险工具                      |
| HR-020 | Scope 外文件写入被拒绝                 |
| HR-021 | 两个 Run 的 Plan 不串扰              |
| HR-022 | 两个 Run 的 Mode 不串扰              |
| HR-023 | 两个 Run 的 Sandbox 不串扰           |
| HR-024 | 取消 Run A 不影响 Run B             |
| HR-025 | Trace 事件 Sequence 连续           |
| HR-026 | 所有 Tool Call 都有终结事件            |
| HR-027 | 所有终态都有 Outcome                 |
| HR-028 | Snapshot 恢复后不重复事务              |
| HR-029 | Artifact 与 Evidence 关系正确       |
| HR-030 | Secret Redaction 不泄露凭证         |

---

# 十九、分 PR 实施计划

# PR-H0：Harness Contracts

## 目标

建立类型，不改变运行行为。

## 新增

```text
src/harness/contracts/*
src/harness/index.ts
```

## 内容

* AgentHarness；
  -AgentSession；
  -AgentRun；
  -AgentRunScope；
  -RunStatus；
  -RunOutcome；
  -HarnessEvent；
  -HarnessInterrupt；
  -HarnessArtifact；
  -RunBudget；
  -CapabilityDescriptor；
  -错误分类。

## 测试

```text
tests/harness_contracts.test.ts
tests/harness_outcome.test.ts
tests/harness_status_transition_types.test.ts
```

## 验收

* 类型完整；
  -无运行行为变化；
  -不存在 `any`；
  -Contract 不依赖 UI；
  -Contract 不依赖具体 Provider；
  -Contract 不导入 `loop.ts`。

## 停止条件

如果 Contract 必须引用大量 `loop.ts` 内部类型，说明 Loop 边界仍未稳定，停止继续接线。

---

# PR-H1：Harness Facade 与 Legacy Adapter

## 目标

让现有 Loop 可以通过 Harness 调用。

## 新增

```text
src/harness/runtime/agent-harness.ts
src/harness/runtime/legacy-loop-adapter.ts
src/harness/runtime/run-registry.ts
```

## 修改

```text
src/runtime/bootstrap.ts
src/ui/cli.ts
src/tui/main.tsx
```

## 行为

```text
CLI / TUI
  → AgentHarness
  → LegacyLoopAdapter
  → agentLoop
```

## 配置

```json
{
  "harness": {
    "mode": "legacy"
  }
}
```

可选：

```text
legacy
shadow
enabled
```

初始默认 `legacy`。

## 测试

* CLI 旧行为一致；
  -TUI 旧事件一致；
  -最终文本不重复；
  -Plan Ready 不丢失；
  -Provider Error 正常展示。

## 验收

生产入口不再直接调用 Loop。

## H1 实施记录（2026-08-02）

**状态：完成。** 全部门禁绿色（typecheck / 139 文件测试 / build / npm pack / diff --check）。

实现要点与过渡机制（技术债延续到后续阶段）：

1. **HarnessEvent 契约扩展**（`contracts/events.ts`）：新增 4 个 bridge 变体——`toolCall`、`display`（status/task_progress/thinking_blocks/confirm/user_question 展示透传）、`planReady`（plan 负载 H1 阶段不透明，H7 正式化 plan-approval interrupt schema）、`clarification`；事件名常量增补 `text.emitted`/`display.changed`/`error.raised`/`plan.ready`/`clarification.ready`。契约保持不依赖 StreamEvent/Provider 类型。
2. **动态选项传输**：运行时稳定依赖（provider/tools/hooks/stagedContext/thinkingStore/knowledgeBase/modelRouter/gateTelemetryFile/contextMapPolicy/flashTriagePolicy）由 `createRuntime` 注入 harness 构造；CLI/TUI 每轮动态选项（conversationHistory/thinkEffort/stableMemoryContext/autoApprovePlan/runTrace/initialPlanState/planText/resumeFromCheckpoint）经 `AgentRunInput.metadata` 的 `LEGACY_*` key 传输（`legacy-loop-adapter.ts` 导出常量）。H4/H7 正式化 budget 与 interrupt 时替换。
3. **cancel/inspect/resume 最小实现**：`cancel` 经 run-registry 的 AbortController 桥接 `AgentOptions.abortSignal`（H4 完整化）；`inspect` 返回实时 RunSnapshot（H6 持久化）；`resume` 抛 `HarnessError`（H7 实现，签名按 H0 契约保留）。
4. **run 生命周期三档**：created→running→terminal（completed/cancelled/failed），H2 替换为 LifecycleMachine（`contracts/lifecycle.ts` 已有 `canTransition`/`assertTransition`）。
5. **session 语义**：CLI session 运行时创建/切换，`run()` 对未知 sessionId 自动建 session（H6 持久化后 `createSession()` 成为强入口并恢复 `SessionNotFoundError`）。
6. **顺带修复**：CLI plan 批准重跑时 `planText` 未回传（现在从 plan_ready 记录并随 metadata 回传，`prepare.ts` 的 `activateMasterPlan` 得以生效）。
7. **配置**：`orcana.jsonc` 新增 `harness.mode`（H1 仅 `legacy` 生效，shadow/enabled 留作后续开关）；`settings.example.json` 增加注释段。
8. **测试**：`tests/harness_legacy_adapter.test.ts`（8 项：options 映射/工具过滤/abortSignal 透传/事件桥接全表/planReady/clarification/error/sequence 连续）+ `tests/harness_facade.test.ts`（5 项：全流程/final text 单次/cancel 中止 provider/inspect/resume 占位/双 run 隔离）；L0 Golden + L7 Kernel 回归全绿。

**H2 入口：** LifecycleMachine 落地 + `LoopDecision → RunOutcome` 映射 + `finalizeRun` 级联（CLI/TUI 的"plan 批准重跑"循环届时可迁移为 waiting/resume）。

---

# PR-H2：Lifecycle 与统一 Outcome

## 目标

所有退出转换为正式状态和 Outcome。

## 新增

```text
src/harness/runtime/lifecycle-machine.ts
src/harness/runtime/run-controller.ts
src/harness/runtime/cleanup.ts
```

## 修改

```text
src/agent/loop-types.ts
src/agent/loop.ts
src/runtime/events.ts
```

## 实现

* LifecycleMachine；
  -统一终态；
  -LoopDecision Adapter；
  -所有退出生成 Outcome；
  -所有退出经过 Cleanup。

## 测试

* 正常完成；
  -Plan Ready；
  -Clarification；
  -Context Block；
  -Round Budget；
  -Restart Required；
  -Provider Failure；
  -Cancelled。

## 验收

* 不存在无法分类的退出；
  -每个 Run 恰好一个终态；
  -Cleanup 恰好执行一次。

## H2 实施记录（2026-08-02）

**状态：完成。** 全部门禁绿色（typecheck / 141 文件测试 / build / npm pack / diff --check）。

实现要点：

1. **决策暴露（D1）**：`agentLoop` 生成器返回值从 void → `LoopDecision`（`runAgentLoop` try 末尾 `return decision`；abort-at-start 也返回 `{kind:"return", reason:"aborted"}`）。现有 for await 消费者不受影响（不取返回值）。
2. **Adapter 收集决策（D2）**：`executeLoop` 手动 next 循环 + 关闭协议（finally 里 `iterator.return()` 保持 cancel 传播）；`execute` 返回 `AsyncGenerator<HarnessEvent, LoopDecision>`。
3. **Outcome 映射（D3）**：`outcome-mapper.ts` 对 `LoopDecision` 联合做穷尽 switch —— 新增分支未映射会编译失败（"无未分类退出"由类型系统保证）。映射表：orchestrator_done/verified_write/self_edit→completed；plan_ready→waiting(plan-approval)；clarification→waiting(clarification)；round_budget→paused；context_budget/orchestrator_blocked/empty_round/gate_overflow/prompt_blocked→blocked；aborted/tool_batch_aborted→cancelled；provider_failure→failed。
4. **LifecycleMachine（D4）**：包装 H0 的 `assertTransition`，每次转换更新 `run.status` + 发 `run.*` 事件；同状态幂等；非法转换抛 `InvalidStateTransitionError`；`run-registry.setStatus` 移除。**发现并修复 H0 契约缺口**：`running → paused` 必须经 `pausing` 中间态（H0 的 `LEGAL_TRANSITIONS` 未含 pausing 事件名）——契约增补 `run.pausing` 常量，machine 提供 `transitionTo()` 处理中间态。
5. **RunController（D5）**：created→initializing→running→（bridge 事件）→终态；异常→failed + `run.failed` 事件 + **继续传播**（CLI/TUI 现有 catch 依赖）；`cleanupRun()` 在 finally 恰好执行一次（session detach + controller 兜底 abort）。
6. **统一事件序列**：bridge 事件改用 `run.eventSequence`（不再本地计数），生命周期与桥接事件构成单一连续序列（`EventEnvelope.sequence` 全局有序，H5 Trace 前置）。
7. **cancel reason 透传**：`mapDecisionToOutcome(decision, error, abortReason)` —— cancelled outcome 的 reason 来自 `controller.signal.reason`（如 "user hit cancel"）。
8. **测试**：`harness_lifecycle.test.ts` 7 场景（completed/waiting×2/blocked/paused/failed/cancelled，全部经 `inspect()` 断言 status + outcome.kind + 事件）+ `harness_lifecycle_machine.test.ts` 6 项（合法链/非法/幂等/终态/中间态/事件名）。

**H3 入口：** `AgentRunScope` 9 个 `unknown` 占位 → 真实类型（PlanStore/ModeStore/PatchContext/Sandbox/RippleSession/EvidenceLedger/ArtifactStore/Cancellation/Trace），迁移 `AgentRunState` 字段与 legacy setter 到 run-scoped 所有权。

---

# PR-H3：Run Scope 与全局状态清除

## 目标

实现真正的运行隔离。

## 迁移顺序

1. Plan Store；
2. Mode Store；
3. Patch Context；
4. Context Budget；
5. Ripple Session；
6. Sandbox。

## 修改形式

工具由：

```ts
const TASK_TOOL = ...
```

改为：

```ts
createTaskTool(planStore)
```

Shell 由全局 Setter 改为构造注入或执行上下文注入。

## 测试

```text
tests/harness_run_isolation.test.ts
tests/harness_parallel_runs.test.ts
tests/harness_sandbox_isolation.test.ts
```

## 验收

同时运行两个 Mock Run：

* Plan 不串；
  -Mode 不串；
  -Sandbox 不串；
  -Patch Context 不串；
  -Cancel 不串；
  -Ripple 不串。

这是后续 Graph 的硬前置。

## H3 实施记录（2026-08-02）

**状态：完成。** 全部门禁绿色（typecheck / 143 文件测试 / build / npm pack / diff --check）。

实现要点：

1. **契约类型化**：`contracts/scope.ts` 新增 `ModeStore`/`PatchContextStore`/`RippleSession`/`RunCancellation`/`TraceWriter`；`AgentRunScope` 9 个 `unknown` 占位全部替换（planStore/modeStore/patchContext/sandbox/rippleSession/evidenceLedger/artifactStore/cancellation/trace）——H0 技术债清偿，`grep unknown` 无残留。
2. **唯一所有权打通**：`run-registry` 每 run 用 `assembleRunScope`（`runtime/run-scope.ts`）装配 scope（planStore/sandbox/evidenceLedger 新建 + cancellation 桥接 controller + no-op trace + 内存 artifact store）；`AgentOptions` 新增 `sandbox` 字段，`kernel/context.ts` 改为 `options.sandbox ?? new SandboxManager(...)`；adapter 传 `planStore`/`sandbox` —— **harness scope 与 kernel 是同一实例**（测试用 run 内探针验证）。
3. **inspect 快照**：`RunSnapshot.planState`/`modeState`/`evidenceState` 从占位填为可序列化真实快照（plan revision/goal/nodes、mode、evidence entries 数）——H6 持久化的前置形状。
4. **隔离验证**（双 run 并行）：plan 写入各自快照不串（A 的 plan 出现在 B 的 inspect 中即失败）、mode 经 ALS 各自独立（A 设 planner 后 B 内仍 coder）、patch context 不串、cancel A 不影响 B（B 正常 completed）、kernel 层 planStore/sandbox 实例分离。
5. **边界记录**：mode/patch/ripple/budget 的权威值仍在 kernel ALS（按 run 隔离已成立），scope 提供初始快照——ALS→scope 的读取点迁移（`getActiveMode()` 等调用方改造）留待后续阶段按计划迁移顺序进行；`RunCancellation` 保持 AbortController 桥接（H4 加预算/超时）；`TraceWriter` no-op（H5）。

**H4 入口：** `RunCancellation` 完整化（超时/预算联动）+ `BudgetLedger` Reserve-Commit 实现 + 挂接 Provider/Tool/Verification/Checkpoint + 超预算明确原因（model_call/tool_call/token/wall_time/write/external_action/repair）。

---

# PR-H4：Cancellation 与 BudgetLedger

## 目标

统一资源治理。

## 新增

```text
src/harness/runtime/cancellation.ts
src/harness/contracts/budget.ts
src/harness/runtime/budget-ledger.ts
```

## 修改

* Provider Runner；
  -Tool Executor；
  -Research；
  -Compaction；
  -Verification；
  -Checkpoint。

## 测试

* Provider 可取消；
  -Tool 可取消；
  -取消后无继续事件；
  -并发预算 Reserve；
  -预算不足阻止启动；
  -实际成本正确 Commit；
  -失败 Reservation 被 Release。

## 验收

不再由各模块私自判断总预算。

## H4 实施记录（2026-08-02）

**状态：完成。** 全部门禁绿色（typecheck / 145 文件测试 / build / npm pack / diff --check）；**kernel 零改动**（git diff 验证）。

实现要点：

1. **BudgetLedger**（`runtime/budget-ledger.ts`）：H0 契约的 Reserve→Commit 实现——reserve 按 kind 校验（含未 commit 的 pending reservation 并发计数），commit 累计实际用量并校验 token 限额，release 恢复容量，全部幂等；超限抛 `HarnessError("budget_exhausted", <明确原因>)`。
2. **Cancellation 完整化**（`runtime/cancellation.ts`）：`createRunCancellation` 从 run-scope 迁入；新增 `createRunCancellationWithTimeout` —— wall-time 看门狗，超时自动 `cancel("wall_time_budget")`，卡死 run 也能终止。
3. **BudgetGuard**（`runtime/budget-guard.ts`）：harness 控制面观测事件流——modelCalls 按轮次**首个 usage 事件**计数（kernel 每轮先 estimate 后 provider-final，首个事件计数保证超限发生在该轮任何工具事件之前 → "取消后无继续事件"成立）；tokens 仅 provider 源（直写 ledger.used + 限额自检）；toolCalls 逐事件计数。超限 → `controller.abort(reason)` → 既有 cancel 链路（H2）产出 cancelled outcome，reason = BudgetExhaustionReason。
4. **装配**：`AgentRunInput.budget?: Partial<RunBudget>` 限额入口；`maxRounds → maxModelCalls` 映射（显式 budget 优先）；`AgentRun.budget` 真实实现（H1 起占位清除）；`inspect.budgetState` 返回 limits/used/remaining 快照。
5. **行为冻结**：预算治理完全在 harness 层（§3.4 控制面/§9.3 全局预算移交 Harness），kernel 无改动。
6. **边界记录**：write/external_action/repair 限额在 ledger 中就绪但未挂接（kernel 事件流未桥接工具分类，H8/H9 接入）；token 记账直写 used（绕过 commit 的 token 校验路径，guard 自检等效）。

**H5 入口：** Typed Events / Trace V2 —— EventEnvelope 序列化落盘（`run.eventSequence` 已全局连续，H2 前置就绪）、事件类型联合、`migrateLegacyTrace()`、统一 Redaction、TraceWriter 从 no-op 接真实现。

---

# PR-H5：Typed Events 与 Trace V2

## 目标

建立统一可重放事件协议。

## 新增

```text
src/harness/telemetry/*
src/harness/persistence/event-store.ts
```

## 修改

```text
src/agent/run-trace.ts
benchmarks/ripplebench/scorer.ts
evals/live-runner.ts
```

## 实现

* Event Envelope；
  -Schema Version；
  -Sequence；
  -事件类型联合；
  -Trace Migration；
  -统一 Redaction。

## 重点修复

所有 Scorer 通过共享类型读取：

```ts
event.payload
```

禁止读取猜测字段。

## 验收

* Sequence 连续；
  -事件顺序稳定；
  -旧 Trace 可读取；
  -敏感值被遮蔽；
  -Trace 写入异常不导致 Run 失败。

## H5 实施记录（2026-08-02）—— 第一里程碑收官声明

**状态：完成。** 全部门禁绿色（typecheck / 146 文件测试 / build / npm pack / diff --check）。

**里程碑成果（计划 §二十五）：** 正式 Harness API（H1）· 统一运行生命周期（H2）· 明确 Outcome（H2）· 真正 Run 隔离（H3）· 统一取消和预算（H4）· 可用于 Replay 的类型化 Trace（H5）。

实现要点：

1. **TraceWriter 契约对齐**：`append<T>(event: EventEnvelope<T>)`（§12.3 计划形状），no-op 实现同步。
2. **JSONL TraceWriter**（`telemetry/trace-writer.ts`）：`.orcana/harness/events/<runId>.jsonl`；队列 + `setImmediate` 节流批量写；写失败静默（回队重试不抛）；close 后 append no-op；flush/close 幂等。
3. **全事件接入**：lifecycle 事件（run.*）与 bridge 事件都经 trace 落盘 —— 事件顺序 = 落盘顺序 = sequence 连续（`run.eventSequence`，H2 前置）。发现并修复时序问题：终态事件原先在 flush/close 之后 append 被丢弃，重排到 try 内。
4. **Redaction**：复用 `secret-redactor.redactForTrace`（不重复实现），payload 落盘前遮蔽。
5. **迁移**（`telemetry/migration.ts`）：`migrateLegacyTraceLine`/`migrateLegacyTrace` 旧 `{runId,timestamp,type,data}` → Envelope（payload.legacy 承载），损坏行跳过。
6. **scorer 共享类型**（`benchmarks/ripplebench/scorer.ts`）：`readRunEvents` 优先识别新 Envelope、旧行走迁移函数，归一化为 `{type, ...data}` —— 不再裸 JSON 猜测字段。
7. **边界**：kernel 旧 `AgentRunTrace`（`.orcana/runs/`）保留（§22.3 H11 前不删）；H5 trace 与旧 trace 并行，均为共享类型可读。

**H6 入口：** FileHarnessStore + RunSnapshot 持久化 + Schema Migration + Workspace Hash + Continuation Point（inspect 的 plan/mode/budget 快照形状已在 H3/H4 就绪）。

---

# PR-H6：Store、Snapshot 与基础恢复

## 目标

Run 可以持久化和重新装配。

## 新增

```text
src/harness/persistence/*
```

## 实现

* FileHarnessStore；
  -Run Snapshot；
  -Schema Migration；
  -恢复依赖注入；
  -Workspace Hash；
  -Continuation Point。

## 测试

* Snapshot round-trip；
  -旧 Schema 迁移；
  -中断后恢复；
  -损坏 Snapshot 拒绝；
  -缺失 Artifact 报告；
  -Workspace 改变检测。

## 验收

恢复后不会重复已经完成的不可逆操作。

## H6 实施记录（2026-08-02）

**状态：完成。** 全部门禁绿色（typecheck / 147 文件测试 / build / npm pack / diff --check）。

实现要点：

1. **存储契约**（`persistence/harness-store.ts`）：`SerializableSession`/`SerializableRun`/`SerializablePlanState`（可重建集：goal/intent/current/nodes{id,title,status,dependsOn,blockedBy,evidence,reactCount}）+ `HarnessStore` 接口（§13.2：save/loadSession、save/loadRun、appendEvent、save/loadSnapshot）。
2. **FileHarnessStore**（`persistence/file-harness-store.ts`）：`.orcana/harness/{sessions,runs,snapshots,events}/`；损坏/缺失/版本不匹配一律返回 null（读永不崩溃）；快照文件名 `<runId>-<sequence>.json`。
3. **序列化/恢复**（`persistence/serialization.ts`）：`serializeRun` scope 实例→快照投影（JSON 安全，无 AbortController/planStore 泄漏）；`restoreAgentRun` 重新装配 scope（assembleRunScope 复用）+ budget 重建（limits/used 恢复）+ **plan 节点状态保留（done 不重置 —— 不重复不可逆操作）**；`deserializePlanState` 经 `createMasterPlan` 重建后回填状态，tracker 占位（H7 完整化）；`snapshotFromRun` 与 inspect 同形状。
4. **Workspace Hash**（`persistence/workspace-hash.ts`）：复用 `fingerprintFile`（sha256），排除 node_modules/.git/.orcana/dist/.wolf，排序聚合；稳定 + 变化可检测（测试验证）。
5. **接线**：`AgentHarnessInput.store?`/`workspaceHash?`；run 终态（含异常 failed）在 finally 中 best-effort `saveRun + saveSnapshot`；`inspect` 内存 miss → store.loadRun → restore 后返回快照（新 harness 实例可查历史 run，模拟进程重启）。
6. **边界**：快照时机仅终态（§13.3 完整时机表——初始化/计划接受/WAITING/事务提交等——H7 按需补充）；tracker/_packet 不序列化（占位重建）；workspace hash 计算器由调用方注入（大项目性能控制）。

**H7 入口：** Plan Approval 与 Clarification 从"结束后重启"升级为持久等待 —— `interrupt.created` 事件 + `resume()` 实现（快照恢复 + Workspace Hash 校验 + 幂等响应 + 从 Continuation Point 继续）。

---

# PR-H7：Interrupt / Resume

## 目标

把 Plan Approval 和 Clarification 从“结束后重启”升级为“持久等待后恢复”。

## 第一阶段

* Plan Approval；
  -Clarification。

## 第二阶段

* Tool Approval；
  -Credential；
  -Manual Verification。

## 测试

-等待状态持久化；
-进程重启后 Resume；
-重复响应幂等；
-错误 Schema 拒绝；
-用户拒绝形成正式分支；
-过期 Interrupt 不恢复。

## 验收

WAITING 期间不持有 Provider、Sandbox 或子进程资源。

## H7 实施记录（2026-08-02）

**状态：完成。** 全部门禁绿色（typecheck / 148 文件测试 / build / npm pack / diff --check）。

实现要点：

1. **响应 Schema 校验**（`interrupts/response-validator.ts`）：JsonSchema 子集最小校验（type/properties/required/enum），返回错误列表。
2. **Interrupt 处理器**（`interrupts/plan-approval.ts` + `clarification.ts`）：kind 专属 schema 与 prompt；`applyPlanApprovalResponse`（续跑 metadata：`LEGACY_INITIAL_PLAN_STATE` + `LEGACY_PLAN_TEXT` —— 与 CLI 预 H7 续跑输入一致）；`applyClarificationResponse`（history 注入：原 prompt → 标记 assistant 消息 → 回答 user 消息 —— `findPendingClarification` 要求标记前的 user 消息，注入顺序按此构造，续跑不再触发澄清）。
3. **InterruptManager**（`interrupts/interrupt-manager.ts`）：waiting 决策自动创建 pending interrupt（run-controller 挂载 + `interrupt.created` 事件 + H6 落盘含 interrupt）；resume 校验链（§11.3）：waiting → pending（重复已答幂等拒绝 `interrupt_not_pending`）→ interruptId 匹配 → schema（`invalid_interrupt_response`）→ workspace hash（`workspace_changed`）。
4. **resume() 续跑**：`runControlledRun` 支持 `resumeInput`（`waiting→resuming→running` 起点，不发 initializing）；budget guard/trace/终态保存全复用；新 AbortController（waiting 时旧 controller 已被 cleanup abort）；拒绝分支 `accepted:false` → rejected + cancelled（reason "interrupt_rejected"）正式 outcome。
5. **跨实例 resume**：store.loadRun → restoreAgentRun → registerRestored + savedWorkspaceHash 校验；进程内重复 resume 由 interrupt.status 拦截。
6. **验收确认**：WAITING 期间资源已释放（run 结束即 cleanup，测试验证 run 正常终态）；mock 环境无验证证据时续跑后为 completion-gate blocked —— kernel 合理行为（测试断言"离开 waiting + interrupt answered"）。
7. **边界**：CLI/TUI 的 do-while 批准重跑保留（legacy 模式回滚开关），resume API 已就绪，CLI 迁移记为后续项；tool_approval/credential/manual_verification 属第二批（未实现）。

**H8 入口：** Artifact/Evidence 统一 —— `ArtifactStore` 真实现（H3 内存版升级）+ EvidenceLedger 绑定 Artifact + 新鲜度（workspaceHash/relevantFileHashes/transactionId）+ CompletionOrchestrator 改从 Artifact/Evidence 派生完成事实（消除 `lastTypecheck` 重复事实）。

## H8 实施记录（2026-08-02）

**状态：完成。** 全部门禁绿色（typecheck / 154 文件测试 / build / npm pack / diff --check）。

实现要点：

1. **ArtifactStore 真实现**（`artifacts/{provenance,artifact-store,freshness,evidence-adapter}.ts`）：契约扩展 `markSuperseded/findByKind/entries/storeContent/getContent`（§14.1/§14.2）；content 按 sha256 去重（同内容同 ref），artifact 只存 ref+hash；`createArtifact` 工厂统一 stamp producedBy/createdAt（来源）；status 转换幂等（stale/superseded）。
2. **Evidence↔Artifact 绑定**（§14.2）：`EvidenceEntry` 加 `artifactId/stale`；adapter 的 `ingestVerificationWithArtifact`/`ingestTypecheckWithArtifact` 一次产出 artifact（typecheck_result/test_result/build_result，status valid/failed）+ 绑定 evidence（transaction snapshot 取自 result.transaction，与 `ingestVerificationResult` 一致）；`putPatchArtifact`/`putPlanArtifact`（新取代旧 → superseded）/`putRippleArtifact` 独立函数。
3. **新鲜度**（§14.3，`freshness.ts`）：workspaceHash 漂移 → 验证类 artifact stale；relevantFileHashes 逐文件比对（删除=变化）→ stale；每个 stale artifact 同步 `markEvidenceStale`（evidence 侧 stale）；`hasFreshPassingEvidence` L1 拒绝 stale（旧数据无字段= falsy，向后兼容）——"旧证据不能完成新版本任务"。
4. **注入链**（L2 同模式）：`AgentOptions.artifactStore/runId` → `RunPhaseContext` → `verificationCtx`；harness `buildLoopOptions` 注入 run-scope 的 store（唯一所有权）；`run-scope.ts` 的 H3 占位 `createInMemoryArtifactStore` 删除。
5. **coordinator 接线**：`bindVerificationToLedger` 有 store 时逐 result 走 adapter（否则现状路径，行为不变）；batch tsc → `ingestTypecheckWithArtifact`；`bindVerificationToLedger` 改 async（adapter 为异步，round.ts 调用点 await）。
6. **CompletionOrchestrator 消除 `lastTypecheck`（验收达成）**：`CompletionOrchestratorInput.lastTypecheck` 删除；`buildCompletionContext`/`evaluateExternalGate`/narrow-edit 全部改 `deriveLastTypecheck(evidenceLedger)` 派生（gates ctx 值同源，单一事实）；truthfulness 无 ledger 时仅靠 verificationResults（fail-closed）；`NarrowEditCheckInput.lastTypecheckPassed` 删除；`verificationState.lastTypecheck` 保留为 kernel 内部 compat projection（batch-executor/maintenance 用，非 orchestrator 依赖）。
7. **序列化升级**：`SerializableRun.evidenceState` 从 count → `SerializedEvidenceEntry[]` + `artifactRefs`；`snapshotFromRun`/`inspect` 返回真实序列化 entries 与 artifact refs；restore 兼容 H6 旧文件（非数组 → 空 ledger）；content 不跨 run 恢复（refs 即快照）。
8. **测试**（`tests/harness_artifacts.test.ts` 12 项）：Typecheck/Test/Patch（supersede）/Ripple/Plan Artifact、Artifact Stale（文件变化+workspace 漂移+删除）、证据绑定事务（transaction/generation 校验）、content 去重、serialization 快照；orchestrator 测试清理 6 处旧字段（1 项语义适配：无 typecheck 证据 → 不自动完成 fail-closed）。

**H9 入口：** Capability Registry —— 统一 Tool/Model/Verifier 能力描述（§15）；第一批迁移 read_file/find_symbol/find_references/write_file/edit_file/shell/typecheck；patch/plan/ripple artifact 真接线点在 CapabilityExecutor After Hook（§15.3 "Artifact / Evidence" 步骤）。

---

# PR-H8：Artifact 与 Evidence Integration

## 目标

将产物、证据和新鲜度统一。

## 新增

```text
src/harness/artifacts/*
```

## 修改

```text
src/agent/evidence-ledger.ts
src/agent/completion-orchestrator.ts
src/verification/*
src/agent/patch-transaction.ts
```

## 测试

* Typecheck Artifact；
  -Test Artifact；
  -Patch Artifact；
  -Ripple Artifact；
  -Artifact Stale；
  -证据绑定事务；
  -旧证据不能完成新版本任务。

## 验收

CompletionOrchestrator 不再依赖散落的 `lastTypecheck` 等重复事实。

---

## H9 实施记录（2026-08-03）

**状态：完成。** 全部门禁绿色（typecheck / 155 文件测试 / build / npm pack / diff --check）。

实现要点：

1. **Capability 基础设施**（`src/harness/capabilities/{descriptor,registry,tool-adapter,index}.ts`）：H0 契约实现——registry（register/resolve/list，重复/未知抛 typed `HarnessError`）；`createCapabilityDescriptor` 保守默认值；`TOOL_OUTPUT_SCHEMA` 共享占位（`{success, content}`，metadata 自由扩展）；`budgetKindsFor`（tool_call 恒含 + write/external_action）。**Tool→Capability 纯投影**（§15.4 + §23 风险控制：复用 `projectToolContract`，不建第二套工具系统）：sideEffect 归约（external 优先于 workspace_write——shell 命令首先是外部动作，与 H4 kind 设计对齐）、riskLevel=contract.risk.baseLevel（每次调用真实风险仍由 L4 `getToolRisk` 计算）、producesEvidence=state.updates 含 evidence、concurrencyGroup 按 isConcurrencySafe 区分；`registerToolCapabilities` 只注册第一批 7 工具；`classifyToolSideEffect` 注册优先、`inferToolCategory` 回退（file→write、shell/network→external）。
2. **CapabilityExecutor 八步链**（§15.3，`executor.ts` + `policy-adapter.ts`）：Budget Reserve → Policy → Before Hook → Handler → After Hook → Result Schema Validation → Artifact/Evidence → Budget Commit。**8 层 Gate 顺序不复制**：node 模式经 `buildNodePolicyInput` 直调同一 `evaluateToolPolicy` 纯函数（编译级冻结）；loop 模式 `policyDecision` 恒等透传。Handler：loop 走 `executeSingleTool`（hooks 由步骤 3/5 拥有，防双跑，含 streaming 工具）、node 走注册 handler；`parallelResult` 完全跳过 hooks（L4 语义）；失败路径全部 release 已 reserve 预算。**未迁移工具兜底**：loop 模式（有 tool）resolve 失败时现场投影（与 classify 回退同源），node 模式严格拒绝。
3. **Loop 统一入口（验收达成）**：`batch-executor` 两处工具调用（并行只读 + 主路径）改走 `executeCapability`；`tool_batch_executor.test.ts` **零改动全绿**作行为冻结回归（L0 Golden / L7 kernel 亦全绿）。注入链：`AgentHarness` 建 registry → `LegacyLoopAdapterDeps.capabilityRegistry` → `AgentOptions` → `RunPhaseContext` → `ToolBatchContext`（H8 同模式）。
4. **H4 技术债清偿（write/external_action 限额）**：`BudgetRequest.kind` 补 `"repair"`（ledger 三个 switch 分支，三件套对齐）；tool_call 桥接事件携带 `sideEffect` 分类（additive 字段，`harness_legacy_adapter.test.ts` 字段级断言不受影响）；`BudgetGuard` 按分类追加 consume write/external_action → 超限 reason 自动为 `write_budget`/`external_action_budget`（`budgetReasonFromMessage` 已支持）。**repair 事件挂接留后**：loop 事件流无 repair-cycle 事实源，维护协调器迁移时再接（文档化）。
5. **H8 技术债清偿（patch/plan/ripple artifact 真接线）**：patch → executor After Hook tracker（`createToolArtifactTracker`：before 按 input.path 快照文件（1MB 上限），after 对 success+`metadata.patchTransactionId` 的结果读文件 → `generateLineDiff`/`formatDiff` → `putPatchArtifact`，typecheck 天然排除——sideEffect 非 write）；plan → adapter `plan_ready` 桥接点（`planTextFromPayload` 提取，`putPlanArtifact`）；ripple → coordinator `runRippleVerificationPhase`（与 H8 typecheck 同点，每轮一个 `ripple_report`）。全部 best-effort（artifact 失败不破坏 run）。**对 §15.3 的诚实偏离**：plan/ripple 是流程事实（interrupt/验证阶段）而非 capability 执行，接线点放在事实产生处，避免把非工具流程伪造成 capability（§23 风险控制）。
6. **测试**（`tests/harness_capabilities.test.ts` 25 项）：投影表（7 工具 sideEffect/risk/idempotent/evidence）、registry（注册/未知/重复/自定义能力）、classify 回退、budgetKinds、repair kind、executor（node 执行/失败/未知拒绝/策略一致性/预算耗尽与释放/read 只计 tool_call/before 阻断/after 替换/parallelResult 短路/policyDecision 恒等）、artifact（patch 全链 diff 断言/失败与无事务不记录/planText 提取）；`harness_budget.test.ts` +2（write/external 限额经真实 harness run，断言 sideEffect 分类 + 取消 reason）。

**H10 入口：** Context Pipeline —— 上下文提供与 Loop 执行分离；Capability 的 node 模式策略默认值由 Node 上下文富化（§17.3 `NodeExecutionContext.capabilities` 依赖 H9 registry）。

---

# PR-H9：Capability Registry

## 目标

统一 Tool、Model、Verifier 和未来 Worker 的能力描述。

## 新增

```text
src/harness/capabilities/*
```

## 第一批迁移

* read_file；
  -find_symbol；
  -find_references；
  -write_file；
  -edit_file；
  -shell；
  -typecheck。

## 测试

* Schema 验证；
  -Policy 顺序；
  -风险分类；
  -Budget；
  -Hook；
  -Artifact；
  -未知 Capability 拒绝。

## 验收

普通 Loop 和未来 Node Runtime 使用同一执行入口。

---

# PR-H10：Context Pipeline

## 目标

把上下文提供与 Loop 执行分离。

## 新增

```text
src/harness/context/*
```

## 迁移顺序

1. Stable Memory；
2. Project Kernel；
3. Plan State；
4. Mode Contract；
5. ContextMap；
6. Skills；
7. Knowledge；
8. Research；
9. Conversation Tail。

## 测试

* Context 顺序；
  -预算裁剪；
  -必需 Context 保留；
  -重复来源去重；
  -Cache Key 稳定；
  -过期 Context 不加载。

## 验收

Loop 不再直接拼装十余种 Context 来源。

---

# PR-H11：Unified Node Runtime

## 目标

建立未来 Graph 的执行原语。

## 新增

```text
src/harness/nodes/*
```

## 首批节点

* FunctionNode；
  -ToolNode；
  -LlmAgentNode；
  -VerificationNode；
  -HumanNode。

## 限制

* 只支持顺序调用；
  -不实现 DAG；
  -不实现并行写；
  -不实现动态 Workflow。

## 测试

* Node 生命周期；
  -Node Budget；
  -Node Cancellation；
  -Node Artifact；
  -Node Context；
  -LlmAgentNode 与旧 Loop 行为一致。

## 验收

单 Agent 可以被正式表示为一个 `LlmAgentNode`。

---

# PR-H12：Eval Harness 2.0

## 目标

建立可信回归体系。

## 新增

```text
evals/harness/*
tests/harness-replay/*
```

## 实现

* Function Replay；
  -Run Replay；
  -Provider Script；
  -Tool Script；
  -Trace Invariant；
  -多维 Rubric；
  -基线比较；
  -失败分类；
  -报告。

## CI 分层

```text
每次提交：
typecheck + unit

每个 PR：
unit + function replay + run replay

发布候选：
integration + live smoke

正式发布：
完整 live eval + RippleBench
```

## 验收

Harness 重构后不仅“测试通过”，还能够回答：

-能力是否退化；
-安全性是否退化；
-成本是否上升；
-轮数是否增加；
-虚假完成是否增加；
-恢复是否可靠；
-运行是否隔离。

---

# 二十、实施依赖图

```text
Loop Readiness
      ↓
H0 Contracts
      ↓
H1 Facade / Adapter
      ↓
H2 Lifecycle / Outcome
      ↓
H3 Run Isolation
      ↓
H4 Cancellation / Budget
      ↓
H5 Typed Trace
      ↓
H6 Persistence
      ↓
H7 Interrupt / Resume
      ↓
H8 Artifact / Evidence
      ↓
H9 Capability Registry
      ↓
H10 Context Pipeline
      ↓
H11 Node Runtime
      ↓
H12 Eval Harness 2.0
      ↓
Execution Graph
```

部分工作可并行：

```text
H5 Typed Trace
      ├──────── H8 Artifact Schema
      └──────── H12 Eval Schema Design
```

但生产接线仍应按主依赖顺序合并。

---

# 二十一、与剩余 Loop 减重的协作关系

## 现在即可开始

即使 Loop 只完成一半，也可以先做：

* H0 Contract；
  -Harness 状态机设计；
  -Event Schema；
  -Artifact Schema；
  -Eval Scenario 设计；
  -Run Isolation 测试骨架。

## 等 Loop 状态集中后再做

* H1 Adapter；
  -H2 Outcome；
  -H3 全局状态清除。

## 等 Tool/Verification 边界稳定后再做

* H8 Artifact；
  -H9 Capability Registry。

## 等 Context 拼装抽离后再做

* H10 Context Pipeline。

## 必须最后做

* H11 Node Runtime；
  -Execution Graph。

---

# 二十二、迁移与兼容策略

## 22.1 Feature Flag

```json
{
  "harness": {
    "mode": "legacy"
  }
}
```

模式：

* `legacy`：原 Loop 行为；
  -`shadow`：Harness 记录状态，但原 Loop 决策；
  -`enabled`：Harness 正式控制生命周期。

---

## 22.2 Shadow 对比

Shadow 模式记录：

* Legacy 退出原因；
  -Harness 推导 Outcome；
  -事件数量；
  -预算；
  -Artifact；
  -清理状态。

若二者结论不同，记录：

```text
harness.shadow_mismatch
```

不得影响用户当前运行。

---

## 22.3 回滚

每个 PR 都必须可通过 Feature Flag 退回 Legacy。

在 H11 完成以前，不删除：

* 原 `agentLoop()` 导出；
  -旧 Trace Reader；
  -旧 Session 数据读取；
  -旧 Plan Approval 输入。

---

## 22.4 废弃顺序

1. 标记直接调用 `agentLoop()` 为 deprecated；
2. CLI/TUI 全部迁移；
3. Eval 迁移；
4. 插件和外部入口迁移；
5. 两个发布周期后移除 Legacy Adapter。

---

# 二十三、风险与控制

| 风险                                | 控制                               |
| --------------------------------- | -------------------------------- |
| Harness 与 Loop 双写状态               | 明确唯一 Owner，Shadow 只读             |
| 重构期间行为退化                          | Legacy Feature Flag              |
| 事件数量过大                            | 批量写入和 Payload Reference          |
| Snapshot 太重                       | 只保存可序列化状态和 Artifact Ref          |
| Resume 重复副作用                      | Transaction ID + Idempotency Key |
| Capability Registry 变成另一套 Tool 系统 | Adapter 复用现有 ToolDescriptor      |
| Context Pipeline 改坏 Cache         | Stable Layer 保持字节稳定              |
| Evidence 迁移导致完成失败                 | 兼容 Adapter + Shadow 比对           |
| Eval 评分失真                         | Required Check + 多维 Rubric       |
| Node Runtime 提前膨胀                 | 首版只做顺序执行                         |
| Graph 与 Harness 同时开工              | H11 验收前禁止 Scheduler 接线           |

---

# 二十四、Definition of Done

Harness 2.0 完成时必须满足：

## API

* CLI/TUI 只调用 AgentHarness；
  -生产代码不直接调用 Loop；
  -所有 Run 有唯一 Run ID；
  -所有 Run 有唯一 Outcome。

## 隔离

-无模块级运行状态；
-两个 Run 并行不串扰；
-取消一个 Run 不影响另一个；
-每个 Run 有独立 Sandbox、Plan、Mode 和 Evidence。

## 生命周期

-合法状态转换完整；
-非法转换被拒绝；
-所有终态只出现一次；
-所有退出都执行清理。

## 恢复

-Plan Approval 可持久恢复；
-Clarification 可持久恢复；
-重复 Resume 幂等；
-Workspace 改变会阻止危险恢复；
-已提交事务不重复执行。

## 事件

-所有事件类型化；
-Sequence 连续；
-Schema 可迁移；
-敏感信息被隐藏；
-Scorer 使用共享事件类型。

## 证据

-Artifact 与 Evidence 分离；
-Evidence 绑定 Workspace 状态；
-过期 Evidence 不满足完成；
-最终报告能追溯到实际 Artifact。

## 能力

-工具经过统一 CapabilityExecutor；
-权限和风险不可绕过；
-Budget 不可绕过；
-结果经过 Schema 验证。

## 上下文

-所有来源经过 Context Pipeline；
-Context 有预算；
-Context 可追踪来源；
-Graph Node 可获得独立 ContextSlice。

## 评测

-至少 30 个 Harness Scenario；
-完整 Run Replay；
-双 Run 隔离测试；
-Interrupt / Resume 测试；
-Truthfulness 测试；
-成本和效率基线；
-Live Smoke Test。

---

# 二十五、最终推荐执行范围

不要一次完成全部 H0–H12。

当前合理的第一里程碑是：

```text
H0 Contracts
→ H1 Facade
→ H2 Lifecycle
→ H3 Run Isolation
→ H4 Cancellation / Budget
→ H5 Typed Trace
```

完成 H5 后，Orcana 会获得：

* 正式 Harness API；
  -统一运行生命周期；
  -明确 Outcome；
  -真正 Run 隔离；
  -统一取消和预算；
  -可用于 Replay 的类型化 Trace。

第二里程碑：

```text
H6 Persistence
→ H7 Interrupt / Resume
→ H8 Artifact / Evidence
```

完成后获得：

* 可持久等待；
  -进程重启恢复；
  -幂等 Resume；
  -可信 Artifact 与 Evidence。

第三里程碑：

```text
H9 Capability
→ H10 Context
→ H11 Node Runtime
→ H12 Eval 2.0
```

完成后，Orcana 才具备安全进入 Execution Graph 阶段的条件。

---

# 二十六、最终架构定位

Harness 2.0 完成后，Orcana 的层次应当变成：

```text
Orcana
├── Agent Harness
│   ├── Lifecycle
│   ├── Session / Run
│   ├── Interrupt / Resume
│   ├── Budget / Policy
│   ├── Capability
│   ├── Context
│   ├── Artifact / Evidence
│   └── Trace / Replay
│
├── Unified Node Runtime
│   ├── LlmAgentNode
│   ├── ToolNode
│   ├── FunctionNode
│   ├── VerificationNode
│   └── HumanNode
│
└── Future Execution Graph
    ├── Scheduler
    ├── Ready Queue
    ├── Join
    ├── Retry
    └── Convergence
```

这时，Loop 不再是 Orcana 的全部核心。

它只是 Orcana Harness 中负责 LLM 自主推理与工具迭代的一个执行器。

而 Harness 才是管理：

```text
目标
状态
资源
能力
证据
风险
恢复
生命周期
```

的真正 Agent Kernel。
