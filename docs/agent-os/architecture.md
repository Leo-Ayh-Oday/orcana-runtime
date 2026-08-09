# Orcana Agent OS 升级总方案

## Durable Agent World + Agent Kernel

---

## 0. 文档目标

本方案解决的不是：

> “怎么让 Orcana 的 Linux Sandbox 更强？”

因为完成 Linux Execution Fabric 后，这个问题已经进入收益递减阶段。

新的问题是：

> 如何让 Orcana 从一个运行 Agent 的 Runtime，升级成一个管理 Agent 世界、资源、权限、记忆、模型、事件、副作用与长期生命周期的 Agent OS？

最终目标定义：

> Orcana Agent OS 是运行在 Linux 之上的 Agent Kernel。它为 Agent 提供持久世界、身份、能力句柄、语义虚拟内存、模型计算、事件、中断、服务、资源调度、副作用事务、可复现执行、世界分支和可验证演化。

Linux 继续负责：

```text
Process
CPU
RAM
GPU
Filesystem
Network
Device
Namespace
cgroup
VM
```

Orcana Kernel 负责：

```text
Agent
World
Task
Context
Memory
Capability
Model
Tool
Service
Event
Artifact
Effect
Evidence
Human Attention
Evolution
```

---

## 1. 这次升级的核心架构发现

结合 Cloudflare Computer、Pi 和 Orcana 自己已有架构，可以提炼三个非常重要的结论。

### 1.1 Cloudflare Computer：Computer 不等于 Container

Cloudflare Computer 的核心结构是：

```text
Durable Workspace
       │
       ├── SQLite-backed authoritative VFS
       │
       └── Runtime
            ├── Container
            ├── Worker Shell
            └── Worker JavaScript
```

权威状态存在 Workspace，而 Container 只是运行该状态的一个 execution backend。容器死亡不等于 Workspace 死亡；执行 Backend 可以更换，而 Workspace 保持同一个逻辑实体。

因此 Orcana 应建立：

> Execution is a projection of World State, not the authority of World State.

### 1.2 Pi：Agent 不等于 Conversation

Pi Core 明确区分：

```text
AgentMessage[]
    ↓
transformContext()
    ↓
convertToLlm()
    ↓
LLM Message[]
```

也就是说：

```text
Agent State
≠
LLM Context
```

Pi 的 Context Transform、Agent Events、Steering、Follow-up、Session Tree 都证明 Agent 控制状态完全可以独立于某一次模型上下文。

Orcana 应继续往前：

> Context Window 只是 Agent World 的一个动态工作集。

### 1.3 Orcana：已有很多 Kernel 原语，不应推倒重写

现有 Orcana 已经拥有统一：

```text
CapabilityDescriptor
tool
model
skill
worker
verifier
human
external_service
```

并记录：

```text
sideEffect
permissions
risk
retryable
idempotent
cancellable
producesEvidence
```

这已经非常接近 Capability Kernel 的前身。

现有 Context Pipeline 也已经具备：

```text
stable
plan
node
volatile
```

以及：

```text
budget
freshness
dedupe
trim
cache prefix
```

这就是 Semantic MMU 的起点。

Harness Event 已经带：

```text
schemaVersion
eventId
sequence
runId
sessionId
parentEventId
```

可以直接扩展成 Agent Event Kernel 的协议基础。

BudgetLedger 已经采用：

```text
Reserve
→ Commit
→ Release
```

这也是未来统一 Agent Resource Scheduler 很好的起点。

所以策略不是重写 Orcana。

策略是：

> 把现在已有的 Runtime 原语提升成 Kernel 原语。

---

## 2. Agent OS 十条架构宪法

未来任何设计都应该接受这十条原则检查。

### P1 — World is Authority

`AgentWorld` 是 Agent 长期状态的权威。

Linux Worktree、Container、MicroVM、Remote Worker 都不是。

### P2 — Execution is Projection

执行环境只是 World 的临时计算投影：

```text
World Snapshot
→ Projection
→ Execute
→ Delta
→ Validate
→ Commit
```

### P3 — Agent State ≠ LLM Context

模型上下文只是：

```text
AgentWorld
→ Semantic MMU
→ ContextImage
→ LLM
```

生成出来的工作集。

### P4 — Capability Defines Authority

Tool 只是 LLM API。

真正权限属于：

`CapabilityHandle`

### P5 — Backend Selection Is Routing

选择：

```text
Capability VM
Bubblewrap
Podman
MicroVM
Remote Worker
```

只能决定在哪里执行。

不能决定拥有什么权限。

Cloudflare Computer 也明确把 backend routing 与 authorization 分离。

### P6 — Execution Completion ≠ World Commit

程序成功退出：

```text
exitCode = 0
```

不能直接意味着：

```text
Node = Completed
```

必须经过：

```text
Execution
→ World Commit
→ Effect Settlement
→ Evidence Binding
→ Graph Completion
```

### P7 — Unknown Effects Are Reconciled

外部副作用已经 dispatch、但结果未知：

```text
UNKNOWN
```

不能盲目 Retry。

必须：

```text
reconcile()
```

### P8 — External Systems Are Sources/Drivers

GitHub、R2、Google Drive、数据库：

```text
External System
→ Driver / Mount
→ AgentWorld
```

不能与 AgentWorld 形成无约束 Multi-Master。

Cloudflare Computer 对 Mount 也采用这一权威分层思想。

### P9 — Models Are Replaceable Compute

Agent Identity 不绑定：

```text
GPT
Claude
DeepSeek
Local Model
```

模型是调度资源。

### P10 — Every Autonomous Action Produces Provenance

最终必须回答：

```text
谁做的？
为什么有权做？
看到了什么？
用了哪个模型？
在哪执行？
用了什么资源？
修改了什么？
产生了什么外部副作用？
什么证据允许任务完成？
```

---

## 3. 最终系统分层

```text
┌───────────────────────────────────────────────────────┐
│                    Agent Applications                 │
│                                                       │
│ Coding │ Research │ DevOps │ Browser │ Evolution     │
└──────────────────────────┬────────────────────────────┘
                           │
                      Agent ABI
                           │
┌──────────────────────────▼────────────────────────────┐
│                   ORCANA AGENT KERNEL                 │
│                                                       │
│ Agent Process Manager                                 │
│ Identity Kernel                                       │
│ Capability / Handle Kernel                            │
│ Effect Kernel                                         │
│ Event / Interrupt Kernel                              │
│ Service Manager                                       │
│                                                       │
│ Semantic MMU                                          │
│ Model Scheduler                                       │
│ Resource Scheduler                                    │
│ Human Attention Scheduler                             │
│                                                       │
│ Provenance / Evidence Kernel                          │
└──────────────────────────┬────────────────────────────┘
                           │
┌──────────────────────────▼────────────────────────────┐
│                       AGENT WORLD                     │
│                                                       │
│ WorldDB        WorldLedger       CAS                  │
│ WorldFS        Memory            Artifacts            │
│ Tasks          Services          Effects              │
│ Branches       Checkpoints       Execution Journal    │
└──────────────────────────┬────────────────────────────┘
                           │
                     Projection Layer
                           │
        ┌──────────────────┼───────────────────┐
        ▼                  ▼                   ▼
 Capability VM       Linux Execution       Remote Worker
                         Fabric
                    ┌────┼─────┐
                    ▼    ▼     ▼
                  bwrap Podman MicroVM
                           │
┌──────────────────────────▼────────────────────────────┐
│                        Linux                          │
│ cgroup │ namespaces │ VFS │ net │ BPF │ hardware    │
└───────────────────────────────────────────────────────┘
```

