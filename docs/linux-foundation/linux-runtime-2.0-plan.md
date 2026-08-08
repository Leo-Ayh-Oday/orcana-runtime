# Orcana Linux Runtime 2.0 可执行总计划

**计划编号：** LR2（LNXF-2.0 计划线）
**英文名称：** Orcana Linux Runtime 2.0 — Executable Master Plan
**上一版：** [LNXF-1.0 实施计划](execution-plan.md) / [LNXF R2.1 实现计划](production-closure-r2-plan.md)
**定位：** 在 LNXF-1.0（LF-0~LF-8）+ R0~R6 + PR-0~PR-10 + R2.1 修复线之后，从 7 个 P0 出发，规划 Production Execution Closure（LR2-0）→ orcana-execd（LR2-1）→ Performance Plane（LR2-2）→ Adaptive Scheduler（LR2-3）→ Strong Isolation（LR2-4）→ Durable Service Cell（LR2-5）→ Evolution Lab（LR2-6）→ Remote Workers（LR2-7）的执行路线。

> 记录说明：先 LR2-0 后 execd，按顺序推进；push/release 按 LR2 计划线点名拆分，不进入 0.9 版本线。

---

## 一、先确定当前真实起点

当前 LNXF 已经具备相当完整的**设计原语和组件骨架**，但还不能称为 Production Execution Plane。

### 1. 当前最重要的七个 P0

| P0                         | 当前状态                                                                                                            | 必须采取的动作                                   |
| -------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| P0-1 执行权威分裂                | `getLinuxBroker()` 默认创建 `shadow` Broker；`cancelCell`、`cancelAgent`、`cancelRun` 是空实现，`cleanupRun` 固定返回 0。        | 让所有产品级进程进入统一 `ExecutionGateway → Broker`。 |
| P0-2 大量直接 `spawn()`        | 不只有 `run_process`。Git、TypeScript、MCP、LSP、Service、CodeGraph、Worktree、Verification 等模块都直接导入 `node:child_process`。 | 建立进程执行点清单，将产品运行进程和基础设施进程分类迁移。             |
| P0-3 宿主环境泄漏                | `runProcess()` 在有自定义环境时仍把 `process.env` 整体合并进去。                                                                 | 改成显式环境构建，禁止默认继承宿主环境。                      |
| P0-4 ResourceLedger 未进入执行链 | 当前 Ledger 是单进程内存预留表；Broker 没有使用它，也没有和 cgroup 生命周期绑定。                                                            | 预留、启动、释放必须成为一次状态事务。                       |
| P0-5 cgroup 只是组件           | `CgroupManager` 已能创建层级、写资源限制和执行 `cgroup.kill`，但 Broker 后端尚未接线。                                                  | 每个 Cell 启动前必须创建并进入真实 cgroup。              |
| P0-6 Receipt 包含"假事实"       | Bubblewrap Receipt 中 metrics、写入观测为空，却直接声明 mounts 已释放、cgroup 已删除；Receipt 构造器本身也默认 cleanup 成功。                    | 未观测字段必须是 `unknown`，不能默认写成成功。              |
| P0-7 恢复不是持久执行              | 当前状态主要写入独立 JSON 文件，Janitor 只按 boot ID 判断旧启动残留。                                                                  | 升级为事务状态机、Attempt Journal 和同一次开机内的崩溃恢复。     |

上述判断直接来自当前实现：Broker 默认 shadow 且取消、清理为空；`runProcess()` 直接 spawn 并合并宿主环境；ResourceLedger 是独立内存结构；Bubblewrap 后端直接调用 supervisor 并构造缺少真实指标的 Receipt。

代码库中的直接进程创建点明显不止一个工具，因此 Production Closure 不能只修改 `run_process`，必须建立全仓执行点清单和例外白名单。

### 2. 还有一个必须立即修复的 Provenance Bug

当前：

```ts
JSON.stringify(value, Object.keys(value as object).sort())
```

并不是正确的递归规范化 JSON。

第二个参数是属性白名单，它会在所有嵌套对象中复用顶层键列表，导致大量嵌套字段被过滤。例如：

```ts
JSON.stringify(
  { a: { x: 1 }, b: 2 },
  ["a", "b"],
)

// {"a":{},"b":2}
```

因此当前 `cellSpecDigest`、`policyDigest` 和 Receipt 中的策略摘要可能对不同嵌套配置生成相同或不完整的序列化结果。这个问题必须在 Production Closure 前修复，否则缓存、重放、Evidence 和远程执行都会建立在错误摘要上。

正确方案：

1. 使用递归稳定排序；
2. 明确定义数字、`undefined`、数组、空对象的规范；
3. 添加 digest golden tests；
4. Digest 输出暂时保留完整 SHA-256，展示层再缩短；
5. `schemaVersion` 和 `canonicalizationVersion` 必须进入摘要。

---

## 二、你需要理解的最小 Linux 模型

