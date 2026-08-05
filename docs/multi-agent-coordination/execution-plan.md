# Orcana 多 Agent 协调层融合实施计划

**计划版本：** MACP-1.0
**实施基线：** Orcana Runtime `v0.8.0`
**基线提交：** `6cde9f4a7758b2922f41cfeffb6a0dc0c79c9492`
**目标版本：** 静态受治理多 Agent 协调 `v0.9.0`
**实施原则：** Kernel 零改动、Harness 权威不变、Workflow 可选启用、证据优先、角色不产生新权威、先静态后动态。

---

# 一、实施目标

本计划不重新建设一套多 Agent 框架。

目标是在现有：

* Typed Execution Graph；
* AgentHarness 2.0；
* H11 Node Runtime；
* AgentPool；
* RepairLoop；
* PermissionGate；
* EvidenceLedger；
* PatchTransaction；
* ResultStore；
* Checkpoint / Replay；

基础上，补齐真正的多 Agent 协调语义。

最终支持：

```text
用户任务
→ 判断是否启用多 Agent
→ Planner 生成计划契约
→ 计划经过结构化验收
→ 任务分区与文件所有权分配
→ 多个 Coder 在隔离工作区执行
→ 每个 Coder 独立验证
→ 安全合并
→ 整体重新验证
→ Reviewer 独立审查
→ 确定性裁决
→ 完成 / 修复 / 重规划 / 人工处理 / 策略阻止
```

最终系统必须满足：

> 多 Agent 只能提升任务处理能力，不能降低现有权限、证据、验证和完成门槛。

---

# 二、当前真实基线

## 2.1 已经具备

当前版本已经存在：

* DAG 调度；
* 只读并行；
* 单写者锁；
* 证据完成门；
* 节点结果存储；
* 检查点与重放；
* 动态图编译；
* 动态图写入审批；
* 收敛修复循环；
* Agent 注册、预算和取消；
* 文件所有权声明；
* Worktree 创建工具；
* 冲突检测；
* Agent 结果合并；
* H11 统一节点类型；
* Human Node 原语。

## 2.2 目前仍然缺少

### 缺口一：依赖只表示“结束”

当前 `dependsOn` 在上游成功或失败后都会解除，下游可能在上游失败后继续执行。当前就绪队列只计算依赖是否结束，不检查其结果是否已成功或被接受。

### 缺口二：Agent 工作区和所有权没有端到端接线

`AgentPool` 保存 `ownerFiles`、`worktree`、预算和取消状态，但当前调度器主要使用取消与节点预算，尚未在工具写入路径中强制调用 `canWrite()`，也没有把 Agent 的 Worktree 根目录传入工具执行上下文。

### 缺口三：Workflow 尚未正式通过 H11 执行

H11 已定义 `function / tool / llm_agent / verification / human` 统一节点，以及预算、取消、诊断、证据和中断上下文。

但当前 Workflow 节点主要通过 `HandlerRegistry.run(input)` 执行，尚未正式创建和调用 H11 `HarnessNode`。

### 缺口四：人工等待不可持久化恢复

当前 PermissionGate 将待批准图保存在进程内存中，尚不具备跨进程等待、恢复令牌、重启恢复和图版本校验。

### 缺口五：当前合并规则不适合真实裁决

当前 `mergeAgentArtifacts()` 对同名字段采用“后一个覆盖前一个”，虽然会报告文件冲突，但可能丢失前面 Agent 的结构化结果。

### 缺口六：完成条件仍以自由文本为主

当前 TaskPacket 有 `scope`、`doneCriteria`、`verification` 和预算，但 `doneCriteria` 仍是字符串数组，无法可靠地全部转化为确定性验证。

---

# 三、不可违反的架构不变量

## 3.1 Kernel 零改动

禁止修改：

```text
src/agent/loop.ts
```

以及为多 Agent 绕过原有 Kernel 门禁。

所有新能力必须位于：

```text
src/workflow/
src/harness/
```

或已有能力执行入口的适配层。

## 3.2 工具只能通过受管入口

任何 Planner、Coder、Reviewer 或协调节点都不能直接：

* 调用 Shell；
* 修改文件；
* 执行 Git；
* 发起网络请求；
* 安装依赖。

必须通过 Harness 和 CapabilityExecutor 的正式路径。

## 3.3 模型不能拥有状态权威

模型可以：

* 提议计划；
* 提议修改；
* 提议裁决；
* 给出审查意见；
* 给出置信度声明。

模型不能：

* 自行宣布计划已批准；
* 自行宣布证据已通过；
* 自行扩大文件所有权；
* 自行绕过安全否决；
* 自行修改权限；
* 自行宣布任务完成。

## 3.4 角色不等于权限

`planner`、`coder`、`reviewer` 只是当前任务中的职责标签。

真实权限由以下内容决定：

```text
Assignment
+ Capability Policy
+ File Ownership
+ Worktree
+ Budget
+ User Approval
```

## 3.5 完成只认有效证据

以下内容不能作为完成依据：

* 模型自评；
* Agent 数量；
* 多数投票；
* 置信度；
* 协商结果；
* Reviewer 的自然语言认可。

最终完成仍必须通过：

