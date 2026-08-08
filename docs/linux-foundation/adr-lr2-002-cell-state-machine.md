# ADR-LR2-002 Cell State Machine

**状态：** 提案（LR2-0 Batch A 冻结）
**计划：** [Linux Runtime 2.0 可执行总计划](linux-runtime-2.0-plan.md)
**关联：** [ADR-L1](architecture-decisions.md)、[ADR-LR2-001](adr-lr2-001-execution-authority.md)、[ADR-LR2-003](adr-lr2-003-receipt-evidence-boundary.md)

## 背景

当前 Cell 状态 `pending/running/succeeded` 不足以支持持久恢复：

- 崩溃/重启后无法从状态判断"执行到哪一步"（已预留？已进 cgroup？已发信号？）；
- 迁移历史被覆盖丢失（`state` 字段只保留当前值）；
- 恢复（LR2-1 execd 恢复、LR2-0 P0-7）需要精确的中间态（RESERVED / STARTING / EXIT_OBSERVED…）才能决定"重跑 / 释放 / 接管监控 / 生成 Recovery Receipt"。

## 决策

采用**主链 + 异常终态 + append-only 迁移记录**的持久状态机：

```text
ACCEPTED
→ POLICY_COMPILED
→ WAITING_RESOURCES
→ RESERVED
→ CGROUP_READY
→ WORKSPACE_READY
→ BACKEND_READY
→ STARTING
→ RUNNING
→ EXIT_OBSERVED
→ RECEIPT_COMMITTED
→ EVIDENCE_BOUND
→ CLEANUP_PENDING
→ CLEANED
```

异常终态：

```text
REJECTED_POLICY
START_FAILED
CANCELLED
TIMED_OUT
OOM_KILLED
OUTPUT_LIMITED
LOST
SIDE_EFFECT_UNKNOWN
CLEANUP_FAILED
```

1. **状态迁移不可覆盖历史**：每次迁移必须追加一条记录：
   `cell_id / attempt_id / from_state / to_state / reason_code / timestamp / event_sequence / actor / payload_digest`；
   `current_state` 只是物化视图（materialized），权威是 append-only 迁移流。
2. **启动事务**（LR2-0G）按固定顺序执行：Validate Intent → Compile CellSpec → Estimate ResourceRequest → ResourceLedger.reserve() → Persist Reservation → Create cgroup → Write cgroup limits → Prepare workspace/cache → Start backend → Confirm process entered cgroup → Mark RUNNING。任一步失败：记录失败状态 → 释放 Reservation → 清理已创建资源 → 写 CleanupReceipt。
3. **取消顺序**（LR2-0J）：CANCELLING →（可用时）cgroup.freeze → 优雅终止 → grace period → cgroup.kill → 等待 `cgroup.events populated=0` → 清理 mount/container/workspace/port/cache lock → 释放 Reservation → 写 CleanupReceipt。
4. **恢复语义**（LR2-1 §7）：非终态 Attempt 按当前状态执行对应恢复动作（RESERVED 无 cgroup → 释放并标记 START_FAILED；RUNNING populated=1 → 接管监控；EXIT_OBSERVED 无 Receipt → 生成 Recovery Receipt；CLEANUP_PENDING → 幂等继续清理）。

## 影响

- Broker 的 `cellRuns` 内存状态需落为持久状态机（SQLite append-only `cell_events` + materialized `current_state`，LR2-1）；
- 状态迁移、Reservation、idempotency response 必须在一个数据库事务内提交（LR2-1 §5）；
- Gate：`NONTERMINAL_CELL_LOST_AFTER_RESTART = 0` / `SAME_BOOT_CRASH_UNRECOVERED = 0`。

## 不变量

- 每次状态迁移都有 `from_state`（初始态除外）与 `reason_code`；
- `event_sequence` 单调递增，TUI/客户端重连从最后确认序号继续；
- 异常终态不得通过覆盖 `state` 字段伪装为正常终态。