你不需要先系统学完 Linux，再开发 Orcana。应当按阶段只学习当下会实际使用的原语。

| Linux 原语             | 在 Orcana 中的作用                     | 不负责什么                     |
| -------------------- | --------------------------------- | ------------------------- |
| Process              | 一个真实运行程序                          | 不天然包含其全部后代                |
| Process Group        | 对一组相关进程发送信号                       | 无法提供内存、CPU、I/O 限制         |
| pidfd                | 稳定引用一个具体进程，避免 PID 重用竞态            | 不能代替整个 cgroup             |
| cgroup v2            | 组织进程、限制资源、统计资源、树级取消               | 不负责文件系统隔离                 |
| Namespace            | 隔离 mount、PID、network、IPC 等视图      | 不直接限制资源                   |
| Bubblewrap           | 快速组合 namespace 和 mount sandbox    | 不是完整容器生命周期管理器             |
| Rootless Podman      | OCI 镜像、RootFS、容器生命周期和可复现环境        | 仍然共享宿主内核                  |
| Landlock             | 非特权进程主动缩小文件和网络访问权                 | 不代替 mount namespace 和 DAC |
| seccomp              | 限制可调用的 syscall                    | 不理解文件路径和业务权限              |
| systemd user service | 管理 `orcana-execd` 生命周期和 cgroup 委托   | 不应成为 Graph 或完成权威          |
| Unix Domain Socket   | 本机 Runtime 与 execd 的 IPC          | Socket 权限本身不能代替协议授权       |

cgroup v2 支持正式的子树委托、`cgroup.kill`、`cgroup.freeze` 和 `cgroup.events`；`cgroup.events` 的 `populated` 状态可用于确认进程树是否真正退出。

Linux pidfd 提供稳定的进程引用，并可避免传统 PID 被回收后误杀其他进程的竞态；因此 execd 应同时持有 pidfd 和 cgroup 路径：pidfd 管主进程，cgroup 管整棵执行树。

---

## 三、最终目标架构

```text
Graph Scheduler / Harness / Tool Runtime
                    │
                    │ ExecutionIntent
                    ▼
            ExecutionGateway
                    │
          Harness Permission Token
                    │
                    ▼
              Broker Client
                    │
             Unix Socket RPC
                    ▼
             orcana-execd
   ┌────────────────┼─────────────────┐
   │                │                 │
State Machine   Resource Scheduler   Policy Compiler
   │                │                 │
SQLite/WAL      Reservation/PSI   CellPlan/BackendPlan
   │                │                 │
   └────────────────┼─────────────────┘
                    ▼
            Cell Orchestrator
                    │
        cgroup + workspace + cache
                    │
                    ▼
      Bubblewrap / Podman / MicroVM
                    │
             orcana-cell-init
                    │
                    ▼
               Target Process
                    │
      metrics / writes / network / exit
                    ▼
              Execution Receipt
                    │
              Evidence Binding
                    │
             Graph Completion Gate
```

## 权威边界

必须固定以下关系：

```text
Graph
= 任务依赖与完成权威

Harness
= 权限与副作用批准权威

ExecutionGateway
= 所有运行请求的唯一入口

orcana-execd
= Linux 进程、cgroup、容器、缓存和运行状态权威

Receipt
= 已发生执行事实

Evidence
= Receipt 对任务结论的解释与绑定
```

`Agent Domain`、`Execution Cell`、`Service Cell` 都只能是 Graph Assignment 的执行投影，不能反向成为任务完成权威。

---

## 四、LR2-0：Production Execution Closure

这是当前唯一应立即进入实施的阶段。

## LR2-0A：冻结执行合同

### 新增核心合同

建议建立：

```text
src/runtime/execution/
├── execution-gateway.ts
├── execution-intent.ts
├── execution-context.ts
├── execution-result.ts
└── execution-errors.ts
```

### `ExecutionIntent`

它表达业务层想做什么，但不能直接指定 bwrap、Podman 或任意 mount：

```ts
interface ExecutionIntent {
  requestId: string
  runId: string
  nodeRunId: string
  attempt: number

  tool: {
    capabilityId: string
    executable: string
    args: string[]
    cwdRef: WorkspaceRef
  }

  workload: {
    kind: "inspect" | "build" | "test" | "dependency" | "service"
    readonly: boolean
    expectedOutputs?: string[]
  }

  requestedResources?: Partial<ResourceHint>
  requestedNetwork?: NetworkRequest
}
```

### `ExecutionContext`

只能由 Harness 和 Graph Runtime 构造：

```ts
interface ExecutionContext {
  assignmentId?: string
  agentId?: string
  approvedCapabilityId: string
  sideEffectClass: "read" | "write" | "network" | "external"
  workspaceAuthority: WorkspaceAuthority
  secretGrants: SecretGrantRef[]
  approvalToken: string
}
```

### 不变量

模型或 Tool 参数不得直接提供：

