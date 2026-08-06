# Orcana Runtime Durable Runtime 整体实施方案

**方案版本：** DUR-1.0
**计划线：** DUR（Durable Run History + Effect Receipt）
**仓库基线：** `Leo-Ayh-Oday/orcana-runtime`
**基线版本：** `v0.8.16`
**实施原则：** 增量演进、默认关闭、单写者优先、行为冻结（缺省路径逐字节不变）、History 权威 + Snapshot 投影、三崩溃窗口测试进 CI。

**参考报告：** Temporal 深审（2026-08-06，会话内报告）、Kigi 深审（2026-08-06，会话内报告）。两份报告均为静态审查（本机无法解析 `github.com`，未克隆/构建/运行），本方案只吸收其语义结论，不复制其代码、API 表面或架构（见 §6 借鉴边界）。

**性质声明：** 本计划是自建实现。借鉴的是行业通用模式（Event Sourcing、at-least-once + 幂等、Worker/Verifier 分离、Worktree 隔离）；实现全部为 Orcana 自有代码，长在 `src/workflow/`、`src/harness/`、`src/runtime/linux/` 现有架构之上；Temporal 分布式控制面、Task Token、Kigi 文本 Marker 协议等均显式 REJECT。

---

## 实施进度

| PR | 状态 | 版本 | 日期 | 备注 |
| --- | --- | --- | --- | --- |
| DUR-000 Verifier 能力隔离 | 待开始 | v0.8.17 | — | Kigi P0 清偿：验证节点只读从 prompt 契约升级为能力 Profile 强制 |
| DUR-001 Run Event Store + 投影恢复 | 待开始 | v0.8.18 | — | 权威追加日志 + 纯 reducer + 快照/tail 恢复 + 状态哈希 + 版本门 |
| DUR-002 Effect Ledger + 幂等收据 | 待开始 | v0.8.19 | — | 写节点 + Sandbox Cell 的 attempt/lease/heartbeat/receipt |
| DUR-003 Durable Timer + 中断生命周期 | 待开始 | v0.9.0 | — | Timer 事件族消费、中断过期、运行中断/恢复审计 |

---

# 一、方案定位

## 1.1 DUR 在 Orcana 中是什么

DUR 是运行真相层：把 Orcana 运行状态的权威来源从"进程内存 + best-effort 快照"升级为"append-only 事件日志 + 可重建投影"。

```text
用户目标
  ↓
Execution Graph（G0–G7）── 图编排层（已有）
  ↓
Run Event Log（DUR）───── 持久真相层（本方案）
  ├─ Node 生命周期事件
  ├─ Effect 尝试/租约/收据
  ├─ Timer 事件
  └─ 中断生命周期事件
  ↓
投影（Snapshot + Tail Replay）── 加速读取层
  ↓
Evidence / 完成门 ────────── 可信结论层（已有）
```

完成后三层闭环：

> 事件日志（事实）→ 投影（状态）→ 证据（声明）→ 完成门（结论），每一层可审计。

## 1.2 目标与非目标

### 本轮必须实现

1. 权威 append-only Run Event Log（每 run 线序追加，fsync 提交，行原子）；
2. 纯确定性 Projection Reducer + 周期 Snapshot（temp+rename）+ state_hash；
3. Tail Replay 恢复 + 哈希校验，失败 fail-closed；
4. 版本门：schemaVersion / reducerVersion / specDigest 不匹配 → fail closed；
5. Effect Attempt / Lease / Heartbeat / Receipt + 幂等键（写节点 + Sandbox Cell）；
6. Durable Timer 原语 + 中断过期消费 + RunInterrupted/RunResumed 生命周期事件；
7. 验证节点能力隔离（Kigi P0 清偿）；
8. 三个崩溃窗口验收实验（EXP-DUR-001/002/003）进 CI；
9. 确定性验证：同一 History 重放 100 次 state_hash 相同（EXP-DUR-004）。