---

## 4. 五种权威必须彻底分开

这是未来 Orcana 最容易设计错误的地方。

### 4.1 User / Policy Authority

决定：

> Agent 最多允许拥有什么权限。

### 4.2 Graph Authority

决定：

```text
任务是什么
节点关系是什么
什么时候完成
```

Typed Execution Graph 保持这个权威。

绝不能让 AgentWorld 或 execd 替代 Graph。

### 4.3 AgentWorld Authority

决定：

> 现在世界是什么状态。

包括：

```text
文件
Memory
Task state
Artifact
Service
World object
Branch
Effect journal
```

### 4.4 Execution Fabric Authority

决定：

> Linux 上实际发生了什么。

包括：

```text
Process
Exit
cgroup
metrics
writes
network
sandbox
cleanup
```

### 4.5 Evidence Authority

决定：

> 哪些事实足够支持任务完成声明。

因此最终链：

```text
Graph Intent
       ↓
Capability Authorization
       ↓
World Projection
       ↓
Execution
       ↓
World Commit
       ↓
Effect Settlement
       ↓
Evidence Binding
       ↓
Graph Completion
```

---

## 5. AgentWorld：新的第一等核心对象

### 5.1 基本模型

```ts
interface AgentWorld {
  worldId: string
  currentRevision: bigint
  currentBranchId: string
  rootObjectId: string
  createdAt: number
  updatedAt: number
  status:
    | "active"
    | "suspended"
    | "archived"
    | "corrupted"
}
```

---

## 6. AgentWorld 内部组成

```text
AgentWorld
│
├── WorldFS
├── Object Namespace
├── CAS
├── Semantic Memory
├── Artifact Registry
├── Task State
├── Agent Processes
├── Services
├── Events
├── Capabilities
├── Execution Journal
├── Effect Journal
├── Evidence
├── Branches
└── Checkpoints
```

---

## 7. WorldDB + WorldLedger + CAS

三个东西必须分开。

### WorldDB

回答：

> 现在是什么？

使用：

`SQLite + WAL`

保存 Materialized State。

### WorldLedger

回答：

> 为什么变成这样？

Append-only。

例如：

```text
rev 183
world.object.created
world.file.updated
agent.spawned
capability.delegated
execution.committed
effect.dispatched
effect.reconciled
memory.updated
service.started
```

### CAS

回答：

> 实际内容是什么？

例如：

```text
sha256:<digest>
```

保存：

```text
file chunks
artifacts
snapshots
context pages
logs
large tool output
model transcript
execution evidence
```

---

## 8. 推荐持久化结构

```text
~/.local/share/orcana/
└── worlds/
    └── <world-id>/
        ├── world.db
        ├── ledger/
        │   └── events.log
        ├── cas/
        │   └── sha256/
        ├── snapshots/
        ├── projections/
        └── recovery/
```

后期：

`CAS` 可以迁移到：

```text
remote object store
NAS
distributed CAS
```

但 WorldDB 初期保持本机强权威。

---

## 9. World Revision

任何正式 World mutation：

```text
revision N
→ transaction
→ revision N+1
```

例如：

```ts
interface WorldCommit {
  worldId: string
  baseRevision: bigint
  newRevision: bigint
  branchId: string
  actor: PrincipalId
  deltaDigest: string
  executionReceiptIds: string[]
  effectReceiptIds: string[]
  timestamp: number
}
```

要求：

```text
baseRevision == currentRevision
```

否则：

```text
WORLD_CONFLICT
```

不能 silent overwrite。

---

## 10. World Branch

Branch 不只是 Git Branch。

```text
WorldBranch
├── branchId
├── parentBranchId
├── baseRevision
├── headRevision
├── owner
├── purpose
└── status
```

包含：

```text
filesystem delta
memory delta
task state
artifacts
effects
execution history
evidence
```

因此：

`Git Branch` 只是 WorldBranch 中 source-code 部分的一个实现细节。

---

## 11. World Snapshot

```ts
interface WorldSnapshot {
  snapshotId: string
  worldId: string
  branchId: string
  revision: bigint
  manifestDigest: string
  filesystemDigest: string
  memoryDigest: string
  taskStateDigest: string
  capabilityStateDigest: string
  serviceStateDigest: string
  createdAt: number
}
```

快照必须 immutable。

---

## 12. Content Addressed World

借鉴 Cloudflare Computer：

文件不要以：

```text
path → bytes
```

作为同步基本单位。

而是：

```text
path
  ↓
manifest
  ↓
chunks
  ↓
CAS
```

Cloudflare 当前采用 chunk + hash + revision/cursor 做增量传输和恢复。

Orcana 推荐：

```text
小文件：
whole-file hash
大文件：
FastCDC / fixed chunk
```

初期可以：

```text
1 MiB fixed chunk
```

后期再引入 FastCDC。

---

## 13. World Projection

这是整个系统最核心的执行机制。

执行：

```text
World Snapshot
      ↓
Projection Plan
      ↓
Projection
      ↓
Execute
      ↓
Delta
      ↓
Validate
      ↓
World Commit
```

---

## 14. 三种 Projection Mode

不能把 Cloudflare FUSE 全盘照搬。

Cloudflare 自己的 benchmark 已经证明 FUSE 路径在大规模连续 IO 和完整 npm install 上存在明显开销。

所以 Orcana 使用三种模式。

### Mode 1 — Capability Direct

适合：

```text
read
grep
metadata
structured data
memory
artifact
git metadata
small transforms
```

路径：

```text
Agent
→ Capability Kernel
→ World API
→ WorldDB / CAS
```

完全不启动 Linux。

### Mode 2 — Native Projection

Coding 默认。

```text
World Snapshot
      ↓
Materialized readonly base
      +
OverlayFS upper
      ↓
Linux Cell
```

完成：

```text
upperdir
→ Delta Scanner
→ CAS
→ World Commit
```

适合：

```text
npm
bun
git
cargo
clang
tests
build
```

### Mode 3 — Live WorldFS

只用于：

```text
LSP
long-running service
collaborative workspace
interactive daemon
```

可以：

`FUSE`

或未来自研 userspace FS。

---

## 15. World Commit State

Execution State 和 World State 不再混为一个状态。

### Execution

```text
PENDING
STARTING
RUNNING
COMPLETED
FAILED
CANCELLED
```

### World

```text
UNPROJECTED
PROJECTED
DELTA_READY
COMMIT_PENDING
COMMITTED
CONFLICTED
REJECTED
```

### Effect

```text
NONE
PREPARED
DISPATCHED
COMMITTED
UNKNOWN
RECONCILING
FAILED
```

### Evidence

```text
PENDING
BOUND
REJECTED
STALE
```

可能出现：

```text
Execution = COMPLETED
World     = COMMIT_PENDING
Effect    = NONE
Evidence  = PENDING
```

完全合法。

---

## 16. Agent ABI

这是 Runtime → OS 的关键。

定义 Kernel Operations。

注意：

不是 Linux syscall。

而是 Orcana 内部稳定 ABI。

### World