* 宿主 mount source；
* cgroup 路径；
* Backend argv；
* seccomp 文件路径；
* 真实秘密值；
* 缓存宿主路径；
* 任意网络 namespace；
* `allowDegradation=true`。

这些必须由 Policy Compiler 从受信输入生成。

## LR2-0B：建立完整 Cell 状态机

当前 `pending/running/succeeded` 不足以支持持久恢复。

建议升级为：

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

每次状态迁移必须记录：

```text
cell_id
attempt_id
from_state
to_state
reason_code
timestamp
event_sequence
actor
payload_digest
```

不得通过覆盖一个 `state` 字段丢失历史。

## LR2-0C：清点全仓进程执行点

生成：

```text
docs/linux-runtime/process-execution-inventory.md
config/runtime-process-bypass-allowlist.json
scripts/check-process-bypass.ts
```

把直接进程执行分成四类：

### A. 必须进入 Broker

* `run_process`
* `run_shell_script`
* Git 命令
* TypeScript 编译
* 测试执行
* AST/CodeGraph 外部程序
* Verification 命令
* Agent Worktree 相关 Git 命令
* 用户启动的开发服务

### B. 应升级为 Durable Service Cell

* MCP Server
* LSP Server
* 开发服务器
* 长期监听器
* 本地数据库

### C. Broker 内部允许执行

* Bubblewrap
* Podman
* `orcana-cell-init`
* 网络代理
* 系统能力探测中的固定只读命令

### D. 非产品 Runtime

* 发布脚本
* 代码生成脚本
* 测试夹具
* 本地开发工具

CI Gate：

```text
任何 src/ 下新增 node:child_process import
→ 默认失败

只有 bypass allowlist 中的 Broker 内部文件
→ 可以通过
```

Gate 名称：

```text
DIRECT_PRODUCT_PROCESS_BYPASS = 0
UNCLASSIFIED_CHILD_PROCESS_IMPORT = 0
```

## LR2-0D：将工具迁移到 ExecutionGateway

先修改：

```text
src/tools/process.ts
src/tools/shell.ts
```

原来的：

```ts
runProcess(...)
```

改成：

```ts
executionGateway.execute(intent, context)
```

随后按顺序迁移：

```text
Git
→ TypeScript / test
→ Verification
→ CodeGraph / ast-grep
→ Worktree commands
→ MCP / LSP / Service
```

不要一次删除旧路径。迁移开关应为：

```text
shadow
enabled
enforced
```

### Shadow

同时编译 CellSpec，但仍执行旧路径，比较：

* command；
* cwd；
* 环境；
* Profile；
* Backend；
* 预计资源；
* 输出；
* 退出码。

### Enabled

默认走 Broker；发生明确基础设施故障时，可按策略回退旧路径，但必须生成 Degradation Evidence。

### Enforced

禁止旧路径。Broker 不可用则执行失败。

## LR2-0E：修正 cgroup 委托模型

当前通过检查 `~/.config/systemd/user` 和尝试写入 `user.slice` 推断委托，不够可靠。Orcana 不应该尝试在任意可写 cgroup 父目录中"寻找权力"，而应只管理 systemd 明确委托给自己的子树。

正确模型：

```text
systemd user manager
└── orcana-execd.service  [Delegate=cpu memory pids io]
    └── execd delegated subtree
        ├── run-...
        │   ├── system
        │   └── agent-...
        │       └── cell-...
```

systemd 的 `Delegate=` 正是用于允许服务管理其单元 cgroup 下的私有子树，而且非特权委托只应在统一 cgroup v2 层级上使用。

实现要求：

1. execd 从 `/proc/self/cgroup` 获取自身实际 cgroup；
2. 只允许在该路径下创建子 cgroup；
3. 不再扫描和尝试写入 `/sys/fs/cgroup/user.slice`；
4. 验证 controller 是否实际委托；
5. 缺少强制 controller 时，严格 Profile 直接失败；
6. 每个 Cell 创建前写入所有限制；
7. Cell 主进程必须在执行目标程序之前进入 cgroup。

## LR2-0F：关闭"启动后再 attach"的竞态

仅在 Node.js `spawn()` 返回 PID 后写 `cgroup.procs`，目标程序可能已经开始 fork、读秘密或占用资源。

采用启动握手：

```text
execd
→ 创建 cgroup
→ 启动受控 launcher
→ launcher 阻塞
→ execd/launcher 确认已进入 cgroup
→ 释放 launcher
→ exec backend/target
```

初期可以使用一个很小的 Native Launcher：

```text
orcana-cell-launcher
├── attach self to cgroup
├── report ready through pipe
├── wait release token
└── exec backend
```

后续再与 `orcana-cell-init` 合并。

## LR2-0G：资源预留进入真实启动事务

一次 Cell 启动必须按此顺序：

