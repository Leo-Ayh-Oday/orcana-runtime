# 3-Agent 架构契约 (Agent Contract)

> 版本 0.2.0
> 本文档定义 orcana 中 Planner、Coder、Inspector 三个独立 Agent 及 Meta-Agent 的接口契约。
> **所有 Agent 输出必须是结构化 JSON。Review 必须对照 Plan Checklist 逐条打勾，禁止自由发挥。**

## 1. 架构总览

```
                          ┌──────────────────────┐
                          │     meta-agent.ts     │
                          │  (主持协商 + 仲裁裁定)  │
                          └────┬────┬────┬────────┘
                               │    │    │
                    ┌──────────┼────┼────┼──────────┐
                    │          │    │    │          │
                    ▼          ▼    │    ▼          ▼
              ┌────────┐  ┌────────┐  ┌───────────┐
              │planner │  │ coder  │  │ inspector  │
              │.ts     │  │.ts     │  │.ts         │
              └────────┘  └────────┘  └───────────┘
                   │           │            │
                   └───────────┼────────────┘
                               │
                    ┌──────────▼──────────┐
                    │  共享工具层 (不变)     │
                    │  file | shell | git  │
                    │  search | codegraph  │
                    └─────────────────────┘
```

## 2. Agent 角色定义

### 2.1 Planner — 分析师

**职责**：只读分析，输出结构化 Plan。**不写代码，不执行修改。**

**输入**：用户需求 + 项目上下文 (kernel)
**输出**：`PlanDocument` (JSON)

```typescript
interface PlanDocument {
  id: string                    // UUID
  goal: string                  // 一句话目标
  confidence: number            // 0-100，上限80%
  created_at: string            // ISO timestamp
  context_hash: string          // 上下文指纹

  steps: PlanStep[]
}

interface PlanStep {
  id: string                    // "step-1", "step-2", ...
  order: number
  action: string                // 人类可读描述
  target_files: string[]        // 涉及的文件路径
  tool_hint: string             // "write_file" | "edit_fim" | "shell" | ...

  checklist: ChecklistItem[]    // 审查者逐条打勾的清单
}

interface ChecklistItem {
  id: string                    // "CL-1a"
  check: string                 // 可验证的检查项
  category: "syntax" | "type"   | "contract" | "side-effect"
  verify_method: string         // "tsc --noEmit" | "grep <pattern>" | "bun test"
}
```

**约束**：
- 每个 step 的 checklist 不少于 2 条，不超过 6 条
- `confidence` 必须 ≤ 80，超过自动截断
- 必须附带 `context_hash`，确保审查时可复现

### 2.2 Coder — 执行者

**职责**：基于 Plan 逐 step 执行修改，自验证。**不偏离 Plan，不做自由发挥。**

**输入**：`PlanDocument`
**输出**：`CoderReport`

```typescript
interface CoderReport {
  plan_id: string               // 对应 PlanDocument.id
  steps: ExecutedStep[]
  overall_confidence: number    // ≤80
  errors: ExecError[]
}

interface ExecutedStep {
  step_id: string
  status: "done" | "skipped" | "failed"
  files_changed: string[]
  self_check: {                 // 执行后自检
    checklist_id: string
    passed: boolean
    evidence: string            // 验证证据(如 tsc 输出行)
  }[]
  diff_summary: string          // 变更摘要
  confidence: number            // ≤80
}

interface ExecError {
  step_id: string
  message: string
  attempted_fix: string         // 尝试了什么修复
  recommendation: "retry" | "skip" | "escalate"
}
```

**约束**：
- 严格按 `step.order` 顺序执行
- 每个 step 执行完立即自检 checklist
- 不通过 → 最多修复 2 次，再失败 → escalate 给 Meta-Agent
- **禁止修改不在 `target_files` 中的文件**

### 2.3 Inspector — 审查者

**职责**：对照 Plan checklist 逐条打勾。**不做自由发挥式的评审。**