* 必选完成条件；
* 验证证据；
* 文件状态；
* 权限检查；
* EvidenceLedger；
* CompletionOrchestrator。

## 3.6 禁止自动覆盖冲突

同一文件、同一符号或同一关键决策出现冲突时：

```text
保留双方产物
→ 生成冲突记录
→ 确定性处理或进入裁决
```

禁止使用：

```text
later-wins
last-write-wins
多数 Agent 自动覆盖
```

作为正式代码合并策略。

## 3.7 全部可选启用

没有多 Agent 协调配置时：

```text
现有单 Agent 行为必须完全不变
```

---

# 四、目标分层

```text
┌──────────────────────────────────────────┐
│ 多 Agent 协调裁决层                       │
│                                          │
│ AssignmentCompiler                       │
│ RoleOutputValidator                      │
│ DisagreementClassifier                   │
│ DecisionPolicy                           │
│ NegotiationController                    │
│ HumanEscalation                          │
├──────────────────────────────────────────┤
│ Workflow Runtime                         │
│                                          │
│ 条件依赖 / DAG / Scheduler / Replay       │
│ AgentPool / Budget / Worktree / Conflict │
│ ResultStore / Evidence Gate              │
├──────────────────────────────────────────┤
│ Workflow-Harness Adapter                 │
│                                          │
│ function / tool / llm_agent              │
│ verification / human                     │
├──────────────────────────────────────────┤
│ Harness                                  │
│                                          │
│ Capability / Policy / Budget / Evidence  │
│ Cancellation / Interrupt / Artifact      │
├──────────────────────────────────────────┤
│ Kernel                                   │
│ 保持零改动                               │
└──────────────────────────────────────────┘
```

---

# 五、核心数据契约

## 5.1 条件依赖

当前：

```ts
dependsOn: string[]
```

目标：

```ts
interface WorkflowDependency {
  nodeId: string
  when:
    | "terminal"
    | "succeeded"
    | "failed"
    | "accepted"
    | "rejected"
    | "blocked"
}
```

兼容规则：

* `schemaVersion: "0.1"` 的字符串依赖继续解释为 `terminal`；
* 新协调图必须使用 `schemaVersion: "0.2"`；
* 新角色模板禁止使用隐式字符串依赖；
* Planner → Coder 必须使用 `accepted`；
* Coder → Verification 使用 `succeeded`；
* Verification → Merge 使用 `accepted`；
* 失败处理节点可以使用 `failed` 或 `blocked`。

---

## 5.2 执行状态与接受状态分离

```ts
type NodeExecutionStatus =
  | "pending"
  | "ready"
  | "running"
  | "succeeded"
  | "failed"
  | "blocked"
  | "cancelled"
  | "waiting"

type NodeAcceptanceStatus =
  | "not_required"
  | "pending"
  | "accepted"
  | "rejected"
  | "needs_repair"
  | "needs_replan"
  | "needs_human"
```

一个节点可能：

```text
执行成功
但产物未被接受
```

例如：

* Planner 成功生成计划，但计划缺少验证；
* Coder 成功写入代码，但证据不足；
* Reviewer 成功完成审查，但提出硬性否决。

---

## 5.3 节点执行收据

```ts
interface WorkflowNodeReceipt {
  nodeId: string
  nodeRunId: string
  attempt: number

  executionStatus: NodeExecutionStatus
  acceptanceStatus: NodeAcceptanceStatus

  outputArtifactIds: string[]
  evidenceIds: string[]
  diagnosticIds: string[]

  workspaceDigestBefore?: string
  workspaceDigestAfter?: string

  startedAt: number
  finishedAt?: number
}
```

禁止重试覆盖旧收据。

每次重试必须创建新的：

```text
nodeRunId
attempt
```

---

## 5.4 参与者任务分配

不直接在永久 AgentSpec 中增加固定角色。

```ts
interface ParticipantAssignment {
  assignmentId: string
  runId: string
  agentId: string

  role: "planner" | "coder" | "reviewer"

  scope: string[]
  ownerFiles: string[]
  worktreeRoot?: string

  authority: {
    canRead: boolean
    canWriteOwnedFiles: boolean
    canProposePlan: boolean
    canReview: boolean
    canApproveOwnOutput: false
  }

  budget: {
    maxNodes: number
    maxWrites: number
    maxModelCalls: number
    maxTokens: number
    maxWallTimeMs: number
  }
}
```

固定不变量：

```text
Worker 不能批准自己的产物。
Coder 不能担任自身修改的唯一 Reviewer。
```

---

## 5.5 类型化完成条件

```ts
type CriterionType =
  | "file_exists"
  | "file_not_exists"
  | "text_matches"
  | "text_not_matches"
  | "symbol_exists"
  | "command_passes"
  | "test_passes"
  | "typecheck_passes"
  | "build_passes"
  | "schema_valid"
  | "evidence_present"
  | "semantic_review"

interface CompletionCriterion {
  id: string
  description: string
  type: CriterionType

  criticality: "hard" | "soft"
  required: boolean

  target?: string
  assertion?: Record<string, unknown>

  verifier:
    | "deterministic"
    | "verification_node"
    | "reviewer"

  evidenceRequirement?: {
    minimumLevel: "L1" | "L2" | "L3"
    freshnessRequired: boolean
  }
}
```

