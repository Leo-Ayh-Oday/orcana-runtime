# DeepSeek Orcana Typed Execution Graph Runtime 完整实施方案

**方案版本：** GEP-1.0  
**仓库基线：** `Leo-Ayh-Oday/deepseek-orcana`  
**基线提交：** `2207db20eb284d8b2f695c13951a3078bbff3682`  
**当前包版本：** `0.3.4`  
**实施原则：** 增量演进、默认关闭、单写者优先、验证先于并行、多智能体延后。

---

# 一、项目目标

## 1.1 总体目标

将 Orcana 当前以 `agentLoop()` 为核心的单智能体执行模型：

```text
用户请求
  ↓
单一 Agent Loop
  ↓
规划、读文件、写代码、验证、修复
  ↓
完成判断
```

升级为：

```text
用户请求
  ↓
Workflow Compiler
  ↓
Typed Execution Graph
  ↓
受控 Scheduler
  ↓
确定性节点 + 模型节点 + 工具节点 + 验证节点
  ↓
Evidence-backed Completion
```

最终形成：

> **Constraint-first Typed Execution Graph Runtime**

每个节点必须有明确契约，每条边必须传递结构化数据，每次并行必须受权限和资源约束，每个循环必须具备收敛条件，每次完成必须有验证证据。

---

## 1.2 本阶段不追求的目标

本方案第一阶段明确不做：

* 不做任意 JavaScript Workflow 执行；
* 不允许模型生成并执行未经验证的编排代码；
* 不做多个 Agent 并行修改同一个工作区；
* 不默认启用多智能体；
* 不替换现有 `agentLoop()`；
* 不移除现有 GateChain；
* 不废弃 MasterPlan、TaskPacket、EvidenceLedger；
* 不重新建立一套平行任务状态系统；
* 不为了“图”而将所有逻辑都改造成模型调用；
* 不在首阶段实现分布式调度、远程节点或 Agent 集群。

---

# 二、当前架构基础

Orcana 已经具备执行图的大部分前置结构。

## 2.1 MasterPlan 已经是基础 DAG

当前 `PlanNode` 已包含：

* 节点 ID；
* 状态；
* TaskTracker；
* `dependsOn`；
* `blockedBy`；
* evidence；
* TaskPacket。

节点激活前也会检查依赖是否完成。

但当前仍以单一 `current` 节点串行推进，因此它是：

> 有依赖关系的数据结构，但不是完整图调度器。

---

## 2.2 TaskPacket 已经接近节点契约

当前 TaskPacket 已定义：

* `goal`
* `scope`
* `doneCriteria`
* `verification`
* `ripplePolicy`
* `contextBudget`

其中资源预算包含每节点最大工具数、最大轮次和估算 Token。

同时已经有 JSON Schema 与语义校验。

因此本方案不新建另一套任务定义，而是：

> 将 TaskPacket 扩展为 WorkflowNode 的业务契约。

---

## 2.3 已有 DAG 校验能力

`plan-validator.ts` 已包含：

* 空计划检查；
* 唯一 ID 检查；
* DFS 环检测；
* 无效依赖检查；
* Tracker 检查；
* verification 检查；
* scope 检查。

这些能力应被复用到 Workflow Graph Validator，而不是重新实现。

---

## 2.4 已有局部并行能力

当前 `agentLoop()` 会对同一回合内的多个只读、并发安全工具调用执行 `Promise.all`。所有调用在执行前仍经过权限、Ripple、Context Readiness、Mode Contract 和 Tool Risk 检查。

但当前并行粒度仅限：

```text
一个 Agent 回合
  └─ 多个只读 tool call
```

目标需要提升为：

```text
一个 Workflow Run
  └─ 多个相互独立的 Workflow Node
```

---

## 2.5 已有统一完成路径

CompletionOrchestrator 当前按以下顺序执行：

1. 同步 GateChain；
2. External Completion Gate；
3. Flash Judge；
4. Evidence Hard Gate；
5. Truthfulness Gate。

EvidenceLedger 已经提供结构化证据和 `canClaimDone()` 硬完成门。

因此 Workflow Runtime 不应再造一套完成判断，而应把节点结果接入现有 CompletionOrchestrator。

---

# 三、目标架构

```text
┌───────────────────────────────────────────────────────────┐
│                    CLI / TUI / RuntimeController           │
└─────────────────────────────┬─────────────────────────────┘
                              │ UserIntent
                              ▼
┌───────────────────────────────────────────────────────────┐
│                       Workflow Router                      │
│  narrow_edit / long_task / research / audit / refactor    │
└─────────────────────────────┬─────────────────────────────┘
                              │
                              ▼
┌───────────────────────────────────────────────────────────┐
│                     Workflow Compiler                      │
│ MasterPlan + TaskPacket + ContextMap → WorkflowSpec        │
└─────────────────────────────┬─────────────────────────────┘
                              │
                              ▼
┌───────────────────────────────────────────────────────────┐
│                     Workflow Validator                     │
│ Schema / DAG / Policy / Budget / Capability / Side Effect │
└─────────────────────────────┬─────────────────────────────┘
                              │
                              ▼
┌───────────────────────────────────────────────────────────┐
│                     Workflow Scheduler                     │
│ Ready Queue / Dependencies / Concurrency / Retry / Cancel │
└──────────────┬─────────────────────┬──────────────────────┘
               │                     │
               ▼                     ▼
      Deterministic Nodes      Model / Tool Nodes
               │                     │
               └──────────┬──────────┘
                          ▼
┌───────────────────────────────────────────────────────────┐
│                      Result Store                          │
│ NodeResult / EdgePayload / Usage / Evidence / Diagnostics │
└─────────────────────────────┬─────────────────────────────┘
                              ▼
┌───────────────────────────────────────────────────────────┐
│                 Single Writer Transaction                 │
│ PatchPlan → PatchTransaction → Verify → Commit/Rollback    │
└─────────────────────────────┬─────────────────────────────┘
                              ▼
┌───────────────────────────────────────────────────────────┐
│                  CompletionOrchestrator                    │
│ Ripple / Task / Evidence / Judge / Truthfulness / Done     │
└───────────────────────────────────────────────────────────┘
```

---

# 四、核心设计原则