```text
1. Validate Intent
2. Compile CellSpec
3. Estimate ResourceRequest
4. ResourceLedger.reserve()
5. Persist Reservation
6. Create cgroup
7. Write cgroup limits
8. Prepare workspace/cache
9. Start backend
10. Confirm process entered cgroup
11. Mark RUNNING
```

任何一步失败：

```text
→ 记录失败状态
→ 释放 Reservation
→ 清理已创建资源
→ 写 CleanupReceipt
```

ResourceLedger 不能只算 CPU 和内存。必须统一处理：

```text
cpu
memory
pids
temporary disk
network slots
service ports
cache write locks
backend slots
```

## LR2-0H：Receipt 必须只记录真实观测

建议拆成三类：

```text
ExecutionStartReceipt
ExecutionExitReceipt
CleanupReceipt
```

最终 `SandboxReceipt` 是三者的聚合，而不是执行一结束便假定清理成功。

字段应支持：

```ts
type Observed<T> =
  | { status: "observed"; value: T }
  | { status: "unsupported"; reason: string }
  | { status: "unknown"; reason: string }
```

禁止：

```ts
cgroupRemoved: true // 没有实际检查
metrics: {}         // 却被当作完整 Receipt
```

实际指标来源：

```text
cpu.stat
memory.current
memory.peak
memory.events
pids.current
io.stat
cgroup.events
backend inspect
workspace diff
network gateway log
```

## LR2-0I：Receipt 绑定 Graph Evidence

Graph 节点不能只依据 ToolResult 判断完成。

完成链应为：

```text
ToolResult
+ Final Receipt
+ Verification Evidence
+ Ownership Evidence
→ Node Completion Gate
```

写节点完成条件：

```text
exitCode 满足要求
AND Receipt 完整
AND 没有未批准写入
AND Cleanup 满足策略
AND Verification 通过
```

服务节点除外，它进入 `SERVICE_READY`，不能使用短任务完成语义。

## LR2-0J：取消与清理

取消顺序：

```text
1. Cell 状态 → CANCELLING
2. cgroup.freeze，可用时先冻结
3. 请求优雅终止
4. 等待 grace period
5. cgroup.kill
6. 等待 cgroup.events populated=0
7. 清理 mount/container/workspace/port/cache lock
8. 释放 Reservation
9. 写 CleanupReceipt
```

`cgroup.kill` 能对整个子树生效并处理并发 fork；`cgroup.events` 可确认子树是否仍有活动进程。

### LR2-0 最终 Gate

```text
DIRECT_PRODUCT_PROCESS_BYPASS          = 0
HOST_ENVIRONMENT_IMPLICIT_INHERIT      = 0
UNRESERVED_CELL_START                  = 0
PROCESS_OUTSIDE_CELL_CGROUP            = 0
RECEIPT_UNOBSERVED_SUCCESS_FIELD       = 0
RECEIPT_WITHOUT_VALID_DIGEST           = 0
WRITE_NODE_WITHOUT_EXECUTION_EVIDENCE  = 0
CANCELLED_CELL_PROCESS_REMAINS         = 0
CLEANUP_RESOURCE_LEAK                  = 0
```

只有这些全部关闭，才能进入 execd。

---

## 五、LR2-1：orcana-execd

## 1. 定位

`orcana-execd` 是：

```text
非特权 Linux 执行控制平面
```

它不是：

```text
Graph Scheduler
Agent Planner
Harness Permission Authority
全局完成权威
秘密仓库
Root Daemon
```

## 2. 推荐实现边界

第一版继续使用 TypeScript/Bun：

```text
packages/exec-protocol/
src/execd/
├── server.ts
├── session-manager.ts
├── cell-manager.ts
├── run-manager.ts
├── lease-manager.ts
├── event-stream.ts
├── state-store.ts
└── recovery.ts
```

Native 部分单独使用 Rust：

```text
native/orcana-cell-launcher/
native/orcana-cell-init/
```

这样不会因为要开发 daemon 就立即把整个 Runtime 改写成 Rust。

## 3. Unix Socket

默认路径：

```text
$XDG_RUNTIME_DIR/orcana/execd.sock
```

要求：

```text
目录权限 0700
SocketMode 0600
禁止放在 /tmp
拒绝其他 UID
```

使用 Unix Socket 的 `SO_PEERCRED` 获取连接方 PID、UID、GID，而不是相信客户端自己上报身份。Linux 会返回连接建立时的对端凭据。

## 4. 本地 RPC

第一版不要引入 gRPC。使用：

```text
4-byte frame length
+ UTF-8 JSON payload
```

核心方法：

```text
Hello
SubmitCell
WatchCell
GetCell
CancelCell
CancelAgent
CancelRun
CleanupRun
AcquireLease
RenewLease
ReleaseLease
AttachLogs
ListRecoverableRuns
```

每个请求必须包含：

```text
protocolVersion
requestId
idempotencyKey
sessionId
sequence
payload
approvalToken
```

每个事件必须包含单调递增 `eventSequence`，TUI 重连后从最后确认的序号继续读取。

