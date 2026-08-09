# ADR-AK-001 World Authority

**状态：** 已定案（AK-0）
**Task：** `AK0-FND-001`

## 背景

Linux worktree、容器、MicroVM 与远程 Worker 都会终止、重建或迁移。若它们持有 Agent 长期状态权威，执行后端生命周期就会错误地决定 Agent 世界生命周期。

## 决策

`AgentWorld` 是文件、Memory、Artifact、Service、World object、Branch 与 Effect journal 当前状态的唯一权威。WorldDB 保存 materialized state，WorldLedger 解释状态演化，CAS 保存内容；三者职责分离。

正式 World mutation 必须通过带 `baseRevision` 的 World Commit。提交基线不是当前 HEAD 时返回冲突，禁止静默覆盖。

## 边界

- Graph 仍是 Task、依赖与完成权威；
- Evidence 仍是完成声明充分性权威；
- Execution Fabric 只报告 Linux 上实际发生的事实；
- Driver 与 Worker 不得直接修改 WorldDB。

## 后果

执行后端可替换，World 可快照、恢复与迁移；代价是执行完成与 World Commit 必须成为两个独立状态。

## 不变量

```text
SECOND_WORLD_AUTHORITY = 0
REMOTE_DIRECT_WORLD_MUTATION = 0
```
