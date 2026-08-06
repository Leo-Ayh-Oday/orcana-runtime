# LNXF Production Closure R2 完整修复实施计划

## 0. 文档状态

```text
计划名称：LNXF Production Closure R2
审查基线：3bbf44298ebb63c4f8b048b23c1037ad89c16f82
当前版本：0.8.26.1
实施类型：生产底座封口
优先级：STOP-LINE / P0
```

本计划用于关闭 Orcana Linux Execution Foundation 当前剩余的生产级缺陷。

本轮不新增 Service Cell、Fleet、长期自治、多 Agent 自进化等上层能力。所有工作只围绕以下四个核心问题：

1. 执行权威是否唯一；
2. 资源获取和释放是否原子；
3. Receipt 是否只有一份最终真相；
4. 失败、取消、崩溃和恢复是否可验证。

当前 `CapabilityRequest` 同时包含工具声明字段、运行身份字段和 `worktreeRoot`，与"身份由 Runtime 生成"的注释不一致；当前运行时身份字段也仍是可选字段。

---

# 1. 当前状态与冻结结论

在本计划全部关闭前，项目状态统一为：

```text
LNXF_COMPONENT_IMPLEMENTATION:      PARTIAL_PASS
LNXF_PRODUCTION_INTEGRATION:        FAIL
LNXF_AUTHORITY_CLOSURE:             FAIL
LNXF_FAILURE_ATOMICITY:             FAIL
LNXF_EVIDENCE_DURABILITY:           FAIL
LNXF_MULTI_AGENT_ISOLATION:         FAIL
LINUX_FOUNDATION_FREEZE:            REVOKED
M8 / SERVICE CELL / FLEET:          BLOCKED
```

允许继续：

* LNXF 修复；
* 不依赖 Linux 执行权威的 Graph、Context、Memory 研究；
* Shadow 模式实验；
* 文档和测试基础设施建设。

禁止继续：

* 宣布 Linux Foundation 稳定；
* 使用 `enabled/enforced` 执行不可信代码；
* 携带真实 Secret；
* 多 Agent 并发写入；
* Service Cell；
* Agent Fleet；
* 长期进程托管；
* 依据当前 Receipt 自动发布或自动完成任务。

---

# 2. 全局不可破坏不变量

所有 PR 都必须围绕以下不变量实现。

## INV-A：执行身份只能来自 Runtime

```text
模型输入
工具参数
仓库内容
MCP 返回值
```

均不得指定：

```text
runId
nodeRunId
agentId
assignmentId
domainId
workspaceId
worktreeRoot
ownerFiles
cellId
```

这些字段只能从可信 Runtime Context 注入。

---

## INV-B：宿主目录不能由工具参数决定

模型可以声明逻辑工作目录，例如：

```text
.
src
packages/runtime
```

模型不得声明宿主物理路径，例如：

```text
/
~/.ssh
/home/user
/tmp/other-project
```

最终宿主路径必须满足：

```text
requestedRelativeCwd
→ Runtime AuthorizedWorkspace
→ canonical resolve
→ containment check
→ backend host cwd / mount
```

---

## INV-C：PID 0、PID 1 和 Runtime 自身 PID 永远不能进入 Cell cgroup

任何 cgroup attach 前必须保证：

```text
Number.isSafeInteger(pid)
pid > 1
pid !== process.pid
/proc/<pid> 确实存在
目标进程处于 pre-exec stopped 状态
```

---

## INV-D：用户载荷只能在 cgroup attach 成功后启动

正确顺序必须是：

```text
spawn exec-gate
→ gate 自停 SIGSTOP
→ Runtime 验证 PID
→ attach cgroup
→ 验证 /proc/<pid>/cgroup
→ SIGCONT
→ exec 真实目标
```

严禁：

```text
spawn 用户程序
→ 用户代码开始执行
→ 再尝试 attach
```

---

## INV-E：每次资源获取必须立即登记补偿操作

任何操作：

```text
reserve
lock
domain reserve
cgroup create
secret materialize
seccomp materialize
container create
state write
```

必须遵守：

```text
获取成功
→ 立即登记 compensation
→ 才能进入下一阶段

```

不能依赖 `cellRuns` 是否已经登记来决定是否回滚。

---

## INV-F：Receipt 只能由 Broker 在完整清理后最终构造

Backend 不得构造最终 Receipt。

Backend 只能返回：

```text
RawExecutionOutcome
BackendFacts
```

Broker 必须完成：

```text
进程退出
→ 指标采集
→ 容器清理
→ cgroup 清理
→ Secret 清理
→ 临时文件清理
→ 清理验证
→ 构造 Final Receipt
→ 原子持久化
→ 读回校验
→ 发送唯一 cell.receipt
```

---

## INV-G：事件流 Receipt、Evidence Receipt 和 StateStore Receipt 必须完全一致

必须满足：

```text
emittedReceipt.receiptDigest
===
persistedReceipt.receiptDigest
===
evidenceEntry.receiptDigest
```

并且：

```text
canonicalJson(emittedReceipt)
===
canonicalJson(persistedReceipt)
```

---

## INV-H：同一物理 Workspace 必须共享同一锁

锁键不能使用：

```text
worktree:<agentId>
```

必须使用：

```text
workspace:<workspaceId>
```

其中 `workspaceId` 由 canonical physical root 生成或由可信 Workspace Registry 分配。

两个 Agent 指向同一物理目录时，必须冲突。

---

## INV-I：无 cgroup 时取消仍然必须生效

取消顺序固定为：

```text
AbortController.abort()
→ Supervisor terminateTree()
→ cgroup.kill（存在时）
→ container rm -f（存在时）
→ 等待清理验证
```

cgroup 是第二通道，不是取消成立的前提。

---

## INV-J：能力缺失不能用 SKIP 冒充 Freeze

以下能力必须有独立真实 Lane：

```text
Bubblewrap
Rootless Podman
cgroup v2 delegation
```

声明 Freeze 时，关键 Lane 不允许 SKIP。

---

# 3. 实施顺序

严格按照以下顺序实施：

| 顺序 | PR    | 主题                                        |
| -- | ----- | ----------------------------------------- |
| 0  | R2-0  | 状态撤销与修复线建立                                |
| 1  | PR-9  | Execution Authority 与 Workspace Authority |
| 2  | PR-10 | Spawn Gate 与 cgroup attach 原子化            |
| 3  | PR-11 | Broker 事务状态机与补偿栈                          |
| 4  | PR-12 | Final Receipt 单一真相与持久化                    |
| 5  | PR-13 | Agent Domain、聚合预算、取消与锁                    |
| 6  | PR-14 | Podman、Secret、Seccomp 与 Recovery          |
| 7  | PR-15 | 真实攻击评测、CI Lane 与 Freeze Gate              |