```text
world.open
world.snapshot
world.branch
world.commit
world.diff
world.checkout
```

### Objects

```text
object.open
object.read
object.write
object.list
object.close
```

### Capability

```text
capability.request
capability.delegate
capability.attenuate
capability.revoke
capability.inspect
```

### Agent

```text
agent.spawn
agent.signal
agent.suspend
agent.resume
agent.exit
```

### Execution

```text
execution.submit
execution.attach
execution.cancel
execution.inspect
```

### Event

```text
event.subscribe
event.wait
event.publish
event.unsubscribe
```

### Memory

```text
memory.map
memory.recall
memory.pin
memory.unpin
memory.prefetch
```

### Model

```text
model.infer
model.reserve
model.cancel
```

### Effect

```text
effect.prepare
effect.dispatch
effect.commit
effect.reconcile
```

### Service

```text
service.start
service.attach
service.health
service.stop
```

---

## 17. Agent Object Model

Agent 不应该直接接触大量宿主资源标识。

例如不要：

```text
/home/user/project
/dev/video0
sk-xxxx
localhost:5432
```

改成：

```text
worldfs://project
device://camera/front
secret://github/main
service://postgres/dev
```

---

## 18. AgentObject

```ts
type AgentObjectType =
  | "file"
  | "directory"
  | "workspace"
  | "artifact"
  | "memory"
  | "model"
  | "service"
  | "secret"
  | "network_endpoint"
  | "device"
  | "execution"
  | "human_attention"
```

---

## 19. Capability Handle

现有 CapabilityDescriptor 应逐渐拆成：

`CapabilityDefinition`

和：

`CapabilityHandle`

因为“系统能做什么”与“这个 Agent 被允许做什么”是不同问题。

### CapabilityDefinition

```ts
interface CapabilityDefinition {
  id: string
  kind: string
  operations: string[]
  inputSchema: JsonSchema
  outputSchema: JsonSchema
  effectClass: EffectClass
  driverId: string
  cancellable: boolean
  idempotent: boolean
  reconcilable: boolean
}
```

### CapabilityHandle

```ts
interface CapabilityHandle {
  handleId: string
  capabilityId: string
  ownerPrincipal: string
  objectScope?: string
  rights: string[]
  constraints: CapabilityConstraint[]
  issuedAt: number
  expiresAt?: number
  parentGrant?: string
}
```

---

## 20. Capability Attenuation

父权限：

```text
github.repo:orcana-runtime
rights:
  read
  write
  push
  create_pr
```

子 Agent：

```text
read
write
```

Reviewer：

```text
read
```

必须满足：

```text
ChildRights ⊆ ParentRights
```

永远不能放大。

---

## 21. Semantic Capability

不要停留在：

```text
network=true
secret=github
```

应该是：

```ts
github.repo("orcana-runtime").read
github.repo("orcana-runtime").push(
    branch="agent/*"
)
artifact.publish(
    namespace="benchmarks"
)
model.infer(
    class="coding",
    maxCost=0.30
)
```

这是 Agent OS 比普通 Sandbox 安全模型更有价值的地方。

---

## 22. Tool 与 Capability 分离

未来：

Tool 只是：

> 给 LLM 看的调用接口。

真正执行：

```text
LLM Tool Call
     ↓
Tool Adapter
     ↓
Agent ABI
     ↓
Capability Handle
     ↓
Kernel
```

例如：

`git_push`

不再：

```ts
spawn("git push")
```

而是：

```text
git_push Tool
↓
GitPushHandle
↓
Effect Kernel
↓
Git Driver
```

---

## 23. Driver Model

不要复制 Pi Extension 的完全宿主权限模型。

Pi Extensions 可以订阅生命周期、注册 Tool、修改 Context、保存状态等，但其文档明确指出 Extension 以完整系统权限运行；Pi 自身也明确不提供内置的 filesystem/process/network/credential 限制。

Orcana 应做：

> Agent Driver

### Driver Interface

```ts
interface AgentDriver {
  id: string
  describeCapabilities(): CapabilityDefinition[]
  open(): Promise<void>
  invoke(
    capability: string,
    input: unknown,
    context: DriverInvocationContext
  ): Promise<DriverResult>
  reconcile?(
    effect: EffectRecord
  ): Promise<ReconcileResult>
  subscribe?(
    source: EventSource
  ): AsyncIterable<KernelEvent>
  close(): Promise<void>
}
```

Driver 类型：

```text
GitHub
Browser
Google Drive
Slack
Database
Cloud
Email
Model Provider
Device
Robot
```

Driver 自身运行在：

`Service Cell`

或受限 Host Service。

---

## 24. Effect Kernel

这是 Agent OS 必不可少的一层。

Effect 分类：

```text
PURE
IDEMPOTENT
RECONCILABLE
IRREVERSIBLE
```

### 示例

```text
read file
→ PURE
write CAS
→ IDEMPOTENT
Git push
→ RECONCILABLE
send email
→ IRREVERSIBLE
```

---

## 25. Effect Lifecycle

```text
DECLARED
→ AUTHORIZED
→ PREPARED
→ DISPATCHING
→ DISPATCHED
→ COMMITTED
```

失败：

```text
REJECTED
FAILED
UNKNOWN
RECONCILING
```

---

## 26. Effect Intent

```ts
interface EffectIntent {
  effectId: string
  worldId: string
  agentId: string
  nodeRunId: string
  capabilityHandleId: string
  class: EffectClass
  operation: string
  targetDigest: string
  inputDigest: string
  idempotencyKey?: string
  state: EffectState
}
```

---

## 27. Effect UNKNOWN

例如：

```text
Git push 请求已经发出
↓
Orcana crash
↓
没有 Receipt
```

状态：

```text
UNKNOWN
```

禁止：

```text
retry push
```

必须：

```text
Git Driver.reconcile()
```

查询：

```text
remote ref
commit SHA
```

判断：

```text
已经成功
→ COMMITTED
确认没发生
→ RETRYABLE
无法判断
→ HUMAN_REQUIRED
```

---

## 28. Semantic Virtual Memory

现有 Context Pipeline 不删除。

它升级为：

> Semantic MMU

现有：

```text
ContextContribution
ContextProvider
ContextSlice
stable / plan / node / volatile
```

已经是很好的基础。

---

## 29. SemanticPage

```ts
interface SemanticPage {
  pageId: string
  worldId: string
  kind:
    | "task"
    | "code"
    | "memory"
    | "evidence"
    | "conversation"
    | "documentation"
    | "artifact"
    | "execution"
  contentRef: string
  sourceDigest: string
  semanticDigest: string
  estimatedTokens: number
  priority: number
  recency: number
  pinned: boolean
  reconstructable: boolean
  dependencies: string[]
}
```

---

## 30. ContextImage

每次模型调用不直接拿 Message History。

而是：

```text
AgentWorld
↓
Semantic MMU
↓
Working Set
↓
ContextImage
↓
LLM
```

---

## 31. Page Lifecycle

支持：

```text
page-in
page-out
pin
unpin
prefetch
evict
compress
invalidate
rehydrate
```

---

## 32. Semantic Page Fault

例如 Agent 进入：

`scheduler.ts`

MMU 检测：

```text
当前 Task 涉及 scheduler
↓
scheduler source pages 缺失
↓
相关 architecture ADR 缺失
↓
最近 scheduler evidence 缺失
```