`doneCriteria: string[]` 暂时保留用于显示和兼容。

真正的自动完成门逐步转向：

```text
CompletionCriterion[]
```

---

## 5.6 角色输出

### PlannerOutput

```ts
interface PlannerOutput {
  planVersion: string
  goal: string

  taskPackets: TaskPacket[]
  criteria: CompletionCriterion[]

  assumptions: string[]
  unresolvedQuestions: string[]
  requiredApprovals: string[]

  proposedAssignments: Array<{
    role: "coder" | "reviewer"
    scope: string[]
    ownerFiles: string[]
  }>
}
```

### CoderOutput

```ts
interface CoderOutput {
  assignmentId: string
  changedFiles: string[]

  patchTransactionIds: string[]
  evidenceIds: string[]

  criterionResults: Array<{
    criterionId: string
    status: "passed" | "failed" | "unknown"
    evidenceIds: string[]
  }>

  deviations: PlanAmendmentRequest[]
  unresolvedIssues: string[]
}
```

### ReviewerOutput

```ts
interface ReviewerOutput {
  reviewedPlanVersion: string
  reviewedWorkspaceDigest: string

  verdicts: Array<{
    criterionId: string
    verdict: "passed" | "failed" | "unknown"
    severity: "hard_veto" | "repairable" | "soft"
    evidenceIds: string[]
    rationale: string
  }>

  evidenceGaps: string[]
  conflicts: string[]

  recommendation:
    | "accept"
    | "repair"
    | "replan"
    | "human"
    | "policy_block"
}
```

---

## 5.7 计划偏离申请

```ts
interface PlanAmendmentRequest {
  requestId: string

  basePlanVersion: string
  proposedPlanVersion: string

  trigger:
    | "new_information"
    | "environment_mismatch"
    | "tool_unavailable"
    | "scope_conflict"
    | "verification_failure"
    | "user_change"
    | "other"

  changedScope: string[]
  changedCriteria: string[]
  addedPermissions: string[]
  addedCost: Record<string, number>

  supportingEvidenceIds: string[]
  requiresHumanApproval: boolean
}
```

禁止原地修改已批准计划。

正确流程：

```text
原计划 v1
→ 偏离申请
→ 校验
→ 新计划 v2
→ 批准或拒绝
```

---

# 六、实施路线

# 阶段 M0：基线冻结与实施文档

## 目标

在写代码前固定真实基线，避免 Codex根据旧文档重复建设。

## 工作内容

1. 新建：

```text
docs/multi-agent-coordination/execution-plan.md
docs/multi-agent-coordination/architecture-decisions.md
docs/multi-agent-coordination/acceptance-matrix.md
```

2. 记录：

* 基线提交；
* 现有接口；
* 当前缺口；
* 不变量；
* 阶段范围；
* 明确非目标；
* 每阶段验收门。

3. 将以下内容标为现状缺口：

* 条件依赖；
* H11 接线；
* Worktree 真正执行；
* 所有权写入门；
* 持久化人工等待；
* 冲突安全合并；
* 类型化完成条件。

## 验收

* 文档中的每个“已实现”都有源码和测试依据；
* 不允许把类存在等同于端到端能力存在；
* 当前 `v0.8.0` 行为没有任何改变。

---

# 阶段 M1：条件依赖与结果传播

**建议版本：** `v0.8.1`

## 目标

解决：

```text
Planner 失败后 Coder 仍然执行
```

这一 P0 问题。

## 主要改动

建议文件：

```text
src/workflow/types.ts
src/workflow/scheduler/dependency-policy.ts
src/workflow/scheduler/ready-queue.ts
src/workflow/scheduler/scheduler.ts
src/workflow/results/result-store.ts
```

## 任务

1. 引入 `WorkflowDependency`；
2. 引入执行状态与接受状态分离；
3. 就绪队列按依赖条件判断；
4. 未满足条件的节点进入 `blocked`，不能死锁；
5. 支持失败处理分支；
6. 保持 `schemaVersion: 0.1` 旧语义；
7. 新增 `schemaVersion: 0.2`；
8. 检查点恢复后重新计算依赖条件；
9. 依赖条件必须可序列化和重放。

## 测试

```text
planner failed → coder 不执行
planner succeeded 但未 accepted → coder 不执行
planner accepted → coder 执行
coder failed → repair 节点执行
coder succeeded → failure-handler 不执行
上游 cancelled → 下游按规则 blocked
旧 0.1 spec 行为不变
checkpoint 恢复后条件一致
```

## 验收门

```text
DEPENDENCY_SEMANTICS: PASS
LEGACY_SPEC_COMPATIBILITY: PASS
FAILED_UPSTREAM_LEAK: 0
```

---

# 阶段 M2：Workflow-Harness 正式适配

**建议版本：** `v0.8.2`

## 目标

所有真正的：

* 模型节点；
* 工具节点；
* 验证节点；
* 人工节点；

都通过 H11 Node Runtime 执行。

## 建议新增