### 本轮明确不做

- 不建缩小版 Temporal Server：无多服务拆分、无 Task Token、无 Shard、无 Multi-cluster、无 Remote Task Queue；
- 不宣称 exactly-once execution：只承诺 at-least-once attempt + 幂等收据；
- 不重算式 Replay LLM/工具输出：输出 = Event Payload，只记录不重算生成；
- 不复制 Kigi 文本 Marker 协议（NODE_RESULT/NODE_VERDICT 类）：使用 typed 结果通道；
- 不改 `agentLoop()`、不触碰 TUI、不动 GateChain、不动 EvidenceLedger 对外 API；
- 不改 G1–G7 既有测试语义（History 缺省关闭，行为冻结）；
- Signal / Update / Continue-As-New / Worker Versioning / SQLite 权威存储：DEFER（触发条件见 §10）；
- 不把 EvidenceLedger 平行改造成第二套系统（只接进账事件，账本 API 不动）。

---

# 二、当前基础（2026-08-06 勘察结论）

| 现状 | 位置 | 结论 |
| --- | --- | --- |
| 节点结果持久化 = 整文件覆盖快照，best-effort | `src/workflow/results/result-store.ts` | 非权威、无 fsync、写失败静默吞掉 |
| 唯一追加流是观测性 Trace | `src/agent/run-trace.ts`、`src/harness/telemetry/trace-writer.ts` | 观察日志，不是状态权威源 |
| 真正耐久的记录只有 Interrupt | `src/workflow/interrupts/`（MACP-M4，`.orcana/workflow/interrupts/<id>.json`） | 已含 `computeSpecDigest` + workspaceHash 先例 |
| R5 Sandbox Receipt → Evidence | `src/runtime/linux/receipt.ts`、`src/agent/evidence-ledger.ts`（ingestSandboxReceipt） | 已是 mini Effect Receipt，但只进内存台账 |
| 证据账本随 Run JSON 序列化 | `src/harness/persistence/{serialization,harness-store,file-harness-store}.ts` | 快照式，非事件源 |
| sqlite+WAL 先例（仅检索加速） | `src/memory/sqlite-store.ts`、`src/session/` | 仓库哲学：JSONL 为真相、sqlite 是加速层 |
| 调度决策可确定性重算 | `src/workflow/scheduler/{ready-queue,dependency-policy,concurrency-controller}.ts` | Reducer 可直接复用其语义 |
| 写节点单写者事务 | `src/workflow/execution/transaction-executor.ts`（apply_patch/run_process/run_targeted_verification） | Effect 收据的天然接线点 |
| 多 Agent 合并事务 + 全量验证 | `src/workflow/agents/{integration-plan,integration-verifier}.ts`（MACP-M5） | DUR-002 合并事件接线点 |
| 验证节点 | `src/harness/nodes/verification-node.ts`、`src/workflow/coordination/role-output-validator.ts` | DUR-000 隔离对象 |
| 测试/门禁 | `tests/workflow/*`、package.json scripts | typecheck / test / build / pack:check / git diff --check |

---

# 三、核心设计决策

## D1. 事件日志格式与提交纪律

```
.orcana/workflow/runs/<runId>.events.jsonl    # 权威日志
.orcana/workflow/runs/<runId>.snapshot.json   # 投影快照（temp+rename）
```

- 一行一个 Event，行内 `schemaVersion`；`seq` 单调递增、run 内唯一；
- 提交 = `openSync(fd)` 句柄 + `appendFileSync(fd, line)` + `fdatasyncSync(fd)`（批提交）；
- 恢复 = 解析合法前缀：遇不可解析/撕裂行即停（行原子追加保证撕裂行无法伪装成合法 JSON）；seq 出现缺口 → fail-closed；
- 单写者：同一 run 只有一个 scheduler 实例追加，无需锁；快照替换使用临时文件 + rename（参考 Kigi storage 的原子覆盖思路与现有 `interrupt-store` 的同步写模式）；
- 与既有观测流的关系：Harness Trace（`.orcana/harness/events/<runId>.jsonl`）是观测性遥测，DUR 日志是权威状态源，二者不合并、不互斥。