自动：

```text
PAGE_FAULT
→ load
```

不要求模型自己反复：

```text
read_file
read_file
read_file
```

---

## 33. Context Pressure

定义：

```text
NORMAL
PRESSURED
CRITICAL
```

Pressure 指标：

```text
context tokens
pinned tokens
reconstructable tokens
ephemeral tokens
cache hit
fault frequency
compaction loss
```

---

## 34. Pressure Policy

```text
NORMAL
→ normal
PRESSURED
→ evict speculative context
→ compress old tool output
→ page out reconstructable docs
CRITICAL
→ checkpoint
→ preserve Task + Evidence + active code
→ rebuild minimum working set
```

---

## 35. Inference Receipt

以后每一次 LLM 调用也是正式执行事实。

```ts
interface InferenceReceipt {
  inferenceId: string
  worldId: string
  agentId: string
  nodeRunId: string
  provider: string
  model: string
  contextImageDigest: string
  capabilitySetDigest: string
  toolSchemaDigest: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cost: number
  latencyMs: number
  startedAt: number
  finishedAt: number
}
```

这样 Evolution Lab 才能真正公平比较：

```text
同模型？
同 Context？
同工具？
同权限？
同预算？
```

---

## 36. AgentProcess

Agent 成为真正的 Kernel Principal + Process。

```ts
interface AgentProcess {
  agentId: string
  parentAgentId?: string
  principalId: string
  worldId: string
  branchId: string
  role: string
  capabilityTableId: string
  semanticAddressSpaceId: string
  resourceBudgetId: string
  status: AgentProcessState
}
```

---

## 37. AgentProcess State

```text
NEW
RUNNABLE
RUNNING_INFERENCE
WAITING_EXECUTION
WAITING_EVENT
WAITING_EFFECT
WAITING_HUMAN
SUSPENDED
EXITED
FAILED
```

AgentProcess 不等于 Linux Process。

一个 AgentProcess 可以：

```text
Claude
↓
Linux Cell
↓
WAITING_EVENT
↓
DeepSeek
↓
Remote Worker
```

仍然是同一个 Agent。

---

## 38. Model Scheduler

模型正式成为：

> Cognitive Compute Resource

Model Scheduler 输入：

```text
Task type
risk
complexity
latency
cost
context requirements
privacy
required capabilities
historical quality
```

输出：

`ModelAllocation`

例如：

```text
simple classification
→ local/cheap
implementation
→ coding model
architecture decision
→ strong reasoning
verification
→ independent model
```

---

## 39. Unified Agent Resource Scheduler

现有 BudgetLedger 已经有 Reserve → Commit 模型。未来扩展资源维度。

### Compute

```text
CPU
RAM
GPU
disk
network
```

### Intelligence

```text
model calls
tokens
context
KV cache
API quota
money
```

### Authority

```text
write capability
network capability
secret access
deployment authority
```

### Human Attention

```text
approval
question
review
escalation
```

---

## 40. ResourceVector

```ts
interface AgentResourceVector {
  cpu?: number
  memoryBytes?: number
  gpu?: GPURequest
  contextTokens?: number
  modelClass?: string
  modelCostMax?: number
  externalActionBudget?: number
  attentionUnits?: number
}
```

---

## 41. Human Attention Scheduler

人类注意力变成资源。

优先级：

```text
P0 security incident
P1 irreversible side effect
P2 architecture decision
P3 ambiguity
P4 progress/info
```

多个低级请求：

```text
10 questions
```

应该合并为：

```text
Decision Packet
```

避免多 Agent 同时骚扰用户。

---

## 42. Event Kernel

Harness 当前事件已经具备 schema、sequence、run identity，可以作为初始协议。

但未来事件不是 UI telemetry。

而是 Agent 调度事实。

### Event

```text
world.changed
file.changed
artifact.created
execution.completed
service.ready
service.failed
github.pr.updated
memory.pressure
model.available
resource.available
approval.granted
deadline.reached
security.violation
```

Agent 可以：

```text
subscribe()
↓
WAITING_EVENT
```

而不是：

```text
LLM loop
→ polling
→ burn tokens
```

---

## 43. Agent Service Manager

服务：

```text
LSP
MCP
RepoIndexer
Reviewer
Browser
Database
Research Monitor
Memory Manager
Evolution Controller
```

声明：

```text
Requires
Wants
After
OnEvent
Capabilities
ResourceBudget
RestartPolicy
Owner
```

例如：

```yaml
service: reviewer
on:
  - github.pr.updated
requires:
  - repo-indexer
capabilities:
  - github.pr.read
  - github.pr.comment
model:
  class: reviewer
budget:
  cost: 0.20
```

事件到：

```text
github.pr.updated
```

Reviewer 才启动。

完成后销毁。

---

## 44. Capability VM

这是从 Cloudflare Worker JavaScript Backend 得到的重要启发。

Cloudflare isolate 默认没有宿主环境、任意网络和宿主秘密，而通过受信 Host Capability Modules 提供 node:fs、ws:git、ws:artifacts。

Orcana 可以建立：

> Capability VM

运行轻量 generated code：

```text
JSON transformation
text processing
structured analysis
small adapters
data filtering
agent-generated helper code
```

只提供：

```text
orca:fs
orca:git
orca:artifact
orca:memory
orca:model
orca:http
```

没有：

```text
ambient filesystem
ambient network
ambient process
ambient secrets
```

---

## 45. 三层执行模型

```text
Tier 1
Capability VM
↓
Fast / Narrow Authority
Tier 2
Linux Cell
↓
Full POSIX
Tier 3
MicroVM
↓
Extreme Risk
```

这是未来 Orcana 执行模型的推荐默认。

---

## 46. World Branch + Evolution

Evolution 不允许：

```text
正在运行的 Agent
直接修改当前正式 Runtime
```

必须：

```text
Baseline World
├── Candidate A
├── Candidate B
└── Candidate C
```

各自：

```text
World Branch
+
same benchmark
+
same context policy
+
same resources
```

完成：

```text
Evidence A
Evidence B
Evidence C
```

然后：

```text
Evolution Gate
→ Promotion
→ merge World Branch
```

---

## 47. Remote Worker 重新定义

远程 Worker 不应该拥有一个“自己的世界”。

它只获得：

```text
World Snapshot Manifest
+
Capability Grant
+
Execution Spec
```

查询：

```text
CAS objects already present?
```

只传：

```text
missing objects
```

执行：

```text
snapshot
→ projection
→ execute
→ delta
```

返回：

```text
Delta Manifest
Execution Receipt
Artifact refs
```

Coordinator：

```text
validate
→ World Commit
```

---

## 48. Remote Sync 不允许 Multi-Master

Cloudflare Computer 使用明确的权威 VFS + transient execution mirror，而不是多个完全对等文件系统。

Orcana 保持：

```text
AgentWorld
= authority
Remote Worker
= execution replica
```

避免直接上：

```text
CRDT Everything
```

---

## 49. World Migration

以后迁移的是：

> Agent Reality

不是 Linux Process。

迁移：

```text
World Snapshot
CAS
AgentProcess checkpoint
Pending Events
Capability Grants
Task State
```

然后：

```text
Laptop
↓ suspend
Server
↓ resume
```

只有真的需要保留进程状态的 Service 才考虑 CRIU。

