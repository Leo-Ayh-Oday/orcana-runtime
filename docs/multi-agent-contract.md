# 多Agent协作契约 v1.0

> 状态：Draft  
> 签署方：Planner / Coder / Reviewer / Meta-Agent  
> 生效：本契约一经签署，所有Agent行为必须遵守此协议。

---

## §1 实体定义

### 1.1 Agent接口

```typescript
interface AgentIdentity {
  role: "planner" | "coder" | "reviewer"
  version: string
  model: string          // 底层LLM模型名
}

interface AgentOutput<T> {
  role: AgentIdentity["role"]
  timestamp: number
  payload: T
  confidence: Confidence   // 详见 §3
  self_assessment: SelfAssessment
}
```

### 1.2 消息类型

```typescript
// 元Agent → 所有Agent
interface TaskDispatch {
  type: "task_dispatch"
  task_id: string
  goal: string            // 自然语言任务描述
  context_snapshot: string // 项目快照（kernel + recent files）
  constraints: string[]   // 硬约束：不删文件、不改public API等
}

// Planner → 元Agent
interface PlanPayload {
  type: "plan"
  steps: PlanStep[]
  rationale: string       // 为什么选择这个方案
  alternatives: string[]  // 考虑过但放弃的方案（2-3条）
  estimated_complexity: 1 | 2 | 3 | 4 | 5
}

interface PlanStep {
  id: string              // "step-1", "step-2" ...
  action: string          // 自然语言：要做什么
  target: string          // 目标文件（单文件）
  checklists: ChecklistItem[]
  dependencies: string[]  // 依赖的 step id
}

interface ChecklistItem {
  id: string
  assertion: string       // 可验证的断言，如："foo() 的返回值类型是 Promise<Bar>"
  category: "type_safety" | "behavior" | "side_effect" | "consistency"
  grep_pattern?: string   // 可选：grep验证时的搜索模式
}

// Coder → 元Agent
interface CodePayload {
  type: "code"
  steps_completed: string[]  // 对应 PlanStep.id
  diff_summary: string       // 修改摘要
  self_passed: string[]      // 自检通过的 ChecklistItem.id
  self_failed?: string[]     // 自检失败的 ChecklistItem.id
  test_result?: {
    passed: boolean
    output: string
  }
}

// Reviewer → 元Agent
interface ReviewPayload {
  type: "review"
  checklist_results: ChecklistVerdict[]
  consistency_issues: ConsistencyIssue[]
  ripple_findings: RippleFinding[]   // 来自 Ripple Engine
  overall_assessment: "approved" | "approved_with_warnings" | "rejected"
}

interface ChecklistVerdict {
  item_id: string        // 对应 ChecklistItem.id
  passed: boolean
  evidence: string       // 证据："第42行出现了 Promise<Bar> 签名"
  confidence: number     // 对该项判断的局部置信度
}
```

---

## §2 Plan-as-Contract（计划即契约）

### 2.1 核心原则

**Plan不是建议，是契约。** 一旦元Agent裁定执行某个Plan，Coder必须严格按照Plan中的步骤和Checklist执行，不得自行添加或跳过步骤。

### 2.2 允许的偏离

Coder在以下情况下**允许**向元Agent申请偏离：

1. **技术不可能**：目标文件不存在或API不可用
2. **发现未声明的依赖**：需要先修改其他文件
3. **更优实现路径**：在不改变功能的前提下，有更简洁的实现

偏离流程：
```
Coder → 元Agent: DeviateRequest { step_id, reason, alternative }
元Agent → Reviewer: 征求快速意见（单轮）
元Agent → Coder: Approved / Denied / Modified
```

### 2.3 Checklist要求

每个ChecklistItem必须满足：

| 属性 | 要求 |
|------|------|
| **可验证性** | 能在代码中通过 grep / tsc / runtime test 确认 |
| **原子性** | 一条 Check 只验证一件事 |
| **正向** | 断言"存在什么"而非"不存在什么" |
| **具体** | 不说"代码没问题"，说"第N行函数签名匹配接口定义" |

---

## §3 置信度评分引擎

### 3.1 计算公式

```
Confidence = BASE × (1 - UNCERTAINTY_INDEX) × HISTORY_FACTOR
```

其中：
- `BASE = 0.8`（硬上限）
- `UNCERTAINTY_INDEX = U_domain + U_code + U_novelty`（归一化到 0~1）
- `HISTORY_FACTOR` = 该Agent历史准确率（初始值为1.0）

### 3.2 不确定性因子