**输入**：`PlanDocument` + `CoderReport` + 实际代码状态
**输出**：`InspectionReport`

```typescript
interface InspectionReport {
  plan_id: string
  created_at: string

  checklist_results: ChecklistResult[]   // 一一对应 plan steps
  summary: InspectionVerdict
  confidence: number                     // ≤80
}

interface ChecklistResult {
  step_id: string
  checklist_id: string
  passed: boolean
  actual: string              // 实际观察到的证据
  evidence_line?: string      // grep/tsc 输出行
}

interface InspectionVerdict {
  decision: "pass" | "partial_pass" | "fail"
  pass_count: number
  fail_count: number
  failed_items: string[]      // 失败的 checklist_id 列表
  recommendation: string      // 简短的建议(≤200字)
}
```

**约束**：
- **必须**逐条对照 checklist，不可跳过
- 验证方法必须使用 checklist 中定义的 `verify_method`
- 不可添加 checklist 之外的评审项（除非是致命缺陷）
- 致命缺陷（如改错了关键 API）可加 `fatal_findings` 字段

## 3. Meta-Agent 仲裁协议

### 3.1 职责

Meta-Agent 本身不写代码、不读代码。它的工作是：

1. 接收 Planner 的 `PlanDocument`
2. 广播给 Coder + Inspector
3. 收集双方的 `CoderReport` + `InspectionReport`
4. 执行仲裁决策

### 3.2 仲裁决策树

```
                    ┌─ Planner confidence ─┐
                    │                      │
               ≥70% │                      │ <70%
                    ▼                      ▼
            高置信路径              低置信路径
                    │                      │
       ┌───────────┼───────────┐    ┌──────┴──────┐
       │           │           │    │  元Agent介入  │
       ▼           ▼           ▼    │  要求Planner  │
    pass       partial      fail    │  补充分析     │
       │       _pass          │     └──────────────┘
       │         │            │
       ▼         ▼            ▼
    批准合并   有条件批准    🔴 中止
    ✅        ⚠️(标注)     🚫 回退
```

### 3.3 置信度汇总公式

```
overall_confidence = min(
  plan.confidence,
  coder.overall_confidence,
  inspector.confidence,
  80  // 硬上限
)
```

**分歧度计算**：

```
disagreement_score = |plan.confidence - inspector.confidence| + failed_checklist_count * 10

if disagreement_score > 30  →  触发元Agent协商轮
if disagreement_score > 60  →  中止，要求 Planner 重新计划
```

### 3.4 Meta-Agent 输出

```typescript
interface ArbitrationResult {
  decision: "approve" | "conditional_approve" | "reject"
  overall_confidence: number
  disagreement_score: number
  needs_negotiation: boolean
  escalated_steps: string[]
  final_message: string       // 给用户的一句话总结
}
```

## 4. 通信协议

所有 Agent 间通信通过 TypedEventBus (`src/agent/bus.ts`) 进行，使用强类型事件：

```typescript
type AgentEvent =
  | { type: "plan.created";   payload: PlanDocument }
  | { type: "plan.broadcast";  payload: PlanDocument }
  | { type: "coder.done";      payload: CoderReport }
  | { type: "inspector.done";  payload: InspectionReport }
  | { type: "arbitration";     payload: ArbitrationResult }
  | { type: "negotiation";     payload: { step_id: string; question: string } }
  | { type: "escalate";        payload: { step_id: string; error: string } }
```

## 5. 不变约束

以下规则对所有 Agent 通用：

1. **只读优先** — 不确定时用 `read_file`，不要猜测
2. **文件不存在就说找不到** — 禁止编造
3. **Windows 适配** — shell 用 `dir/type/findstr`
4. **编辑前必须 read_file** — Coder 执行写操作前的第一步永远是读
5. **修改后必跑 typecheck + test** — Coder 自检和 Inspector 审查都必须验证
6. **置信度上限 80%** — 所有 Agent 的 confidence 字段不得超过 80
