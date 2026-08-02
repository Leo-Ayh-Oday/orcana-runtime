# Orcana Agent Loop Kernel 重构计划

**文档状态：** In Progress  
**计划编号：** ALK-1.0  
**代码核对日期：** 2026-07-30  
**仓库基线：** `07821ea8a6f741112fafb41307af210042115fad`  
**当前包版本：** `0.3.4`  
**关联方案：** `docs/typed-execution-graph-runtime-plan.md`  
**实施原则：** 行为冻结、增量迁移、Run Scope 优先、唯一控制链、Graph Runtime 后置。

## 实施进度

| 阶段 | 状态 | 日期 | 结果 |
| --- | --- | --- | --- |
| L0 行为基线 | 完成 | 2026-07-30 | Golden Trace、提前退出清理、Stop Hook 终态、Plan Ready、Context Budget 和 Runtime Self-edit 回归已落地；新增工具契约指纹已同步，全量门禁绿色 |
| L1 AgentRunState | 完成 | 2026-07-30 | 新增 Run/Round State、只读序列化 Snapshot 和显式 StatePatch；运行级局部状态按 ownership 迁移，L0 Golden Trace 保持一致 |
| L2 Run Scope 与并发隔离 | 完成 | 2026-07-30 | Plan/Todo/Tool Registry 与 Runtime/File State 绑定到单一 AgentRunScope；Patch registry、Ripple cache、Checkpoint scheduler 均按 Run 隔离，重叠双 Run 测试通过 |
| L3 ProviderRoundRunner | 完成 | 2026-07-30 | Provider 请求、流解析、usage、文本缓冲、idle timeout、abort、iterator cleanup 和失败恢复策略已抽出；`loop.ts` 不再直接调用 Provider |
| L4 ToolBatchExecutor | 完成 | 2026-08-02 | `src/agent/tool-execution/{batch-executor,single-executor,result-normalizer}.ts` 抽出；并行只读、8 层 Policy、Hook、timeout/abort、ToolLedger 与结果规范化统一到一个执行入口；hard-block 也写入 Ledger；`loop.ts` 由 2077 行降至 **1726 行**（净减 351，低于 400–500 预估）；`tests/tool_batch_executor.test.ts` 9 项；门禁绿色 |
| L5 VerificationCoordinator | 完成 | 2026-08-02 | `src/agent/verification/coordinator.ts` 抽出 `bindVerificationToLedger` / `runRippleVerificationPhase` / `runBatchTypecheckAndTaskTracker`；Ripple 验证、义务解析、cascade、narrow-edit 完成、批量 typecheck、TaskTracker 验证投影、lastResults 全部移出 `loop.ts`；`loop.ts` 不再直接运行 typecheck 或操作 Ripple obligation；`loop.ts` 降至 **1647 行**（净减 79，远低于 250–350 预估）；门禁绿色 |
| L6 MaintenanceCoordinator | 完成 | 2026-08-02 | `src/agent/maintenance/coordinator.ts`（389 行）包含全部 7 项维护操作：forward/historical microcompact、thinking compaction、semantic recall、adaptive checkpoint、knowledge distillation、knowledge reconcile；提供组合式 `runMaintenance()`；`loop.ts` 降至 **1446 行**（2077 → 1446，累计净减 631）；`tests/maintenance_coordinator.test.ts` 5 项；门禁绿色 |
| L7 LoopDecision | 未开始 | — | 不提前实施 |

## 重启续作点

**记录日期：** 2026-08-02  
**当前边界：** L0—L6 已完成（L6 全部 7 项维护操作已抽入 `maintenance/coordinator.ts`，含组合式 `runMaintenance()`；`loop.ts` 1446 行）；L7 尚未开始。  
**下次入口：** `PR-L7：引入 LoopDecision` 收束 Agent Kernel（目标 `loop.ts` 300–500 行，当前 1446 行）。注意：单一 `runMaintenance()` 调用点受控制流位置约束（forward microcompact 须在 history push 前、semantic recall 须在 router state update 前），loop.ts 仍按位置逐个调用；组合式 `runMaintenance()` 已提供。

### 审计遗留偏差（2026-08-02，严格对照本计划审核后记录）

1. **L0–L3（`385a275`）单 commit 打包 + 行为面变更**：L0–L3 四个阶段合并为一个 commit，无法独立回退；且该 commit 除结构重构外还包含行为面改动——系统提示词重写（`src/agent/prompts.ts`）、新增 `ask_user`/`todo_write`/`git_show`/`git_add`/`git_commit` 工具与 `user_question` 事件、TUI `QuestionPanel`、`runPostEditDiagnostics` 的 existsSync 守卫。这些违反"行为冻结"原则（Provider 消息序列 / tool_use 表面已变），且 Golden Trace 基线（`tests/fixtures/agent-loop-l0-golden.json`）创建于这些改动**之后**，冻结的是新行为而非重构前行为。**处置待定**：拆分为独立 feature commit，或正式补一份行为面变更说明并重订基线声明。
2. **L4 hard-block 记 Ledger** 是真实 StreamEvent 行为变化（新增 status 事件），属 L4 验收授权，但未上报 Golden Trace 差异；`planOnlyRound` 阻断仍未记 Ledger，"blocked 均有记录"只部分满足；abort 的在途工具不记 Ledger。
3. **L5**：`lastTypecheck`/`verificationEvidence` 仍被直接写（coordinator + batch-executor 共 7 处），未由 Ledger 派生（已注释为后续项）；shell unmanaged write 与 Runtime self-edit verification 未移入 coordinator；无专项测试。
4. **L6**：checkpoint/reconcile 失败仍会传播中断主任务（`maintenance/coordinator.ts` 头注释承诺与实现不符）；无 per-capability 配置开关；无专项测试。
5. **行数承诺修正**：实际 `loop.ts` 行数 L4=1726、L5=1647、L6=1595，均低于计划预估；本计划此前记录的数字已更正。