禁止并行修改同一个核心执行文件。

尤其禁止 PR-9～PR-14 同时修改 `broker.ts` 后再一次性解决冲突。

---

# 4. R2-0：立即撤销错误完成状态

## 4.1 目标

在代码修复前，先消除错误状态声明，避免后续开发继续依赖不稳定底座。

## 4.2 修改文件

```text
docs/linux-foundation/acceptance-matrix.md
docs/reliability/defect-register.yaml
docs/reliability/gate-matrix.md
CHANGELOG.md
```

## 4.3 修改内容

统一写入：

```text
LNXF PR-1~8:
  component fixes: completed
  production closure: revoked
  R2 closure: required
  freeze: blocked
```

新增缺陷编号：

```text
LNXF-R2-P0-01  Untrusted Workspace Authority
LNXF-R2-P0-02  PID Zero / Runtime Self-Attach
LNXF-R2-P0-03  Broker Compensation Leak
LNXF-R2-P0-04  Receipt Double Truth
LNXF-R2-P0-05  Domain Budget Not Authoritative
LNXF-R2-P0-06  Podman Host CWD Invalid
LNXF-R2-P0-07  Strict Isolation Fail-Open
LNXF-R2-P0-08  Physical Workspace Lock Bypass
```

## 4.4 完成条件

```text
所有文档不再出现：
LNXF production complete
Linux Foundation frozen
M8 unblocked
```

---

# 5. PR-9：Execution Authority 与 Workspace Authority 封口

## 5.1 目标

彻底分离：

```text
不可信能力声明
```

和：

```text
可信执行权威
```

当前 `CapabilityRequest` 仍包含 `worktreeRoot`、`ownerFiles` 和身份字段，必须移除。

---

## 5.2 新增核心类型

修改：

```text
src/runtime/linux/contracts.ts
src/runtime/execution-context.ts
```

新增：

```ts
export interface UntrustedCapabilityRequest {
  command: {
    executable: string
    args: string[]
    relativeCwd?: string
    stdin?: "closed" | "pipe"
  }

  profile: ExecutionProfile
  network?: {
    mode: NetworkMode
    allowedHosts?: string[]
    allowedPorts?: number[]
  }

  env?: Record<string, string>
  timeoutMs?: number
  stdoutMaxBytes?: number
  stderrMaxBytes?: number
  memoryMaxBytes?: number
  pidsMax?: number

  writableMounts?: RequestedMount[]
  readonlyMounts?: RequestedMount[]
  cache?: CacheMountRequest[]
}
```

该类型中禁止出现：

```text
runId
nodeRunId
cellId
agentId
assignmentId
domainId
workspaceId
worktreeRoot
ownerFiles
absolute cwd
```

新增：

```ts
export interface AuthorizedWorkspace {
  workspaceId: string
  projectId: string

  /** realpath 后的物理根目录。 */
  hostRoot: string

  /** main/worktree/system。 */
  kind: "main" | "worktree" | "system"

  /** 是否允许写入。 */
  access: "readonly" | "readwrite"

  /** Runtime 分配的文件所有权。 */
  ownerFiles: readonly string[]
}

export interface TrustedExecutionIdentity {
  runId: string
  nodeRunId: string
  attempt: number
  agentId?: string
  assignmentId?: string
}

export interface TrustedExecutionAuthority {
  identity: TrustedExecutionIdentity
  workspace: AuthorizedWorkspace
  domainId?: string
}
```

---

## 5.3 Workspace Registry

新增文件：

```text
src/runtime/linux/workspace/workspace-authority.ts
```

实现：

```ts
export class WorkspaceAuthorityRegistry {
  registerMainWorkspace(...)
  registerAgentWorktree(...)
  get(workspaceId)
  require(workspaceId)
  resolveCwd(workspace, requestedRelativeCwd)
  verifyOwnerFiles(workspace, files)
}
```

### `register*` 必须执行

```text
realpath(hostRoot)
目录存在性检查
拒绝根目录 /
拒绝真实 HOME 根
拒绝 .ssh/.gnupg/.aws/.kube 等路径
拒绝容器 socket 目录
生成稳定 workspaceId
```

建议：

```ts
workspaceId = `ws_${digestOf({
  projectId,
  canonicalHostRoot,
  kind
})}`
```

同一物理目录必须生成同一锁身份。

---

## 5.4 相对工作目录解析

实现：

```ts
resolveAuthorizedCwd(
  workspace: AuthorizedWorkspace,
  requestedRelativeCwd?: string,
): string
```

规则：

1. 默认值为 `"."`；
2. 拒绝绝对路径；
3. 拒绝空字节；
4. `resolve(workspace.hostRoot, relativeCwd)`；
5. 对最近存在父目录执行 `realpath`；
6. 确保最终路径位于 `workspace.hostRoot` 内；
7. 防止符号链接逃逸；
8. 不存在目录直接拒绝；
9. 返回 canonical host cwd。

错误码：

```text
EXECUTION_AUTHORITY_MISSING
WORKSPACE_NOT_AUTHORIZED
WORKSPACE_PATH_ESCAPE
WORKSPACE_CWD_MISSING
WORKSPACE_READONLY
WORKSPACE_OWNER_FILE_VIOLATION
```

---

## 5.5 Runtime Context 修改

当前 `ExecutionIdentity` 全部是可选字段，并存在 legacy compatibility fallback。

新增：

```ts
const EXECUTION_AUTHORITY =
  createRuntimeContextKey<TrustedExecutionAuthority | undefined>(
    "execution-authority",
    () => undefined,
  )

export function setExecutionAuthority(
  authority: TrustedExecutionAuthority,
): void

export function getExecutionAuthority():
  TrustedExecutionAuthority | undefined

export function requireExecutionAuthority():
  TrustedExecutionAuthority
```

生产 Linux 执行路径禁止使用 legacy compatibility context。

只有以下情况允许没有 Authority：

```text
shadow compile test
纯策略单元测试
显式 system authority
Windows legacy path
```

---

## 5.6 Policy Compiler 修改

修改：

```text
src/runtime/linux/policy-compiler.ts
```

接口从：

```ts
compileCapabilityRequest(request, ctx?)
```

修改为：

```ts
compileCapabilityRequest(
  request: UntrustedCapabilityRequest,
  authority: TrustedExecutionAuthority,
): CompileResult
```

权威优先级必须变成：

```text
authority identity：唯一来源
authority workspace：唯一来源
request：只能声明能力和资源需求
```

生成：