```text
src/workflow/harness/workflow-node-adapter.ts
src/workflow/harness/node-context-factory.ts
src/workflow/harness/node-result-adapter.ts
src/workflow/execution/harness-node-executor.ts
```

## 任务

1. 根据 Workflow 节点构建 H11 HarnessNode；
2. 创建 `NodeExecutionContext`；
3. 绑定：

   * runId；
   * nodeRunId；
     -预算；
     -取消；
     -上下文；
   * ArtifactStore；
   * Trace；
   * CapabilityRegistry；
4. 将 H11 `NodeResult` 转换为 Workflow Node Receipt；
5. 保留 Evidence、Diagnostics、Usage；
6. 模型节点只能通过 `LlmAgentNode`；
7. 工具节点只能通过 `ToolNode`；
8. 人工节点只能通过 `HumanNode`；
9. 禁止 Workflow 注册新的旁路模型调用函数；
10. 旧纯函数 reducer 可以继续作为受限 deterministic handler。

## 测试

```text
llm_agent 节点经过 H11
tool 节点经过 CapabilityRegistry
verification 节点保留 evidence
human 节点产生 interrupt
取消信号可以传递到运行中节点
预算耗尽产生结构化结果
NodeUsage 完整传播
NodeDiagnostic 完整传播
```

## 停止条件

出现以下任一情况立即停止阶段：

* 需要修改 Kernel；
* 模型必须绕过 H11 才能运行；
* 工具必须绕过 CapabilityExecutor；
* Workflow 与 Harness 产生两套预算事实源。

## 验收门

```text
H11_ADAPTER: PASS
KERNEL_DIFF: 0
DIRECT_LLM_BYPASS: 0
DIRECT_TOOL_BYPASS: 0
```

---

# 阶段 M3：真实工作区隔离与所有权强制

**建议版本：** `v0.8.3`

## 目标

让 AgentPool 中的：

```text
ownerFiles
worktree
canWrite
```

从声明升级为真实执行约束。

## 建议新增

```text
src/workflow/agents/assignment.ts
src/workflow/agents/ownership-policy.ts
src/workflow/agents/workspace-context.ts
src/workflow/execution/workflow-execution-context.ts
```

## 任务

1. 创建 `ParticipantAssignment`；
2. Scheduler 根据节点 ID 或显式 assignmentId 获取任务分配；
3. 将 Agent Worktree 根目录写入 NodeExecutionContext；
4. 所有相对路径以 Worktree 为根解析；
5. 写入前调用所有权策略；
6. 所有权匹配必须使用规范化路径；
7. 阻止：

   * `../` 路径逃逸；
   * 符号链接逃逸；
   * 绝对路径绕过；
   * 大小写差异绕过；
8. 写入工具输出必须携带实际写入路径；
9. 实际写入路径与声明范围二次比对；
10. Coder 只能写自己的文件；
11. Planner、Reviewer 默认不能写项目工作区；
12. Worktree 创建失败时：

    * 写任务禁止降级为共享工作区；
    * 只读任务允许降级；
13. 生命周期结束时清理 Worktree；
14. 崩溃恢复时识别遗留 Worktree。

## 测试

```text
Agent A 写入 A 所有文件 → 通过
Agent A 写入 B 所有文件 → 拒绝
声明 a.ts 实际写 src/a.ts → 拒绝
../ 路径逃逸 → 拒绝
符号链接逃逸 → 拒绝
两个 Agent 真正在不同 Worktree 写入
主工作区在合并前不变化
取消后 Worktree 可清理
崩溃后能识别遗留目录
无 AgentPool 时旧行为不变
```

## 验收门

```text
UNOWNED_WRITE: 0
WORKTREE_ESCAPE: 0
SHARED_WORKSPACE_MULTI_WRITE: 0
SINGLE_AGENT_REGRESSION: 0
```

---

# 阶段 M4：持久化中断、人工等待与恢复

**建议版本：** `v0.8.4`

## 目标

让 Workflow 可以安全暂停，而不是阻塞进程等待。

## 建议新增

```text
src/workflow/interrupts/types.ts
src/workflow/interrupts/interrupt-store.ts
src/workflow/interrupts/resume-token.ts
src/workflow/interrupts/resume-controller.ts
```

## 数据结构

```ts
interface WorkflowInterruptRecord {
  interruptId: string
  runId: string
  specId: string
  specDigest: string
  nodeId: string
  nodeRunId: string

  kind:
    | "approval"
    | "user_input"
    | "conflict_resolution"
    | "plan_amendment"
    | "external_uncertainty"

  prompt: string
  responseSchema: unknown

  createdAt: number
  expiresAt?: number

  status: "waiting" | "resolved" | "cancelled" | "expired"
}
```

## 任务

1. Workflow Run 增加：

   * `waiting_approval`；
   * `waiting_user_input`；
2. 中断记录写入持久化存储；
3. Scheduler 停止相关子图；
4. 不相关且安全的只读子图是否继续，由策略明确决定；
5. 释放当前进程资源；
6. 返回恢复令牌；
7. 用户回复后：

   * 校验令牌；
   * 校验图版本；
   * 校验响应 Schema；
   * 校验中断仍有效；
8. 从中断节点继续；
9. 已完成节点不得重复执行；
10. 写入前重新检查工作区和证据新鲜度；
11. 过期中断不能恢复。