重启后：

1. 不重复实施 L0—L3；
2. 保留工作树中的既有用户改动，不做 reset/checkout；
3. 先运行 `git diff --check`、Provider Runner/L0 Golden 定向测试和
   `bun run typecheck`；
4. 从 Tool Policy、并行只读执行、Hook、timeout/abort、ToolLedger 和结果
   规范化的现有内联边界开始审计；
5. 不提前迁移 L5 VerificationPipeline 或 L6 MaintenancePipeline。

L1 ownership 决议：`AgentRunState` 是可持久化运行事实的所有者；
Router State 暂时保留 thinking/routing 行为驱动权；`StateMachine` 明确为只读
监控与转移校验层；`EvidenceLedger` 是完成判断的验证事实源，`lastTypecheck`
和 `TaskTracker.verificationEvidence` 仅保留为兼容视图。Provider、Tool
Registry、Hook、Sandbox 等服务引用不进入 State 或 Snapshot。

L2 ownership 决议：`AgentRunScope` 是运行级能力引用的所有者，包含
`PlanStore`、`TodoStore`、Run-bound Tool Registry、类型化
`RuntimeExecutionContext` 和独立 `RuntimeFileStateContext`。Mode、Patch、
Sandbox、Ripple、Context Budget 与 Checkpoint scheduler 通过类型化 key
存入当前 Run；Patch transaction registry 和 Ripple program/provider cache
也由当前 Run 独占。Checkpoint 的 `SessionStore` 注册表按持久化 `sessionId`
管理外部服务，可跨恢复 Run 存活，不属于活动 Run 状态。

L3 ownership 决议：`ProviderRoundRunner` 是单轮 Provider 请求和流生命周期
的所有者；`ProviderRoundResult` 是 text/thinking/tool call/usage/failure
的结构化输出；`failure-policy` 负责异常分类和 retry-or-block 恢复决策。
`loop.ts` 仅构造请求、转发 Runner 事件、应用结果并执行 continue/break，
不再直接调用 `provider.streamChat()`。Clarification、Thinking Compaction
和 Semantic Recall 统一复用同一原始流生命周期入口。

本阶段门禁已通过：`bun run test`、`bun run typecheck`、`bun run build`、
`npm pack --dry-run --json` 与 `git diff --check`。L0 Golden Trace 和内置
Tool Contract 指纹保持一致。下一阶段从 L4 `ToolBatchExecutor` 开始，
不在 L3 中提前迁移 Verification 或 Maintenance。

---

# 一、结论与实施门槛

Orcana 应当在正式实现 Graph Runtime 之前完成 `agentLoop()` 内核重构。

原因不是 `src/agent/loop.ts` 超过两千行，而是它同时承担运行时装配、状态维护、工作流控制、Provider 驱动、工具执行、验证协调、记忆维护和资源清理。当前实现适合单 Agent、单活动任务的 CLI 运行模型，但阶段边界、状态所有权和跨 Run 隔离仍不足以承载节点并行、后台 Workflow、多 Agent 及节点级恢复。

本计划的目标不是削弱 `loop.ts` 的唯一控制链，而是将其从 God Orchestrator 重构为 Agent Kernel：

```text
所有决策经过唯一控制链
≠
所有实现都位于同一文件
```

Graph Runtime 的开工门槛为：

1. Agent Run 的创建、退出、取消和清理均有统一生命周期；
2. 所有运行级可变状态具有明确所有者；
3. `planRef` 等生产路径不再依赖进程级可变引用；
4. Provider、Tool、Verification、Maintenance 均通过单一阶段协议接入；
5. 完成、阻塞、暂停、澄清和计划审批均使用结构化决策；
6. 双 Run 隔离、Golden Trace 和提前退出清理测试通过。

在这些条件满足前，不应继续向 `loop.ts` 直接接入 Graph Scheduler。

---

# 二、当前基线审计

## 2.1 当前规模

以核对日期的工作树为准：

| 项目 | 当前值 |
| --- | ---: |
| `src/agent/loop.ts` 行数 | 2077 |
| import 声明数 | 71 |
| 主要生成器 | `agentLoop()` + `runAgentLoop()` |
| 运行级局部可变状态 | 40+ |
| 已抽取的 Round/Tool/Completion 模块 | 5+ |

`loop.ts` 当前至少覆盖以下能力：

1. 历史消息加载、Prompt Hook、Flash Triage 和 Intent 分类；
2. TaskTracker、MasterPlan、Clarification、Research 和 ContextMap；
3. ModeContract、Context Epoch、Stable Prefix 和 Pre-round GateChain；
4. Provider 请求、流解析、Usage/Cache 统计、超时和失败恢复；
5. CompletionOrchestrator、只读工具并行、Tool Policy、Hook 和 ToolLedger；
6. 工具结果截断、Ripple Obligation、Typecheck、Verification 和 Evidence；
7. Gate Overflow、Thinking Compaction、Semantic Recall 和 Runtime Self-edit；
8. Checkpoint、Knowledge Distillation/Reconcile、Telemetry、Stop Hook 和清理。

这已经不是普通的大文件，而是具备多个状态所有者和多个副作用域的 God Orchestrator。

## 2.2 原始风险核对结果

原始分析中的部分问题已在当前基线中得到修复，因此本计划以现状为准，不重复实现已经存在的机制。