```ts
identity = {
  cellId: runtimeGeneratedCellId,
  ...authority.identity,
}

filesystem.worktreeRoot = authority.workspace.hostRoot
filesystem.ownerFiles = [...authority.workspace.ownerFiles]
command.cwd = resolveAuthorizedCwd(
  authority.workspace,
  request.command.relativeCwd,
)
```

工具请求不得覆盖任何 Authority 字段。

---

## 5.7 ProcessExecutor 修改

修改：

```text
src/runtime/process-executor.ts
src/tools/process.ts
```

`ProcessRequest` 分为：

```ts
export interface ProcessRequest {
  command: string
  args: string[]

  /** Linux 下只能表示 AuthorizedWorkspace 内相对路径。 */
  cwd?: string

  env?: Record<string, string>
  timeoutMs?: number
  abortSignal?: AbortSignal
  profile?: ExecutionProfile
  network?: NetworkMode
}
```

移除：

```text
runId
nodeRunId
agentId
domainId
assignmentId
attempt
worktreeRoot
ownerFiles
```

Linux 路径：

```text
ProcessRequest
→ UntrustedCapabilityRequest
→ requireExecutionAuthority()
→ broker.compileRequest(request, authority)
```

Windows legacy 可暂时保留绝对 `cwd` 语义，但必须明确与 Linux 路径分离。

---

## 5.8 Agent 入口接线

修改 Agent Loop 进入点。

在 Agent Run 创建后：

```text
确定 project root
注册 main workspace
创建 runId/nodeRunId
创建 TrustedExecutionAuthority
进入 AsyncLocalStorage Scope
```

每个子 Agent Worktree 创建后：

```text
注册 Agent Worktree
建立 Agent Domain
生成新的 Authority
在子 Agent Scope 中注入
```

禁止工具层自行推导 cwd 为 Workspace Root。

---

## 5.9 测试

新增：

```text
tests/runtime/linux/execution-authority.test.ts
tests/runtime/linux/workspace-authority.test.ts
```

必须覆盖：

```text
EA-001 请求无法声明 runId
EA-002 请求无法声明 agentId
EA-003 请求无法声明 worktreeRoot
EA-004 相对 cwd 正常解析
EA-005 cwd=/ 被拒绝
EA-006 cwd=/home/user 被拒绝
EA-007 cwd=../../outside 被拒绝
EA-008 symlink 指向 workspace 外被拒绝
EA-009 同物理根生成同一 workspace lock identity
EA-010 不同真实 Worktree 可并行
EA-011 enabled 模式缺少 Authority 时 fail-closed
EA-012 shadow 单元测试可使用显式 Test Authority
EA-013 ownerFiles 只来自 Authority
EA-014 模型 env 不能伪造 ORCANA_RUN_ID
```

---

## 5.10 PR-9 完成条件

```text
CapabilityRequest 中身份字段数量：0
CapabilityRequest 中宿主路径字段数量：0
ProcessRequest 中执行身份字段数量：0
Linux enabled 执行无 Authority：100% 拒绝
workspace escape tests：全部通过
```

---

# 6. PR-10：Spawn Gate 与 cgroup attach 原子化

## 6.1 目标

消除：

```text
proc.pid ?? 0
→ cgroup.procs 写入 0
→ Runtime 被移动或杀死
```

当前 Supervisor 在 PID 不存在时会归一成 `0`，并立即调用 `onSpawn`；cgroup manager 又会无条件写入 `cgroup.procs`。

---

## 6.2 新增 Exec Gate

新增：

```text
src/runtime/linux/process/exec-gate.ts
```

Linux 启动命令统一包装为固定脚本：

```sh
kill -STOP $$
exec "$@"
```

实际 argv：

```text
/bin/sh
-c
'kill -STOP $$; exec "$@"'
orcana-exec-gate
<real executable>
<arg1>
<arg2>
...
```

用户参数只作为位置参数传入，禁止拼接 shell 字符串。

由于 `exec` 不创建新 PID：

```text
gate PID
===
最终 backend PID
```

cgroup 归属保持不变。

---

## 6.3 Supervisor 接口修改

修改：

```text
src/runtime/linux/process/supervisor.ts
src/runtime/linux/backends/backend.ts
```

移除同步 `onSpawn(pid)`。

新增：

```ts
export interface ProcessPreparationHooks {
  prepareProcess?: (pid: number) => Promise<void>
}

export interface SpawnedProcess {
  proc: ChildProcess
  pid: number
  prepared: boolean
}
```

启动流程：

```text
spawn exec-gate
→ 等待 spawn 事件
→ error 则失败，绝不返回 PID 0
→ 验证 pid
→ 等待 /proc/<pid>/stat 状态为 T
→ prepareProcess(pid)
→ prepareProcess 成功后 SIGCONT
→ 用户载荷启动
```

等待 Gate 停止状态最多：

```text
500ms，10ms 一次
```

超时错误：

```text
PROCESS_PREEXEC_GATE_TIMEOUT
```

---

## 6.4 PID 验证

新增：

```ts
export function assertSafeManagedPid(pid: number): void {
  if (!Number.isSafeInteger(pid)) throw ...
  if (pid <= 1) throw ...
  if (pid === process.pid) throw ...
  if (!existsSync(`/proc/${pid}`)) throw ...
}
```

在以下位置重复防御：

```text
Supervisor
Broker prepare hook
CgroupManager.attach
termination.ts
```

`terminateTree()`、`killProcessGroup()` 遇到 `pid <= 1` 必须拒绝，不能执行：

```ts
process.kill(-pid, ...)
```

---

## 6.5 cgroup attach 验证

修改：

```text
src/runtime/linux/cgroup/manager.ts
```

`attach` 返回结构化结果：

```ts
interface CgroupAttachResult {
  attached: boolean
  pid: number
  expectedPath: string
  observedPath?: string
}
```

流程：

```text
写入 cgroup.procs
→ 读取 /proc/<pid>/cgroup
→ 验证进程已进入目标 Cell cgroup
```

验证失败时：

```text
不允许 SIGCONT
立即 SIGKILL Gate
等待子进程退出
SIGCONT 前必须 SIGKILL
抛 CGROUP_ATTACH_FAILED
```

严格 Profile 下不得仅记录 degradation 后继续执行。

---

## 6.6 无 cgroup 路径

无 cgroup 时：

```text
exec-gate 自停
→ 运行时明确确认该 Profile 允许无 cgroup
→ SIGCONT
```

严格资源 Profile 不允许进入该路径。

---

## 6.7 测试

新增：

```text
tests/runtime/linux/spawn-gate.test.ts
tests/runtime/linux/runtime-self-protection.test.ts
```

必须覆盖：