## 5. 持久化状态

不要继续把独立 JSON 文件作为权威状态库。

使用 SQLite：

```text
runs
domains
cells
cell_attempts
cell_events
reservations
leases
receipts
cleanup_actions
service_cells
port_leases
cache_locks
idempotency_keys
```

关键模式：

```text
append-only cell_events
+ materialized current_state
```

状态迁移、Reservation 和 idempotency response 必须在一个数据库事务内提交。

Artifact、stdout 和大日志不放进数据库主体：

```text
SQLite 保存索引
Filesystem/CAS 保存大对象
```

## 6. systemd 用户服务

初期使用普通 user service，由 execd 自己绑定 Socket。稳定后再增加 systemd socket activation。

建议服务属性：

```ini
[Service]
ExecStart=%h/.local/bin/orcana-execd
Restart=on-failure
UMask=0077
Delegate=cpu memory pids io
NoNewPrivileges=yes
```

初期不要求 execd 自身崩溃后 Cell 继续运行。第一目标是：

```text
CLI / TUI / Agent 主进程崩溃
→ execd 和 Cell 仍然存在
→ 新客户端可重连
```

如果需要用户退出登录后仍运行，再由用户显式启用 lingering。systemd 的 lingering 会让 user manager 在开机时启动并在用户退出后继续存在。

## 7. 恢复

execd 启动后逐个检查非终态 Attempt：

```text
状态 RESERVED
→ 没有 cgroup
→ 释放预留并标记 START_FAILED

状态 STARTING
→ 有 cgroup，无进程
→ 标记 START_FAILED

状态 RUNNING
→ cgroup populated=1
→ 重新接管监控

状态 RUNNING
→ cgroup populated=0
→ 读取退出记录或标记 EXIT_STATUS_UNKNOWN

状态 EXIT_OBSERVED
→ 无 Receipt
→ 从现存观测生成 Recovery Receipt

状态 RECEIPT_COMMITTED
→ 无 Evidence
→ 通知 Graph 重新执行 Evidence Binding

状态 CLEANUP_PENDING
→ 幂等继续清理
```

外部副作用节点不能直接重跑：

```text
Git push
发布
发消息
写远程数据库
上传 Artifact
```

必须进入：

```text
SIDE_EFFECT_UNKNOWN
→ 使用对应外部系统查询
→ reconcile
→ commit / retry / human intervention
```

## LR2-1 Gate

```text
CLIENT_CRASH_LOSES_CELL                  = 0
DUPLICATE_SUBMIT_STARTS_SECOND_CELL      = 0
UNAUTHENTICATED_LOCAL_CLIENT             = 0
EVENT_SEQUENCE_GAP_UNDETECTED            = 0
NONTERMINAL_CELL_LOST_AFTER_RESTART       = 0
SAME_BOOT_CRASH_UNRECOVERED               = 0
UNKNOWN_SIDE_EFFECT_BLIND_RETRY           = 0
```

---

## 六、LR2-2：Performance Plane

## 1. Sandbox Plan Cache

缓存对象：

```text
CompiledSandboxPlan
├── profileDigest
├── toolContractDigest
├── runtimeVersion
├── platform
├── backendVersion
├── policyDigest
├── mountTemplate
├── environmentTemplate
├── backendArgvTemplate
├── seccompObjectRef
└── validationResult
```

运行时只允许注入：

```text
Cell identity
workspace path
resource values
arguments
secret handles
temporary paths
```

缓存内容中不得出现秘密值、真实 Token、临时端口或某次 Cell 的路径。

## 2. 内容寻址缓存

目录建议：

```text
~/.cache/orcana/
├── cas/sha256/
├── objects/
├── staging/
├── locks/
├── manifests/
└── cache.db
```

写入流程：

```text
创建 staging
→ 写入
→ 计算 digest
→ 校验 producer Receipt
→ 原子 rename
→ 标记 immutable
→ 发布 manifest
```

缓存状态：

```text
STAGING
VALID
QUARANTINED
INVALID
EVICTING
```

禁止多个 Cell 直接共享可写 `node_modules`。

应优先缓存：

```text
Bun/npm 下载缓存
依赖安装只读层
TypeScript build info
Repo Map
AST index
测试发现结果
构建 Artifact
RootFS
```

## 3. Overlay Workspace

顺序：

```text
native OverlayFS
→ fuse-overlayfs
→ Git Worktree fallback
```

结构：

```text
lowerdir = 基础只读仓库快照
upperdir = Agent 写层
workdir  = Overlay 内部工作目录
merged   = Cell 可见工作区
```

Git 仍负责：

```text
版本事实
提交
合并
回滚
```

Overlay 负责：

```text
瞬时克隆
写入差异
失败丢弃
Reviewer 只读快照
Evolution 候选复制
```