| 项目 | 当前状态 | 结论 |
| --- | --- | --- |
| Run 级 `try/finally` | 已存在 | `runAgentLoop()` 在 `finally` 中清理 Context、Sandbox 和 Stop Hook |
| 消费者提前关闭生成器 | 已处理 | 外层 `agentLoop()` 会调用内部 iterator 的 `return()` |
| Clarification 提前返回清理 | 已覆盖 | Clarification 位于 `try` 内，`return` 会进入 `finally` |
| ModeContract | 已 Run Scope 化 | 通过 `RuntimeExecutionContext` + `AsyncLocalStorage` 保存 |
| Patch Context | 已 Run Scope 化 | 通过 `RuntimeExecutionContext` 保存 |
| Shell Sandbox | 已 Run Scope 化 | 通过 `RuntimeExecutionContext` 保存 |
| Ripple Cascade Files | 已 Run Scope 化 | 通过 `RuntimeExecutionContext` 保存 |
| Context Budget Mode | 已 Run Scope 化 | 通过 `RuntimeExecutionContext` 保存 |
| File State / Write Generation | 已 Run Scope 化 | 使用独立的 `RuntimeFileStateContext` |
| MasterPlan `planRef` | L2 已解决 | `PlanStore` 为 Run owner，`task` 工具由当前 Run 工厂绑定；`planRef` 仅保留 deprecated 兼容投影 |
| 生产路径 fallback context | L2 已解决 | `agentLoop()` 显式创建并进入 `AgentRunScope`；legacy fallback 仅供直接模块测试和迁移兼容 |
| 多套验证和任务状态 | 未解决 | Evidence、lastTypecheck、VerificationResult、Tracker 等仍并行维护 |
| `StateMachine` 驱动权 | 未解决 | 源码明确标注其仍是 monitoring layer，行为由 flags 驱动 |
| 阶段边界 | 未解决 | Provider、Tool、Verification、Maintenance 仍密集耦合于主循环 |

因此，本计划不再把“补一个 `try/finally`”描述为待实现功能，而是把现有清理机制纳入 L0 行为基线并补齐回归测试。

## 2.3 已消除的首要隔离缺陷

L2 之前，`src/agent/master-plan.ts` 导出：

```ts
export const planRef: { current: MasterPlan | null } = { current: null }
```

`src/tools/meta.ts` 中的静态 `TASK_TOOL` 直接读取：

```ts
const plan = planRef.current
```

两个并发 Run 可能发生：

```text
Run A: planRef = Plan A
Run B: planRef = Plan B
Run A: task tool 读取到 Plan B
```

这是 Graph 并发适配中优先级最高的实际缺陷。

L2 已将其替换为 `PlanStore` + `createTaskTool(planStore)`，并由
Run-bound Tool Registry 在每次 `agentLoop()` 启动时绑定。静态工具目录只
保留 fail-closed 描述符，不持有活动计划；`planRef` 仅作为 deprecated
兼容投影，生产 loop 和内置工具均不再导入它。同阶段发现的
`todo_write` 模块级任务列表也已迁移到 Run-scoped `TodoStore`。

实现复用了并类型化既有 `RuntimeExecutionContext`，没有新建第三套上下文
系统。

## 2.4 多套状态并行维护

`runAgentLoop()` 当前同时维护：

* Router `state`；
* `StateMachine`；
* `intentPolicy`；
* `taskTracker`；
* `masterPlan` 和 `planRef`；
* `evidenceLedger`；
* `lastTypecheck`；
* `lastVerificationResults`；
* `lastRippleReports`；
* `pendingRippleObligations`；
* 多个写入、错误、预算、Epoch、Gate 和 Compaction 标志。

同一个事实可能被写入多个位置。例如“类型检查是否通过”可能同时存在于：

```text
lastTypecheck
  ├─ VerificationResult[]
  ├─ TaskTracker.verificationEvidence
  ├─ EvidenceLedger
  └─ CompletionOrchestrator input
```

重构必须为每类事实指定唯一事实源，并将其他形态降级为派生视图或兼容投影。

## 2.5 当前拆分的局限

现有拆分方向正确：

* `src/agent/round/pre-loop.ts`
* `src/agent/round/post-loop.ts`
* `src/agent/round/request-builder.ts`
* `src/agent/tool-execution/policy.ts`
* `src/agent/completion-orchestrator.ts`

但 `pre-loop.ts` 同时承载超时、Hook、Research、Typecheck 文本识别和 Runtime Self-edit；`post-loop.ts` 同时承载 diagnostics、Ripple Verification、Thinking Compaction、Promise 提取和 StateMachine 更新。

这仍然是按“循环前/循环后”分类的 Utility Drawer。后续拆分必须改为按业务能力和状态所有权分类。

---

# 三、目标与非目标

## 3.1 目标

本计划完成后应达到：

* `loop.ts` 只表达生命周期顺序、阶段调用、事件输出、取消和唯一完成出口；
* 所有运行级状态归属于一个可快照的 Agent Run；
* 每轮临时状态只在 Round 内存在，轮末显式提交必要结果；
* Provider、Tool、Verification 和 Maintenance 各自拥有清晰输入、输出和失败语义；
* 所有工具继续经过统一的 Tool Policy、Hook 和 Tool Ledger；
* 所有完成决策继续经过 CompletionOrchestrator 和 Evidence 硬门；
* 所有生产路径不再依赖进程级运行状态；
* Agent Kernel 可被 CLI、TUI 和未来 Graph Node Executor 复用；
* 默认行为、事件顺序和安全 Gate 顺序保持兼容。

## 3.2 非目标

本计划不做：