## 测试

```text
人工节点暂停图
进程退出后记录仍存在
重启后正确读取 waiting 状态
合法回复继续执行
错误 Schema 被拒绝
过期令牌被拒绝
图版本变化后旧令牌被拒绝
同一令牌不能重复使用
恢复后已完成节点不重跑
恢复前工作区改变触发重新验证
```

## 验收门

```text
PERSISTENT_INTERRUPT: PASS
DOUBLE_RESUME: 0
STALE_RESUME_ACCEPTED: 0
PROCESS_BOUND_WAITING: 0
```

---

# 阶段 M5：冲突安全合并

**建议版本：** `v0.8.5`

## 目标

替换生产路径中的 `later-wins` 合并。

## 建议新增

```text
src/workflow/agents/merge-bundle.ts
src/workflow/agents/integration-plan.ts
src/workflow/agents/conflict-policy.ts
src/workflow/agents/integration-verifier.ts
```

## 合并结构

```ts
interface AgentResultBundle {
  outputs: Record<string, unknown>
  patches: Record<string, string[]>
  evidence: Record<string, string[]>
  files: Record<string, string[]>
}

interface ConflictSet {
  fileConflicts: FileConflict[]
  symbolConflicts: SymbolConflict[]
  contractConflicts: ContractConflict[]
}
```

## 任务

1. 所有 Agent 结果按 Agent ID 独立保存；
2. 禁止字段覆盖；
3. 不相交文件可以自动进入 IntegrationPlan；
4. 同文件修改产生 ConflictSet；
5. 同文件相同补丁可以去重；
6. 同文件不同补丁不得自动覆盖；
7. 集成过程必须通过单写者事务；
8. 合并后运行整体验证；
9. 合并前的局部验证不能替代合并后验证；
10. 合并失败时回滚正式工作区；
11. 原 Agent Worktree 保留至裁决结束；
12. 冲突未解决时运行状态为 `blocked_conflict`。

## 测试

```text
不同文件自动组合
相同文件相同内容去重
相同文件不同内容进入冲突
不同字段输出均被保留
合并后整体测试失败 → 回滚
合并中断 → 正式工作区不出现半成品
冲突不能通过 Agent 顺序改变结果
```

## 验收门

```text
AUTOMATIC_CONFLICT_OVERWRITE: 0
POST_MERGE_VERIFICATION: REQUIRED
PARTIAL_INTEGRATION: 0
```

---

# 阶段 M6：类型化计划契约

**建议版本：** `v0.8.6`

## 目标

让 Planner 产出的计划可被程序检查，而不是只依赖自然语言。

## 建议新增

```text
src/workflow/contracts/criteria.ts
src/workflow/contracts/plan-contract.ts
src/workflow/reducers/criterion-evaluator.ts
src/workflow/reducers/plan-contract-validator.ts
```

## 任务

1. 引入 CompletionCriterion；
2. 为每个 Criterion 分配稳定 ID；
3. 区分 hard 与 soft；
4. 区分 deterministic 与 semantic；
5. Planner 输出必须通过 JSON Schema；
6. 所有写任务必须至少有一个验证 Criterion；
7. 关键权限和安全条件自动成为 hard Criterion；
8. 不能自动验证的条件必须明确标为 `semantic_review`；
9. 禁止将所有自然语言条件粗暴转成 grep；
10. 编译后生成确定性验证节点；
11. 计划版本与 Criterion ID 绑定；
12. 计划修改必须产生新版本。

## 测试

```text
缺少 Criterion ID → 拒绝
重复 ID → 拒绝
写任务无验证条件 → 拒绝
hard Criterion 未通过 → 不可完成
soft Criterion 未通过 → 可进入裁决
semantic Criterion 不可伪装成 deterministic
旧 doneCriteria 仍可显示
```

## 验收门

```text
PLAN_CONTRACT_SCHEMA: PASS
HARD_CRITERION_BYPASS: 0
FAKE_DETERMINISTIC_CHECK: 0
```

---

# 阶段 M7：角色与输出契约

**建议版本：** `v0.8.7`

## 目标

引入 Planner、Coder、Reviewer，但不引入新的执行机制。

## 建议新增

```text
src/workflow/coordination/assignments.ts
src/workflow/coordination/role-contracts.ts
src/workflow/coordination/role-output-validator.ts
```

## 权限基线

### Planner

允许：

* 读取项目；
* 读取知识；
* 产生计划 Artifact；
* 提议任务分配；
* 提议依赖与审批。

禁止：

* 修改项目代码；
* 批准自己的计划；
* 扩大权限。

### Coder

允许：

* 读取任务所需上下文；
* 写入自己的 Worktree；
* 修改拥有的文件；
* 运行批准的验证；
* 提交偏离申请。

禁止：

* 修改其他 Agent 文件；
* 修改正式主工作区；
* 批准自己的代码；
* 静默偏离计划。

### Reviewer

允许：

* 读取最终差异；
* 读取计划；
* 读取证据；
* 运行只读检查和验证；
* 产生审查 Artifact。

禁止：

* 修改代码；
* 直接合并；
* 绕过证据门；
* 单独扩大任务范围。

