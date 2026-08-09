# execd v2 收尾实现计划（LR2-1v2）

**计划编号：** LR2-1v2
**英文名称：** execd v2 — 跨进程句柄接管 + AttachLogs + 背压 + approvalToken
**上一版：** [LR2-1 orcana-execd](lr2-1-execd-implementation-plan.md)（L1-A~I 完成）
**基线：** `b2d5723`（LR2-7 完成，门禁全绿）
**定位：** 收掉 LR2-1 遗留的四项 v2 范围（执行句柄接管 / AttachLogs 大对象 /
背压 / approvalToken 校验），使 execd 达到"客户端崩溃 → execd 与 Cell 仍
存在 → 新客户端可重连"与"重启可接管监控"的完整语义。

> 记录说明：push/release 按 LR2 计划线点名拆分。

## 零、现状盘点（2026-08-09）

- execd 已有：Unix socket 服务（SO_PEERCRED 认证）、StateStore（SQLite
  13 表 append-only 事件流）、CellManager（14 态状态机 + broker 接线 +
  幂等）、LeaseManager、EventStream（断点续读）、Recovery；
- **遗留 1（跨进程句柄）**：`recovery.ts:61` —— execd 重启后 RUNNING 的
  cell 一律标 LOST（"进程无法接管"），计划 §7 的"重新接管监控"未实现；
- **遗留 2（AttachLogs）**：`cell-manager.ts:200-204` —— stdout/stderr
  截断 16KB/事件落库（索引语义），AttachLogs 方法存在但大对象无落盘、
  无读取路径（M13）；
- **遗留 3（背压）**：`event-stream.ts` —— 订阅 live 队列无限增长
  （M14 记录不修）；
- **遗留 4（approvalToken）**：server.ts 未校验 approvalToken（M17：
  v1 信任客户端）。

## 一、阶段划分

### L2-A 执行句柄持久化 + 重启接管（`src/execd/handle.ts` + `recovery.ts`）

- Cell 启动时记录执行句柄（可持久化形状）：
  ```text
  handle_id / cell_id / cgroup_path / pidfd? / spawn_pid / parent_pid
  / started_at / backend / cell_plan_digest
  ```
- pidfd 不可跨重启（同一 boot 内可用）：重启接管策略按可观测事实：
  - cgroup 路径存在且 `cgroup.events populated=1` → 进程树仍活着 → 重新
    挂接监控（周期性探活 `cgroup.events` + `cgroup.kill` 能力就绪）→
    RUNNING（重新接管）；
  - cgroup 存在但 populated=0 → 树已退出 → 读退出记录或 EXIT_STATUS_UNKNOWN
    → 收敛 EXIT_OBSERVED；
  - cgroup 不存在 → START_FAILED / 已清理。
- 接管后：取消（cgroup.kill 树杀）、超时、监控都走 cgroup 路径（不再
  依赖 broker 内存态）。
- 验收：同 boot 重启接管 RUNNING 真实进程（cgroup 探活 + 取消生效）、
  已退出树收敛、无 cgroup 收敛 START_FAILED。

### L2-B AttachLogs 大对象（`src/execd/log-store.ts` + 协议）

- 大对象落盘：`$XDG_RUNTIME_DIR/orcana/logs/{cellId}/{seq}.log`（0600），
  SQLite 只存索引（cell_id / seq / offset / length / kind）；
- 事件流仍只存截断 16KB 索引（在线 watch 语义不变）；
- `AttachLogs { cellId, sinceSequence?, offset? }` → 流式回放落盘日志
  （帧：chunk + 末尾 EOF 标记 + latest sequence）；
- 大日志不阻塞 DB：写文件缓冲 + 定时刷盘。
- 验收：AttachLogs 读到完整 stdout（超 16KB 不截断）、断点续读、文件
  权限 0600、无残留（清理时删除）。

### L2-C 事件背压（`event-stream.ts`）

- 每订阅队列有界（默认 4096 事件）；超限 → 订阅者标记"落后"（不再
  实时推送，通知调用方用落库历史补读）—— 不丢事件、不无限增长；
- 慢消费者检测：drain 间隔超阈值 → 降级为纯轮询（跳过实时推送）。
- 验收：大量事件下队列有界、不丢失（可补读）、落后标记准确。

### L2-D approvalToken 校验（`server.ts` + `cell-manager.ts`）

- execd 启动注入受信 token 源（`TrustedTokenProvider`：由调用方/配置文件
  提供，v1 至少支持固定 token + 环境变量注入）；
- SubmitCell 必须携带 `approvalToken` 且与受信源匹配 → 否则
  `UNAUTHORIZED_APPROVAL` 拒绝（不启动 Cell）；
- Cancel 类操作同样校验（持有 token 才可取消/清理）。
- 验收：无 token / 错 token 拒绝、正确 token 放行、幂等重试不受影响。

### L2-E Gate 验收 + 独立审核

```text
EXECD_RESTART_LOSES_RUNNING_CELL   = 0（同 boot 重启可接管）
CGROUP_POPULATED_UNTRACKED         = 0（活进程树必有归属）
ATTACH_LOGS_TRUNCATED              = 0（大对象完整可读）
EVENT_QUEUE_UNBOUNDED              = 0
SLOW_CONSUMER_EVENT_LOSS           = 0
UNAUTHORIZED_APPROVAL              = 0
LOG_LEAK_AFTER_CLEANUP             = 0
```

每项一条验收测试 + 独立 subagent 审核（同流程）。

## 二、文件布局

```text
src/execd/
├── handle.ts      执行句柄记录（持久化形状 + cgroup 探活）
├── log-store.ts   大对象落盘 + AttachLogs 回放
├── event-stream.ts  （改造：有界队列 + 落后标记）
├── server.ts      （改造：AttachLogs 路由 + approvalToken 校验）
├── cell-manager.ts（改造：句柄记录 + token 透传）
└── recovery.ts    （改造：RUNNING 接管路径）
tests/execd/v2/    验收测试
```

## 三、风险与决策

- **pidfd 不可跨重启**：接管判定只用 cgroup.events populated（可观测
  事实），不依赖 pidfd/内存态；
- **同 boot 限制**：跨 boot（机器重启）cgroup 一定不存在 → 收敛
  START_FAILED（v1 语义不变）；本阶段只解决"execd 重启、内核未重启"；
- **AttachLogs 文件缓冲**：日志写入带 fsync 策略（WAL 语义），cell
  清理时级联删除；
- **token 注入**：第一版支持 env 注入 + 测试注入器；完整 Harness
  token 签发在后续线。

## 四、执行顺序

L2-A → L2-B → L2-C → L2-D → L2-E（每阶段：实现 → 门禁 → 提交）。
