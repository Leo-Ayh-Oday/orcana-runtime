# ADR-LR2-003 Receipt and Evidence Boundary

**状态：** 提案（LR2-0 Batch A 冻结）
**计划：** [Linux Runtime 2.0 可执行总计划](linux-runtime-2.0-plan.md)
**关联：** [ADR-L1](architecture-decisions.md)、[ADR-LR2-001](adr-lr2-001-execution-authority.md)、[ADR-LR2-002](adr-lr2-002-cell-state-machine.md)

## 背景

LNXF-1.0 已按 PR-2/PR-15 方向收敛"无默认成功值"（cleanup 缺失 → -1/false），但仍有残留：

- Receipt 构造器 `metrics: input.metrics ?? {}` —— 空观测被当作完整 metrics；
- `worktreeRetained` 仍抄 spec 推定（`spec.lifecycle.retainOnFailure`），未实测化；
- 无 `Observed<T>` 三态类型（observed / unsupported / unknown）——"未观测"与"观测到失败"无法区分；
- Receipt 与 Evidence 的边界（事实 vs 解释）未正式冻结。

## 决策

1. **Receipt 只记录真实观测**：任何字段若未实测，必须是 `unknown`，禁止默认写成成功。

   ```ts
   type Observed<T> =
     | { status: "observed"; value: T }
     | { status: "unsupported"; reason: string }
     | { status: "unknown"; reason: string }
   ```

   禁止：`cgroupRemoved: true`（无实际检查）、`metrics: {}`（却被当作完整 Receipt）。
   真实指标来源：`cpu.stat / memory.current / memory.peak / memory.events / pids.current / io.stat / cgroup.events / backend inspect / workspace diff / network gateway log`。

2. **三类 Receipt**：`ExecutionStartReceipt`、`ExecutionExitReceipt`、`CleanupReceipt`；最终 `SandboxReceipt` 是三者的聚合，**执行结束 ≠ 清理成功**。清理验证（processesRemaining=0、mountsReleased、cgroupRemoved、containerRemoved）必须来自真实测量；未验证时如实缺省（-1/false）且 `receiptComplete = false`。

3. **Receipt = 已发生执行事实；Evidence = Receipt 对任务结论的解释与绑定**。Evidence 绑定 `receiptDigest`（对去除 digest 字段的完整 Receipt 的摘要），而非 cellSpecDigest。

4. **完成链**：`ToolResult + Final Receipt + Verification Evidence + Ownership Evidence → Node Completion Gate`。写节点完成条件：`exitCode 满足要求 AND Receipt 完整 AND 无未批准写入 AND Cleanup 满足策略 AND Verification 通过`。

5. **Digest 规范**（承接 provenance bug 修复）：递归稳定排序 canonical JSON；数字/`undefined`/数组/空对象语义固定（`undefined` 键丢弃、`undefined` 值 → `null`、数组逐元素递归）；`schemaVersion` 与 `canonicalizationVersion` 必须进入摘要；digest 保留完整 SHA-256（展示层再缩短）；golden tests 固化。

## 影响

- `buildReceipt` 输入补 `Observed<T>` 字段；`metrics` 空默认改为 `unknown`；`worktreeRetained` 由 ReceiptInput 实测传入（不再抄 spec）；
- `computeReceiptDigest` 覆盖 schemaVersion/canonicalizationVersion；
- Gate：`RECEIPT_UNOBSERVED_SUCCESS_FIELD = 0` / `RECEIPT_WITHOUT_VALID_DIGEST = 0` / `WRITE_NODE_WITHOUT_EXECUTION_EVIDENCE = 0` / `CLEANUP_RESOURCE_LEAK = 0`。

## 不变量

- 未观测字段 ≠ 成功字段；`unknown` 不满足任何"已验证"断言；
- 外部副作用节点（Git push、发布、发消息、远程数据库、上传 Artifact）不得直接重跑：进入 `SIDE_EFFECT_UNKNOWN` → 外部系统查询 → reconcile → commit / retry / human intervention；
- 服务节点走 `SERVICE_READY` 语义，不使用短任务完成语义。