## D2. Reducer 与投影

- `reduceProjection(state, event) → state` 纯函数（无 IO、无时钟依赖；时间戳只进 Payload 不进决策）；
- 投影 = nodeResults 表 + runMeta + effect 投影 + timer 投影；
- `state_hash = sha256(规范化投影)`；Snapshot 记录 `{throughSeq, stateHash, reducerVersion}`；
- 恢复 = 读最新快照 → 验哈希 → Tail Replay → 重算哈希比对，不一致 → 拒绝恢复（不静默继续）；
- 决策可重算性：Ready 集合由既有 `ReadyQueue` / `dependency-policy` 从投影确定性推出——Temporal "Command 匹配"的本地等价物；EXP-DUR-004 的 100 次重放哈希相等作为运行时断言而非仅测试断言。

## D3. 接线方式：可选注入，行为冻结

- `SchedulerOptions.history?: RunHistoryStore`（缺省 = 今天的行为逐字节不变，G1–G7 测试零改动回归）；
- `new ResultStore(...)` 构造点换成工厂：有 history → `HistoryBackedResultStore`（同一接口，内部 = append + 投影更新 + 按阈值快照）；无 history → 原 ResultStore；
- 现有 `store.put()/restore()` 调用点零改动；history 模式下 `store.restore()` 变为"日志恢复"。

## D4. Effect 语义

- Effect 事件与节点事件**同一条日志**（单一写路径——关闭 Kigi Crash Window 的关键）；
- `effectId = stableHash(nodeId + requestHash)`；`idempotencyKey` 由业务侧提供；
- 状态机：`EffectRequested → EffectLeased → EffectHeartbeat* → EffectCompleted | EffectFailed`；
- 崩溃后：同 `idempotencyKey` 存在 `EffectCompleted` → 直接复用结果、禁止重执行（EXP-DUR-002）；
- R5 SandboxReceipt digest 作为 `EffectCompleted` 的 `receiptRef` 进事件（升级现有链路，不另建系统）。

## D5. 版本门

- 每个 Event 行 `schemaVersion`；`RunStarted` 携带 `reducerVersion + specDigest`（复用 `computeSpecDigest`）；
- 恢复时 reducerVersion/specDigest 与当前运行不匹配 → fail closed + 明确错误（EXP-DUR-005）。

## D6. 验证隔离

- VerificationNode 与多 Agent integration verify 回调以能力 Profile 运行（read/search/git diff/test 允许；write/network-mutation/写侧 exec 拒绝），拒绝不靠 prompt；
- 复用 H9 Capability Registry 的 policy 层，新增 `readonly-verifier` 预置 Profile；越权 → `capability_denied` Evidence + 节点失败。

## D7. 已定决策（可复议）

| 决策点 | 默认选择 | 理由 | 复议条件 |
| --- | --- | --- | --- |
| Event 存储介质 | JSONL + fsync（行原子） | 贴合仓库"JSONL 为真相"哲学；SQLite 有先例但改动面大 | 事件量级导致 Tail Replay 变慢，或需要跨事件批量原子性 |
| Effect 覆盖范围 | 写节点 + Sandbox Cell | 低频高价值；agent 节点内每次 tool 调用高频且已有 Trace | 出现真实"agent 节点副作用重复执行"事故 |
| DUR-000 归属 | 并入 DUR 计划线 | 一次计划线一个 release 节奏 | 需要独立交付时单开 |

---

# 四、PR 详细任务单

## PR-DUR-000：Verifier 能力隔离（v0.8.17）

**目标：** 清偿 Kigi 报告 P0 缺陷——验证只读由 prompt 契约升级为能力边界。

### 交付