## 4.1 节点不等于 Agent

Workflow Node 可以是：

| 节点类型 | 示例 |
| --- | --- |
| `deterministic` | 去重、排序、依赖计算、证据聚合 |
| `tool` | read_file、find_symbol、git_diff |
| `model` | 规划、代码生成、语义分析 |
| `flash` | triage、judge、recall score |
| `verify` | typecheck、test、build、Ripple |
| `transaction` | PatchTransaction |
| `barrier` | 等待多个上游完成 |
| `router` | 根据风险或结果选择路径 |
| `human` | 计划批准、权限确认、阻塞处理 |

多节点不代表必须产生多个 Agent 会话。

---

## 4.2 Edge 必须表示真实数据依赖

禁止用“然后”自动建立边。

只有下游节点确实读取上游输出时，才建立：

```text
A ── output ──> B
```

例如：

```text
find-symbols
  └─ symbols[] ──> find-references
```

但以下两个节点不应存在依赖：

```text
读取 package.json
读取 tsconfig.json
```

它们应同时进入 Ready Queue。

---

## 4.3 确定性逻辑优先使用代码

以下操作不得调用模型：

* 数组 flatten；
* 去重；
* 排序；
* group by；
* 状态统计；
* 依赖满足判断；
* 环检测；
* 结果哈希；
* 验证证据聚合；
* Ripple Obligation 合并；
* 失败签名归一化；
* 预算计算；
* Ready Queue 计算。

模型只处理需要语义判断的工作。

---

## 4.4 单写者原则

初期任何时间最多只能有一个写节点进入 `running`：

```text
maxConcurrentWriteNodes = 1
```

所有并行分析结果必须先汇总，再由单一 Patch Planner 生成统一修改方案。

---

## 4.5 所有完成必须绑定 Evidence

节点进入 `succeeded` 不代表任务完成。

对于有验证要求的节点：

```text
Node succeeded
  +
Required Evidence passed
  +
No unresolved Ripple Obligation
  +
Done Criteria satisfied
  =
Node deliverable accepted
```

---

# 五、核心数据模型

## 5.1 WorkflowSpec

新增：

```ts
export interface WorkflowSpec {
  id: string
  version: number
  template: WorkflowTemplateId
  goal: string
  createdAt: number

  nodes: WorkflowNodeSpec[]
  edges: WorkflowEdgeSpec[]

  budgets: WorkflowBudget
  policies: WorkflowPolicy
  metadata?: Record<string, unknown>
}
```

---

## 5.2 WorkflowNodeSpec

```ts
export type WorkflowNodeKind =
  | "deterministic"
  | "tool"
  | "model"
  | "flash"
  | "verify"
  | "transaction"
  | "router"
  | "barrier"
  | "human"

export interface WorkflowNodeSpec {
  id: string
  title: string
  kind: WorkflowNodeKind

  handler: string
  dependsOn: string[]

  inputSchema?: JsonSchema
  outputSchema?: JsonSchema

  sideEffect: "none" | "read" | "write" | "external"
  concurrencyGroup: string

  retryPolicy: RetryPolicy
  timeoutMs: number
  budget: NodeBudget

  taskPacket?: TaskPacket
  requiredCapabilities?: string[]
}
```

---

## 5.3 WorkflowEdgeSpec

```ts
export interface WorkflowEdgeSpec {
  id: string
  from: string
  to: string

  outputKey?: string
  inputKey?: string

  transport: "reference" | "copy" | "summary"
  required: boolean

  transform?: string
}
```

`transform` 只能引用受信任的 reducer 名称，不允许内嵌任意代码。

---

## 5.4 NodeRun

```ts
export type NodeRunStatus =
  | "pending"
  | "ready"
  | "running"
  | "succeeded"
  | "failed"
  | "blocked"
  | "skipped"
  | "cancelled"

export interface NodeRun {
  runId: string
  workflowRunId: string
  nodeId: string

  status: NodeRunStatus
  attempt: number

  startedAt?: number
  finishedAt?: number

  inputHash?: string
  outputHash?: string

  error?: NodeRunError
  usage: NodeUsage
  evidenceIds: string[]
}
```

---

## 5.5 NodeResult

```ts
export interface NodeResult<T = unknown> {
  status: "succeeded" | "failed" | "blocked"
  output?: T

  evidence: EvidenceEntry[]
  diagnostics: NodeDiagnostic[]
  usage: NodeUsage

  retryable?: boolean
  error?: NodeRunError
}
```

---

## 5.6 WorkflowRun

```ts
export interface WorkflowRun {
  id: string
  workflowId: string
  sessionId: string

  status:
    | "created"
    | "validating"
    | "running"
    | "paused"
    | "blocked"
    | "completed"
    | "failed"
    | "cancelled"

  nodeRuns: Record<string, NodeRun>

  startedAt?: number
  finishedAt?: number

  totalUsage: NodeUsage
  checkpointId?: string
}
```

---

# 六、新增文件结构

建议新增：

```text
src/workflow/
├── index.ts
├── types.ts
├── schema.ts
├── errors.ts
├── config.ts
│
├── compiler/
│   ├── index.ts
│   ├── master-plan-adapter.ts
│   ├── task-packet-adapter.ts
│   ├── template-compiler.ts
│   └── graph-normalizer.ts
│
├── validation/
│   ├── index.ts
│   ├── schema-validator.ts
│   ├── dag-validator.ts
│   ├── capability-validator.ts
│   ├── budget-validator.ts
│   ├── side-effect-validator.ts
│   └── validation-report.ts
│
├── scheduler/
│   ├── index.ts
│   ├── scheduler.ts
│   ├── ready-queue.ts
│   ├── dependency-resolver.ts
│   ├── concurrency-controller.ts
│   ├── retry-controller.ts
│   ├── cancellation.ts
│   └── progress-tracker.ts
│
├── execution/
│   ├── node-executor.ts
│   ├── handler-registry.ts
│   ├── execution-context.ts
│   ├── deterministic-executor.ts
│   ├── tool-executor.ts
│   ├── model-executor.ts
│   ├── verify-executor.ts
│   └── transaction-executor.ts
│
├── results/
│   ├── result-store.ts
│   ├── edge-store.ts
│   ├── result-hash.ts
│   ├── node-output-validator.ts
│   └── serialization.ts
│
├── reducers/
│   ├── registry.ts
│   ├── dedupe.ts
│   ├── merge-ripple-obligations.ts
│   ├── aggregate-evidence.ts
│   ├── merge-diagnostics.ts
│   ├── rank-findings.ts
│   └── context-reducer.ts
│
├── convergence/
│   ├── state.ts
│   ├── failure-signature.ts
│   ├── progress-metrics.ts
│   ├── dry-round-policy.ts
│   └── convergence-gate.ts
│
├── templates/
│   ├── registry.ts
│   ├── code-explain.ts
│   ├── narrow-fix.ts
│   ├── cross-module-refactor.ts
│   ├── security-audit.ts
│   ├── test-repair.ts
│   └── research-report.ts
│
├── persistence/
│   ├── workflow-store.ts
│   ├── checkpoint-adapter.ts
│   ├── replay.ts
│   └── migration.ts
│
└── telemetry/
    ├── workflow-trace.ts
    ├── workflow-metrics.ts
    └── graph-snapshot.ts
```

