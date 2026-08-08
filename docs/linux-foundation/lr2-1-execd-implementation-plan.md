# orcana-execd 实现计划（LR2-1）

**计划编号：** LR2-1
**英文名称：** orcana-execd — Non-Privileged Linux Execution Control Plane
**上一版：** [LR2-0 可执行总计划](linux-runtime-2.0-plan.md)（Batch A/B/C 已完成，LR2-0 Gate 全绿）
**基线：** `8e8814d`（LR2-0 完成，门禁 310/310）
**定位：** LR2-0 完成后启动 daemon 线：Unix socket RPC + SQLite 状态权威 + systemd user service + 同 boot 崩溃恢复。

> 记录说明：push/release 按 LR2 计划线点名拆分。

## 零、技术选型实测（2026-08-08）

| 项 | 结论 |
|---|---|
| Unix socket | `node:net` IPC（`Bun.socket` 在此 bun 构建不可用） |
| SO_PEERCRED | `bun:ffi` + libc `getsockopt(SOL_SOCKET=1, SO_PEERCRED=17)` —— 实测拿到真实 pid/uid/gid（fd 取自 `socket._handle.fd`） |
| SQLite | `bun:sqlite`（内置，WAL 模式） |
| 新依赖 | 无（全部内置） |

## 一、架构定位

```text
CLI / TUI / Agent 主进程（客户端，可崩溃）
        │  Unix Socket RPC（4-byte frame + JSON）
        ▼
      orcana-execd（systemd user service）
   ┌────┼────┬─────────┬──────────┐
server  state  cell/run  lease    recovery
       (SQLite)  manager  manager
   └────┴────┴─────────┴──────────┘
        │
        ▼
 LinuxExecutionBroker（enabled 模式，execd 内持有）
        │
   Cell 执行（cgroup/workspace/backend → Receipt）
```

- execd **不是**：Graph Scheduler / Agent Planner / Harness 权限权威 / 全局完成权威 / 秘密仓库 / Root Daemon。
- v1 第一目标：**CLI/TUI/Agent 主进程崩溃 → execd 与 Cell 仍然存在 → 新客户端可重连**（不要求 execd 自身崩溃后 Cell 继续运行——那是后续）。
- 复用：`LinuxExecutionBroker`（execd 进程内持有，enabled）；新写：RPC 层 + SQLite 状态 + session/lease/recovery。

## 二、阶段划分与验收

### L1-A ExecProtocol 契约（`src/execd/protocol/`）

- `frame.ts`：4-byte big-endian length + UTF-8 JSON；单帧上限 16 MiB；编解码 + 流式解析器（跨帧缓冲）。
- `messages.ts`：Request 基类（protocolVersion/requestId/idempotencyKey/sessionId/sequence/payload/approvalToken）+ 12 个方法 payload 类型 + Response（ok/error code）。
- `events.ts`：ServerEvent（eventSequence 单调递增 + 类型 + payload）。
- `peercred.ts`：bun:ffi getsockopt SO_PEERCRED → { pid, uid, gid }。
- 验收：帧编解码 golden（长度边界/截断/大帧）、未知方法拒绝、版本不匹配拒绝、peercred 单测（本进程连接）。

### L1-B StateStore（`src/execd/state/`）

- `store.ts`：bun:sqlite + WAL + busy_timeout；13 表：
  `runs / domains / cells / cell_attempts / cell_events / reservations / leases / receipts / cleanup_actions / service_cells / port_leases / cache_locks / idempotency_keys`。
- append-only `cell_events` + materialized `cells.current_state`；每次迁移追加事件（from/to/reason/sequence/actor/payload_digest）。
- 事务封装：`withTransaction(fn)`——状态迁移 + Reservation + idempotency response 同事务。
- 验收：schema 建表、事件追加 + 物化、幂等键（同 requestId 同响应）、事务回滚（失败不落半态）、WAL 崩溃安全（kill 后 reopen 不丢已提交）。

### L1-C execd Server（`src/execd/server.ts` + `session-manager.ts` + `event-stream.ts`）

- Unix socket：`$XDG_RUNTIME_DIR/orcana/execd.sock`；目录 0700、socket 0600；拒绝非本地（peer uid ≠ 本进程 uid）。
- 帧编解码接线 + SessionManager（sessionId ↔ 连接；WatchCell 订阅；断线事件流缓存）。
- EventStream：每事件单调递增 `eventSequence`（内存 + SQLite cell_events 行号）；重连客户端从最后确认序号续读。
- 验收：连接/认证（同 uid 放行、伪造其他 uid 拒绝——用第二进程连接测试）、WatchCell 事件序列无缺口、断线重连续读。

### L1-D Cell/Run Manager（`src/execd/cell-manager.ts` + `run-manager.ts`）