```text
SG-001 不存在的 executable 不调用 prepareProcess
SG-002 不存在 executable 不写 cgroup.procs
SG-003 PID 0 被拒绝
SG-004 PID 1 被拒绝
SG-005 process.pid 被拒绝
SG-006 Gate 停止后才 attach
SG-007 attach 成功后才执行 payload
SG-008 attach 失败时 payload side effect 为 0
SG-009 attach 失败时子进程归零
SG-010 timeout 时 gate/payload 全部归零
SG-011 abort 时 gate/payload 全部归零
SG-012 Runtime /proc/self/cgroup 执行前后不变
SG-013 seccomp FD 通过 exec gate 正常继承
```

`SG-008` 使用一个会写文件的 payload：

```text
attach 被故意注入失败
→ 文件绝不能出现
```

---

## 6.8 PR-10 完成条件

```text
代码中不存在：proc.pid ?? 0
cgroup.attach(0)：不可达
用户 payload 在 attach 前执行次数：0
Runtime 自身 cgroup 变化次数：0
```

---

# 7. PR-11：Broker 事务状态机与补偿栈

## 7.1 目标

解决资源预留、锁和 cgroup 在中途失败时无法完整回滚的问题。

当前 ResourceLedger 会把成功 reservation 保存在内部 Map，只有显式 `release()` 才会释放。

---

## 7.2 新增事务模块

新增：

```text
src/runtime/linux/execution-transaction.ts
```

定义：

```ts
export type ExecutionPhase =
  | "created" | "authority_validated" | "domain_reserved"
  | "host_reserved" | "workspace_locked" | "cache_locked"
  | "cgroup_created" | "materialized" | "process_prepared"
  | "running" | "exited" | "cleaning" | "finalized" | "failed"

export interface CompensationResult {
  name: string
  success: boolean
  error?: string
}

export class ExecutionTransaction {
  readonly cellId: string
  phase: ExecutionPhase

  registerCompensation(
    name: string,
    action: () => void | Promise<void>,
  ): void

  async compensateAll(): Promise<CompensationResult[]>

  async closeNormally(): Promise<CompensationResult[]>
}
```

补偿必须：

```text
后进先出
每个补偿只执行一次
单个补偿失败不能阻止后续补偿
返回完整失败报告
```

---

## 7.3 Broker 事务顺序

修改：

```text
src/runtime/linux/broker.ts
```

执行顺序必须重构为：

```text
1. validate authority
2. compile spec
3. select backend
4. validate backend
5. create AbortController
6. create provisional CellExecutionRecord
7. reserve Agent Domain budget
8. reserve global ResourceLedger
9. acquire physical workspace lock
10. acquire cache locks
11. create Run/Agent/Cell cgroup
12. materialize seccomp/secrets/cache
13. start gated process
14. execute
15. collect raw outcome
16. cleanup transaction resources
17. finalize receipt
18. persist receipt
19. emit final receipt
20. remove active record
```

---

## 7.4 Provisional Cell Record

`cellRuns` 不能只在所有前置步骤完成后才登记。

新增：

```ts
interface CellExecutionRecord {
  cellId: string
  authority: TrustedExecutionAuthority
  phase: ExecutionPhase
  controller: AbortController
  transaction: ExecutionTransaction
  backend?: BackendId
  pid?: number
  containerId?: string
}
```

在任何资源获取前创建：

```text
phase=created
```

因此在以下阶段也可以取消：

```text
waiting resources
waiting lock
creating cgroup
materializing
preparing process
```

---

## 7.5 资源和锁补偿

每项成功后立即登记。

示例：

```ts
const reservation = ledger.reserve(...)
if (!reservation.ok) throw ...

tx.registerCompensation(
  "release-host-reservation",
  () => ledger.release(reservation.reservation.reservationId),
)
```

Workspace Lock：

```ts
if (!locks.acquire(key, "exclusive", cellId)) throw ...

tx.registerCompensation(
  "release-workspace-lock",
  () => locks.release(key, cellId),
)
```

cgroup：

```ts
const cellPath = cgroup.createCell(...)

tx.registerCompensation(
  "remove-cell-cgroup",
  async () => {
    if (!cgroup.removeCell(cellPath)) {
      throw new Error("cell cgroup not removed")
    }
  },
)
```

---

## 7.6 Cache Lock 接线

所有 Cache 必须进入事务锁。

规则：

```text
cache.mode=ro
→ shared lock

cache.mode=rw-locked
→ exclusive lock
```

锁键：

```text
cache:<kind>:<key>
```

重复请求必须去重，避免同一 Cell 重复获取相同锁。

---

## 7.7 异常语义

任何阶段抛错：

```text
record.phase = failed
controller.abort()
tx.compensateAll()
生成 ExecutionFailureOutcome
进入 Final Receipt 流程
```

补偿失败必须写入：

```text
cleanup.failures
violations
```

禁止：

```text
catch {}
best effort 且不记录
仅写 degradation 后继续成功
```

---

## 7.8 测试

新增：

```text
tests/runtime/linux/broker-transaction-r2.test.ts
```

故障注入点：

```text
TX-001 Domain reserve 失败
TX-002 Global reserve 失败
TX-003 Workspace lock 失败
TX-004 Cache lock 失败
TX-005 createRun 失败
TX-006 createAgent 失败
TX-007 createCell 失败
TX-008 Secret materialization 失败
TX-009 Seccomp materialization 失败
TX-010 Backend compile 失败
TX-011 Spawn 失败
TX-012 cgroup attach 失败
TX-013 Backend runtime 抛错
TX-014 Receipt persistence 失败
TX-015 正常成功
TX-016 用户取消
TX-017 wall timeout
TX-018 output limit
```

每个场景结束后统一断言：

```text
ledger.outstanding().length === 0
activeCells().length === 0
workspace locks === 0
cache locks === 0
Cell cgroup 不存在
Secret files === 0
Seccomp files === 0
Podman containers === 0
```

---

## 7.9 PR-11 完成条件

```text
任意注入阶段失败后：
ResourceLedger outstanding = 0
Isolation locks = 0
activeCells = 0
残留受管资源 = 0
```

---

# 8. PR-12：Final Receipt 单一真相与持久化

## 8.1 目标

消除：

```text
Backend Receipt
Broker 修改后的 Receipt
事件流 Receipt
StateStore Receipt
Evidence Receipt
```

之间的分叉。

---

## 8.2 Backend Contract 重构

修改：

```text
src/runtime/linux/backends/backend.ts
src/runtime/linux/backends/bubblewrap.ts
src/runtime/linux/backends/host-audit.ts
src/runtime/linux/backends/podman.ts
```

删除 Backend 接口中的：

```ts
buildReceipt(...)
```

新增：