---

# 七、需要修改的现有文件

## 7.1 核心运行链

### `src/agent/loop.ts`

改动原则：

* 第一阶段不拆除；
* 增加 Workflow 执行入口；
* 当 `options.workflowRun` 存在时，执行当前节点；
* 将工具结果和验证结果返回 Workflow ResultStore；
* 继续复用现有 GateChain；
* 保持非 Workflow 模式行为不变。

禁止一次性重写整个文件。

---

### `src/agent/loop-types.ts`

新增：

```ts
workflowMode?: "off" | "shadow" | "enabled"
workflowRunId?: string
workflowNodeId?: string
workflowContext?: WorkflowExecutionContext
```

---

### `src/agent/master-plan.ts`

新增适配方法：

```ts
toWorkflowSpec(plan: MasterPlan): WorkflowSpec
fromWorkflowSpec(spec: WorkflowSpec): MasterPlan
```

逐步将：

```ts
current: string
```

从唯一执行游标降级为兼容字段。

---

### `src/agent/task-packet.ts`

扩展：

* `handler`
* `nodeKind`
* `sideEffect`
* `concurrencyGroup`
* `inputSchema`
* `outputSchema`
* `requiredCapabilities`

不能破坏现有 TaskTracker 转换逻辑。

---

### `src/agent/plan-validator.ts`

抽取可复用函数：

```ts
validateDagStructure()
validateDependencies()
validateNodeContracts()
```

Workflow Validator 复用这些函数。

---

### `src/agent/completion-orchestrator.ts`

增加：

```ts
workflowRun?: WorkflowRun
currentNodeResult?: NodeResult
```

完成判断前检查：

* Workflow 是否有未完成必要节点；
* 必要节点是否有证据；
* 是否存在 failed/blocked 必要节点；
* 是否存在未消费的 transaction result。

---

### `src/agent/evidence-ledger.ts`

增加：

```ts
workflowRunId?: string
nodeRunId?: string
edgeId?: string
```

证据必须能够追踪到：

```text
WorkflowRun
  → NodeRun
  → PatchTransaction
  → Verification Command
```

---

### `src/agent/patch-transaction.ts`

增加：

* Workflow Node 绑定；
* 单写者锁；
* 事务输入哈希；
* 事务输出哈希；
* 验证失败自动 rollback；
* 事务状态事件；
* 重复执行幂等保护。

---

### `src/agent/meta-agent.ts`

逐步替换“是否触碰新文件”的进度判断。

改为使用：

* unresolved diagnostics 数量；
* unresolved ripple obligations 数量；
* passed evidence 数量；
* 完成 done criteria 数量；
* 失败签名重复次数；
* 节点状态变化。

当前 MetaAgent 的进度指标容易把“修改同一核心文件”误判成停滞。

---

## 7.2 Runtime 层

### `src/runtime/controller.ts`

新增 Action：

```ts
| "workflow_started"
| "workflow_paused"
| "workflow_resumed"
| "workflow_cancelled"
| "workflow_node_approved"
```

新增方法：

```ts
startWorkflow()
pauseWorkflow()
resumeWorkflow()
cancelWorkflow()
approveWorkflowNode()
```

---

### `src/runtime/events.ts`

增加事件：

```ts
workflow.created
workflow.validated
workflow.started
workflow.paused
workflow.completed
workflow.failed

workflow.node.ready
workflow.node.started
workflow.node.succeeded
workflow.node.failed
workflow.node.blocked
workflow.node.retrying

workflow.edge.produced
workflow.evidence.added
workflow.checkpoint.saved
```

---

### `src/runtime/event-bus.ts`

确保：

* 事件顺序稳定；
* 支持 workflowRunId 过滤；
* 支持 NodeRun 级订阅；
* 支持 Replay 重放；
* 事件持久化失败不影响核心执行。

---

### `src/runtime/session.ts`

增加：

```ts
activeWorkflowRunId?: string
workflowStatus?: WorkflowRun["status"]
```

---

## 7.3 Context 层

### `src/context/context-map.ts`

增加：

```ts
sliceContextForNode(
  map: ContextMap,
  node: WorkflowNodeSpec
): NodeContextSlice
```

每个节点只能获得：

* 相关文件；
* 相关符号；
* 直接依赖结果；
* 必要规则；
* 必要历史；
* 当前预算。

不得默认继承整条会话。

---

### `src/context/staged.ts`

增加 Node Scope：

```text
L0: system invariant
L1: workflow stable prefix
L2: node contract
L3: edge payload
L4: volatile tool result
```

---

### `src/agent/context-epoch.ts`

增加 Node Epoch：

* 每个长节点可以独立 rollover；
* 节点结束后只保留结构化输出；
* 不把完整节点历史传入下游；
* Graph 主上下文只保存摘要和引用。

---

## 7.4 Provider 层

### `src/provider/router.ts`

增加按 Node 类型路由：

```text
deterministic → no model
flash         → Flash
model:analysis → Pro/high
model:patch    → Pro/max when high risk
verify:model  → Flash or independent provider
```

---

### `src/provider/capabilities.ts`

增加能力声明：