* 不实现 Graph Scheduler；
* 不实现多 Agent；
* 不实现并行写；
* 不替换 MasterPlan、TaskPacket 或 EvidenceLedger；
* 不删除现有 Gate；
* 不改变默认 Provider 和模型路由策略；
* 不一次性重写 2000+ 行；
* 不为了减少行数而制造无状态所有权的 Helper；
* 不把所有阶段改造成 Graph Node；
* 不在本计划中解决所有模块级只读缓存。

---

# 四、架构原则与不可破坏约束

## 4.1 Functional Core + Imperative Shell

采用：

> Functional Core + Imperative Shell

具体含义：

* `loop.ts` 是命令式外壳；
* Gate 判断和状态迁移尽量为纯函数；
* 副作用由显式服务执行；
* 状态只能由拥有它的阶段修改；
* 阶段返回结构化结果；
* 主循环只按顺序组合阶段。

## 4.2 唯一硬接线点

必须保持：

```text
loop
  → prepareRound
    → PreRoundGateChain

loop
  → executeToolRound
    → ToolBatchExecutor
      → evaluateToolPolicy
      → Hook
      → Tool

loop
  → evaluateCompletionRound
    → CompletionOrchestrator
      → Evidence hard gate
```

不得出现绕过上述路径的备用执行入口。

## 4.3 行为冻结优先于结构优化

每次提取必须满足：

* Provider 消息序列不变；
* `tool_use` / `tool_result` 邻接关系不变；
* StreamEvent 顺序不变；
* final text 不重复；
* Gate 调用顺序不变；
* Stable Prefix 和 Cache Prefix 语义不变；
* 取消会关闭活动 Provider/Tool；
* 所有退出路径均执行清理和 Stop Hook。

## 4.4 显式状态所有权

任何状态字段都必须回答：

1. 谁创建；
2. 谁可以修改；
3. 谁可以读取；
4. 何时提交；
5. 是否需要持久化；
6. 它是否为唯一事实源。

无法回答这些问题的字段不得直接迁移进一个“大状态对象”。

---

# 五、目标运行时模型

## 5.1 `AgentRunServices`：不可变依赖

```ts
interface AgentRunServices {
  provider: LLMProvider
  tools: ToolRegistry
  hooks?: HookSystem
  modelRouter?: ModelRouter

  clock: Clock
  sandbox: SandboxManager
  trace?: AgentRunTrace
  telemetry: GateTelemetry

  stagedContext?: StagedContextManager
  thinkingStore?: ThinkingStore
  knowledgeBase?: KnowledgeBase
}
```

约束：

* 创建 Agent Run 后不得替换服务引用；
* 服务不得通过模块级 setter 注入；
* Tool Registry 必须由当前 Run 创建或绑定；
* 生命周期资源由 `disposeAgentRun()` 统一释放。

## 5.2 `AgentRunScope`：运行级能力引用

```ts
interface AgentRunScope {
  planStore: PlanStore
  todoStore: TodoStore
  toolRegistry: AgentRunToolRegistry
  runtimeContext: RuntimeExecutionContext
  fileState: RuntimeFileStateContext
}
```

实现优先复用并类型化当前 `RuntimeExecutionContext`。短期可以保留 `AsyncLocalStorage` 作为深层调用的上下文载体，但生产路径必须由 Agent Run 显式创建，不得依赖 fallback Map。

## 5.3 `AgentRunState`：运行级可变状态

```ts
interface AgentRunState {
  identity: {
    runId: string
    sessionId?: string
    prompt: string
    language: UILanguage
  }

  conversation: {
    rawMessages: ProviderMessage[]
    stablePrefix?: ProviderMessage
    stablePrefixHash?: string
  }

  planning: {
    intentPolicy: IntentPolicy
    taskTracker: TaskTracker | null
    masterPlan: MasterPlan | null
    mode: ModeName
    planApproved: boolean
  }

  execution: {
    round: number
    modifiedFiles: Set<string>
    toolErrors: number
    consecutiveErrors: number
    requestedMaxThinking: boolean
  }

  verification: {
    evidenceLedger: EvidenceLedger
    rippleObligations: RippleObligation[]
    lastResults: VerificationResult[]
  }

  budget: {
    usage: UsageStats
    contextInput: number
    contextOutput: number
    epoch: EpochState
    mode: RuntimeContextBudgetMode
  }

  lifecycle: {
    stopReason: "completed" | "aborted" | "error" | "blocked"
    startedAt: number
    stopHookDispatched: boolean
  }
}
```

说明：

* `EvidenceLedger` 成为验证事实源；
* `lastTypecheck` 最终应由 `lastResults` 或 Ledger 派生；
* `taskTracker.verificationEvidence` 作为兼容视图，不再被独立写入；
* `masterPlan` 的 Run 内引用必须与 `PlanStore.current` 指向同一事实；
* Router State 与 StateMachine 的驱动权必须在 L1 设计评审中确定。

## 5.4 `RoundState`：单轮临时状态

```ts
interface RoundState {
  round: number
  finalText: string
  thinkingBlocks: ThinkingBlock[]
  toolCalls: ToolCall[]
  toolResults: ToolResult[]
  modifiedFiles: Set<string>
  verificationResults: VerificationResult[]
  providerFailure?: ProviderFailure
}
```

轮结束后只允许通过显式 `StatePatch` 将必要结果提交到 `AgentRunState`。

## 5.5 统一决策类型

```ts
type LoopDecision =
  | { kind: "continue" }
  | { kind: "done"; finalText: string }
  | { kind: "plan_ready"; plan: MasterPlan }
  | { kind: "clarification"; request: ClarificationRequest }
  | { kind: "blocked"; reason: string }
  | { kind: "paused"; checkpointId: string }
  | { kind: "restart_required"; files: string[] }
```