---

## 50. 当前 Orcana 模块如何演进

### `src/harness/`

保留。

角色从：

```text
Agent Harness
```

逐渐变成：

```text
Agent Application Runtime
+
Kernel ABI Gateway
```

### Capability Registry

当前：

```text
CapabilityDescriptor
```

升级路线：

```text
CapabilityDescriptor
      ↓ compatibility
CapabilityDefinition
      +
CapabilityHandle
```

现有 capability router 仍负责：

```text
LLM tool disclosure
```

它不再负责：

```text
authority
```

现有 Router 已经按 task profile 动态披露工具，这个机制应该保留。

### `src/context/` + H10

升级：

```text
Context Pipeline
→ Semantic MMU
```

### `src/memory/`

变成：

```text
Semantic Page Store
Memory Objects
World Memory Driver
```

### `src/workflow/`

保持：

```text
Task / Dependency / Completion Authority
```

禁止塞 World 存储职责进去。

### `src/runtime/linux/`

保持：

```text
Linux Execution Fabric
```

禁止塞：

```text
Agent Task
Memory
Model Scheduler
Global Completion
```

进去。

### EvidenceLedger

保持 Evidence Authority。

增加关联：

```text
WorldCommit
ExecutionReceipt
EffectReceipt
InferenceReceipt
```

### Provider Router

逐步升级为：

```text
Model Scheduler
```

### Tool Registry

继续作为：

```text
LLM-facing API registry
```

不再被当作最终权限系统。

### Agent Loop

短期保持。

以后变成：

> AgentProcess 的一个 User-Space Runtime

而不是 Kernel 本身。

---

## 51. 推荐源码目录

```text
src/
├── kernel/
│   ├── abi/
│   │
│   ├── world/
│   │   ├── contracts.ts
│   │   ├── store.ts
│   │   ├── ledger.ts
│   │   ├── revision.ts
│   │   ├── snapshot.ts
│   │   ├── branch.ts
│   │   ├── commit.ts
│   │   └── cas.ts
│   │
│   ├── identity/
│   │   ├── principal.ts
│   │   └── identity-store.ts
│   │
│   ├── capabilities/
│   │   ├── definition.ts
│   │   ├── handle.ts
│   │   ├── table.ts
│   │   ├── delegation.ts
│   │   ├── policy.ts
│   │   └── audit.ts
│   │
│   ├── effects/
│   │   ├── contracts.ts
│   │   ├── journal.ts
│   │   ├── dispatcher.ts
│   │   └── reconciler.ts
│   │
│   ├── process/
│   │   ├── agent-process.ts
│   │   ├── process-table.ts
│   │   └── checkpoint.ts
│   │
│   ├── events/
│   │   ├── event-log.ts
│   │   ├── bus.ts
│   │   └── subscriptions.ts
│   │
│   ├── memory/
│   │   ├── semantic-page.ts
│   │   ├── address-space.ts
│   │   ├── mmu.ts
│   │   └── pressure.ts
│   │
│   ├── scheduler/
│   │   ├── resources.ts
│   │   ├── model.ts
│   │   ├── attention.ts
│   │   └── admission.ts
│   │
│   ├── services/
│   │   ├── contracts.ts
│   │   └── manager.ts
│   │
│   └── provenance/
│       ├── inference-receipt.ts
│       └── world-receipt.ts
│
├── drivers/
│
├── vm/
│   └── capability/
│
├── runtime/
│   └── linux/
│
├── harness/
├── workflow/
├── context/
├── memory/
└── provider/
```

---

## 52. 实施阶段总图

```text
AK-0   Kernel Constitution
  ↓
AK-1   Durable Agent World
  ↓
AK-2   World Projection + Commit
  ↓
AK-3   Identity + Capability Kernel
  ↓
AK-4   Effect Kernel
  ↓
AK-5   Semantic MMU
  ↓
AK-6   Agent Process + Unified Scheduler
  ↓
AK-7   Event Kernel + Service Manager
  ↓
AK-8   Driver Model + Capability VM
  ↓
AK-9   World Branch + Evolution
  ↓
AK-10  Distributed World / Migration
  ↓
AK-11  Trusted Agent Appliance
```

AK-11 是可选长期阶段。

### AK-0 — Kernel Constitution

#### 目标

先固定权威边界。

禁止直接写大量实现。

#### Task 0.1

新增：

```text
docs/agent-os/architecture.md
```

定义：

```text
AgentWorld
AgentProcess
AgentObject
Capability
Effect
WorldCommit
Projection
```

#### Task 0.2

ADR：

```text
ADR-AK-001 World Authority
ADR-AK-002 Execution Projection
ADR-AK-003 Task vs World Authority
ADR-AK-004 Capability vs Tool
ADR-AK-005 Effect Semantics
ADR-AK-006 Agent State vs Context
ADR-AK-007 External System Authority
```

#### Task 0.3

定义 authority graph。

写成自动测试的数据结构。

例如：

```text
Graph may command Kernel
Kernel may command Execution Fabric
Execution Fabric may never complete Graph
Driver may never mutate World directly
LLM Tool may never hold host secret
```

#### AK-0 Gate

```text
SECOND_TASK_AUTHORITY             = 0
SECOND_WORLD_AUTHORITY            = 0
TOOL_AS_AUTHORITY                 = 0
EXECUTION_COMPLETES_GRAPH_DIRECT  = 0
```

### AK-1 — Durable Agent World

这是第一项真正实现。

#### Task 1.1 WorldDB

SQLite Schema：

```text
world_meta
world_objects
world_heads
world_branches
world_commits
world_snapshots
world_events
world_artifacts
world_services
```

#### Task 1.2 World Revision

实现：

```text
compare-and-commit
```

要求：

```text
baseRevision
```

匹配 HEAD。

#### Task 1.3 WorldLedger

所有 mutation：

```text
append event
+
update materialized state
```

必须在同一个事务。

#### Task 1.4 CAS

实现：

```text
put()
get()
has()
link()
unlink()
gc()
```

CAS Object：

```text
digest
size
mediaType
createdAt
refCount / reachability
```

#### Task 1.5 Manifest

支持：

```text
Directory Manifest
File Manifest
World Manifest
```

#### Task 1.6 Snapshot

```text
world.snapshot()
```

必须是 deterministic。

#### Task 1.7 Recovery

模拟：

```text
transaction before commit crash
transaction after DB commit before response crash
CAS object written but manifest missing
manifest committed but CAS missing
```

#### AK-1 Gate

```text
WORLD_REVISION_SPLIT_BRAIN     = 0
LEDGER_DB_DIVERGENCE           = 0
CAS_MISSING_REFERENCED_OBJECT  = 0
UNREACHABLE_OBJECT_LEAK        = 0
NONDETERMINISTIC_SNAPSHOT      = 0
CRASH_LOSES_COMMITTED_WORLD    = 0
```

### AK-2 — Projection + World Commit

#### Task 2.1 Projection Contract

```ts
interface WorldProjectionPlan {
  worldId: string
  snapshotId: string
  mode:
    | "direct"
    | "native"
    | "live"
  writableRoots: string[]
  readonlyRoots: string[]
  expectedOutputs: string[]
}
```

#### Task 2.2 Native Projection

使用已有：

```text
OverlayFS
Linux Execution Fabric
```

#### Task 2.3 Delta Scanner