```ts
supportsStructuredOutput
supportsThinking
supportsFIM
supportsPrefixCache
supportsParallelSubcalls
supportsToolUse
```

Workflow Validator 必须在执行前确认节点能力可以被当前 Provider 满足。

---

## 7.5 Tool 层

### `src/tools/registry.ts`

扩展工具描述：

```ts
sideEffect
concurrencyGroup
idempotent
retryable
requiredCapabilities
producesEvidence
```

示例：

```ts
read_file:
  sideEffect = "read"
  concurrencyGroup = "filesystem-read"
  idempotent = true

write_file:
  sideEffect = "write"
  concurrencyGroup = "workspace-write"
  idempotent = false
```

---

## 7.6 Verification 层

### `src/verification/collector.ts`

增加：

* NodeRun 绑定；
* 事务绑定；
* 证据去重；
* 过期证据判断；
* 验证命令输出哈希；
* 验证覆盖范围。

代码修改后，修改前产生的证据不得继续算作当前版本证据。

---

## 7.7 Session 与 Checkpoint

### `src/session/checkpoint.ts`

Checkpoint 增加：

```ts
workflowSpec
workflowRun
nodeRuns
edgePayloadRefs
convergenceState
transactionState
```

---

### `src/session/migration.ts`

新增 Workflow Schema Version：

```text
session schema vN
  → workflow schema v1
```

必须支持旧会话无损加载。

---

## 7.8 TUI

修改：

* `src/tui/state/types.ts`
* `src/tui/state/tui-store.ts`
* `src/tui/components/PlanPanel.tsx`
* `src/tui/components/RightRail.tsx`
* `src/tui/components/StatusBar.tsx`
* `src/tui/components/ToolCard.tsx`

新增：

```text
src/tui/components/WorkflowGraphPanel.tsx
src/tui/components/WorkflowNodeCard.tsx
src/tui/components/WorkflowEdgeList.tsx
src/tui/components/WorkflowEvidencePanel.tsx
```

首版不需要画复杂图形，只显示：

```text
[✓] inspect-package
[▶] inspect-types
[ ] analyze-callers
[!] patch
[ ] verify
```

并显示：

* 依赖；
* 状态；
* 耗时；
* Token；
* 工具数；
* 证据；
* 阻塞原因。

---

# 八、Workflow Compiler

## 8.1 输入

Compiler 接受：

```ts
interface WorkflowCompileInput {
  prompt: string
  intent: IntentPolicy
  masterPlan?: MasterPlan
  taskPacket?: TaskPacket
  contextMap?: ContextMap
  providerCapabilities: ProviderCapabilities
}
```

---

## 8.2 编译流程

```text
Intent
  ↓
选择 Workflow Template
  ↓
MasterPlan 转 Node
  ↓
TaskPacket 附加 Node Contract
  ↓
根据 dependsOn 建 Edge
  ↓
插入必要 Router / Barrier / Verify Node
  ↓
归一化 Graph
  ↓
Workflow Validator
```

---

## 8.3 自动插入节点

Compiler 应自动插入：

### 写节点前

```text
context-readiness
risk-classification
patch-plan
```

### 写节点后

```text
ripple-verify
typecheck
test
evidence-aggregate
completion-check
```

模型不能自行删除这些强制节点。

---

## 8.4 Graph Normalization

归一化规则：

* 删除重复依赖；
* 拒绝自依赖；
* 拒绝循环；
* 补齐缺失节点 ID；
* 确保单写节点；
* 合并连续 deterministic reducer；
* 检测没有消费者的输出；
* 检测没有输入来源的必需字段；
* 为 barrier 自动生成 required upstream set；
* 为 router 检查所有分支是否可达；
* 为高风险写节点强制增加验证节点。

---

# 九、Scheduler 设计

## 9.1 Ready Queue 算法

节点可进入 ready 的条件：

```text
status == pending
AND 所有 required dependencies succeeded/skipped
AND 没有 active blocker
AND concurrency group 有容量
AND budget 未耗尽
AND required capabilities available
```

伪代码：

```ts
while (!terminal(run)) {
  const readyNodes = calculateReadyNodes(run, spec)

  if (readyNodes.length === 0) {
    if (hasRunningNodes(run)) {
      await waitForNodeCompletion()
      continue
    }

    if (hasBlockedRequiredNodes(run)) {
      markWorkflowBlocked()
      break
    }

    if (allRequiredNodesSucceeded(run)) {
      markWorkflowCompleted()
      break
    }

    throw new WorkflowDeadlockError()
  }

  const selected = concurrencyController.select(readyNodes)

  await Promise.all(
    selected.map(node => executeNode(node))
  )
}
```

---

## 9.2 并发组

默认配置：

```json
{
  "workflow": {
    "maxConcurrentNodes": 6,
    "maxConcurrentReadonly": 4,
    "maxConcurrentFlash": 2,
    "maxConcurrentPro": 1,
    "maxConcurrentNetwork": 2,
    "maxConcurrentWrite": 1,
    "maxConcurrentVerification": 3
  }
}
```

建议并发组：

| Group | 默认并发 |
| --- | ---: |
| `filesystem-read` | 4 |
| `code-search` | 4 |
| `network` | 2 |
| `flash-model` | 2 |
| `pro-model` | 1 |
| `workspace-write` | 1 |
| `verification` | 3 |
| `git-write` | 1 |

---

## 9.3 失败策略

节点失败后，根据策略处理：

```ts
interface RetryPolicy {
  maxAttempts: number
  backoff: "none" | "linear" | "exponential"
  retryOn: string[]
  fallbackHandler?: string
}
```

失败类型：

* `transient_provider`
* `rate_limit`
* `timeout`
* `schema_mismatch`
* `tool_failure`
* `permission_denied`
* `verification_failed`
* `policy_blocked`
* `non_retryable`
* `budget_exhausted`

规则：

* Provider 临时错误：可重试；
* Schema 不匹配：模型节点最多重试两次；
* 权限拒绝：不可自动重试；
* 验证失败：进入 Repair Graph；
* 预算耗尽：暂停或缩小范围；
* 重复失败签名：触发 Convergence Gate。

---

## 9.4 失败隔离