Landlock 与 OverlayFS 组合时，必须针对最终 merged hierarchy 建立规则，不能假设限制 lower/upper 层就会自动限制合并视图。内核文档明确指出 OverlayFS 各层和 merged hierarchy 在 Landlock 看来是独立文件层级。

## 4. Bubblewrap 与 Podman 分工

Bubblewrap 创建独立 mount namespace，并由调用方精确选择沙盒中可见的文件系统路径，因此适合日常低冷启动 Cell。

Rootless Podman 使用 user namespace，不会获得启动用户本身没有的宿主权限；但需要正确配置 subordinate UID/GID，且 rootless storage、网络和 OverlayFS 存在宿主能力约束。

推荐：

| Backend         | 用途                            |
| --------------- | ----------------------------- |
| Bubblewrap      | inspect、普通 build、普通 test      |
| Rootless Podman | 严格工具链、镜像复现、依赖安装、需要 OCI RootFS |
| Host Audit      | 仅明确批准的兼容降级                    |
| MicroVM         | 极高风险执行                        |

## LR2-2 Gate

先运行固定基准并记录冷启动、热启动和缓存命中基线，再确定硬阈值。不得在没有基线的情况下随意规定性能数字。

至少验证：

```text
CACHE_KEY_COLLISION             = 0
CACHE_CROSS_POLICY_REUSE        = 0
CACHE_POISON_PROMOTION          = 0
CONCURRENT_CACHE_WRITE_CORRUPT  = 0
FAILED_CELL_POLLUTES_CACHE      = 0
OVERLAY_WRITE_ESCAPES_UPPER     = 0
WARM_START_REGRESSION           = 0
```

---

## 七、LR2-3：Adaptive Scheduler

## 1. 不要一开始使用机器学习

第一版采用可解释统计模型：

```text
WorkloadFingerprint
→ HistoricalResourceProfile
→ Quantile Estimate
→ Reservation
→ Actual Usage
→ Calibration
```

## 2. WorkloadFingerprint

建议字段：

```text
tool kind
command family
repository class
file-count bucket
lockfile digest
test-count bucket
backend
profile
cache state
runtime family
previous failure class
```

不要把完整命令参数直接作为唯一 fingerprint，否则样本会过度碎片化。

## 3. HistoricalResourceProfile

记录：

```text
sampleCount
cpuUsec p50/p90/p99
peakMemory p50/p90/p99
wallTime p50/p90/p99
peakPids
read/write bytes
failure rate
oom rate
cache hit rate
lastUpdatedAt
```

估算规则：

```text
无历史
→ 使用 Tool/Profile 保守模板

少量历史
→ max(default, observed max × safety factor)

稳定历史
→ p90/p95 + safety margin

发生 OOM
→ 快速提高 memory estimate

连续稳定
→ 缓慢降低 estimate
```

"升得快、降得慢"，避免调度器因为偶然低使用量持续压低资源。

## 4. PSI 背压

Linux PSI 可在系统级和 cgroup 级提供 CPU、memory、I/O stall 信息，并支持事件触发。

调度器输入：

```text
/proc/pressure/cpu
/proc/pressure/memory
/proc/pressure/io

cell cgroup:
cpu.pressure
memory.pressure
io.pressure
```

策略状态：

```text
NORMAL
CONSTRAINED
CRITICAL
RECOVERY
```

行为：

| 状态          | 调度行为                  |
| ----------- | --------------------- |
| NORMAL      | 正常启动                  |
| CONSTRAINED | 停止低优先级预取和 Evolution   |
| CRITICAL    | 暂停新 build/test，保留交互任务 |
| RECOVERY    | 逐步恢复并发，防止振荡           |

阈值必须从真实机器基线校准，而不是复制云服务器参数。

## 5. Graph 关键路径

当前 Graph Scheduler 主要使用 `maxParallel`、ReadyQueue、读并发和单写者锁；Linux Runtime 的资源情况还没有成为调度输入。

增加：

```text
criticalPathLength
downstreamBlockedCount
userVisibility
verificationImportance
estimatedDuration
estimatedResourceCost
cacheHitProbability
retryRisk
```

推荐优先级模型：

```text
priority =
  criticality
+ userVisibility
+ downstreamUnlockValue
+ verificationValue
+ cacheOpportunity
- resourcePressureCost
- retryRisk
```

先保留显式字段和决策日志，不要把公式隐藏成不可解释评分。

## 6. 公平性

至少使用：

```text
Run-level weighted fair queue
+ Agent concurrency budget
+ Evolution hard quota
+ Interactive reserved capacity
```

不能让一个大型测试 Run 占满所有 Cell slot。

## 7. Work Stealing

只在以下条件全部成立时迁移：

```text
节点尚未开始
新 Agent 具备相同 capability
重新生成 ParticipantAssignment
文件所有权不扩大
秘密重新授权
私有上下文依赖为 false
生成新的 Node Attempt
```

## 8. 推测执行

第一批只允许：

```text
测试发现
依赖扫描
Repo Map
Reviewer 预分析
缓存预热
只读索引
```