## 任务

1. 实现三个角色输出 Schema；
2. 所有模型输出先校验再使用；
3. 无效输出进入结构化失败；
4. 格式重试不得重复执行写操作；
5. 角色输出写入 ArtifactStore；
6. 角色输出必须绑定：

   * runId；
   * nodeRunId；
   * planVersion；
   * workspaceDigest；
7. Reviewer 不读取 Coder 隐藏推理；
8. Reviewer 只读取计划、最终差异、相关源码和证据；
9. Coder 不能成为自身唯一 Reviewer。

## 验收门

```text
ROLE_OUTPUT_SCHEMA: PASS
SELF_APPROVAL: 0
ROLE_AUTHORITY_LEAK: 0
```

---

# 阶段 M8：固定多 Agent 流水线

**建议版本：** `v0.8.8`

## 目标

上线第一条真正可用的静态多 Agent 协调模板。

## 模板名称

```text
multi_agent_reviewed_change
```

默认关闭，只能显式启用。

## 拓扑

```text
task-input
   ↓
planner
   ↓
plan-contract-validator
   ↓ accepted
assignment-compiler
   ↓
coder-a ─ verification-a
coder-b ─ verification-b
coder-c ─ verification-c
   ↓
integration-plan
   ↓
single-writer-merge
   ↓
global-verification
   ↓ accepted
reviewer
   ↓
deterministic-adjudicator
```

## 任务

1. 第一版只允许一个 Planner；
2. Coder 数量由静态配置决定；
3. 文件所有权必须在 Coder 启动前确定；
4. Reviewer 在整体合并和验证后执行；
5. Planner 失败时禁止启动 Coder；
6. 任一 Coder 越权写入立即阻止；
7. 一个 Coder 失败不能自动取消无关 Coder；
8. 合并前必须等待所有必要 Coder；
9. 可选任务必须显式标注；
10. Reviewer 的 hard veto 立即阻止；
11. 无证据不得进入 Reviewer 最终接受路径；
12. 最终完成仍进入原 CompletionOrchestrator。

## 第一版使用条件

仅用于：

* 修改范围可以预先分区；
* 文件所有权能够明确；
* 存在清晰验证命令；
* 项目处于 Git 或可靠快照环境；
* 用户显式启用。

不用于：

* 多 Agent 同时重构同一核心文件；
* 范围高度不确定；
* 无法定义完成条件；
* 外部副作用不可回滚；
* 安全敏感操作；
* 大规模动态架构迁移。

## 验收门

```text
STATIC_MULTI_AGENT_PIPELINE: PASS
PLANNER_FAILURE_CODER_START: 0
UNVERIFIED_MERGE_ACCEPTED: 0
SINGLE_AGENT_DEFAULT_CHANGED: 0
```

---

# 阶段 M9：确定性裁决控制器

**建议版本：** `v0.8.9`

## 目标

不建立拥有最终权威的 Meta Agent。

建立：

```text
CoordinationDecisionController
```

## 输入

* Plan Contract；
* Coder 结果；
* Criterion 结果；
* Evidence；
* ConflictSet；
* ReviewerOutput；
* Budget；
* Permission Decisions；
* Workspace Digest。

## 输出

```ts
type CoordinationDecision =
  | "accepted"
  | "repair_required"
  | "replan_required"
  | "human_required"
  | "policy_blocked"
```

## 硬裁决规则

以下任一情况不得通过：

* hard Criterion 失败；
* 权限违规；
* 文件所有权违规；
* 工作区逃逸；
* 缺少必要证据；
* 证据失效；
* 未解决同文件冲突；
* Reviewer hard veto；
* 不确定外部副作用；
* 用户明确禁止事项；
* 预算或安全策略拒绝。

## 软裁决规则

以下内容可综合评估：

* 代码风格；
* 非关键性能；
* 文档完整度；
* 次要可维护性；
* 两个均可接受方案的偏好。

禁止使用一个统一的 `0.7` 平均值覆盖 hard 条件。

## 验收门

```text
DETERMINISTIC_ADJUDICATION: PASS
HARD_VETO_BYPASS: 0
EVIDENCE_BYPASS: 0
```

---

# 阶段 M10：生产级验收与 v0.9.0 冻结

**目标版本：** `v0.9.0`

## 目标

证明静态多 Agent 协调真实可用，而不是只存在类和测试桩。

## 必测场景

至少覆盖：

1. Planner 正常规划；
2. Planner 失败；
3. Planner 输出非法；
4. Planner 计划未接受；
5. 两个 Coder 修改不同文件；
6. Coder 越权写入；
7. Coder 被取消；
8. Coder 预算耗尽；
9. 一个 Coder 失败、另一个继续；
10. 两个 Coder 修改同一文件；
11. Worktree 创建失败；
12. 合并前主工作区不变化；
13. 合并后整体验证通过；
14. 合并后整体验证失败并回滚；
15. Reviewer 正常接受；
16. Reviewer 提出可修复缺陷；
17. Reviewer 提出 hard veto；
18. 证据过期；
19. 人工暂停后重启恢复；
20. 恢复令牌重复使用；
21. 动态图试图扩大权限；
22. 无 AgentPool 的旧 Graph；
23. 原单 Agent 路径；
24. Replay 恢复；
25. Checkpoint 恢复；
26. 多次运行结果确定性；
27. 同一输入不同 Agent 顺序不改变冲突裁决；
28. Worker 无法自我批准；
29. 模型置信度高但证据不足；
30. 用户拒绝后图不会继续。