- SubmitCell：requestId 幂等（idempotency_keys 表，同 requestId 返回已提交的 run/cell 响应）→ Cell 状态机（LR2-0 ADR-002 14 态）→ 经 `LinuxExecutionBroker.execute`（execd 内）→ 事件落库 + 广播。
- GetCell / CancelCell / CancelAgent / CancelRun / CleanupRun：映射 broker 取消/清理 + 状态机迁移。
- 验收：提交→状态机推进→Receipt 落库→取消→清理；**重复 SubmitCell 同 requestId 不启动第二个进程**（DUPLICATE_SUBMIT_STARTS_SECOND_CELL）。

### L1-E Lease Manager（`src/execd/lease-manager.ts`）

- AcquireLease/RenewLease/ReleaseLease；lease 过期扫描（时间戳）；lease 持有期间 Run 不回收。
- 验收：获取/续期/释放/过期；过期后资源可回收。

### L1-F Recovery（`src/execd/recovery.ts`）

- 启动扫描非终态 Attempt，按主计划 §7 动作表恢复：
  RESERVED→释放+START_FAILED；STARTING（有 cgroup 无进程）→START_FAILED；RUNNING（populated=1）→接管监控；RUNNING（populated=0）→EXIT_STATUS_UNKNOWN；EXIT_OBSERVED→Recovery Receipt；RECEIPT_COMMITTED→通知重绑定；CLEANUP_PENDING→幂等继续清理。
- 外部副作用（Git push/发布/发消息/远程写/上传）→ `SIDE_EFFECT_UNKNOWN`：查询外部系统 → reconcile → commit/retry/human（v1 提供状态机 + 标记，不自动重跑）。
- 验收：kill -9 execd 后重启 → 非终态 Attempt 全部收敛；同 boot 崩溃恢复（SAME_BOOT_CRASH_UNRECOVERED）。

### L1-G systemd user service + CLI

- `packaging/orcana-execd.service`：ExecStart=%h/.local/bin/orcana-execd / Restart=on-failure / UMask=0077 / Delegate=cpu memory pids io / NoNewPrivileges=yes。
- `src/execd/main.ts`（daemon 入口）+ `src/execd/cli.ts`（客户端：submit/watch/cancel/list——测试与验收用）。
- 验收：CLI 退出 → execd 存活 → 新 CLI 重连读到事件（CLIENT_CRASH_LOSES_CELL）。

### L1-H LR2-1 Gate 验收

```text
CLIENT_CRASH_LOSES_CELL                  = 0
DUPLICATE_SUBMIT_STARTS_SECOND_CELL      = 0
UNAUTHENTICATED_LOCAL_CLIENT             = 0
EVENT_SEQUENCE_GAP_UNDETECTED            = 0
NONTERMINAL_CELL_LOST_AFTER_RESTART       = 0
SAME_BOOT_CRASH_UNRECOVERED               = 0
UNKNOWN_SIDE_EFFECT_BLIND_RETRY           = 0
```

每个 Gate 一条验收测试（`tests/execd/`）。

### L1-I 独立 Agent 审核

实现完成后由独立 subagent 审核（安全性/协议/状态一致性/竞态），审核结论与修复并入。

## 三、文件布局

```text
src/execd/
├── main.ts            daemon 入口（systemd ExecStart）
├── cli.ts             客户端 CLI（测试/验收用）
├── server.ts          Unix socket 监听 + 帧路由 + 认证
├── session-manager.ts 连接会话 + WatchCell 订阅
├── cell-manager.ts    Cell 生命周期（Submit/Get/Cancel + 状态机）
├── run-manager.ts     Run 生命周期（Cancel/Cleanup/关闭 domain）
├── lease-manager.ts   Lease 获取/续期/释放/过期
├── event-stream.ts    事件流（eventSequence + 断点续读）
├── state/
│   └── store.ts       SQLite（13 表 + 事务 + idempotency）
├── recovery.ts        启动恢复（非终态 Attempt 扫描）
└── protocol/
    ├── frame.ts       4-byte 帧编解码
    ├── messages.ts    Request/Response payload 类型
    ├── events.ts      ServerEvent 类型
    └── peercred.ts    SO_PEERCRED ffi
tests/execd/
└── *.test.ts          L1-A~H 验收
```

## 四、依赖链

```
L1-A (protocol) ─► L1-C (server) ─► L1-D (cell/run) ─► L1-F (recovery)
L1-B (store) ────┘                      │
                                         ├► L1-E (lease) ─► L1-G (systemd)
                                         └► L1-H (gates) ─► L1-I (审核)
```

## 五、风险与决策

- **SO_PEERCRED 依赖 bun:ffi**：bun 版本升级需复测；失败时降级为 socket 文件权限 + 目录权限（0600/0700 已限同用户）——认证强度降级必须显式记录。
- **execd 内持有 broker 单例**：Cell 执行仍在 execd 进程内（v1 不跨进程执行）；execd 崩溃 → Cell 丢失（L1-F 只恢复状态记录，不恢复进程）——符合"初期不要求 execd 自身崩溃后 Cell 继续运行"。
- **事件流内存缓存**：WatchCell 订阅断线期间的增量由 SQLite cell_events 兜底（重连从 eventSequence 续读）。
- **Windows**：execd Linux-only（非 Linux 平台 main.ts 拒绝启动）。