提交前重新验证：

```text
inputDigest
workspaceDigest
policyDigest
toolchainDigest
```

不一致则丢弃，不得将过期推测结果写入 Evidence。

---

## 八、LR2-4：Strong Isolation

## 1. `orcana-cell-init`

建议 Rust 实现，保持在极小范围：

```text
native/orcana-cell-init/
├── plan.rs
├── fd.rs
├── landlock.rs
├── seccomp.rs
├── rlimit.rs
├── env.rs
└── exec.rs
```

固定执行顺序：

```text
1. 从受保护 FD 读取 CellPlan
2. 校验 schema、digest 和授权
3. 关闭未授权 FD
4. 设置 rlimits
5. 设置 no_new_privs
6. 应用 Landlock
7. 应用 seccomp
8. 设置 cwd 和显式环境
9. execve target
```

它不负责：

```text
Graph
缓存选择
网络策略解释
秘密存储
调度
复杂配置解析
```

Landlock 允许非特权进程缩小自身 ambient rights，并会把限制继承给后代；seccomp BPF 用于缩小进程可使用的 syscall 面。

## 2. seccomp Profile

Profile 维度：

```text
runtimeFamily
+ toolKind
+ sandboxProfile
+ architecture
```

首批：

```text
node-bun-readonly
node-bun-build
python-readonly
git
compiler
unknown-deny
```

演进流程：

```text
observe
→ candidate
→ compatibility replay
→ security replay
→ canary
→ enforce
```

观察结果只能生成候选，不允许自动晋升。

## 3. Egress Gateway

分三步实施：

### E1：记录模式

```text
代理记录 DNS、目标 Host、端口、方法和字节数
但不宣称无法绕过
```

### E2：强制路由模式

```text
Cell netns
→ 无直接外部默认路由
→ 只能到 Gateway
→ Gateway 执行 DNS/Host/Port Policy
```

### E3：泄漏检测

```text
上传字节预算
敏感模式扫描
重定向逐跳检查
DNS rebinding 防护
请求方法限制
目标分类
```

只有通过"原始 socket 绕过、重定向绕过、DNS 重绑定、IPv6 绕过"等评测，才能把 `proxy-allowlist` 标记为强制安全。

## 4. MicroVM

Firecracker 需要 KVM 和 `/dev/kvm` 访问；生产环境还应使用 jailer、cgroup、namespace 和 seccomp 等多层限制。因此它不是普通 rootless Cell 的直接替代品，而是具备明确宿主能力时的 extreme-risk Backend。

适用：

```text
未知二进制
递归生成的运行时代码
供应链恶意样本
安全实验
Evolution Kernel 候选
```

不适用：

```text
普通 Git
普通测试
普通 TypeScript build
Repo Map
```

---

## 九、LR2-5：Durable Service Cell

必须建立独立合同，不能在普通 Cell 上增加一个 `serviceMode=true` 就结束。

## Service 状态机

```text
DECLARED
→ STARTING
→ PROCESS_RUNNING
→ READINESS_PENDING
→ READY
→ DEGRADED
→ RESTARTING
→ STOPPING
→ STOPPED
```

异常：

```text
START_FAILED
HEALTH_FAILED
LEASE_EXPIRED
OWNER_LOST
PORT_CONFLICT
RESTART_EXHAUSTED
```

## ServiceCellSpec

```text
serviceId
ownerRunId
ownerAgentId
command
workspace
dependencies
portRequests
readinessProbe
healthProbe
restartPolicy
leasePolicy
logPolicy
shutdownContract
retentionPolicy
```

## 核心原则

```text
Lease 到期
≠ 立即盲杀

Owner Run 中断
→ 根据 retentionPolicy
  ├── retain
  ├── pause
  ├── terminate
  └── transfer ownership
```

LSP、MCP、开发服务器和本地数据库应逐步迁移到这一模型。

---

## 十、LR2-6：Evolution Lab

Evolution Lab 不能只是"让新版本跑测试"。

## 不可信边界

候选版本不得控制：

```text
测试集
评分器
基线版本
环境构造
失败样本
晋升条件
回滚条件
```

## 执行流程

```text
Capability Gap
→ Proposal
→ Candidate Commit
→ Immutable Evaluation Manifest
→ Baseline Environment
→ Candidate Environment
→ Replay
→ Security Evaluation
→ Performance Evaluation
→ Differential Report
→ Canary
→ Human Approval
→ Promotion
→ Regression Watch
```

## Environment Digest

```text
source digest
lockfile digest
toolchain digest
rootfs/image digest
kernel capability digest
CellSpec
network policy
resource policy
evaluator version
benchmark manifest digest
```

## 晋升要求

```text
正确性不下降
安全 Gate 不下降
关键性能满足阈值
失败样本未减少或隐藏
评测器未变化
候选未写入基线
Canary 未出现新回归
```

---