每个阶段使用统一返回协议：

```ts
interface PhaseResult<T> {
  value: T
  effects: RunEffect[]
  statePatch?: AgentRunStatePatch
  decision?: LoopDecision
}
```

其中：

* `effects` 描述待输出事件、Trace 和 Telemetry；
* `statePatch` 描述允许提交的状态变化；
* `decision` 描述控制流；
* 阶段内部不得直接结束整个 Agent Run。

---

# 六、目标模块边界

## 6.1 `src/agent/run/bootstrap.ts`

负责：

* 历史加载；
* Prompt Submit Hook；
* Flash Triage；
* Intent 和 Research Route；
* Context Kernel / ContextMap；
* TaskTracker / Plan 初始状态；
* Sandbox 和 Run Services 准备；
* Clarification 评估。

输出：

```ts
BootstrapResult
```

不负责：

* Provider 主回合；
* 工具执行；
* 完成判断；
* 低频维护。

## 6.2 `src/agent/round/prepare.ts`

负责：

* Context Slice；
* Context Epoch；
* Stable Prefix；
* Mode Prompt；
* Volatile Context；
* Pre-round GateChain；
* Provider Request。

输出：

```ts
PreparedRound
```

## 6.3 `src/agent/provider/round-runner.ts`

负责：

* 调用 `provider.streamChat()`；
* 解析 text、thinking、tool calls 和 usage；
* Provider idle timeout；
* Abort 和 iterator 关闭；
* Provider 错误分类和恢复信息；
* StreamEvent 转发；
* Buffer 与 transcript 完整性。

输出：

```ts
ProviderRoundResult
```

## 6.4 `src/agent/tool-execution/batch-executor.ts`

负责：

* 只读并行候选判断；
* Tool Policy；
* Permission 和风险顺序；
* Rate Limit；
* Before/After Hook；
* Streaming Tool；
* Timeout / Abort；
* ToolLedger；
* 结果规范化和截断。

必须保持当前 Policy 顺序和单一入口：

```text
Rate Limit
  → Permission
  → Readonly Intent
  → Ripple Block
  → Planning Phase
  → Context Readiness
  → Web Search / Mode Contract
  → High-risk Tool
  → Hook
  → Tool
```

## 6.5 `src/agent/verification/coordinator.ts`

负责：

* 修改文件识别；
* Runtime self-edit 标记；
* Ripple Report；
* Ripple Obligation；
* Typecheck；
* VerificationResult；
* EvidenceLedger 写入；
* required files；
* narrow edit completion；
* TaskTracker 的兼容投影。

输出：

```ts
VerificationCoordinatorResult
```

## 6.6 `src/agent/maintenance/coordinator.ts`

负责低频维护：

* Forward Microcompact；
* Historical Microcompact；
* Thinking Compaction；
* Semantic Recall；
* Checkpoint；
* Knowledge Distillation；
* Knowledge Reconcile。

统一入口：

```ts
runMaintenance(run, roundResult)
```

Maintenance 不得改变 Tool Policy、Completion Decision 或验证事实。

---

# 七、目标 `loop.ts`

不要求强行压缩到 100 行。合理目标是 300—500 行，并只保留主控制链：

```ts
export async function* agentLoop(
  prompt: string,
  options: AgentOptions,
): AsyncGenerator<StreamEvent> {
  const run = await createAgentRun(prompt, options)

  try {
    const bootstrap = await bootstrapAgentRun(run)
    yield* emitEffects(bootstrap.effects)

    if (bootstrap.decision) {
      yield* emitDecision(bootstrap.decision)
      return
    }

    while (run.state.execution.round < run.limits.maxRounds) {
      const prepared = await prepareRound(run)
      yield* emitEffects(prepared.effects)

      if (prepared.decision) {
        yield* emitDecision(prepared.decision)
        return
      }

      const providerResult = yield* runProviderRound(run, prepared.value.request)

      const handled = providerResult.toolCalls.length > 0
        ? await executeToolRound(run, providerResult)
        : await evaluateCompletionRound(run, providerResult)

      yield* emitEffects(handled.effects)
      applyStatePatch(run.state, handled.statePatch)

      if (handled.decision.kind === "continue") continue

      yield* emitDecision(handled.decision)
      return
    }
  } finally {
    await disposeAgentRun(run)
  }
}
```

最终 `loop.ts` 不应直接知道：

* Shell 如何执行；
* Provider Stream 如何拼装；
* Ripple 如何合并；
* Typecheck 如何识别；
* Checkpoint 如何保存；
* Thinking 如何压缩；
* Knowledge 如何蒸馏。

---

# 八、分阶段实施路线

实施顺序：

```text
L0 行为基线
  ↓
L1 AgentRunState
  ↓
L2 Run Scope 与并发隔离
  ↓
L3 ProviderRoundRunner
  ↓
L4 ToolBatchExecutor
  ↓
L5 VerificationCoordinator
  ↓
L6 MaintenanceCoordinator
  ↓
L7 LoopDecision 与最终 Kernel
  ↓
Graph Runtime G0
```

每个 PR 必须可独立合并和回滚，不得提前实现后续阶段。

## PR-L0：行为基线与清理回归

### 目标

冻结当前正确行为，确认现有 Run 生命周期对所有退出路径生效。

### 实施

* 保留现有外层 iterator 关闭协议；
* 保留 `runAgentLoop()` 的 `try/catch/finally`；
* 将清理顺序写成测试契约；
* 建立 Golden Trace fixture；
* 记录关键 StreamEvent、ProviderMessage、Gate 和 Tool 调用顺序；
* 增加 Clarification、Plan Ready、Context Budget Block、Runtime Self-edit 等退出场景；
* 确认 Stop Hook 只执行一次。