```ts
export interface BackendOutputEvent {
  type: "stdout" | "stderr" | "status"
  data?: string
  state?: string
  at: number
}

export interface RawExecutionOutcome {
  startedAt: number
  finishedAt: number

  exitCode: number | null
  signal: string | null

  timedOut: boolean
  cancelled: boolean
  outputLimitHit: boolean

  backendFacts: {
    backend: BackendId
    backendVersion?: string
    pid?: number
    containerId?: string
    cidfile?: string
  }

  observedWrites: string[]
  observedDeletes: string[]
  unexpectedWrites: string[]
  violations: SandboxViolation[]
}

export interface BackendExecution {
  events: AsyncIterable<BackendOutputEvent>
  result: Promise<RawExecutionOutcome>
}

start(
  spec: ExecutionCellSpec,
  context: BackendRunContext,
): BackendExecution
```

Broker：

```text
启动 BackendExecution
→ 流式转发 events
→ await result
→ 清理
→ 构造 Receipt
```

---

## 8.3 Receipt 清理模型

修改：

```text
src/runtime/linux/contracts.ts
src/runtime/linux/receipt.ts
```

清理字段修改为：

```ts
export interface CleanupVerification {
  required: {
    processTree: boolean
    mountNamespace: boolean
    cgroup: boolean
    container: boolean
    secrets: boolean
    materializedFiles: boolean
  }

  observed: {
    processesRemaining: number
    mountsReleased?: boolean
    cgroupRemoved?: boolean
    containerRemoved?: boolean
    secretFilesRemaining?: number
    materializedFilesRemaining?: number
  }

  verified: boolean

  failures: Array<{
    code: string
    resource: string
    message: string
  }>
}
```

这样 Host Audit 无 cgroup 时可以表达：

```text
required.cgroup = false
observed.cgroupRemoved = undefined
verified = true
```

而不是把"不适用"错误地表示为 `false`。

---

## 8.4 Receipt 构造时点

Final Receipt 只能在以下动作完成后构造：

```text
Backend 结束
metrics 已读取
process tree 已验证
container 已验证
cgroup 已删除
mount namespace 已释放
secret 已清理
seccomp/temp/cidfile 已清理
transaction compensation 已完成
```

构造函数：

```ts
buildFinalReceipt({
  spec,
  capabilities,
  rawOutcome,
  cleanupVerification,
  transactionReport,
})
```

返回值必须立即 `deepFreeze()`。

---

## 8.5 Receipt Digest 验证

`computeReceiptDigest()` 保持递归 canonical JSON。

新增：

```ts
export function verifyReceiptDigest(
  receipt: SandboxReceipt,
): boolean
```

Evidence ingestion 前必须重新计算。

当前 Evidence ingestion 不能只检查字段存在，还必须验证：

```text
receiptDigest 正确
cleanup.verified=true
无未接受的 critical violation
```

---

## 8.6 原子持久化

修改：

```text
src/runtime/linux/recovery/state-store.ts
```

`appendReceipt` 修改为：

```ts
persistReceiptAtomically(
  runId: string,
  receipt: SandboxReceipt,
): PersistedReceiptReference
```

过程：

```text
写临时文件
→ fsync 临时文件
→ rename 到最终路径
→ fsync receipts 目录
→ 读回 JSON
→ 重新计算 digest
→ 与内存 Receipt 比较
→ 返回引用
```

文件名：

```text
<cellId>-attempt-<attempt>.json
```

返回：

```ts
interface PersistedReceiptReference {
  runId: string
  cellId: string
  path: string
  receiptDigest: string
  readBackVerified: true
}
```

---

## 8.7 Receipt 事件顺序

唯一允许顺序：

```text
cell.status running
cell.stdout/stderr...
cell.exit
cleanup
persist receipt
cell.receipt
cell.status succeeded/failed
```

`cell.receipt` 中携带的对象必须是被持久化并读回校验的同一个 Final Receipt。

持久化失败时：

```text
禁止发送 cell.receipt
禁止生成 Evidence
抛 RECEIPT_PERSIST_FAILED
任务不得声明完成
```

Shadow 模式可以显式使用：

```text
receiptPersistence: optional
```

但 `enabled/enforced` 必须为 required。

---

## 8.8 Evidence 修改

修改：

```text
src/agent/evidence-ledger.ts
src/harness/artifacts/evidence-adapter.ts
```

`ingestSandboxReceipt` 必须：

```text
验证 receiptDigest
验证 cleanup.verified
验证 persisted reference
验证 receipt.runId 与当前 Authority 一致
验证 receipt.agentId 与当前 Authority 一致
验证 receipt.cellSpecDigest
```

Evidence Entry 增加：

```ts
persistedReceiptRef?: string
receiptReadBackVerified?: boolean
```

---

## 8.9 测试

新增：

```text
tests/runtime/linux/final-receipt.test.ts
tests/runtime/linux/receipt-durability.test.ts
```

必须覆盖：

```text
RCPT-001 Backend 不再构造 Receipt
RCPT-002 成功执行只有一个 Receipt
RCPT-003 失败执行只有一个 Receipt
RCPT-004 取消执行只有一个 Receipt
RCPT-005 output limit 有最终 Receipt
RCPT-006 emitted digest = persisted digest
RCPT-007 emitted canonical JSON = persisted canonical JSON
RCPT-008 篡改 Receipt 后 Evidence 拒绝
RCPT-009 持久化失败时 Evidence 为 0
RCPT-010 cleanup 未验证时 completion gate 拒绝
RCPT-011 Host Audit 无 cgroup 时正确表达"不适用"
RCPT-012 Podman container 未清理时 cleanup.verified=false
RCPT-013 Secret 残留时 cleanup.verified=false
```

---

## 8.10 PR-12 完成条件

```text
每次执行 Final Receipt 数量：1
Backend Receipt 数量：0
emittedDigest == persistedDigest：100%
持久化失败后 sandbox evidence 数量：0
```

---

# 9. PR-13：Agent Domain、聚合预算、取消与物理锁

## 9.1 目标

让 Agent Domain 从数据结构升级为真实执行权威。

当前 Broker 创建 `AgentDomainManager` 时只注入 Ledger，没有注入已经探测到的 cgroup manager；DomainManager 也没有执行大部分聚合预算。

---

## 9.2 Broker 构造顺序修正

当前顺序调整为：

```text
probe capabilities
→ detect delegation
→ create CgroupManager
→ create ResourceLedger
→ create IsolationDomainLock
→ create WorkspaceAuthorityRegistry
→ create AgentDomainManager({
     cgroup,
     ledger,
     locks,
     workspaceRegistry
   })
```

不能先创建 DomainManager，再创建 cgroup。

---

## 9.3 Domain Reservation

新增：

```ts
interface DomainReservation {
  reservationId: string
  domainId: string
  cellId: string

  cpuQuota: number
  memoryBytes: number
  pids: number
  wallTimeMs: number
  outputBytes: number
  tempBytes: number
}

```