## 十一、LR2-7：Remote Workers

远程协议应复用本地语义：

```text
Submit Cell
Watch Events
Cancel
Lease
Receipt
Artifact
Recovery
```

## Coordinator

负责：

```text
Graph authority
Assignment
Policy authorization
Worker selection
Lease
Receipt verification
Evidence binding
Completion
```

## Worker

负责：

```text
声明能力
验证 CellPlan
本地资源预留
执行
监控
清理
生成 Receipt
上传 Artifact
```

## 必须区分两个概念

### Signed Receipt

只能证明：

```text
"这份 Receipt 由持有该 Worker 密钥的一方生成"
```

不能自动证明：

```text
"Worker 报告的内容一定真实"
```

若需要更强真实性，需要后续引入：

```text
TPM
measured boot
TEE
remote attestation
trusted worker admission
```

第一版只在受信 Worker 集群内使用：

```text
mTLS
Worker identity key
CellPlan signature
Lease fencing token
Artifact digest
Receipt signature
```

Worker 永远不能拥有全局完成权。

---

## 十二、现在应直接执行的前 20 个任务

严格按以下顺序，不要并行展开 Performance、MicroVM 或 Work Stealing。

## Batch A：修复事实基础

1. 编写 `ADR-LR2-001 Execution Authority`。
2. 编写 `ADR-LR2-002 Cell State Machine`。
3. 编写 `ADR-LR2-003 Receipt and Evidence Boundary`。
4. 修复递归 canonical JSON 和 digest golden tests。
5. 将 Receipt 所有未观测成功默认值改为 `unknown`。
6. 建立全仓 `child_process` Inventory。
7. 新增 child-process CI bypass Gate。

## Batch B：建立统一入口

8. 新建 `ExecutionGateway`。
9. 新建 `ExecutionIntent` 和 `ExecutionContext`。
10. 建立 `ExecutionCellSpecBuilder`，只接收受信 Context。
11. 将 `run_process` 迁移到 Gateway。
12. 将 `run_shell_script` 迁移到 Gateway。
13. 增加 shadow parity 评测。

## Batch C：接入真实 Linux 资源

14. 用 systemd 正式委托 execd/当前 Runtime cgroup。
15. 修正 delegated root 探测，只使用自身被委托子树。
16. 将 ResourceLedger 接入 Broker。
17. 将 CgroupManager 接入 Cell 启动和取消。
18. 增加 launcher handshake，关闭 attach 竞态。
19. 从真实 cgroup 生成 metrics 和 CleanupReceipt。
20. 将 Receipt 绑定 Graph Evidence 和完成 Gate。

完成第 20 项并通过 LR2-0 Gate 后，才创建 `orcana-execd`。

---

## 十三、阶段禁止项

在 LR2-0 未通过前禁止投入主线：

```text
MicroVM Backend
Work Stealing
推测执行
复杂 PSI 调度
机器学习资源预测
远程 Worker
Evolution 自动晋升
完整 Egress Gateway
大规模 CAS
```

可以写 ADR 和实验 Spike，但不能进入 Production 主路径。

---

## 十四、每阶段对应的 Linux 学习顺序

## LR2-0 前

必须掌握：

```text
进程、PID、process group
signal、SIGTERM、SIGKILL
/proc
cgroup v2 基础
mount namespace
环境变量与 FD
```

实践验收：

```text
能创建一个 cgroup
能把进程放进去
能限制 memory/pids
能读取 memory.events
能用 cgroup.kill 清理整个树
```

## LR2-1 前

必须掌握：

```text
Unix Domain Socket
SO_PEERCRED
systemd user service
cgroup delegation
SQLite transaction/WAL
进程重连和幂等
```

实践验收：

```text
CLI 退出后 daemon 仍运行
第二个 CLI 能重连并读到事件
重复 requestId 不会启动第二个进程
daemon 重启能识别未完成 Attempt
```

## LR2-2 前

必须掌握：

```text
VFS
bind mount
OverlayFS
fuse-overlayfs
inode、rename、文件锁
content-addressed storage
```

## LR2-4 前

必须掌握：

```text
no_new_privs
Landlock
seccomp
network namespace
DNS 与代理绕过
KVM 基础
```

学习必须与当前阶段代码和评测绑定，不要先去学大量日常 Linux 运维命令。

---

## 十五、最终阶段判断标准

LNXF 结束的标准不是"文件都存在"，而是：

```text
每个真实进程都能回答：

谁批准了它？
它属于哪个 Run、Node、Agent 和 Attempt？
执行前预留了什么资源？
进入了哪个 cgroup？
看见了哪些文件？
具有什么网络权限？
使用了什么工具链和缓存？
产生了哪些写入？
为何退出？
是否真正清理？
哪个 Receipt 证明？
哪个 Evidence 允许 Graph 宣布完成？
```

回答不了其中任何一个问题，该执行都还没有真正进入 Orcana Linux Execution Fabric。