### 测试

* `tool_use` / `tool_result` 邻接；
* final text 不重复；
* Plan Ready 事件仅一次；
* Clarification 后 Sandbox dispose；
* Clarification 后 Run Scope 不残留；
* 消费者提前 `return()` 后 Provider abort；
* Context Budget Block 后清理；
* Runtime Self-edit 后验证和退出顺序；
* Stop Hook completed/aborted/error/blocked 各一次。

### 验收

* 不改变生产执行逻辑；
* Golden Trace 可稳定重放；
* 所有提前退出测试通过；
* 现有 `runtime_agent_context.test.ts` 保持通过。

## PR-L1：引入 `AgentRunState`

### 目标

把运行级局部状态迁移到明确、可快照的状态对象，不改变执行顺序。

### 新增建议

```text
src/agent/run/types.ts
src/agent/run/state.ts
src/agent/run/snapshot.ts
src/agent/run/state-patch.ts
```

### 实施

* 建立 `AgentRunState` 和 `RoundState`；
* 按 ownership 分组迁移局部变量；
* 首阶段允许通过兼容 getter 读取旧字段；
* 引入只读 Snapshot；
* 明确 Router State 和 StateMachine 的关系；
* 明确 EvidenceLedger 为验证唯一事实源的迁移路径；
* 禁止把闭包修改状态的 Helper 原样搬入。

### 验收

* Golden Trace 与 L0 一致；
* `loop.ts` 不再定义数十个互不关联的状态变量；
* Run State 可序列化快照，非序列化服务不混入 State；
* Round State 在轮末被释放；
* 同一事实不存在新增双写。

## PR-L2：消除生产路径的进程级运行状态

### 目标

完成 Graph Runtime 前最重要的并发隔离。

### 实施顺序

1. 将 `planRef` 改为 Run-scoped `PlanStore`；
2. 将 `TASK_TOOL` 改为 `createTaskTool(planStore)`；
3. 将工具注册表绑定到当前 Run Scope；
4. 类型化现有 `RuntimeExecutionContext`；
5. 移除生产路径对 fallback runtime context 的依赖；
6. 明确 Mode、Patch、Sandbox、Ripple、Context Budget 的兼容 API 退场策略；
7. 审计 Checkpoint scheduler、Patch transaction registry 和 Ripple program cache 是否包含运行级可变数据。

### 兼容策略

旧的 setter/getter 可短期保留，但必须：

* 标记 deprecated；
* 只作为测试或兼容适配；
* 在生产 Agent Run 外调用时 fail closed 或返回只读默认值；
* 不再由内置 Tool 直接读取模块级引用。

### 测试

```text
Run A 与 Run B 重叠执行
  ├─ Plan 不串线
  ├─ Mode 不串线
  ├─ Sandbox 不串线
  ├─ Patch Context 不串线
  ├─ Ripple Cascade 不串线
  ├─ Context Budget 不串线
  ├─ Write Generation 不串线
  └─ Stop/Cleanup 不互相影响
```

### 验收

* `src/tools/meta.ts` 不再导入 `planRef`；
* 生产 Tool 不从模块全局读取运行状态；
* 双 Run 隔离测试稳定通过；
* 单 Run 行为和事件 Trace 不变。

### 实施结果（2026-07-30）

* `PlanStore`、`TodoStore` 和 Run-bound Tool Registry 已落地；
* `task` 与 `todo_write` 静态目录描述符在 Run 外 fail closed；
* Mode、Patch、Sandbox、Ripple、Context Budget 和 Checkpoint scheduler
  已使用类型化 Runtime Context key；
* Patch transaction registry、Ripple `ProjectProgram`、Semantic Provider、
  Ast-grep Provider、解析缓存和文件列表缓存均由单个 Run 独占；
* 重叠 Run A/B 已覆盖 Plan、Todo、Mode、Sandbox、Patch、Ripple、Budget、
  Write Generation、transaction registry 和 Tool Registry，不发生串线；
* L0 Golden Trace、49 项主 loop 回归和全量门禁保持绿色。

## PR-L3：抽出 `ProviderRoundRunner`

### 目标

隔离 Provider 流生命周期、解析和错误恢复。

### 迁移内容

* Provider request 调用；
* text/thinking/tool call 收集；
* token usage 和 cache usage；
* idle timeout；
* AbortController；
* iterator `return()`；
* Provider Failure 分类；
* non-retryable 错误；
* transcript buffer 策略。

### 新增建议

```text
src/agent/provider/round-runner.ts
src/agent/provider/round-result.ts
src/agent/provider/failure-policy.ts
```

### 验收

* Provider Trace 与 L0 一致；
* Provider 超时、abort、quota、auth、retry 测试通过；
* 未闭合 tool chain 不会被截断或 rollover；
* `loop.ts` 不直接调用 `provider.streamChat()`；
* 预计从主循环减少 200—300 行。

### 实施结果（2026-07-30）

* 新增 `round-runner.ts`、`round-result.ts` 和 `failure-policy.ts`；
* 主轮次统一收集 text、thinking blocks、tool calls 和真实 Provider usage；
* readonly/completion text buffer 的 flush 顺序保持与 L0 Trace 一致；
* 每次流调用拥有独立子 `AbortController`、idle timer 和 iterator
  `return()` 清理，外部 abort 不会被误分类为 Provider failure；
* Provider error event 保留旧的默认 retry 策略，throw 使用 transport
  classifier，auth/client/quota 均 fail closed；