新增：

```ts
domainManager.reserveCell(
  domainId,
  cellId,
  requested,
): DomainReservation
```

必须执行：

```text
activeCells < maxConcurrentCells
sum(cpu) <= cpuQuotaTotal
sum(memory) <= memoryMaxBytes
sum(pids) <= pidsMax
cell.wallTime <= maxWallTimeMs
cell.output <= maxOutputBytes
cell.temp <= maxTempBytes
```

Domain reservation 必须进入 PR-11 补偿栈。

---

## 9.4 Domain 一致性校验

执行前必须验证：

```text
domain.runId === authority.identity.runId
domain.agentId === authority.identity.agentId
domain.workspaceId === authority.workspace.workspaceId
domain.status === active
```

校验失败：

```text
EXECUTION_DOMAIN_MISMATCH
```

禁止使用：

```ts
compiled.identity.agentId ?? domain.agentId
```

Identity 必须在编译前已经确定，不能执行阶段再补齐。

---

## 9.5 物理 Workspace Lock

修改：

```text
src/runtime/linux/workspace/isolation-lock.ts
```

新增：

```ts
static workspaceKey(workspaceId: string): string {
  return `workspace:${workspaceId}`
}
```

删除 Agent ID 作为物理写锁键的做法。

规则：

```text
同 workspaceId：
  readonly + readonly → 可并行
 任意包含 write → 互斥

不同 workspaceId：
  可并行
```

Main Workspace 默认单写者。

---

## 9.6 取消语义

修改：

```text
src/runtime/linux/broker.ts
src/runtime/linux/workspace/agent-domain.ts
```

### `cancelCell`

```text
标记 cancelling
controller.abort()
等待 Supervisor terminateTree
cgroup.kill（如存在）
container rm -f（如存在）
等待 Final Receipt
```

### `cancelAgent`

不能依赖 cgroup 存在。

```text
domain.status = cancelling
枚举该 Agent 所有活动 Cell
对每个 Cell 调用 cancelCell
cgroup.kill Agent subtree（如存在）
等待全部 Cell 结束
releaseAgent reservations
domain.status = closed
```

### `cancelRun`

```text
阻止新 Cell
取消所有 Cell
关闭所有 Domain
释放 Run reservations
删除 Run cgroup
生成 Run Cleanup Receipt
```

---

## 9.7 Domain cgroup

正确层级：

```text
orcana.scope
└── run-<runId>
    ├── agent-<agentId>
    │   └── cell-<cellId>
    └── system
        └── cell-<cellId>
```

聚合预算写入 Agent cgroup：

```text
memory.max
pids.max
cpu.weight 或 cpu.max
```

单 Cell 限制写入 Cell cgroup。

`closeDomain()` 不能把 Agent cgroup 当作 Cell 调用 `removeCell()`；应新增：

```ts
removeAgent(agentPath)
```

明确执行子 Cell 清理和 Agent 层删除。

---

## 9.8 测试

新增：

```text
tests/runtime/linux/agent-domain-r2.test.ts
tests/runtime/linux/physical-workspace-lock.test.ts
tests/runtime/linux/cancellation-r2.test.ts
```

覆盖：

```text
DOM-001 maxConcurrentCells 生效
DOM-002 聚合 memory 生效
DOM-003 聚合 pids 生效
DOM-004 maxWallTime 生效
DOM-005 maxOutput 生效
DOM-006 maxTemp 生效
DOM-007 domain runId 不匹配被拒
DOM-008 domain agentId 不匹配被拒
DOM-009 domain workspace 不匹配被拒
DOM-010 closed domain 不可执行
DOM-011 两 Agent 同物理目录互斥
DOM-012 两 Agent 不同 Worktree 可并行
DOM-013 无 cgroup 时 cancelAgent 仍取消全部 Cell
DOM-014 cgroup 存在时双通道取消
DOM-015 cancelRun 后所有 reservation=0
DOM-016 Agent cgroup 正确自底向上删除
```

---

## 9.9 PR-13 完成条件

```text
DomainBudget 中每个字段都有运行时消费点
同物理 Workspace 并发写：0
无 cgroup Agent 取消失败：0
Domain/Authority 身份不一致被接受：0
```

---

# 10. PR-14：Podman、Secret、Seccomp 与 Recovery

## 10.1 Podman 宿主 cwd

当前 Podman `CompiledExecution.cwd` 被写成容器内 `/workspace`，与宿主 cwd 契约不符。

修改：

```text
src/runtime/linux/backends/podman.ts
```

必须区分：

```ts
hostCwd: authority.workspace.hostRoot
containerWorkdir: "/workspace/<relative>"
```

返回：

```ts
cwd: spec.command.cwd
```

其中 `spec.command.cwd` 已经是经 PR-9 验证的宿主 canonical cwd。

Podman 参数仍使用：

```text
--workdir /workspace/<relative>
```

不得混用。

---

## 10.2 Podman Container Verification

不得再固定：

```ts
containerRemoved: true
```

流程：

```text
生成 Cell 唯一 cidfile
→ Podman 启动
→ 读取 container ID
→ 执行结束
→ podman container exists <id>
→ 存在则 rm -f
→ 再次 exists
→ 不存在才标记 containerRemoved=true
```

添加：

```ts
verifyContainerRemoved(containerId): boolean
```

Run 级清理必须支持可选过滤器：

```ts
cleanupContainers({
  runId,
  cellId?: string,
})
```

当 `cellId` 未提供时，不能附加空 cell label。

---

## 10.3 Image Approval

当前 `startsWith` 审批必须替换为结构化规则：

```ts
type ApprovedImageRule =
  | { type: "exact-digest"; reference: string }
  | { type: "registry-prefix"; registry: string; repositoryPrefix: string }
```

所有最终执行镜像仍必须包含 digest。

Prefix 匹配必须按 registry/repository path segment，而不是普通字符串前缀。

```ts
type ApprovedImageRule =
  | { type: "exact-digest"; reference: string }
  | { type: "registry-prefix"; registry: string; repositoryPrefix: string }
```

所有最终执行镜像仍必须包含 digest。

Prefix 匹配必须按 registry/repository path segment，而不是普通字符串前缀。

---

## 10.4 Secret 生命周期

修改：

```text
src/runtime/linux/secrets.ts
src/runtime/linux/contracts.ts
src/runtime/linux/broker.ts
```

每个 Cell 使用独立目录：

```text
/tmp/orcana-runtime/<runId>/<cellId>/secrets/
```

目录权限：

```text
0700
```

文件权限：

```text
0600
```

创建必须使用：

```text
O_CREAT | O_EXCL
```

