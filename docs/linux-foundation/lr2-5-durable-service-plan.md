# Durable Service Cell 实现计划（LR2-5）

**计划编号：** LR2-5
**英文名称：** Durable Service Cell — Service 状态机 + Lease/Retention 合同
**上一版：** [LR2-4 Strong Isolation](lr2-4-strong-isolation-plan.md)（P4-A~E 完成，含独立审核）
**基线：** `5374b1c`（LR2-4 Gate 验收，门禁 333/333）
**定位：** 持久服务执行模型：LSP/MCP/开发服务器/本地数据库的独立合同 —— 不能
在普通 Cell 上增加 `serviceMode=true` 就结束。

> 记录说明：push/release 按 LR2 计划线点名拆分。

## 零、现状盘点（2026-08-09）

- 已有：`service-cell.ts`（ServiceCell：spawn + 探活 + status starting/ready/stopped/failed）——**简单租约，无状态机/无 retention**；
- 已有：execd 的 `lease-manager`（LR2-1）；
- 无：Service 状态机（9 态）、ServiceCellSpec、retentionPolicy（Lease 到期 ≠ 立即盲杀）。

## 一、阶段划分

### P5-A Service 状态机（`src/runtime/linux/service/state-machine.ts`）

- 9 态：DECLARED → STARTING → PROCESS_RUNNING → READINESS_PENDING → READY
  → DEGRADED → RESTARTING → STOPPING → STOPPED；
- 异常终态：START_FAILED / HEALTH_FAILED / LEASE_EXPIRED / OWNER_LOST /
  PORT_CONFLICT / RESTART_EXHAUSTED；
- 迁移守卫（复用 execd 的守卫式 transition 模式）+ append-only 事件。
- 验收：合法/非法迁移表、异常终态、事件流。

### P5-B ServiceCellSpec（`src/runtime/linux/service/spec.ts`）

- 字段：serviceId / ownerRunId / ownerAgentId / command / workspace /
  dependencies / portRequests / readinessProbe / healthProbe / restartPolicy /
  leasePolicy / logPolicy / shutdownContract / retentionPolicy。
- 校验：字段完整性、portRequests 唯一、probe 形状、restartPolicy 上限。
- 验收：spec 校验（缺字段/非法端口/restart 上限）、类型。

### P5-C 生命周期管理（`src/runtime/linux/service/lifecycle.ts`）

- ServiceManager：DECLARED → 启动（经 ExecutionGateway）→ 探活 → READY →
  健康监测（healthProbe 周期）→ DEGRADED/RESTARTING；
- 端口管理（portRequests → portLeases 表：冲突检测 PORT_CONFLICT）；
- 优雅停止（shutdownContract：SIGTERM → grace → SIGKILL）。
- 验收：启动→READY→健康失败→RESTARTING→RESTART_EXHAUSTED；端口冲突；
  优雅停止。

### P5-D Lease + Retention（`src/runtime/linux/service/retention.ts`）

- **Lease 到期 ≠ 立即盲杀**：到期 → 按 retentionPolicy 决策
  （retain / pause / terminate / transfer ownership）；
- Owner Run 中断 → retentionPolicy 同样适用；
- 与 execd lease-manager 集成（onExpired → retention 决策）。
- 验收：到期不盲杀（retain 保持）、terminate 停止、transfer 转移所有权、
  OWNER_LOST 状态。

### P5-E Gate 验收 + 独立审核

```text
LEASE_EXPIRED_BLIND_KILL       = 0（到期不盲杀）
OWNER_LOST_HANDLING            = 0（Owner 中断按 retention 处理）
PORT_CONFLICT_UNCHECKED        = 0
RESTART_EXHAUSTED_IGNORED      = 0
SERVICE_READY_FALSE_POSITIVE   = 0（探活通过才算 READY）
```

每项一条验收测试 + 独立 subagent 审核（同流程）。

## 二、文件布局

```text
src/runtime/linux/service/
├── state-machine.ts   Service 9 态状态机（守卫式）
├── spec.ts            ServiceCellSpec + 校验
├── lifecycle.ts       ServiceManager（启动/探活/健康/重启/停止）
└── retention.ts       Lease 到期 / Owner 中断 → retentionPolicy 决策
tests/runtime/linux/service/   验收测试
```

## 三、风险与决策

- **本机无 LSP/MCP 真实服务**：用 /bin/sh 长驻进程 + HTTP 探活（node http）做
  集成验证（真实进程语义）。
- **与 execd 的关系**：ServiceManager 可独立运行（execd 集成后续线）；
  retention 决策函数与 lease 解耦（可测）。
- **迁移**：现有 service-cell.ts 保留（旧调用方）；新模型独立目录，迁移在
  LR2-5 完成后按调用方逐一切换。