比较：

```text
lower
upper
```

生成：

```text
creates
writes
deletes
renames
```

#### Task 2.4 Delta Manifest

内容全部进入 CAS。

#### Task 2.5 Commit Validator

验证：

```text
base revision
assignment ownership
write authority
unexpected writes
expected outputs
```

#### Task 2.6 Commit Transaction

```text
Delta
→ CAS
→ WorldDB
→ Ledger
→ WorldCommitReceipt
```

#### Task 2.7 Conflict

实现：

```text
WORLD_HEAD_MOVED
```

第一版不自动 merge。

直接：

```text
retry projection
or
Graph replan
```

#### AK-2 Gate

```text
CELL_DIRECT_WORLD_MUTATION       = 0
UNAUTHORIZED_WORLD_WRITE         = 0
STALE_PROJECTION_COMMIT          = 0
DELTA_WITHOUT_CAS                = 0
WORLD_COMMIT_WITHOUT_RECEIPT     = 0
EXECUTION_SUCCESS_AUTO_COMPLETE  = 0
```

### AK-3 — Identity + Capability Kernel

#### Task 3.1 Principal

```text
User
Agent
SubAgent
Service
Driver
Worker
EvolutionCandidate
System
```

#### Task 3.2 CapabilityDefinition

从现有 CapabilityDescriptor 迁移。

保持 compatibility adapter。

#### Task 3.3 Handle Table

每 AgentProcess：

```text
CapabilityTable
```

#### Task 3.4 Delegation

支持：

```text
delegate
attenuate
expire
revoke
```

#### Task 3.5 Constraints

第一批：

```text
path
repository
branch
host
method
maxBytes
maxCalls
maxCost
expiration
```

#### Task 3.6 Kernel Authorization

所有 Capability 调用必须：

```text
Handle lookup
→ Principal check
→ rights
→ constraints
→ policy
→ allow
```

#### Task 3.7 Tool Adapter

现有 Tool：

```text
ToolCall
↓
Capability Request
```

Shadow 比较旧执行。

#### AK-3 Gate

```text
AMBIENT_CAPABILITY_ACCESS        = 0
CAPABILITY_ESCALATION            = 0
REVOKED_HANDLE_USE               = 0
EXPIRED_HANDLE_USE               = 0
CHILD_RIGHTS_GT_PARENT           = 0
TOOL_BYPASS_KERNEL               = 0
SECRET_VALUE_EXPOSED_TO_MODEL    = 0
```

### AK-4 — Effect Kernel

#### Task 4.1 Effect Classification

现有 sideEffect：

```text
none/read/write/external
```

升级为两维：

```text
World Mutation Class
+
External Effect Class
```

#### Task 4.2 Effect Journal

持久保存：

```text
Intent
Authorization
Dispatch
Result
Reconciliation
```

#### Task 4.3 Idempotency

驱动可声明：

```text
idempotencyKey
```

#### Task 4.4 Reconciler

第一批：

```text
Git
GitHub
Artifact Publish
```

#### Task 4.5 Unknown State

Crash injection：

```text
dispatch 前
dispatch 中
remote commit 后
receipt 前
```

#### Task 4.6 Completion Gate

Graph write/external node：

```text
Effect UNKNOWN
→ cannot complete
```

#### AK-4 Gate

```text
UNKNOWN_EFFECT_BLIND_RETRY       = 0
IRREVERSIBLE_EFFECT_UNAPPROVED   = 0
EFFECT_WITHOUT_INTENT            = 0
EFFECT_WITHOUT_PROVENANCE        = 0
NODE_COMPLETES_WITH_UNKNOWN      = 0
```

### AK-5 — Semantic MMU

这里才正式开始 Context Memory OS。

#### Task 5.1 SemanticPage

先给现有 ContextContribution 增加：

```text
pageRef
```

不要马上删旧接口。

#### Task 5.2 Page Store

Page 内容进入 CAS。

#### Task 5.3 Semantic Address Space

每 AgentProcess：

```text
SemanticAddressSpace
```

#### Task 5.4 Working Set

记录：

```text
mapped
pinned
prefetched
evicted
```

#### Task 5.5 Page Fault

第一版规则化。

不要使用 LLM 决定所有 paging。

输入：

```text
active node
changed files
symbol refs
plan
recent evidence
```

#### Task 5.6 Pressure Manager

指标：

```text
contextUsed
contextLimit
pinnedTokens
faultRate
compressionRatio
```

#### Task 5.7 ContextImage

每次 inference 生成 immutable：

```text
ContextImageManifest
```

#### Task 5.8 InferenceReceipt

正式绑定：

```text
ContextImageDigest
Model
Capabilities
Tools
Budget
```

#### Task 5.9 MMU Replay Eval

同一个：

```text
World Snapshot
Task
Model
```

比较：

```text
old Context Pipeline
vs
Semantic MMU
```

指标：

```text
success
token cost
context faults
repeated reads
constraint loss
```

#### AK-5 Gate

```text
UNTRACKED_CONTEXT_INJECTION      = 0
PINNED_PAGE_EVICTION             = 0
STALE_PAGE_UNDETECTED            = 0
INFERENCE_WITHOUT_CONTEXT_DIGEST = 0
CONTEXT_REPLAY_NONDETERMINISM    = 0
```

### AK-6 — Agent Process + Scheduler

#### Task 6.1 AgentProcess Table

Kernel 持久化：

```text
agentId
parent
world
branch
status
```

#### Task 6.2 Agent Loop Adapter

现有：

```text
agentLoop()
```

运行在一个 AgentProcess 内。

#### Task 6.3 Agent Signals

```text
SUSPEND
RESUME
CANCEL
REPLAN
RESOURCE_PRESSURE
```

#### Task 6.4 Model Registry

模型变成：

```text
ModelDevice
```

属性：

```text
capabilities
cost
latency
context
tool support
reliability
availability
```

#### Task 6.5 Model Scheduler

先规则化。

禁止第一版上 ML scheduler。

#### Task 6.6 Unified ResourceVector

把：

```text
Linux ResourceLedger
Harness BudgetLedger
Model quota
Context Budget
```

接入统一 Admission。

#### Task 6.7 Fairness

至少：

```text
Run fairness
Agent quota
Interactive reserve
Evolution quota
```

#### Task 6.8 Human Attention

建立：

```text
AttentionRequest
AttentionBudget
DecisionPacket
```

#### AK-6 Gate

```text
AGENT_ID_MODEL_COUPLED        = 0
RESOURCE_DOUBLE_RESERVATION   = 0
BACKGROUND_STARVES_USER       = 0
EVOLUTION_STARVES_PRODUCTION  = 0
UNBOUNDED_HUMAN_INTERRUPTS    = 0
```

### AK-7 — Event Kernel + Service Manager

#### Task 7.1 Kernel Event

扩展现有 Harness Event。

Kernel Event 必须持久化关键事件。

#### Task 7.2 Subscription

```text
subscribe
unsubscribe
cursor
ack
```

#### Task 7.3 Event Wake

AgentProcess：

```text
WAITING_EVENT
```

可被：

```text
event
```

唤醒。

#### Task 7.4 Event Dedup

```text
eventId
sourceId
sourceSequence
```

#### Task 7.5 ServiceDefinition

```text
Requires
After
OnEvent
Capabilities
Resources
Restart
```