## 生产指标

```text
越权写入成功数                    = 0
Planner 失败后 Coder 启动数        = 0
冲突自动覆盖数                    = 0
无证据完成数                      = 0
Hard veto 绕过数                  = 0
旧单 Agent 行为差异               = 0
重启恢复重复执行写节点数           = 0
过期恢复令牌接受数                 = 0
主工作区半提交数                  = 0
Kernel 修改行数                   = 0
```

## 冻结条件

只有以下门禁全部通过才发布 `v0.9.0`：

```text
typecheck
完整测试
build
npm pack --dry-run
git diff --check
Harness replay eval
Graph runtime eval
Multi-agent coordination eval
安全回归
人工暂停恢复测试
```

---

# 七、v0.9.0 之后的高级阶段

以下内容不得阻塞静态多 Agent v1。

# 阶段 M11：协商协议

**建议版本：** `v0.9.1`

只处理：

```text
soft_disagreement
```

不处理：

* 安全否决；
* 权限违规；
* 数据破坏；
* 证据不足；
* 不确定副作用。

## 数据结构

```ts
interface NegotiationRound {
  round: number
  disagreementSignature: string

  disagreementSet: Disagreement[]
  proposals: Proposal[]
  counterProposals: Proposal[]

  effectiveChanges: string[]
  remainingDisagreements: string[]

  decision:
    | "converged"
    | "continue"
    | "human"
    | "blocked"
}
```

复用 RepairLoop 的：

* 最大轮次；
* 预算；
* 重复签名；
* 无有效变化停止；
* 结构化报告。

但不能直接把失败签名当成分歧签名。

默认：

```text
最多 3 轮
连续无有效变化 → 停止
仍未收敛 → 人工
```

---

# 阶段 M12：置信度信号与校准

**建议版本：** `v0.9.2`

第一版禁止直接实现统一置信度公式。

先收集：

```text
selfConfidence
evidenceCoverage
contextCompleteness
novelty
historicalAccuracy
conflictCount
operationRisk
```

置信度只影响：

* 是否增加 Reviewer；
* 是否增加验证；
* 是否缩小写权限；
* 是否调用更强模型；
* 是否请求人工。

置信度不能影响：

* Evidence 是否通过；
* hard Criterion 是否通过；
* 权限是否允许；
* 任务是否完成。

只有积累足够真实结果后，才能校准组合公式。

---

# 阶段 M13：动态角色和图生成

**候选目标版本：** `v0.10.0`

前提：

* 静态模板具有充分生产数据；
* 条件依赖稳定；
* H11 接线稳定；
* Worktree 与所有权稳定；
* 人工暂停恢复稳定；
* 确定性裁决稳定；
* 多 Agent 确实优于单 Agent。

动态系统只能：

* 从允许的角色模板中选择；
* 收紧权限；
* 减少范围；
* 调整只读调查；
* 提议新图版本。

动态系统不能：

* 自定义新权限；
* 自定义新工具入口；
* 修改 Kernel；
* 绕过 PermissionGate；
* 自行批准写图；
* 自行扩大 Agent 数量和预算上限。

---

# 八、建议版本路线

| 阶段  |   建议版本 | 交付                       |
| --- | -----: | ------------------------ |
| M0  |   文档阶段 | 基线冻结                     |
| M1  |  0.8.1 | 条件依赖                     |
| M2  |  0.8.2 | Workflow-Harness Adapter |
| M3  |  0.8.3 | Worktree 与所有权强制          |
| M4  |  0.8.4 | 持久化中断恢复                  |
| M5  |  0.8.5 | 冲突安全合并                   |
| M6  |  0.8.6 | 类型化计划契约                  |
| M7  |  0.8.7 | 角色与输出契约                  |
| M8  |  0.8.8 | 固定多 Agent 模板             |
| M9  |  0.8.9 | 确定性裁决                    |
| M10 |  0.9.0 | 静态协调正式冻结                 |
| M11 |  0.9.1 | 协商协议                     |
| M12 |  0.9.2 | 置信度信号                    |
| M13 | 0.10.0 | 动态角色分配                   |

版本号只是推荐，实际发布可以根据仓库发布纪律调整。

---

# 九、每阶段统一执行纪律

每一阶段必须独立完成：

```text
读取真实源码
→ 建立改动范围
→ 写失败测试
→ 实现最小能力
→ 运行定向测试
→ 运行完整测试
→ 验证向后兼容
→ 更新实施记录
→ 独立提交
→ 发布
```

禁止：

* 一次完成多个阶段；
* 将未接线的接口算作完成；
* 只写类型不写真实执行路径；
* 只写单元测试不写端到端测试；
* 通过 mock 证明真实隔离；
* 修改 Kernel 解决 Workflow 问题；
* 为了通过测试降低 Evidence Gate；
* 静默修改现有单 Agent行为。

