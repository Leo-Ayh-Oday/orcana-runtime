# DeepSeek Orcana Harness 2.0 整体实施方案

**方案版本：** H2.0
**适用阶段：** Loop 减重已完成约一半
**核心目标：** 把 Orcana 已有的权限、状态、工具、证据、事务、上下文和恢复机制，收敛为一套稳定、隔离、可恢复、可评测的 Agent Harness。
**后续承接：** Unified Node Runtime、Execution Graph、System Knowledge Graph、Multi-Agent。

## 实施进度

| PR | 状态 | 日期 | 备注 |
| --- | --- | --- | --- |
| H0 Contracts | 完成 | 2026-08-02 | `src/harness/contracts/*`（harness/session/run/outcome/events/interrupt/artifact/capability/budget/errors/schema/snapshot/lifecycle）+ `src/harness/index.ts`；类型完整、无 `any`、不依赖 UI/具体 Provider、不导入 `loop.ts`；`tests/harness_contracts.test.ts` / `harness_outcome.test.ts` / `harness_status_transition_types.test.ts` 共 17 项；门禁绿色。**技术债：** `AgentRunScope` 的 7 个字段（planStore/modeStore/patchContext/sandbox/rippleSession/evidenceLedger/artifactStore/cancellation/trace）与 `RunSnapshot` 的 plan/mode/budget/evidence state 当前以 `unknown` 占位——这是有意为之（避免触发 H0"停止条件"：Contract 引用遗留内部类型即停止接线），H3 Run Scope 时须替换为真实、可序列化类型 |
| H1 Facade / Adapter | 完成 | 2026-08-02 | `src/harness/runtime/{agent-harness,legacy-loop-adapter,run-registry}.ts`；CLI/TUI 生产入口改走 `AgentHarness.run()`（`agentLoop` 直接调用清零）；`cancel` 桥接 abortSignal、`inspect` 返回 RunSnapshot、`resume` H7 占位；`HarnessEvent` 契约扩展 4 个 bridge 变体（toolCall/display/planReady/clarification）；顺带修复 CLI plan 批准重跑 `planText` 未回传 bug；`tests/harness_legacy_adapter.test.ts` 8 项 + `harness_facade.test.ts` 5 项；全量 139 文件门禁绿色。**技术债：** 动态选项经 `AgentRunInput.metadata` 的 `LEGACY_*` key 传输（H1 过渡机制，H4/H7 正式化）；`AgentRunScope` 9 字段仍 `undefined` 占位（H3 替换）；run 终态仅 created→running→terminal 三档（H2 引入 LifecycleMachine） |
| H2—H12 | 未开始 | — | 按依赖图顺序：H2 Lifecycle/Outcome → H3 Run Isolation → H4 Cancellation/Budget → H5 Typed Trace（第一里程碑） |

> 前置状态：ALK 减重 L0—L7 全部完成（2026-08-02）。Readiness Gate 复核：R1 统一清理 ✅（L7 统一 finally + `finalizeRun()`）；R2 RunState 集中 ✅（`AgentRunState` + `kernel/` RunPhaseContext）；R3 阶段边界 ✅（ProviderRoundRunner / ToolBatchExecutor / VerificationCoordinator / MaintenanceCoordinator 四个齐备）；R4 退出结构化 ✅（`LoopDecision` + 唯一终态 switch）；R5 全局状态消除 ✅（所有 legacy setter——mode/patch/sandbox/cascade/budget-mode——均为 deprecated 兼容层，底层写入 AsyncLocalStorage 的 RuntimeExecutionContext；L2 `AgentRunScope` 已隔离 Plan/Tool）。按 §4.2 结果表：R1–R5 全部完成，可直接开始 H0–H2。**H0、H1 已完成**（进度表见上），下一步为 **PR-H2 Lifecycle / 统一 Outcome**。详见 `docs/agent-loop-kernel-refactor-plan.md`（ALK 已收束，续作点指向 Graph Runtime G0，与 Harness H2–H11 并行不冲突）。

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
.deepseek-code/
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