| 因子 | 含义 | 计算方法 |
|------|------|----------|
| `U_domain` | 领域不确定性 | 任务涉及Agent不熟悉的库 → +0.2；涉及已知API → 0 |
| `U_code` | 编码不确定性 | 涉及>3文件 → +0.15；涉及FIM编辑 → +0.1 |
| `U_novelty` | 新颖性 | 项目中出现过的模式 → 0；全新模式 → +0.25 |

```
UNCERTAINTY_INDEX = min(U_domain + U_code + U_novelty, 0.6)

// 所以最低置信度 = 0.8 × (1 - 0.6) = 0.32
// 最高置信度 = 0.8 × (1 - 0)    = 0.80
```

### 3.3 自我评估声明

每个Agent产出时附带：

```typescript
interface SelfAssessment {
  confidence: number          // 0.32 ~ 0.80
  uncertainty_breakdown: {    // 公开不确定性的来源
    domain: number
    code_complexity: number
    novelty: number
  }
  weakest_point: string       // "最不确定的部分是XXX"
  would_defer: boolean        // 是否建议元Agent向其他Agent征求意见
}
```

---

## §4 元Agent决策树

### 4.1 裁决流程

```
┌─ 接收三方Output ─┐
│  Planner: Plan+CF │
│  Coder:   Code+CF │
│  Reviewer:Rev+CF  │
└────────┬──────────┘
         ▼
   ┌─ 一致性评分 ──┐
   │ A = align(P,C) │  Planner vs Coder 一致性
   │ B = align(C,R) │  Coder vs Reviewer 一致性
   │ C = align(P,R) │  Planner vs Reviewer 一致性
   └───────┬────────┘
           ▼
    ┌──────┴──────────────────────┐
    │                             │
    ▼                             ▼
  A+B+C ≥ 0.7               A+B+C < 0.7
  && Reviewer=approved       || Reviewer=rejected
    │                             │
    ▼                             ▼
 ┌──────┐                  ┌──────────┐
 │通过✅ │                  │ 启动协商  │
 └──────┘                  └─────┬────┘
                                 │
                          ┌──────▼──────┐
                          │ 定位分歧点   │
                          │ 最多3轮协商  │
                          └──────┬──────┘
                                 │
                          ┌──────▼──────┐
                          │ 第3轮后     │
                          │ 元Agent强制 │
                          │ 裁定最终方案 │
                          └─────────────┘
```

### 4.2 一致性评分算法

```typescript
function alignmentScore(plan: PlanPayload, code: CodePayload): number {
  let score = 0
  const totalSteps = plan.steps.length
  
  // 每个步骤的完成度
  for (const step of plan.steps) {
    if (code.steps_completed.includes(step.id)) score += 1
    // 自检通过的checklist
    const totalItems = step.checklists.length
    const passedItems = step.checklists.filter(c => 
      code.self_passed.includes(c.id)
    ).length
    score += passedItems / totalItems
  }
  
  return score / (totalSteps * 2)   // 归一化 0~1
}
```

### 4.3 协商协议

```
元Agent发出: NegotiateRequest {
  issue: "Plan的step-2要求修改foo.ts:42，但Coder认为需要同时修改bar.ts"
  candidates: [
    { source: "Planner", proposal: "只改foo.ts", confidence: 0.72 },
    { source: "Coder",    proposal: "foo.ts + bar.ts", confidence: 0.65 }
  ]
}

分歧方回应: NegotiateResponse {
  accept_other: boolean        // 是否接受对方的方案
  counter_proposal?: string    // 新方案
  new_confidence?: number      // 更新后的置信度
}
```

### 4.4 升级到人工

以下条件触发用户介入：

- 3轮协商后一致性评分仍 < 0.4
- 任何Agent的置信度 < 0.32（低于下限）
- 任务涉及安全关键操作（删除文件、修改auth逻辑）

---

## §5 运行时协议

### 5.1 握手

```
元Agent: PING { timestamp }
Agent:   PONG { role, version, ready: boolean, max_context_window: number }
```

### 5.2 超时

- Planner: 60s
- Coder: 120s
- Reviewer: 60s
- 协商回合: 30s each
- 超时视为"弃权"，元Agent忽略弃权方继续裁决

### 5.3 错误处理

| 错误 | 处理 |
|------|------|
| Agent超时 | 弃权，置信度=0，不计入一致性评分 |
| Agent输出格式错误 | 元Agent要求重试（最多1次） |
| Coder执行失败(test不通过) | 自修复（agent/loop.ts现有逻辑），最多3次 |
| 所有Agent置信度<0.4 | 升级到人工 |

---

## §6 签名

```
本契约为 orcana v0.2.0 的多Agent子系统设计规范。
实现时应严格遵循此契约中的接口定义、决策树和置信度算法。

签署日期：2026-06-09
架构师：DeepSeek Code + User
下一里程碑：实现 agent/contract.ts + agent/confidence.ts
```