- `src/harness/capabilities/verifier-profile.ts`：预置 readonly Profile（允许：read/search/git diff/测试类命令；拒绝：写文件、git commit、网络写、写侧 exec）；
- `src/harness/nodes/verification-node.ts` 接线：验证执行包在 Profile 下运行；
- `src/workflow/agents/integration-verifier.ts`：verify 回调走同一 Profile；
- 越权行为 → `capability_denied` Evidence 记录 + 节点失败。

### 测试（tests/harness_verifier_isolation.test.ts）

- EXP-KIGI-001：Verifier 尝试写文件 → 权限拒绝 + `capability_denied` Evidence；
- Profile 允许操作全部可用；拒绝操作全部 fail-closed；
- 原 VerificationNode / integration 测试零改动回归。

### 门禁

五门禁 + L0 Golden Trace + `harness_*` 冻结测试零改动。

## PR-DUR-001：Run Event Store + 投影恢复（v0.8.18）

**目标：** 建立权威事件日志与可验证恢复，这是全部 DUR 的地基。

### 新增文件

```text
src/workflow/durability/
├── contracts.ts               # RunEvent 类型族、schemaVersion、seq、causation/correlationId
├── event-log.ts               # fd 追加 + fdatasync 批提交 + 前缀解析恢复（撕裂行停止）
├── reducer.ts                 # 纯函数投影 + state_hash（规范化投影 sha256）
├── snapshot.ts                # temp+rename 快照、throughSeq/stateHash/reducerVersion 校验
├── history-store.ts           # RunHistoryStore 门面（append/replay/snapshot/restore/version）
└── history-backed-store.ts    # ResultStore 兼容包装（put/restore/all 语义不变）
```

### 事件族（最小集）

```text
RunStarted / NodeScheduled / NodeStarted / NodeCompleted / NodeFailed / NodeBlocked
RunInterrupted / RunResumed / RunCompleted / RunFailed
```

### 接线

- `SchedulerOptions.history?: RunHistoryStore`；`scheduler.ts` 中 `new ResultStore(...)` 构造点换成工厂；
- 快照时机：run 终态 + 每 128 事件 + interrupt 暂停前；
- 恢复路径：快照 → 验哈希 → tail 重放 → 重算哈希比对；失败 fail-closed。

### 测试

```text
tests/workflow/durable-log.test.ts         # 追加/读回/撕裂行/seq 缺口 fail-closed
tests/workflow/durable-projection.test.ts  # EXP-DUR-004：同一 History 重放 100 次哈希相等
tests/workflow/durable-crash.test.ts       # EXP-DUR-001：事件已提交、快照前杀进程 → 恢复哈希一致
tests/workflow/durable-version.test.ts     # EXP-DUR-005：旧事件 + 新 reducerVersion → fail closed
tests/workflow/scheduler-replay.test.ts    # +history 模式对照（缺省路径回归不变）
```

## PR-DUR-002：Effect Ledger + 幂等收据（v0.8.19）

**目标：** 副作用从"碰运气重试"升级为"可安全接管、可安全重试"。

### 事件族追加

```text
EffectRequested / EffectLeased / EffectHeartbeat / EffectCompleted / EffectFailed
TimerScheduled / TimerFired / TimerCanceled   # 先落族，消费在 DUR-003
```

### 交付

- Effect 投影字段：`effectId / idempotencyKey / attempt / leaseOwner / leaseExpiresAt / heartbeatAt / receiptRef`；
- 接线点：`transaction-executor.ts`（写节点）、sandbox cell 执行（R5 路径）、`ingestSandboxReceipt` 前插入 Effect 提交事件；
- 崩溃恢复：同 `idempotencyKey` 已有 `EffectCompleted` → 复用结果、禁止重执行；
- 租约：`leaseExpiresAt` 过期可接管；持续心跳不抢占；
- 附项（EXP-KIGI-003 语义）：worktree 合并（MACP-M5）成功但事件未提交的窗口，通过 Merge Receipt 事件识别已提交、不重执行。