#### Task 7.6 Service Manager

第一批迁移：

```text
LSP
MCP
Repo Indexer
```

#### Task 7.7 Activation

Service 可以：

```text
OnEvent
→ Start
→ Work
→ Idle
→ Stop
```

#### AK-7 Gate

```text
EVENT_LOST_AFTER_COMMIT        = 0
DUPLICATE_EVENT_DOUBLE_EFFECT  = 0
POLLING_REQUIRED_FOR_PROGRESS  = 0
SERVICE_ORPHAN                 = 0
SERVICE_BYPASS_CAPABILITY      = 0
```

### AK-8 — Driver Model + Capability VM

#### Task 8.1 Driver Runtime

Driver 不允许任意 in-process 加载。

#### Task 8.2 Driver Manifest

```yaml
driver: github
provides:
  - github.repo.read
  - github.repo.push
requires:
  - network.github.com
effects:
  push: reconcilable
```

#### Task 8.3 GitHub Driver

作为第一批完整 Driver。

#### Task 8.4 Capability VM

首选：

```text
JavaScript isolate
```

或：

```text
QuickJS
```

需要严格评测后选择。

#### Task 8.5 Trusted Modules

```text
orca:fs
orca:git
orca:artifact
orca:memory
```

#### Task 8.6 No Ambient Authority

VM 内：

```text
no host env
no arbitrary network
no node child_process
no raw secret
```

#### Task 8.7 Backend Router

规则：

```text
structured low-risk
→ Capability VM
POSIX workload
→ Linux
extreme risk
→ MicroVM
```

#### AK-8 Gate

```text
DRIVER_FULL_HOST_AUTHORITY      = 0
VM_AMBIENT_NETWORK              = 0
VM_AMBIENT_SECRET               = 0
VM_RAW_PROCESS                  = 0
BACKEND_CHANGES_AUTHORITY       = 0
```

### AK-9 — World Branch + Evolution

#### Task 9.1 Branch API

```text
branch.create
branch.checkout
branch.diff
branch.merge
branch.discard
```

#### Task 9.2 Branch Isolation

Agent A/B：

```text
same base
different world heads
```

#### Task 9.3 Reviewer Snapshot

Reviewer 得到：

```text
readonly World Snapshot
```

#### Task 9.4 Evolution Branch

```text
baseline
candidate
```

正式化。

#### Task 9.5 Evaluation Manifest

不可由 Candidate 修改。

#### Task 9.6 Promotion

```text
Candidate World
↓
Evidence
↓
Promotion Gate
↓
World Merge
```

#### Task 9.7 Rollback

Promotion 后出现回归：

```text
new World head
→ previous stable snapshot
```

#### AK-9 Gate

```text
CANDIDATE_MUTATES_EVALUATOR    = 0
CANDIDATE_MUTATES_BASELINE     = 0
FAILED_SAMPLE_DELETION         = 0
BRANCH_STATE_LEAK              = 0
PROMOTION_WITHOUT_EVIDENCE     = 0
```

### AK-10 — Distributed World + Migration

只有 AK-1～9 稳定后才能做。

#### Task 10.1 World Manifest Protocol

```text
snapshot
CAS hashes
revision
branch
```

#### Task 10.2 Worker Have/Want

借鉴 Cloudflare 的 content-addressed sync：

```text
Coordinator:
need A B C D
Worker:
have A C
transfer:
B D
```

#### Task 10.3 Delta Return

Worker 不能直接修改 WorldDB。

#### Task 10.4 Worker Lease

```text
lease
fencing token
expiration
```

#### Task 10.5 Remote Receipt

```text
worker identity
runtime version
snapshot digest
capability digest
execution receipt
delta digest
```

#### Task 10.6 Agent Suspend

checkpoint：

```text
AgentProcess
World Revision
Semantic Working Set
Pending Events
Pending Effects
Capabilities
```

#### Task 10.7 Resume Elsewhere

```text
Laptop
→ snapshot
→ Server
→ resume
```

#### AK-10 Gate

```text
REMOTE_WORKER_GLOBAL_AUTHORITY   = 0
REMOTE_DIRECT_WORLD_MUTATION     = 0
STALE_LEASE_COMMIT               = 0
MISSING_CAS_EXECUTION            = 0
MIGRATION_LOSES_PENDING_EFFECT   = 0
```

### AK-11 — Trusted Agent Appliance

这是最后阶段，不是当前主线。

包括：

```text
Immutable Linux
Secure Boot
TPM
Measured Runtime
fs-verity
dm-verity
A/B update
eBPF Semantic Telemetry
Device Broker
```

只有真正形成 Agent OS 产品后再进入。

---

## 53. 评测体系必须同步升级

不能只测：

```text
test passed
```

必须建立：

> Agent OS Conformance Suite

### World

```text
W-001 revision atomicity
W-002 crash recovery
W-003 deterministic snapshot
W-004 CAS GC safety
W-005 stale commit rejection
```

### Capability

```text
C-001 attenuation
C-002 revocation
C-003 expiration
C-004 object scope
C-005 secret isolation
```

### Effect

```text
E-001 dispatch crash
E-002 reconcile success
E-003 reconcile unknown
E-004 idempotency
E-005 irreversible approval
```

### Memory

```text
M-001 page fault
M-002 pinned preservation
M-003 stale invalidation
M-004 pressure
M-005 replay
```

### Agent

```text
A-001 suspend/resume
A-002 parent/child
A-003 cancellation
A-004 model migration
A-005 capability inheritance
```

### Event

```text
EV-001 durable event
EV-002 duplicate
EV-003 cursor resume
EV-004 wake
EV-005 ordering
```

### Evolution

```text
X-001 baseline immutable
X-002 evaluator immutable
X-003 candidate isolation
X-004 promotion
X-005 rollback
```

---

## 54. 故障注入必须成为日常测试

每个关键状态之间随机 Crash。

例如：

```text
Execution completed
↓ CRASH
World commit
```

以及：

```text
effect dispatch
↓ CRASH
receipt
```

以及：

```text
CAS write
↓ CRASH
DB commit
```

以及：

```text
Event commit
↓ CRASH
delivery
```

目标：

> Orcana 不靠“正常路径恰好成功”证明正确性。

---

## 55. 性能指标

Agent OS 不允许因为“更正确”导致不可接受性能倒退。

必须长期跟踪：

```text
World snapshot latency
Projection cold start
Projection warm start
CAS hit rate
World commit latency
Context page fault rate
Context cache hit
Repeated read reduction
Model routing cost
Agent idle token burn
Event wake latency
Human interruptions / task
Remote sync bytes saved
Evolution experiment cost
```

---

## 56. 最重要的五个 SLO

第一阶段建议以这些趋势目标为主，而不是马上固定绝对数值：

1. World commit 不成为普通 coding workload 的主要延迟来源。
2. Native Projection 相比现有 Execution Fabric 的额外 overhead 足够低。
3. Semantic MMU 显著降低重复 read 与 context rebuild。
4. WAITING_EVENT Agent 的模型 Token 消耗接近 0。
5. Remote Worker 大多数重复项目执行只同步 Delta/CAS miss。

数值阈值通过正式 baseline 后冻结。

---

## 57. 禁止事项

### AK-1 之前禁止

```text
Agent-aware Linux scheduler
eBPF policy
CRDT World
distributed WorldDB
```