Secret ID 必须校验：

```text
仅允许 [A-Za-z0-9._-]
禁止 /
禁止 ..
禁止空字节
```

`ExecutionMaterialization` 增加：

```ts
dispose(): Promise<MaterializationCleanupReport>
```

该 dispose 必须进入 PR-11 补偿栈。

---

## 10.5 Seccomp 物化

Seccomp 文件也进入 Cell 独立 materialization 目录。

严格 Profile：

```text
untrusted
evolution
dependency（需要时）
```

若 seccomp 被要求但生成失败：

```text
立即拒绝执行
```

非严格 Profile 才允许降级，并必须写入 Raw Outcome：

```text
SECCOMP_UNAVAILABLE
```

禁止空 `catch`。

---

## 10.6 Podman/Bubblewrap Materialization 清理

统一清理：

```text
secret files
seccomp BPF/JSON
cidfile
temporary wrapper files
temporary environment files
```

Materialization Report：

```ts
interface MaterializationCleanupReport {
  removed: string[]
  remaining: string[]
  failures: Array<{
    path: string
    error: string
  }>
}
```

---

## 10.7 Janitor 重构

修改：

```text
src/runtime/linux/recovery/state-store.ts
src/runtime/linux/broker.ts
src/index.ts
```

`cleanupRun()` 返回结构化结果：

```ts
interface RunCleanupReport {
  runId: string

  cellsCancelled: number
  reservationsReleased: number
  locksReleased: number

  cgroupsRemoved: string[]
  containersRemoved: string[]
  secretPathsRemoved: string[]
  materializationPathsRemoved: string[]
  tempRootsRemoved: string[]

  stateRemoved: boolean
  failures: CleanupFailure[]
}
```

---

## 10.8 Janitor 失败策略

启动 Janitor 可以不阻止普通 CLI 打开，但必须：

```text
记录结构化错误
在 doctor 中显示
阻止 enforced execution
```

存在未清理 P0 资源时：

```text
runtimeHealth.linuxExecution = degraded
enforced mode = unavailable
```

不能完全静默吞掉异常。

---

## 10.9 测试

新增：

```text
tests/runtime/linux/podman-r2.test.ts
tests/runtime/linux/secrets-r2.test.ts
tests/runtime/linux/recovery-r2.test.ts
```

覆盖：

```text
POD-001 host cwd 为真实宿主目录
POD-002 container workdir 独立
POD-003 --rm 后真实验证容器消失
POD-004 rm 失败时 containerRemoved=false
POD-005 run label 清理不附加空 cell label
POD-006 未审批镜像拒绝
POD-007 字符串伪前缀无法绕过审批

SEC-001 每个 Cell Secret 路径独立
SEC-002 同 Secret ID 并发不覆盖
SEC-003 成功后 Secret=0
SEC-004 失败后 Secret=0
SEC-005 取消后 Secret=0
SEC-006 崩溃后 Janitor 清理 Secret
SEC-007 非法 Secret ID 被拒绝

REC-001 同 boot live owner 不清理
REC-002 同 boot dead owner 清理
REC-003 PID 复用不误判
REC-004 跨 boot 全部清理
REC-005 Recovery Receipt 保留
REC-006 Run State 真正删除
REC-007 cleanup 失败时 stateRemoved=false
REC-008 未清理资源阻止 enforced mode
```

---

## 10.10 PR-14 完成条件

```text
Podman host cwd ENOENT：0
containerRemoved 推定赋值：0
Secret 执行后残留：0
Seccomp 严格路径静默降级：0
Janitor 虚假 stateRemoved：0
```

---

# 11. PR-15：真实攻击评测、CI Lane 与 Freeze Gate

## 11.1 目标

让评测验证真实不变量，而不是验证函数是否返回预期字符串。

当前 `eval:linux` 脚本只运行评测程序，workflow 也没有默认附加 `--strict`。

---

## 11.2 评测 CLI 改造

支持：

```text
bun run eval:linux --require=bubblewrap
bun run eval:linux --require=podman
bun run eval:linux --require=cgroup
bun run eval:linux --strict
```

语义：

```text
--require=bubblewrap
  Bubblewrap 必需场景不得 SKIP

--require=podman
  Podman 必需场景不得 SKIP

--require=cgroup
  cgroup delegation 必需场景不得 SKIP

--strict
  所有关键能力均不得 SKIP
```

不要让 Bubblewrap Lane 因 Podman 缺失失败，反之亦然。

---

## 11.3 新增真实场景

在现有 LX 场景后增加：

```text
LX-038 WORKSPACE_ROOT_ESCAPE
LX-039 SYMLINK_CWD_ESCAPE
LX-040 UNTRUSTED_IDENTITY_OVERRIDE
LX-041 SPAWN_ENOENT_NO_CGROUP_ATTACH
LX-042 PID_ZERO_SELF_PROTECTION
LX-043 ATTACH_BEFORE_PAYLOAD
LX-044 ATTACH_FAILURE_PAYLOAD_ZERO
LX-045 LEDGER_ROLLBACK_AFTER_LOCK_FAILURE
LX-046 LOCK_ROLLBACK_AFTER_CGROUP_FAILURE
LX-047 EMITTED_RECEIPT_EQUALS_PERSISTED
LX-048 RECEIPT_PERSIST_FAILURE_BLOCKS_EVIDENCE
LX-049 TWO_AGENTS_SAME_PHYSICAL_WORKSPACE
LX-050 TWO_AGENTS_DISTINCT_WORKTREES_PARALLEL
LX-051 AGENT_CANCEL_WITHOUT_CGROUP
LX-052 DOMAIN_AGGREGATE_BUDGET
LX-053 PODMAN_HOST_CWD_VALID
LX-054 PODMAN_CONTAINER_LEFTOVER_ZERO
LX-055 SECRET_LEFTOVER_SUCCESS_ZERO
LX-056 SECRET_LEFTOVER_ABORT_ZERO
LX-057 SECCOMP_STRICT_FAIL_CLOSED
LX-058 SAME_BOOT_CRASH_RECOVERY
LX-059 RECOVERY_STATE_TRUTH
LX-060 RUNTIME_SELF_CGROUP_UNCHANGED
```

---

## 11.4 LX-037 修正

真正创建：

```text
Agent A + Workspace X
Agent B + Workspace X
```

不能再用两个匿名 Cell 测试 main workspace。

同时增加：

```text
Agent A + Workspace X
Agent B + Workspace Y
```

验证真实并行。

---

## 11.5 CI Workflow

修改：

```text
.github/workflows/ci.yml
.github/workflows/linux-sandbox-lanes.yml
```

### Bubblewrap Lane

```yaml
- run: bun run eval:linux --require=bubblewrap
```