独立节点失败不得直接令整个 Workflow 失败。

节点必须声明：

```ts
required: boolean
failurePolicy:
  | "fail_workflow"
  | "skip_node"
  | "continue_degraded"
  | "route_to_fallback"
```

例如：

```text
semantic-recall 失败
  → continue_degraded

typecheck 失败
  → route_to_repair

permission 失败
  → block_workflow
```

---

# 十、Single Writer Transaction

## 10.1 写入拓扑

```text
并行分析节点
    ↓
deterministic reduce
    ↓
Patch Planner
    ↓
Single Writer Lock
    ↓
PatchTransaction
    ↓
Ripple + Typecheck + Tests
    ↓
Commit 或 Rollback
```

---

## 10.2 Workspace Write Lock

新增全局锁：

```ts
interface WorkspaceWriteLock {
  ownerNodeRunId?: string
  acquiredAt?: number

  acquire(nodeRunId: string): Promise<void>
  release(nodeRunId: string): void
}
```

任何：

* `write_file`
* `edit_file`
* `multi_edit`
* `edit_fim`
* `rollback_transaction`
* 可能修改文件的 shell

都必须持有锁。

---

## 10.3 写节点幂等

每个 PatchTransaction 记录：

```text
inputHash
baseFileHashes
patchHash
resultFileHashes
```

重试时：

* 如果输入和基础文件均未变化，可复用结果；
* 如果工作区发生变化，旧事务必须失效；
* 禁止盲目重复应用同一 Patch。

---

## 10.4 自动回滚

以下情况自动回滚：

* transaction 执行中断；
* 写入部分成功；
* 类型检查失败且修复预算耗尽；
* 检测到非预期文件修改；
* Ripple 存在不可接受 obligation；
* 输出文件哈希与计划不符。

---

# 十一、Context Slice 与缓存

## 11.1 节点输入不继承整条会话

每个节点输入由以下部分组成：

```text
Stable System Prefix
+ Workflow Contract
+ Node Contract
+ Required Edge Payloads
+ Relevant ContextMap Slice
+ Recent Node-local History
```

不得默认传入：

* 完整原始对话；
* 其他无关节点工具输出；
* 其他节点完整思考链；
* 全仓库文件内容；
* 所有历史错误。

---

## 11.2 Edge Payload 分级

```ts
transport: "reference" | "copy" | "summary"
```

### reference

仅传结果引用：

```json
{
  "resultRef": "result://workflow/run/node/output"
}
```

### copy

小型结构化数据直接复制。

### summary

大型输出通过确定性裁剪或模型摘要压缩。

---

## 11.3 缓存策略

节点缓存 Key：

```text
handler
+ model
+ normalized input
+ relevant file hashes
+ system contract version
+ node schema version
```

只读、幂等节点允许缓存：

* project structure；
* symbol search；
* package analysis；
* static dependency scan；
* document parse。

写入、验证和外部实时查询默认不复用缓存。

---

# 十二、验证子图

## 12.1 标准验证 Diamond

```text
PatchTransaction
      │
      ├──── Ripple Verify
      ├──── Typecheck
      ├──── Tests
      ├──── Build
      └──── Security Check
                 │
                 ▼
          Evidence Aggregator
                 │
                 ▼
        CompletionOrchestrator
```

---

## 12.2 Evidence 新鲜度

Evidence 必须绑定代码状态。

建议增加：

```ts
workspaceHash: string
relevantFileHashes: Record<string, string>
```

如果 Evidence 生成后相关文件再次变化：

```text
evidence.status = stale
```

过期证据不能用于 `canClaimDone()`。

---

## 12.3 Verifier Lens

高风险节点可以使用多视角验证：

* correctness；
* security；
* reproducibility；
* performance；
* scope compliance。

第一阶段不需要多个 Pro Agent，可以：

* 代码验证使用确定性工具；
* 语义验证使用多个不同 prompt 的 Flash；
* 最后由一个 Judge 聚合。

---

# 十三、收敛循环

## 13.1 ConvergenceState

```ts
export interface ConvergenceState {
  seenFailureSignatures: Set<string>
  seenDiagnostics: Set<string>
  seenRippleObligations: Set<string>
  seenCandidateFixes: Set<string>

  passedEvidenceIds: Set<string>
  completedCriteria: Set<string>

  consecutiveDryRounds: number
  consecutiveNoMetricImprovement: number

  lastDiagnosticCount: number
  lastOpenObligationCount: number
  lastPassedEvidenceCount: number
  lastCompletedCriteriaCount: number
}
```

---

## 13.2 进展定义

只有以下变化才算进展：

* 未解决诊断减少；
* Ripple obligations 减少；
* 新增 passed evidence；
* 完成新的 done criterion；
* 解除 blocker；
* 必需文件补齐；
* 节点输出首次通过 Schema；
* Workflow 必需节点状态前进。

以下不算进展：

* 重复读取同一文件；
* 重复运行相同失败命令；
* 仅修改更多文件；
* 仅增加输出文本；
* 重复产生已经 rejected 的候选；
* 错误文本改变但根因相同。

---

## 13.3 Failure Signature

错误签名不能只使用前 80 个字符。

建议：

```text
tool name
+ exit code
+ normalized error code
+ top stack frame
+ relevant file
+ normalized diagnostic category
```

例如：

```text
typescript|TS2345|src/a.ts|functionCall
```

---

## 13.4 退出条件

Repair Cycle 在任一条件满足时终止：

* 连续两轮没有新候选；
* 连续两轮核心指标无改善；
* 同一失败签名达到最大重试；
* 节点预算耗尽；
* Workflow 总预算耗尽；
* 验证证明问题不可修复；
* 需要用户提供缺失信息；
* 权限或环境构成硬阻塞。

---

# 十四、内置 Workflow Templates

## 14.1 `code_explain`

```text
inspect-project
  ├─ inspect-config
  ├─ inspect-entrypoints
  ├─ inspect-modules
  └─ inspect-tests
        ↓
deterministic-reduce
        ↓
architecture-synthesis
```

全部只读，可安全并行。

---

## 14.2 `narrow_fix`

```text
locate-error
  ↓
read-target
  ↓
analyze-dependencies
  ↓
patch-plan
  ↓
patch-transaction
  ├─ typecheck
  └─ targeted-test
        ↓
completion
```

