# ADR-AK-007 External System Authority

**状态：** 已定案（AK-0）
**Task：** `AK0-FND-001`

## 背景

GitHub、对象存储、Google Drive、数据库与远程 Worker 都有自己的状态与故障模式。把它们与 AgentWorld 组成无约束 multi-master 会使冲突、恢复和 provenance 无法确定。

## 决策

外部系统通过 Driver 或 Mount 作为 source。AgentWorld 是 Orcana 侧权威，Remote Worker 是 execution replica。远程执行只接收 Snapshot Manifest、Capability Grant 与 Execution Spec，并返回 Delta Manifest 与 Receipt；Coordinator 验证后提交 World。

外部系统已经接受的副作用由 Effect Kernel 记录和 reconcile，不伪装成 WorldDB 本地事务。

## 边界

- Driver 不得直接修改 WorldDB；
- Remote Worker 不得持有全局 World authority；
- 同步使用 revision、cursor、digest 与 fencing token；
- AK-10 前不建立多机 World authority 或 CRDT Everything。

## 不变量

```text
REMOTE_WORKER_GLOBAL_AUTHORITY = 0
REMOTE_DIRECT_WORLD_MUTATION = 0
```