### Podman Lane

```yaml
- run: bun run eval:linux --require=podman
```

### cgroup Lane

GitHub Hosted Runner 无真实委托时不能只打印 `NOT-DELEGATED`。

使用专用 Runner：

```yaml
runs-on:
  - self-hosted
  - linux
  - lnxf-cgroup-v2
```

运行：

```yaml
- run: bun run eval:linux --require=cgroup
```

若当前没有该 Runner：

```text
LNXF Freeze 保持 BLOCKED
```

不能通过 Mock 替代。

---

## 11.6 全能力 Freeze Lane

新增：

```text
lane-lnxf-freeze
```

Runner 标签：

```text
self-hosted
linux
lnxf-full
bubblewrap
rootless-podman
cgroup-v2-delegated
```

运行：

```text
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run build
bun run pack:check
bun run eval:linux --strict
```

上传：

```text
capabilities.json
linux-eval-report.json
receipt-persistence-report.json
resource-leak-report.json
```

---

## 11.7 Branch Protection

以下检查必须设为 Required：

```text
CI / typecheck
CI / test
CI / build
Linux Sandbox / lane-bubblewrap
Linux Sandbox / lane-podman
Linux Sandbox / lane-cgroup
Linux Sandbox / lane-lnxf-freeze
```

没有 Required Check 时，不得宣布 Freeze。

---

## 11.8 PR-15 完成条件

```text
关键场景 SKIP 数量：0
真实 Bubblewrap Lane：PASS
真实 Podman Lane：PASS
真实 cgroup delegation Lane：PASS
Full Freeze Lane：PASS
远端 Required Checks：全部存在
```

---

# 12. 每个 PR 的统一执行规则

## 12.1 每 PR 单独分支

```text
fix/lnxf-r2-authority
fix/lnxf-r2-spawn-gate
fix/lnxf-r2-transaction
fix/lnxf-r2-receipt
fix/lnxf-r2-domain
fix/lnxf-r2-runtime-resources
fix/lnxf-r2-freeze-gate
```

---

## 12.2 禁止混入其他改动

不得包含：

```text
Agent Prompt 优化
Context 压缩
模型路由
UI
TUI
Memory
Graph 重构
RC 系列无关修复
Microbench
文案调整
```

发现无关修改必须拆出。

---

## 12.3 每个 PR 的本地门禁

最低要求：

```bash
bun run typecheck
bun test <targeted-test-files>
bun run test
bun run build
bun run pack:check
git diff --check
```

涉及真实后端时，必须额外执行对应 Eval。

---

## 12.4 不得虚报环境能力

机器缺少：

```text
Bubblewrap
Podman
cgroup delegation
```

只能写：

```text
NOT_EXECUTED_ENVIRONMENT_UNAVAILABLE
```

不能写：

```text
PASS
```

Mock 测试只能证明：

```text
component semantics
```

不能证明：

```text
production integration
```

---

## 12.5 每 PR 交付报告格式

```text
PR:
Commit:
Base SHA:
Head SHA:

Files changed:
Tests added:
Tests modified:

Targeted gate:
Full gate:
Real backend gate:

Known skips:
Known limitations:

Closed defects:
Remaining defects:

Freeze impact:
```

---

# 13. 全局最终验收矩阵

全部 PR 合流后，必须进行一次独立终验。

## 13.1 Authority Gate

```text
模型可控身份字段：0
模型可控宿主根路径字段：0
Workspace Escape：0
Domain Identity Mismatch Accepted：0
```

## 13.2 Process Gate

```text
PID 0 attach：0
PID 1 attach：0
Runtime self attach：0
Attach 前用户 payload：0
取消后进程残留：0
```

## 13.3 Transaction Gate

```text
每个故障注入后的 Ledger outstanding：0
每个故障注入后的 Lock：0
每个故障注入后的 active Cell：0
每个故障注入后的 cgroup：0
```

## 13.4 Receipt Gate

```text
每次执行 Final Receipt：1
Backend Receipt：0
Event/Persisted Digest mismatch：0
持久化失败后 Evidence：0
未验证 Cleanup 通过 Completion：0
```

## 13.5 Multi-Agent Gate

```text
同物理目录并发写：0
不同 Worktree 不必要串行：0
Domain 聚合预算超限接受：0
无 cgroup Agent 取消失败：0
```

## 13.6 Secret/Recovery Gate

```text
成功后 Secret 残留：0
失败后 Secret 残留：0
取消后 Secret 残留：0
Podman 容器残留：0
Janitor 虚假清理报告：0
```

## 13.7 CI Gate

```text
Typecheck：PASS
Full Tests：PASS
Build：PASS
Pack：PASS
Bubblewrap：PASS
Podman：PASS
cgroup Delegation：PASS
Linux Eval Strict：PASS
SKIP：0
```

---

# 14. Freeze 重新开放条件

只有以下所有条件同时成立，才能恢复：

```text
LINUX_FOUNDATION_FREEZE: PASS
```

条件：

1. PR-9～PR-15 全部合流；
2. 所有 P0 缺陷有回归测试；
3. 远端完整 CI 通过；
4. 真 Bubblewrap 通过；
5. 真 Rootless Podman 通过；
6. 真 cgroup v2 delegation 通过；
7. Strict Eval 0 FAIL、0 SKIP；
8. 独立复审没有新的 P0；
9. emitted/persisted/evidence Receipt 完全一致；
10. 任意故障注入后资源归零。

Freeze 通过后，才允许按顺序恢复：

```text
L1：Service Cell
L2：长期 MCP/LSP/Dev Server
L3：Agent Fleet
L4：Lease/Heartbeat
L5：跨进程恢复
L6：长期自治与自进化
```

不能越级。

---

# 15. 最终交付判定

最终目标不是让代码"测试通过"，而是建立以下事实：

```text
执行身份不可伪造
Workspace 不可越权
用户载荷不会逃离资源边界
取消一定触达真实进程
任何失败都会完整回滚
Receipt 只有一份最终真相
Evidence 必须来自持久化 Receipt
同物理目录永远不会多写者
Secret 和容器不会跨运行残留
崩溃恢复报告与真实状态一致
```

最终允许状态：

```text
LNXF_AUTHORITY_CLOSURE:       PASS
LNXF_FAILURE_ATOMICITY:       PASS
LNXF_RECEIPT_DURABILITY:      PASS
LNXF_MULTI_AGENT_ISOLATION:   PASS
LNXF_RECOVERY_TRUTH:          PASS
LNXF_REAL_BACKEND_EVAL:       PASS
LINUX_FOUNDATION_FREEZE:      PASS
```

在达到上述状态前，不得把局部组件完成描述为生产闭环完成。