---

## 14.3 `cross_module_refactor`

```text
scope-analysis
   ├─ public-api-analysis
   ├─ caller-analysis
   ├─ test-analysis
   └─ risk-analysis
          ↓
      plan-reduce
          ↓
      single-patch-plan
          ↓
      transaction
          ↓
   verification barrier
          ↓
      completion
```

---

## 14.4 `security_audit`

```text
route-discovery
   ↓ fan-out
one node per route/module
   ↓
finding-dedupe
   ↓
adversarial-verification
   ↓
severity-ranking
   ↓
report
```

默认只读，不自动修复。

---

## 14.5 `test_repair`

```text
run-failing-tests
   ↓
classify-failures
   ↓ fan-out
analyze independent failure groups
   ↓
dedupe root causes
   ↓
single patch plan
   ↓
transaction
   ↓
rerun affected tests
   ↓
full verification
```

---

## 14.6 `research_report`

```text
question-decomposition
   ↓ fan-out
independent research nodes
   ↓
source normalization
   ↓
claim dedupe
   ↓
claim verification
   ↓
report synthesis
```

---

# 十五、配置设计

在配置中新增：

```json
{
  "workflow": {
    "mode": "off",
    "templates": true,

    "maxConcurrentNodes": 6,
    "maxConcurrentReadonly": 4,
    "maxConcurrentFlash": 2,
    "maxConcurrentPro": 1,
    "maxConcurrentNetwork": 2,
    "maxConcurrentWrite": 1,
    "maxConcurrentVerification": 3,

    "nodeTimeoutMs": 120000,
    "maxWorkflowRounds": 50,
    "maxRepairCycles": 4,

    "checkpointEveryNodes": 3,
    "persistEdgePayloads": false,
    "cacheReadonlyNodes": true,

    "dynamicCompiler": false,
    "allowParallelWrites": false
  }
}
```

模式：

* `off`：完全使用现有 Agent Loop；
* `shadow`：生成 Graph 和 Trace，但不改变执行；
* `enabled`：启用受控 Scheduler。

首发必须默认 `off`。

---

# 十六、可观测性

## 16.1 Workflow Trace

每个节点记录：

* Node ID；
* 状态；
* 处理器；
* 依赖；
* 开始和结束时间；
* 耗时；
* 模型；
* Token；
* 工具调用数；
* 重试次数；
* 输入输出哈希；
* 证据；
* 错误；
* 阻塞原因。

---

## 16.2 核心指标

```text
workflow_total_ms
workflow_node_count
workflow_parallelism_peak
workflow_ready_queue_wait_ms
workflow_node_success_rate
workflow_retry_rate
workflow_cache_hit_rate
workflow_token_total
workflow_token_by_node_kind
workflow_evidence_pass_rate
workflow_repair_cycles
workflow_dry_rounds
workflow_write_lock_wait_ms
```

---

## 16.3 Graph Snapshot

每个状态变化后可以生成：

```json
{
  "workflowRunId": "...",
  "status": "running",
  "nodes": [
    {
      "id": "inspect-api",
      "status": "succeeded"
    },
    {
      "id": "patch",
      "status": "running"
    }
  ],
  "edges": []
}
```

供 TUI、Checkpoint 和 Replay 使用。

---

# 十七、安全边界

## 17.1 所有节点必须经过原有安全系统

Workflow Executor 不得直接执行工具。

正确路径：

```text
Workflow Node
  ↓
Node Executor
  ↓
现有 Tool Policy
  ↓
PermissionGate
  ↓
ToolRisk
  ↓
Sandbox
  ↓
Tool
```

任何绕过 `evaluateToolPolicy()` 的执行方式均视为架构缺陷。

---

## 17.2 动态 Workflow 只能声明，不能编程

模型只允许输出受限 JSON：

```json
{
  "template": "cross_module_refactor",
  "nodes": [],
  "edges": []
}
```

禁止：

* 内嵌 JavaScript；
* 动态 import；
* 执行 shell 编排脚本；
* 自定义 reducer 代码；
* 任意文件系统访问；
* 未经注册的 handler；
* 未经注册的 transform。

---

## 17.3 Capability Allowlist

Handler 必须预注册：

```ts
handlerRegistry.register("tool.read_file", ...)
handlerRegistry.register("reduce.dedupe", ...)
handlerRegistry.register("verify.typecheck", ...)
```

Workflow Spec 引用未知 handler 必须验证失败。

---

# 十八、测试方案

## 18.1 新增单元测试

```text
tests/workflow_types.test.ts
tests/workflow_schema.test.ts
tests/workflow_compiler.test.ts
tests/workflow_validator.test.ts
tests/workflow_dag_cycle.test.ts
tests/workflow_ready_queue.test.ts
tests/workflow_dependency_resolver.test.ts
tests/workflow_scheduler.test.ts
tests/workflow_concurrency.test.ts
tests/workflow_retry.test.ts
tests/workflow_cancellation.test.ts
tests/workflow_result_store.test.ts
tests/workflow_edge_store.test.ts
tests/workflow_output_schema.test.ts
tests/workflow_reducers.test.ts
tests/workflow_single_writer.test.ts
tests/workflow_transaction.test.ts
tests/workflow_evidence.test.ts
tests/workflow_convergence.test.ts
tests/workflow_checkpoint.test.ts
tests/workflow_replay.test.ts
tests/workflow_context_slice.test.ts
tests/workflow_security.test.ts
```

---

## 18.2 必测场景

### DAG

* 无依赖节点全部 ready；
* 依赖完成后下游 ready；
* 循环依赖拒绝；
* 缺失依赖拒绝；
* 自依赖拒绝；
* 不可达节点报告；
* Barrier 等待所有必需上游。

### 并发

* 四个只读节点并行；
* 写节点永远不超过一个；
* 网络节点受并发限制；
* Pro 节点受并发限制；
* 并发节点失败互不污染；
* 取消时未启动节点全部 cancelled。

### Edge

* 必需输出缺失则下游 blocked；
* 输出 Schema 不匹配则节点失败；
* transform 未注册则 Graph 无效；
* 大型输出使用 reference；
* ResultStore 引用可恢复。