* 长任务和普通任务的 retry-or-block 消息、报告与 Trace 由结构化恢复决策
  生成，主循环只执行控制动作；
* Runner 单测 5 项、Provider adapter 78 项、主 loop 49 项、L0 Golden
  5 项和全量门禁均通过。

## PR-L4：抽出 `ToolBatchExecutor`

### 目标

形成所有工具调用的唯一执行入口。

### 迁移内容

* 并行只读判断；
* Policy 输入组装；
* Permission / Risk / Mode / Ripple / Planning Gate；
* rate limits；
* Before/After Hook；
* streaming tool；
* timeout 和 abort；
* ToolLedger；
* 结果规范化、截断和错误分类。

### 新增建议

```text
src/agent/tool-execution/batch-executor.ts
src/agent/tool-execution/single-executor.ts
src/agent/tool-execution/result-normalizer.ts
```

### 验收

* 所有 Tool 只经过一个 Executor；
* 当前 8 层 Policy 顺序保持不变；
* 并行仅允许只读且 concurrency-safe 的工具；
* Hook 仍包围真实工具执行；
* Tool Ledger 对 blocked/failed/success/aborted 均有记录；
* Streaming Tool 中途取消会关闭 iterator；
* 预计从主循环减少 400—500 行。

## PR-L5：抽出 `VerificationCoordinator`

### 目标

统一修改识别、Ripple、验证和 Evidence 状态。

### 迁移内容

* 修改文件集合；
* shell unmanaged write；
* post-edit diagnostics；
* Ripple Report 和 Obligation；
* Typecheck；
* VerificationResult；
* EvidenceLedger ingest；
* TaskTracker verification 投影；
* required files；
* narrow edit completion；
* Runtime self-edit verification。

### 状态收束

```text
VerificationResult
  ↓ ingest
EvidenceLedger  ← 唯一事实源
  ├─ lastTypecheck view
  ├─ TaskTracker verification view
  └─ Completion input view
```

### 验收

* EvidenceLedger 是完成判断的验证事实源；
* 旧字段只由 Ledger 派生，不独立写入；
* 证据 freshness 和 PatchTransaction binding 保持有效；
* Ripple failure → repair → reverify 路径通过；
* `loop.ts` 不直接运行 typecheck 或操作 Ripple obligation；
* 预计从主循环减少 250—350 行。

## PR-L6：抽出 `MaintenanceCoordinator`

### 目标

将低频维护从主 Round 控制流移出。

### 迁移内容

* Forward/Historical Microcompact；
* Thinking collection 和 compaction；
* Semantic Recall；
* Checkpoint；
* Knowledge Distillation；
* Knowledge Reconcile；
* 维护类 usage/trace。

### 约束

* Maintenance failure 默认不得破坏主任务；
* Checkpoint failure 必须可观测；
* Maintenance 不得修改完成决策；
* Compaction 不得破坏 `tool_use` / `tool_result` 邻接；
* Knowledge 和 Recall 调用必须保留 purpose 标记和预算。

### 验收

* 单一 `runMaintenance()` 入口；
* Maintenance 可按能力独立关闭；
* Checkpoint Resume 测试通过；
* Compaction 前后语义 Trace 可比较；
* 预计从主循环减少约 250 行。

## PR-L7：引入 `LoopDecision` 并收束 Agent Kernel

### 目标

清除散落的控制流出口，形成稳定 Kernel。

### 实施

* 将阶段退出改为 `LoopDecision`；
* 将事件、Trace、Telemetry 统一为 `RunEffect`；
* 将状态提交统一为 `AgentRunStatePatch`；
* 建立唯一终态 switch；
* 建立 `finalizeRun(decision)`；
* 保留外层 generator close 协议；
* 将 Stop Hook 和资源清理放入统一生命周期；
* 将 `loop.ts` 收敛为阶段编排。

### 验收

* `loop.ts` 约 300—500 行；
* 只有一个主 Round 循环；
* 只有一处终态 switch；
* 不直接执行 Tool；
* 不直接解析 Provider Stream；
* 不直接执行 Verification、Checkpoint 或文件系统操作；
* 无生产级模块共享运行状态；
* 所有退出均经过 `finally` 和 `finalizeRun()`；
* L0 Golden Trace 除显式批准差异外保持一致。

---

# 九、测试与验证矩阵

## 9.1 必须新增的测试

| 测试 | 目标阶段 | 关键断言 |
| --- | --- | --- |
| Golden Agent Trace | L0 | 事件、消息、Gate、Tool 顺序稳定 |
| Clarification cleanup | L0 | Sandbox/Scope/Stop Hook 均清理 |
| Consumer early return | L0 | Provider 和 Tool iterator 被关闭 |
| Dual Run plan isolation | L2 | Task Tool 只读取本 Run Plan |
| Dual Run full scope isolation | L2 | Mode/Patch/Sandbox/Ripple/Budget/FileState 不串线 |
| Provider retry trace | L3 | 重试前后消息和 failure 分类正确 |
| Provider abort | L3 | 取消及时传递并关闭 stream |
| Tool policy order | L4 | 首个阻断原因和 priority 不变 |
| Parallel readonly tools | L4 | 只读安全工具并行，写工具串行 |
| Tool stream abort | L4 | 关闭 iterator，Ledger 记录 aborted |
| Verification repair | L5 | 失败证据不会被错误 claim done |
| Evidence freshness | L5 | 写入后旧 Evidence 失效 |
| Plan node transition | L5/L7 | node、mode、patch scope 同步迁移 |
| Checkpoint resume | L6 | 状态和消息可恢复 |
| Compaction adjacency | L6 | tool chain 邻接不被破坏 |
| Final text once | L7 | 最终文本和完成事件仅输出一次 |

