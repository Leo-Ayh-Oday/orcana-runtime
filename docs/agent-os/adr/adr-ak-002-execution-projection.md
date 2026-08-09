# ADR-AK-002 Execution Projection

**状态：** 已定案（AK-0）
**Task：** `AK0-FND-001`

## 背景

现有 Linux Execution Fabric 对进程、cgroup、sandbox、网络与清理拥有事实权威，但不应成为持久 World 状态权威。

## 决策

执行统一遵循：

```text
World Snapshot
→ Projection Plan
→ Projection
→ Execute
→ Delta
→ Validate
→ World Commit
```

Capability Direct、Native Projection 与 Live WorldFS 是不同投影模式；backend routing 只决定执行地点，不改变 Capability authority。

## 边界

- Execution Fabric 不得直接写 WorldDB；
- `exitCode = 0` 不得直接完成 Graph；
- World Commit 必须验证 base revision、写权限与预期输出；
- 第一版冲突返回 `WORLD_HEAD_MOVED`，不自动合并。

## 后果

执行可以重试或迁移而不改变权威模型；普通 coding workload 需要承担可测量的投影与提交开销。

## 不变量

```text
CELL_DIRECT_WORLD_MUTATION = 0
EXECUTION_SUCCESS_AUTO_COMPLETE = 0
```