### 测试

```text
tests/workflow/durable-effect.test.ts
# EXP-DUR-002：副作用成功、Receipt 回写前杀进程 → 重试同 key 不重执行，最终一个 EffectCompleted
# EXP-DUR-007：Worker A 租约过期 → B 接管；A 持续心跳 → B 不抢占
# EXP-KIGI-003：Merge 成功、状态提交前崩溃 → 恢复后凭 Merge Receipt 不重执行
```

## PR-DUR-003：Durable Timer + 中断生命周期（v0.9.0）

**目标：** 定时语义进入持久状态机；中断生命周期进入审计闭环。

### 交付

- Timer 投影：恢复时扫描未触发 Timer，过期即 `TimerFired`（仅一次）；
- 消费点：MACP-M4 中断 `expiresAt` 过期判定改走 Timer 事件（记录仍归 InterruptStore，只加生命周期事件，防双写）；
- `RunInterrupted / RunResumed` 绑定 interrupt 创建/回答（审计闭环，InterruptStore 保持记录权威）。

### 测试

```text
tests/workflow/durable-timer.test.ts             # EXP-DUR-003：TimerScheduled → 关进程 → 超期 → 重启 → TimerFired 恰好一次
tests/workflow/durable-interrupt-lifecycle.test.ts
```

### 明确不做（触发条件见 §10）

Signal / Update 不在本 PR。

---

# 五、验收实验（进 CI，一个都不能省）

| 编号 | 场景 | 断言 | 归属 |
| --- | --- | --- | --- |
| EXP-DUR-001 | 事件已提交、快照前杀进程 → 重启 | Tail Replay 后 state_hash 与无崩溃运行一致 | DUR-001 |
| EXP-DUR-002 | 副作用成功、Receipt 回写前杀 Worker → 重试 | 同 idempotencyKey 不重执行；最终一个 EffectCompleted | DUR-002 |
| EXP-DUR-003 | TimerScheduled → 关进程 → 超过 Deadline → 重启 | TimerFired 恰好一次 | DUR-003 |
| EXP-DUR-004 | 同一 History Replay 100 次 | state_hash / ready 集 / 完成判定全部相同 | DUR-001 |
| EXP-DUR-005 | 旧事件 + 新 reducerVersion | fail closed，禁止静默用新语义继续 | DUR-001 |
| EXP-DUR-007 | A 租约过期 → B 接管；A 持续心跳 → B 不抢占 | 租约语义正确 | DUR-002 |
| EXP-KIGI-001 | Verifier 尝试写文件 | 权限拒绝 + capability_denied Evidence | DUR-000 |
| EXP-KIGI-003 | Worktree Merge 成功、状态提交前崩溃 | 恢复后凭 Merge Receipt 不重执行 | DUR-002 |

---

# 六、借鉴边界（抄袭 vs 自建）

| 维度 | 处理 |
| --- | --- |
| 借鉴的模式（Event Sourcing、at-least-once + 幂等、Worker/Verifier、Worktree 隔离、append-only Replan） | 通用软件模式，直接采用其语义 |
| 自建的实现 | 全部新写，长在 Orcana 现有架构（ResultStore 接口、computeSpecDigest、Capability Registry、sandbox receipt、既有 scheduler 接线） |
| REJECT：Temporal 四服务/Task Token/Shard/Multi-cluster/Persistence 后端 | 不复制产品架构与 API 表面 |
| REJECT：Kigi 文本 Marker 协议/FNV32 Slug ID/快照即真相/prompt-only 只读 | 改用 typed 通道、content hash、事件权威、能力 Profile |
| 许可 | 两份参考项目均为宽松许可（MIT/Apache-2.0）；未复制代码；如未来字段命名需对齐，在 `ACKNOWLEDGMENTS.md` 加来源说明 |