## 9.2 每个 PR 的命令门禁

```bash
bun run typecheck
bun run test
bun run build
npm pack --dry-run
```

如果全量测试耗时过长，开发中可以先运行目标测试，但合并前必须执行完整门禁。

## 9.3 Trace 兼容策略

Golden Trace 应区分：

* 必须完全一致：ProviderMessage 顺序、Tool 邻接、Gate 顺序、最终决策；
* 允许归一化：时间戳、随机 ID、token estimate、路径分隔符；
* 允许显式迁移：内部模块名称、Trace schema version；
* 禁止静默变化：Tool Policy priority、Completion Gate 顺序、Evidence freshness。

---

# 十、最终验收标准

## 10.1 `loop.ts`

* 300—500 行左右，行数不是硬门但需说明超出原因；
* 只包含 Run 生命周期、主 Round 循环和终态分发；
* 不直接执行工具；
* 不直接解析 Provider Stream；
* 不直接执行 Checkpoint、Knowledge 或文件系统操作；
* 不保存模块级运行状态；
* 所有退出均执行 `finally`；
* CompletionOrchestrator 仍为唯一完成出口。

## 10.2 状态

* `AgentRunState` 可快照；
* `RoundState` 不跨轮泄漏；
* `PlanStore` 为当前计划唯一事实源；
* EvidenceLedger 为验证唯一事实源；
* MasterPlan 和 TaskTracker 的关系有明确文档与适配层；
* StateMachine 要么成为行为驱动器，要么明确降级为只读观测；
* Context Budget、Epoch、Compaction 的所有者明确；
* 生产路径不使用 fallback 全局运行状态。

## 10.3 并发与生命周期

* 两个 Agent Run 可以在同一进程重叠执行；
* Plan、Mode、Sandbox、Patch、Ripple、Budget 和 FileState 不互相影响；
* Run 取消会传递到 Provider 和 Tool；
* Run 完成、阻塞、异常、澄清和用户提前关闭均释放资源；
* Stop Hook 每个 Run 只触发一次。

## 10.4 Graph Runtime 适配

完成 L7 后，Graph Runtime 只能通过以下协议调用 Agent Kernel：

```text
Workflow Node Executor
  → createAgentRun(nodeContext)
  → Agent Kernel
  → LoopDecision / NodeResult
  → ResultStore
```

Graph Scheduler 不得：

* 直接调用底层 Tool 绕过 ToolBatchExecutor；
* 直接写 EvidenceLedger 绕过 VerificationCoordinator；
* 修改 Agent Run 的内部 flags；
* 绕过 `disposeAgentRun()`；
* 创建第二套完成判断。

---

# 十一、明确禁止的重构方式

## 11.1 禁止大爆炸重写

一次性重写整个 `agentLoop()` 容易破坏：

* tool transcript 邻接；
* 完成文本输出；
* Cache Prefix；
* Gate 顺序；
* Plan Approval；
* Ripple obligations；
* Evidence binding；
* Stop Hook 和取消。

必须按 L0—L7 逐阶段迁移。

## 11.2 禁止只拆 Helper

如果 `handleA()`、`handleB()` 仍通过闭包读写几十个变量，只是隐藏复杂度，不是重构。

每个提取模块必须同时定义：

* 输入；
* 输出；
* 状态所有权；
* 副作用；
* 取消语义；
* 失败语义。

## 11.3 禁止提前 Graph 化

在 Run Kernel 稳定前，不把 Provider、Tool 或 Verification 全部改成 Graph Node。否则会形成大 Loop、Graph Scheduler 和两套状态系统并存。

## 11.4 禁止移除唯一 Gate 链

Gate 实现可以位于独立模块，但其调用必须由 Agent Kernel 明确接线。不得让 CLI、TUI、Workflow 或 Tool 直接绕过主链。

## 11.5 禁止以行数作为唯一完成标准

文件变小不代表：

* 状态已隔离；
* 副作用已收束；
* 测试已覆盖；
* Graph 已可安全并发。

验收必须以状态所有权、并发隔离、唯一执行入口和 Trace 兼容为准。

---

# 十二、PR 执行模板

每个 L 系列 PR 必须在描述中列出：

1. 本 PR 对应阶段；
2. 修改和新增文件；
3. 移出的 `loop.ts` 职责；
4. 状态所有权变化；
5. 执行链变化；
6. 保持不变的 Gate/Policy 顺序；
7. 新增测试；
8. Golden Trace 差异；
9. typecheck/test/build/pack 结果；
10. 回滚边界；
11. 未完成项和已知风险。

若 PR 同时修改两个阶段的状态所有权或控制流，应拆分后再提交。

---

# 十三、最终判断

`loop.ts` 不是失败的实现，而是 Orcana 快速演化阶段形成的第一代内核。它把约束真正接进执行链，这一点必须保留。

下一阶段的正确路线是：

```text
约束全部接入 Loop
  ↓
机制已被验证
  ↓
提取显式 Run State 和阶段边界
  ↓
形成稳定 Agent Kernel
  ↓
由 Graph Scheduler 调用 Kernel
```

最高优先级只有三个：

1. 冻结并持续验证现有清理、取消和输出语义；
2. 消除 `planRef` 等剩余的跨 Run 共享状态，完成状态所有权收束；
3. 按 Provider、Tool、Verification、Maintenance 四个能力边界提取协调器。

完成后，Orcana 将从“所有机制堆叠在同一主循环的安全 Runtime”，升级为“所有机制通过唯一协议接入的 Agent Kernel”，并为 Typed Execution Graph Runtime 提供可靠执行底座。