### AK-3 之前禁止

开放第三方 Agent Driver。

因为 Capability Kernel 不存在。

### AK-4 之前禁止

```text
Agent 自动发送邮件
Agent 自动发布
Agent 自动部署生产
Agent 自动支付
```

### AK-5 之前禁止

继续增加第二套长期 Memory 系统。

### AK-9 之前禁止

Recursive Evolution 自动晋升。

### AK-10 之前禁止

真正多机 World authority。

---

## 58. 第一批 36 个具体工程任务

严格建议按这个顺序。

### Foundation

1. 建立 `docs/agent-os/`。
2. 写 World Authority ADR。
3. 写 Execution Projection ADR。
4. 写 Capability vs Tool ADR。
5. 写 Effect Semantics ADR。
6. 写 Context != State ADR。

### World Core

7. 创建 `src/kernel/world/contracts.ts`。
8. 创建 World SQLite schema。
9. 实现 World revision。
10. 实现 WorldLedger。
11. 实现 CAS。
12. 实现 File Manifest。
13. 实现 World Snapshot。
14. 实现 crash recovery tests。

### Projection

15. 定义 ProjectionPlan。
16. Native Overlay projection。
17. Delta Scanner。
18. Delta Manifest。
19. Commit Validator。
20. WorldCommitReceipt。
21. 将一个真实 read/write Coding Node 接入完整链。

### Capability

22. 定义 Principal。
23. 定义 CapabilityDefinition。
24. 定义 CapabilityHandle。
25. 定义 CapabilityTable。
26. 实现 attenuation。
27. 实现 revoke/expire。
28. 为现有 CapabilityDescriptor 写 compatibility adapter。
29. 将 read_file 接入 Kernel Handle。
30. 将 run_process 接入 Kernel Handle。
31. 将 Git 能力接入 Kernel Handle。

### Effect

32. 实现 EffectJournal。
33. Git Push 迁移为 Effect。
34. Git Push Reconciler。
35. 将 EffectReceipt 绑定 Evidence。
36. 完成第一条：

```text
Graph
→ Kernel
→ World Projection
→ Linux Execution
→ World Commit
→ Effect
→ Evidence
→ Completion
```

只有完成任务 36，才进入 Semantic MMU。

---

## 59. 第一个完整纵向 Slice

不要同时做所有对象。

第一条端到端最好选：

> “Agent 修改一个 TypeScript 文件并提交到 World。”

流程：

```text
User Task
↓
Graph Node
↓
AgentProcess
↓
Semantic MMU Context
↓
Model
↓
ToolCall apply_patch
↓
Capability Handle validation
↓
World Snapshot
↓
Native Projection
↓
Linux / Patch execution
↓
Delta
↓
World Commit
↓
Verification
↓
Evidence
↓
Graph Complete
```

这个 Slice 不涉及：

```text
external effect
remote worker
multi-agent
```

非常适合验证 World 架构。

---

## 60. 第二个纵向 Slice

> “Agent 修改代码 → Git commit → push。”

增加：

```text
Effect Kernel
Git Driver
UNKNOWN reconcile
```

故障测试：

```text
push 已成功
Orcana 在 receipt 前 crash
```

重启：

```text
reconcile
→ remote commit exists
→ Effect COMMITTED
```

不得第二次 push。

---

## 61. 第三个纵向 Slice

> “Agent 等待 GitHub PR review。”

流程：

```text
Agent creates PR
↓
WAITING_EVENT
↓
AgentProcess suspended
↓
0 polling LLM calls
↓
GitHub Driver event
↓
Agent wakes
↓
Semantic MMU loads PR context
↓
continue
```

完成这个 Slice 后，Agent OS 的长期自治轮廓就已经形成。

---

## 62. 第四个纵向 Slice

> “两个 Agent 在同一个 World 的不同 Branch 工作。”

```text
World rev 100
├── branch A
└── branch B
```

完成：

```text
A WorldDelta
B WorldDelta
```

Reviewer：

```text
readonly snapshots
```

Graph：

```text
merge decision
```

这是 Multi-Agent 正确进入 Agent OS 的方式。

---

## 63. 第五个纵向 Slice

> “Evolution Candidate 修改 Orcana 自身。”

```text
Stable World
↓
Evolution Branch
↓
Candidate AgentProcess
↓
Capability restricted
↓
benchmark
↓
Evidence
↓
Human approval
↓
merge
```

这个阶段才可以正式称为：

> governed recursive evolution

---

## 64. 对 Cloudflare Computer 的最终吸收原则

应该直接借鉴：

```text
durable authority separated from execution
pluggable runtime
content-addressed transfer
revision/cursor recovery
idempotent synchronization
execution completion separated from sync completion
backend routing != authorization
```

Cloudflare Computer 当前项目本身仍明确标为 Preview，且其设计文档存在前瞻内容，因此应该吸收原则和已验证实现方式，而不是把它当生产规范直接复制。

不要直接复制：

```text
FUSE everywhere
Cloudflare-specific Durable Object lifecycle
single workspace/container topology
last-writer-wins for every Orcana World conflict
backend-defined authorization
cloud-only assumptions
```

---

## 65. 对 Pi 的最终吸收原则

应该吸收：

```text
minimal agent loop
Agent State != LLM Message
transformContext seam
event-first architecture
steering / follow-up queues
branchable session history
extensions around a small stable core
```

Pi 的 Session 通过 id/parentId 形成可分支历史，这个思想适合升级为 World Branch，而不是只保留为 conversation branch。

不要复制：

```text
extension = full host authority
conversation = durable world
tool = capability authority
```

---

## 66. 最终的 Orcana 定位

当 AK-0～AK-10 全部成立时，Orcana 不再只是：

```text
Coding Agent Runtime
```

而是：

```text
Orcana Agent OS
```

定义：

> A governed operating system for durable autonomous agents.

核心模型：

```text
Durable World
+
Replaceable Cognition
+
Ephemeral Execution
+
Explicit Authority
+
Reconciled Effects
+
Verifiable Provenance
```

可以进一步压缩成：

```text
World
长期存在
AgentProcess
可暂停
Model
可替换
Context
可换入换出
Execution
临时
Worker
可替换
Tool
只是接口
Capability
决定权限
Effect
受治理
Evidence
决定完成
```

---

## 67. 真正达到 Agent OS 的验收标准

只有以下问题全部能被系统准确回答，才算真正完成：

```text
这个 Agent 是谁？
它属于哪个 World？
World 当前 Revision 是多少？
它看到的是哪个 Snapshot？
它为什么拥有这个权限？
权限从谁委托而来？
它当前有哪些 Capability Handles？
当前模型为什么被选择？
模型真正看到了哪些 Semantic Pages？
执行发生在哪个 Backend？
执行使用了哪些 Linux 资源？
产生了什么 World Delta？
Delta 是否已经正式 Commit？
是否发生外部副作用？
副作用当前是 COMMITTED 还是 UNKNOWN？
有哪些 Evidence 支持完成？
如果现在整机断电，哪些状态可以恢复？
如果换一台机器，Agent 能否从同一个 World 继续？
如果 Agent 自己修改 Orcana，候选是否与正式世界隔离？
```

全部回答得出来：

`Orcana`

才真正从：

`Agent Runtime`

跨到了：

`Agent Operating System`
