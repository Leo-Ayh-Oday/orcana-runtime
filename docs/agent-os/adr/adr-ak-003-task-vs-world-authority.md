# ADR-AK-003 Task vs World Authority

**状态：** 已定案（AK-0）
**Task：** `AK0-FND-001`

## 背景

Task 状态与 World 状态相关但不等价。把 Task completion 存进 World 或让 execd 推导完成，会形成第二套 Graph Authority。

## 决策

Typed Execution Graph 单独拥有 Task definition、依赖关系与 completion authority。AgentWorld 记录任务相关 World object 和执行结果投影，但不得裁决节点完成。Execution Fabric、Driver、Tool 和 AgentProcess 都只能向完成链提供事实或候选结果。

完整链固定为：

```text
Graph Intent
→ Capability Authorization
→ World Projection
→ Execution
→ World Commit
→ Effect Settlement
→ Evidence Binding
→ Graph Completion
```

## 后果

一个节点可以处于 `Execution=COMPLETED`、`World=COMMIT_PENDING`、`Evidence=PENDING`，此时 Graph 仍未完成。

## 不变量

```text
SECOND_TASK_AUTHORITY = 0
EXECUTION_COMPLETES_GRAPH_DIRECT = 0
```