---

# 七、门禁与提交约定

- 每 PR 五门禁：`bun run typecheck` / `bun run test` / `bun run build` / `npm pack --dry-run` / `git diff --check`；
- 必须保持 L0 Golden Trace + `agent_loop` / `harness_*` 冻结测试零改动（History 缺省关闭是硬约束）；
- 每完成一个 PR：直接 commit（`feat: ... (DUR-00x)`）+ push + gh release + npm publish，不询问用户；
- push/release 按 DUR 计划线拆分，不与 ALK/Harness/RC/ORMB 混线；
- 开工前先收敛工作区未提交的 `src/runtime/linux/*` 改动（确认归属：LPIC 收尾并入或单独提交），避免污染 DUR 提交。

---

# 八、风险与回退

| 风险 | 对策 |
| --- | --- |
| fsync 开销影响调度 | 批提交 + 128 事件快照；对照 `benchmarks/` 现有基准 |
| History 模式改动 scheduler 主循环 | 包装器不碰主循环；缺省关闭；冻结回归 |
| 日志无限增长 | DUR-001 仅 node 粒度事件（低频）；Continue-As-New DEFER |
| EvidenceLedger 双源 | DUR-002 只接进账事件，账本 API 不动；彻底投影化另开 PR |
| 恢复路径与非确定性 bug 混淆 | 版本门 + 哈希校验 fail-closed，宁停不静默 |
| 与 RC-00/RC-01（defect-register）线冲突 | DUR 不动 verification 六态契约，只加隔离 Profile |

---

# 九、与现有计划线的关系

| 计划线 | 关系 |
| --- | --- |
| ALK-1.0（L0–L7） | 零改动；DUR 只挂 workflow scheduler 层 |
| Harness 2.0（H0–H11） | 零改动；H10 Context Pipeline 与 DUR 无交集；H5 Trace 保持观测角色 |
| Graph Runtime（G0–G7） | DUR 是其持久化地基：G1 ResultStore 成为投影、G5 Replay 获得权威日志、G7/MACP-M5 合并获得 Receipt 事件 |
| LPIC（R0–R6） | R5 Receipt 升级为 Effect 事件（读 receipt、写事件） |
| RC（defect-register） | 无交集 |
| ORMB 微基准 | DUR 门禁可复用其报告存档模式（可选） |

---

# 十、延后项触发条件

| 延后项 | 触发条件 |
| --- | --- |
| Signal | 出现"运行中需要 durable 外部异步输入"的真实需求 |
| Update | Signal 落地且出现"受跟踪运行时修改 + 返回结果"场景 |
| Continue-As-New | 真实 run 事件量超过快照/恢复预算时 |
| SQLite 检索索引 | 事件量级导致冷启动 Tail Replay 变慢时（保留 bun:sqlite WAL 先例） |
| Worker Versioning | Agent Fleet 阶段 |
| EvidenceLedger 完全投影化 | 事件进账稳定运行后，评估账本改由投影派生的收益 |

---

# 十一、预期收益

1. 长任务（深审、自进化、多节点并行）杀进程/重启后可现场恢复，已完成节点保证不重跑；
2. 副作用不因崩溃在恢复后重复执行（关闭当前 `Running→Ready` 重执行窗口）；
3. 崩溃恢复从"重新执行后再看"升级为"重放事实 + 哈希校验"，不匹配 fail-closed；
4. 非确定性 bug 在测试期被 EXP-DUR-004 断言，而非生产期人工发现；
5. 证据链闭环：事件日志（事实）→ 投影（状态）→ 证据（声明）→ 完成门（结论），每层可审计；
6. 验证节点可信度：只读从 prompt 契约升级为能力边界强制；
7. 为 Agent Fleet / 自我进化 Runtime 提供入场券：run 权威状态在 worker 之外，任何进程可接管；
8. 版本门保证旧运行不被新语义静默重解释（self-evolve 前提）。