### Transaction

* 部分写入失败自动回滚；
* 重复 Patch 不重复应用；
* 工作区变化使旧事务失效；
* 验证失败触发 rollback；
* 写锁可以被正确释放。

### Evidence

* 修改后旧 Evidence 过期；
* 节点缺少必要证据不能完成；
* 不同节点证据不会串用；
* 失败 Evidence 不满足完成；
* 最终 Truthfulness Gate 能识别虚假声明。

### Convergence

* 重复错误签名被识别；
* rejected finding 不会反复进入 fresh；
* 两轮 dry 后退出；
* 指标改善时重置 dry counter；
* 预算耗尽后正确终止。

---

## 18.3 集成测试

新增：

```text
tests/workflow_code_explain.integration.test.ts
tests/workflow_narrow_fix.integration.test.ts
tests/workflow_refactor.integration.test.ts
tests/workflow_test_repair.integration.test.ts
tests/workflow_resume.integration.test.ts
tests/workflow_loop_compat.integration.test.ts
```

---

## 18.4 回归要求

每个 PR 必须执行：

```bash
bun run typecheck
bun run test
bun run build
```

同时要求：

* 现有所有测试通过；
* 非 Workflow 模式行为不变；
* 旧 Session 可以加载；
* CLI 和 TUI 可以正常启动；
* npm 打包 Smoke Test 通过。

---

# 十九、分阶段实施路线

# PR-G0：Execution Graph Trace

## 目标

不改变执行行为，只将当前 `agentLoop()` 的运行过程投影成图。

## 新增

```text
src/workflow/types.ts
src/workflow/telemetry/workflow-trace.ts
src/workflow/telemetry/graph-snapshot.ts
src/workflow/results/result-hash.ts
```

## 修改

```text
src/agent/run-trace.ts
src/agent/loop.ts
src/runtime/events.ts
src/tui/state/types.ts
```

## 实现内容

* 记录虚拟节点；
* 记录节点状态；
* 记录工具节点；
* 记录 Gate 节点；
* 记录验证节点；
* 记录边；
* 输出 JSON Snapshot；
* 支持 `workflow.mode=shadow`。

## 验收

* 不改变现有执行结果；
* 每次运行可以生成 Graph Trace；
* Trace 中没有敏感信息；
* Trace 可序列化、反序列化；
* 所有原测试通过。

---

# PR-G1：Read-only DAG Scheduler

## 目标

支持只读节点真正并行执行。

## 新增

```text
src/workflow/scheduler/*
src/workflow/execution/node-executor.ts
src/workflow/execution/handler-registry.ts
src/workflow/execution/tool-executor.ts
src/workflow/results/result-store.ts
src/workflow/results/edge-store.ts
```

## 首批支持 Handler

* `tool.read_file`
* `tool.find_symbol`
* `tool.find_references`
* `tool.project_structure`
* `tool.git_diff`
* `tool.git_status`
* `reduce.dedupe`
* `reduce.merge_diagnostics`

## 验收

* 四个无依赖只读节点能够并行；
* 任何写工具均被拒绝；
* 单节点失败不影响其他节点；
* 下游依赖正确等待；
* Graph 可以 checkpoint；
* Scheduler 无死锁。

---

# PR-G2：Workflow Compiler 与 Templates

## 目标

将 MasterPlan 和 TaskPacket 编译成受控 WorkflowSpec。

## 新增

```text
src/workflow/compiler/*
src/workflow/validation/*
src/workflow/templates/*
```

## 修改

```text
src/agent/master-plan.ts
src/agent/task-packet.ts
src/agent/plan-validator.ts
src/context/context-map.ts
```

## 首批模板

* `code_explain`
* `security_audit`
* `research_report`

全部保持只读。

## 验收

* 相同输入产生稳定 Graph；
* Graph Schema 有版本；
* 循环、未知 Handler、非法副作用被拒绝；
* MasterPlan 可转换为 WorkflowSpec；
* WorkflowSpec 可展示回 MasterPlan 状态。

---

# PR-G3：Single Writer Transaction Graph

## 目标

把修改任务接入 Graph，但保持单写者。

## 新增

```text
src/workflow/execution/transaction-executor.ts
src/workflow/scheduler/concurrency-controller.ts
src/workflow/reducers/aggregate-evidence.ts
```

## 修改

```text
src/agent/patch-transaction.ts
src/agent/evidence-ledger.ts
src/agent/completion-orchestrator.ts
src/tools/registry.ts
src/verification/collector.ts
```

## 首批写模板

* `narrow_fix`
* `test_repair`

## 验收

* 任何时间最多一个写节点；
* 写节点必须持有 WorkspaceWriteLock；
* 失败自动 rollback；
* 验证结果绑定事务和节点；
* 无 Evidence 不能完成；
* 非 Workflow 模式无回归。

完成 G3 后，Graph Runtime 才具备真实可用价值。

---

# PR-G4：Convergent Repair Graph

## 目标

建立可证明收敛的修复循环。

## 新增

```text
src/workflow/convergence/*
```

## 修改

```text
src/agent/meta-agent.ts
src/agent/loop.ts
src/agent/completion-orchestrator.ts
```

## 验收

* 重复失败不无限重试；
* seen 与 confirmed 分离；
* 两轮 dry 后退出；
* 指标改善能继续执行；
* 预算耗尽时输出结构化阻塞报告；
* 同一错误不会通过改变措辞绕过检测。

---

# PR-G5：Context Slice、缓存与 Replay

## 目标

降低 Graph 节点上下文和重复成本。

## 新增

```text
src/workflow/persistence/*
src/workflow/results/result-cache.ts
```

## 修改

```text
src/context/staged.ts
src/context/context-map.ts
src/agent/context-epoch.ts
src/session/checkpoint.ts
src/session/migration.ts
```

## 验收

* 节点不继承无关历史；
* 只读节点可按输入哈希命中缓存；
* 修改文件后相关缓存失效；
* Checkpoint 可从中断节点恢复；
* Replay 不重新执行已成功确定性节点；
* 旧会话兼容。

---

# PR-G6：Dynamic Workflow Compiler

## 目标

允许模型根据任务动态选择受控图。

## 限制

