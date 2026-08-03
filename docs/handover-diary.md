# 交接日记 — 多Agent架构设计

> 日期：2026-06-09  
> 作者：DeepSeek Code + User  
> 状态：设计阶段，待实现

---

## 1. 问题背景

当前项目（orcana）为单Agent循环架构（`agentLoop` + ReAct），但长期来看需要多Agent协作以解决：

- **幻觉累加**：链式执行中，Plan → Code → Review 层层污染
- **决策盲区**：单Agent对复杂任务无"第二意见"
- **质量不可审计**：缺乏结构化验证点

## 2. 架构决策记录 (ADR)

### ADR-1: 选择3-Agent而非N-Agent

**背景**：Multi-Agent 方案从 2 到 10+ 都有先例（MetaGPT 5角色, ChatDev 7+角色）。

**决策**：**恰好3个独立Agent，加1个元Agent裁判。共4个。**

**理由**：

| 维度 | 2-Agent | **3-Agent** ✅ | 5+ Agent |
|------|:-------:|:------------:|:--------:|
| 幻觉隔离 | ⭐⭐ | ⭐⭐⭐ | ⭐⭐（角色过拟合） |
| 协商效率 | ⭐⭐⭐ | ⭐⭐⭐ | ⭐ |
| 可审计性 | ⭐⭐ | ⭐⭐⭐ | ⭐ |
| Token开销 | ⭐⭐⭐ | ⭐⭐ | ⭐ |

三个Agent覆盖核心生命周期：**计划 → 执行 → 审查**。更多角色引入"角色过拟合"——Agent为证明存在价值而强行挑刺。

### ADR-2: 并行独立运行，非链式传递

**决策**：Plan、Code、Review **不传递链式输出**，各自独立产出 → 向元Agent汇报。

**理由**：
- 链式传递 → 前一个Agent的错误成为后一个的输入 → 幻觉累加
- 并行独立 → 三个视角各自产生"第一手判断" → 可交叉比对

**代价**：上下文重复注入（三分共享同一份项目快照），token开销约1.5~2x。

### ADR-3: 置信度上限80%

**决策**：任何Agent对自身产出的置信度评分上限为80%。

**理由**：
- 强制保留20%协商空间
- 避免"我100%确定所以你们闭嘴"的傲慢Agent
- 模仿优秀工程师的"合理谦虚"

**算法**：见 `multi-agent-contract.md` §3。

### ADR-4: 元Agent只裁决，不编码

**决策**：元Agent不参与任何代码生成，只做：

1. 接收三方产出 + 置信度
2. 交叉比对，识别分歧点
3. 对分歧点引导针对性协商
4. 最终裁定执行方案

**理由**：元Agent一旦参与编码就失去中立性，变成"第四方发言者"而非"裁判"。

### ADR-5: Review必须对照Plan的Checklist

**决策**：Reviewer的审查不是自由发挥，而是对照Plan中每个Step的Checklist逐条打勾。

**理由**：
- Plan-as-Contract：计划不是建议，是契约
- 可验证性：每一条Check必须是**代码中可grep到的具体断言**
- 防止Reviewer"凭空发明问题"或"漏掉边界条件"

---

## 3. 架构总览

```
                      ┌──────────────┐
                      │   元Agent     │
                      │  (裁判+主持)   │
                      └──────┬───────┘
                             │
          ┌──────────────────┼──────────────────┐
          │                  │                  │
          ▼                  ▼                  ▼
    ┌──────────┐      ┌──────────┐      ┌──────────┐
    │ Planner  │      │  Coder   │      │ Reviewer │
    │  计划者   │      │  执行者   │      │  审查者   │
    └──────────┘      └──────────┘      └──────────┘
    产出: Plan+CF     产出: Code+CF    产出: Checklist+CF
         │                  │                  │
         └──────────────────┼──────────────────┘
                            │
                    全部上报给元Agent
```

**CF = Confidence Factor（置信度因子，0~0.8）**

---

## 4. 通信协议（概要）

| 阶段 | 发起方 | 接收方 | 消息类型 |
|------|--------|--------|----------|
| 1. 任务分发 | 元Agent | P+C+R | `TaskDispatch { goal, context }` |
| 2. 计划产出 | Planner | 元Agent | `Plan { steps[], confidence }` |
| 3. 编码产出 | Coder | 元Agent | `Code { diffs[], confidence }` |
| 4. 审查产出 | Reviewer | 元Agent | `Review { checklist_results[], confidence }` |
| 5. 交叉比对 | 元Agent | (内部) | 一致性评分 |
| 6a. 通过 | 元Agent | 所有 | `Verdict: Approved` |
| 6b. 协商 | 元Agent | 分歧方 | `Negotiate { issue, candidates }` |
| 6c. 最终裁定 | 元Agent | 所有 | `FinalDecision { plan, code }` |

---

## 5. 与现有系统的集成点

### 5.1 已具备的能力

| 现有模块 | 对应角色 | 状态 |
|----------|----------|------|
| `agent/router.ts` | Planner（思考路由） | ✅ 已有，需改造为独立Agent |
| `agent/loop.ts` | Coder（执行循环） | ✅ 已有，需拆出工具调用层 |
| `ripple/engine.ts` | Reviewer（影响分析） | ✅ 已有 |
| `hooks/index.ts` | 审查钩子 | ✅ 已有 |

### 5.2 待建设的能力

| 待建模块 | 对应角色 | 优先级 |
|----------|----------|--------|
| `agent/confidence.ts` | 置信度评分引擎 | **P0** |
| `agent/meta-agent.ts` | 元Agent裁决器 | **P0** |
| `agent/contract.ts` | Plan契约类型定义 | **P0** |
| `agent/negotiator.ts` | 协商回合引擎 | P1 |
| `tests/multi-agent.test.ts` | 多Agent集成测试 | P1 |

---

## 6. 待决事项

- [ ] 置信度评分算法是否需要基于历史准确率动态校准？
- [ ] 协商回合数上限？（建议3轮，超过则元Agent强制裁定）
- [ ] 是否需要"人工升级"通道（超过80%置信度分歧时通知用户介入）？
- [ ] Coder产出是否需要自动运行typecheck作为置信度因子？

---

## 7. 变更日志

| 日期 | 变更 | 作者 |
|------|------|------|
| 2026-06-09 | 初稿：3-Agent + 元Agent架构确定 | DeepSeek Code + User |
