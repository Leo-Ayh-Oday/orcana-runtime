# ADR-AK-006 Agent State vs Context

**状态：** 已定案（AK-0）
**Task：** `AK0-FND-001`

## 背景

Conversation history 和单次模型 context window 都会压缩、丢弃或因模型切换而重建，不能承担 Agent 长期状态权威。

## 决策

AgentProcess 状态属于 AgentWorld/Kernel；LLM Context 是 Semantic MMU 从 World Snapshot、Task、Memory、Evidence、代码与工具 schema 生成的不可变 `ContextImage` 工作集。

现有 Context Pipeline 保留并渐进升级，先增加 page reference、working set 与 digest，不建立第二套长期 Memory。

## 边界

- Context transform 不得修改权威 Agent State；
- 每次 inference 必须绑定 ContextImage digest；
- pinned page 不得在 pressure 下静默丢失；
- reconstructable page 可换出并按 source digest 重建。

## 不变量

```text
UNTRACKED_CONTEXT_INJECTION = 0
INFERENCE_WITHOUT_CONTEXT_DIGEST = 0
```