* 只输出 JSON；
* 只能使用注册节点类型；
* 只能使用注册 Handler；
* 不能定义任意代码；
* 必须通过 Schema、DAG、Capability、Budget 和 Side-effect 校验；
* 高风险 Graph 需要人工批准；
* 默认关闭。

## 验收

* 非法 Handler 拒绝；
* 非法写并发拒绝；
* 缺少验证节点自动补齐或拒绝；
* 模型无法绕过 PermissionGate；
* 动态 Graph 与静态模板共享 Scheduler。

---

# PR-G7：T3R Multi-Agent

该阶段放到 v1.0 Strong Single 收束之后。

新增能力：

* Agent Pool；
* 每节点独立上下文；
* worktree 隔离；
* file ownership；
* 多 Agent 并行分析；
* 多 Agent 独立验证；
* merge node；
* 冲突检测；
* 预算分配；
* Agent cancellation。

前提：

* G0—G6 稳定；
* PatchTransaction Phase 2 完成；
* Replay 和 Checkpoint 稳定；
* Graph 运行数据证明单 Agent 已成为瓶颈。

---

# 二十、发布策略

## 阶段一：Shadow

```json
{
  "workflow": {
    "mode": "shadow"
  }
}
```

* 生成 Graph；
* 不改变执行；
* 比较预测节点与真实执行；
* 收集 Trace；
* 修正 Compiler。

## 阶段二：Read-only Enabled

只对以下任务启用：

* 解释代码库；
* 安全审查；
* 研究报告；
* 依赖分析；
* 测试发现。

## 阶段三：Narrow Write Enabled

只对：

* 单文件修复；
* 小范围测试修复；
* 明确目标的窄改动。

## 阶段四：Long Task Enabled

在完整验证后支持跨模块任务。

---

# 二十一、风险清单

| 风险 | 影响 | 控制方式 |
| --- | --- | --- |
| 新增第四套任务状态 | 状态混乱 | WorkflowNode 复用 TaskPacket 和 MasterPlan |
| Scheduler 绕过 Gate | 严重安全漏洞 | 所有工具仍经过现有 Tool Policy |
| 并行写冲突 | 文件损坏 | 单写者锁 |
| Graph 过度复杂 | 开发停滞 | G0—G3 逐步实施 |
| Context 成本增加 | Token 上升 | Node Context Slice |
| Flash 调用增多 | 成本上升 | 并发限制、缓存、strict mode |
| Graph 无法收敛 | 无限循环 | ConvergenceState |
| Evidence 串用 | 虚假完成 | 绑定 NodeRun 和 Workspace Hash |
| 动态 Graph 越权 | 安全失控 | 声明式 JSON + Allowlist |
| 旧 Loop 回归 | 发布风险 | Feature Flag，默认关闭 |
| Checkpoint 不兼容 | 会话损坏 | Schema Version + Migration |
| TUI 复杂度过高 | 用户体验下降 | 首版只做节点列表，不做复杂图形 |

---

# 二十二、Definition of Done

Graph Runtime 第一可用版本必须满足：

## 架构

* WorkflowSpec、Node、Edge、Run 类型稳定；
* 所有 Graph 都通过统一 Validator；
* 没有任意代码执行；
* TaskPacket 和 MasterPlan 已有适配器；
* 没有平行的重复任务模型。

## 调度

* 真正支持跨节点只读并行；
* 依赖满足后自动进入 Ready；
* Barrier 正常；
* 失败隔离正常；
* 写节点并发始终为 1；
* 取消和暂停正常。

## 安全

* 所有工具继续经过 PermissionGate；
* 所有写入继续经过 Sandbox、Ripple 和 Transaction；
* 动态 Graph 无法创建未知 Handler；
* 敏感信息不进入 Trace。

## 验证

* 每个必要节点有 Evidence；
* Evidence 具备新鲜度；
* CompletionOrchestrator 是唯一完成出口；
* Truthfulness Gate 继续生效；
* 验证失败会进入受限 Repair Cycle。

## 可恢复性

* Workflow 可 checkpoint；
* 中断后可恢复；
* 已完成节点不重复执行；
* 旧会话可以正常加载。

## 质量

```bash
bun run typecheck
bun run test
bun run build
npm pack --dry-run
```

全部通过。

---

# 二十三、给 Codex 的执行约束

Codex 在实施本方案时必须遵守：

1. 每次只执行一个 PR 阶段；
2. 不提前实现后续阶段；
3. 不一次性重写 `agentLoop()`；
4. 不删除现有 Gate；
5. 不绕过现有 Tool Policy；
6. 不引入任意脚本 Workflow；
7. 不实现并行写；
8. 每次改动前先读取目标文件；
9. 新类型必须有测试；
10. 新状态必须有迁移；
11. 每个新增配置必须有默认值；
12. 默认行为必须保持现状；
13. 每个 PR 都必须运行 typecheck、test、build；
14. 发现架构冲突时停止扩展范围；
15. 提交报告中必须列出：

* 修改文件；
* 新增文件；
* 执行链变化；
* 测试结果；
* 未完成项；
* 已知风险。

---

# 二十四、最终实施优先级

真正推荐的实施范围不是立即做 G0—G7 全部内容。

当前最合理的版本目标是：

```text
G0 Execution Graph Trace
       ↓
G1 Read-only DAG Scheduler
       ↓
G2 Workflow Compiler + Templates
       ↓
G3 Single Writer Transaction Graph
```

完成 G3 后，Orcana 将获得：

* 跨节点并行分析；
* 结构化数据边；
* 受控 DAG 调度；
* 单写者安全修改；
* 节点级预算；
* 节点级 Evidence；
* 完整 Trace；
* 可逐步恢复；
* 与现有 GateChain 兼容。

此时产品定位可以升级为：

> **Orcana 是一个约束优先的终端编码智能体运行时。它通过类型化执行图协调分析、修改与验证，但仍以单写者和证据完成机制保证安全。**

后续再根据实际运行数据决定是否进入 T3R Multi-Agent，而不是因为行业趋势提前扩大架构。

建议下一步直接从 **PR-G0：Execution Graph Trace** 开始，并将该阶段进一步拆成 Codex 可逐项执行的文件级任务单。