---

# 十、五门禁之外的专项门禁

除现有：

```text
typecheck
test
build
pack
diff-check
```

外，增加：

## 协调门禁

```text
multi-agent:dependency
multi-agent:ownership
multi-agent:worktree
multi-agent:interrupt
multi-agent:merge
multi-agent:adjudication
multi-agent:legacy
```

## 安全门禁

```text
path-escape
symlink-escape
self-approval
hard-veto
evidence-bypass
stale-resume
double-resume
conflict-overwrite
```

## 回放门禁

同一固定输入和固定工具结果下：

* 调度结果一致；
* 冲突结果一致；
* 裁决结果一致；
* 已完成节点不重复执行；
* Agent 注册顺序不能改变 hard 结论。

---

# 十一、禁止纳入 v0.9.0 的范围

以下内容延期：

* 模型动态创建任意角色；
* Agent 自主招募其他 Agent；
* 多数投票式共识；
* 多 Agent 共享写同一 Worktree；
* 分布式远程 Agent；
* Agent 市场；
* 长期后台自治；
* 自主修改系统治理规则；
* 自动升级自身权限；
* 知识库自动覆盖权威决策；
* 统一置信度总分；
* 对所有任务默认启用多 Agent；
* 复杂开放式协商；
* 多 Agent 直接修改 Kernel。

---

# 十二、全局停止条件

实施中出现以下任一情况，应停止继续扩展：

## 1. 无法证明真实隔离

如果 Worktree 和路径权限不能端到端验证：

```text
禁止开放并行写
```

## 2. 需要绕过 Harness

如果多 Agent 必须直接调用模型或工具：

```text
架构方案失败，返回重新设计
```

## 3. 静态模板没有收益

生产评测显示：

* 成功率未提高；
* Token 显著增加；
* 延迟显著增加；
* 冲突率过高；
* 人工介入率升高；
* 单 Agent 已足够处理；

则保持多 Agent 为实验功能，不进入默认路径。

## 4. 协调控制器成为第二权威源

如果 Workflow、Harness 和协调层对：

* 权限；
  -预算；
  -完成；
  -证据；
  -取消；

产生不同结论，必须停止并收敛单一权威。

## 5. 复杂度超过可验证能力

任何阶段新增机制后，若无法建立：

* 明确状态；
* 明确所有权；
* 明确失败语义；
* 明确恢复测试；
* 明确验收指标；

不得进入下一阶段。

---

# 十三、最终交付物

完成 `v0.9.0` 时，仓库至少应包含：

```text
docs/multi-agent-coordination/
├── execution-plan.md
├── architecture-decisions.md
├── state-machine.md
├── role-contracts.md
├── permission-matrix.md
├── interrupt-and-resume.md
├── merge-and-conflict.md
├── test-matrix.md
├── evaluation-report.md
└── implementation-record.md
```

源码至少形成：

```text
src/workflow/
├── coordination/
├── contracts/
├── harness/
├── interrupts/
├── agents/
├── scheduler/
├── reducers/
└── templates/
```

测试至少形成：

```text
tests/workflow/coordination/
├── dependency-conditions.test.ts
├── harness-adapter.test.ts
├── ownership-enforcement.test.ts
├── worktree-isolation.test.ts
├── persistent-interrupt.test.ts
├── resume-safety.test.ts
├── conflict-safe-merge.test.ts
├── plan-contract.test.ts
├── role-contracts.test.ts
├── static-pipeline.test.ts
├── adjudication.test.ts
├── backward-compatibility.test.ts
└── production-scenarios.test.ts
```

---

# 十四、正式执行顺序

```text
M0 基线冻结
↓
M1 条件依赖
↓
M2 Workflow-Harness 接线
↓
M3 Worktree 与所有权强制
↓
M4 持久化人工中断
↓
M5 冲突安全合并
↓
M6 类型化计划契约
↓
M7 角色与输出契约
↓
M8 固定多 Agent 流水线
↓
M9 确定性裁决
↓
M10 生产级验收
↓
冻结 v0.9.0
```

M11–M13 必须等待 `v0.9.0` 的真实运行数据。

---

# 十五、最终验收定义

只有同时满足以下条件，才能宣布“多 Agent 协调层完成”：

```text
1. Planner 失败时 Coder 绝不会启动；
2. Coder 只能写自己的隔离工作区和拥有文件；
3. Planner 与 Reviewer 不能直接修改代码；
4. 所有模型与工具执行都经过 H11/Harness；
5. 所有计划偏离都有新版本和审批记录；
6. 同文件冲突不会被自动覆盖；
7. 合并后必须重新进行整体验证；
8. Reviewer 的 hard veto 不能被评分或多数票覆盖；
9. 人工等待可以跨进程暂停与恢复；
10. 恢复不会重复真实写入；
11. 完成仍然只由有效 Evidence 和硬条件决定；
12. 不启用多 Agent 时，现有行为完全不变；
13. Kernel 保持零改动；
14. 生产评测证明多 Agent 在目标任务上具有可测收益。
```

在此之前，只能称为：

```text
多 Agent 机械原语
或
实验性协调能力
```

不能称为已经完成的受治理多 Agent 系统。
