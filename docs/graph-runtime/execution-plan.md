# Orcana Typed Execution Graph 执行方案（融合版）

**文档版本：** Graph Runtime / Execution Plan v1.0（2026-08-05，G0 起，融合 ALK-1.0 + Harness 2.0 + Tool Runtime 特色架构）
**参考文档：** `docs/typed-execution-graph-runtime-plan.md`（2444 行权威参考稿，G0–G7 定义与 DoD 以它为准）
**适用阶段：** ALK-1.0 完成（loop.ts 135 行阶段编排器）、Harness 2.0 全面接线（AgentHarness → LegacyLoopAdapter → agentLoop）、Tool Runtime 2.0 完成（RT-1..13）、Graph Readiness R2 冻结
**执行对象：** 可直接交给代码 Agent 分阶段执行；一个阶段一个 patch 版本，五门禁 → commit → push → gh release → npm publish
**核心原则：** 投影先行（G0 只记录不改执行）；复用现有 run-trace 事件词汇，不新建任务模型；所有 Gate/策略/工具继续走既有通道。

---

## 1. 与参考稿的差异（融合特色架构）

参考稿（typed-execution-graph-runtime-plan.md）写于 v0.4.0 基线，其 §7 假设改 `loop.ts` / `run-trace.ts` / TUI 等文件。融合版按当前架构重排：

| 参考稿假设 | 现状 | 融合决策 |
|---|---|---|
| 改 `src/agent/loop.ts` 挂投影 | loop.ts 是 135 行纯阶段编排器 | **不改**。投影挂在 runTrace 包装器上，kernel 零改动 |
| 改 `src/agent/run-trace.ts` | run-trace 是唯一 trace 通道（prepare/round/finalize/batch-executor 全部经它 record） | 新增 **ProjectingRunTrace 包装器**：`record()` 双路（原样落盘 + 喂投影器），行为不变 |
| 改 `src/tui/state/types.ts` | TUI 是用户并行工作区 | **绝不触碰**。快照只落盘 `.orcana/workflow/` |
| `workflow.mode=shadow` 配置 | config-schema 无 workflow 字段 | 新增 `workflow.mode: "off" \| "shadow"`（默认 off，零开销） |
| 投影"虚拟节点" | 现有事件已有明确词汇 | 直接映射：round_started/tool_call/tool_result/gate_decision/verification_result/epoch_rollover/agent_loop_* |

**运行链（G0 后）：**

```text
CLI/TUI → runtime.startRunTrace(prompt) ─┐
        → AgentRunTrace（JSONL 原样）     ├─ workflow.mode=off  → 零开销原样
        → wrapRunTrace(...) ──────────────┘
        workflow.mode=shadow → ProjectingRunTrace
          ├─ record() → 原 trace 落盘（行为不变）
          └─ record() → WorkflowProjector.observe()（纯同步，只记录）
                └─ terminal 事件 → .orcana/workflow/<runId>.graph.json
```

---

## 2. 阶段总览（G0–G7，与参考稿一致）

| 阶段 | 内容 | 状态 |
|---|---|---|
| G0 | Execution Graph Trace（shadow 投影，只记录不改执行） | ✅ v0.5.23 |
| G1 | Read-only DAG Scheduler（只读节点并行；任何写工具拒绝） | 待做（开工前细化计划） |
| G2 | Workflow Compiler + Templates（MasterPlan/TaskPacket → WorkflowSpec） | 待做 |
| G3 | Single Writer Transaction Graph（写节点单写者 + WorkspaceWriteLock） | 待做 |
| G4 | Convergent Repair Graph（收敛修复循环） | 待做 |
| G5 | Context Slice、缓存与 Replay（result-cache 消费 stableHash） | 待做 |
| G6 | Dynamic Workflow Compiler（声明式 JSON，默认关闭） | 待做 |
| G7 | T3R Multi-Agent（v1.0 Strong Single 收束之后） | 后置 |

---

## 3. G0 详细任务单（v0.5.23）

参考稿 PR-G0 验收：不改变执行结果 / 每次运行可生成 Graph Trace / 无敏感信息 / 可序列化反序列化 / 原测试通过。

### 3.1 新增文件

```text
src/workflow/
├── index.ts                        # barrel 导出
├── types.ts                        # WorkflowMode/Node/Edge/Snapshot/Metrics/TraceEvent
├── telemetry/
│   ├── workflow-trace.ts           # WorkflowProjector + ProjectingRunTrace + wrapRunTrace
│   └── graph-snapshot.ts           # serializeSnapshot/deserializeSnapshot（redact 边界）
└── results/
    └── result-hash.ts              # stableHash/stableSerialize（G1 缓存基础，本阶段只交付原语）
```

### 3.2 投影规则（事件 → 图）

| 事件 | 节点 | 边 | 备注 |
|---|---|---|---|
| agent_loop_started | root:run | — | 根节点，data{maxRounds,toolCount} |
| round_started | round:N（虚拟节点） | root → round（contains） | 激活当前 round 上下文 |
| thinking_decision / model_selected / cache_prefix_shape / provider_status | — | — | 并入当前 round.data |
| token_usage / round_output | — | — | 只保留标量（计量数字，redactor 白名单） |
| tool_call | tool:<callId> | round → tool（contains） | data 只存 inputKeys（参数 key 列表，绝不存值） |
| tool_result | 更新 tool 节点状态 | — | success/blocked → done/failed/blocked；metrics.toolFailures++ |
| gate_decision | gate:<round>:<gate> | round → gate（gates） | 同 gate 决策累积（≤12）；block → gateBlocks++ |
| epoch_rollover | gate:<round>:epoch_rollover | — | 并入 gate 类 |
| verification_result | verification:<round>:<ordinal> | round → verification（produces） | passed/success 决定状态 |
| agent_loop_finished / aborted / blocked | 终止 root | — | decision 记录 reason |

### 3.3 接入点（最小侵入）

1. `src/config/config-schema.ts`：`workflow?: { mode?: "off" | "shadow" }`（默认 off）
2. `src/runtime/bootstrap.ts` `startRunTrace`：`wrapRunTrace(AgentRunTrace.start(...), config.workflow?.mode ?? "off", prompt).trace`——TUI 路径自动生效
3. `src/ui/cli.ts`：`runTurn` 增加 `startRunTrace` 参数，改走 `runtime.startRunTrace`（与 bootstrap projectRoot 等价，行为不变）
4. kernel/loop/run-trace **零改动**

### 3.4 安全

- 工具 input 只投影参数 key 摘要（inputKeys），值永不进投影器
- 快照写盘走 `redactForTrace`（secret-redactor 白名单：token 计量字段豁免——见 759f498 修复）
- 投影器 `observe()` 永不抛错（try/catch，同 trace 写盘策略）

### 3.5 G0 验收（已实现，见 §3.6）

- [x] 不改变执行结果：off 模式 wrapRunTrace 原样返回（零开销）；shadow 仅旁路
- [x] 每次运行生成 Graph Trace：terminal 事件 → `.orcana/workflow/<runId>.graph.json`
- [x] Trace 无敏感信息：inputKeys 摘要 + redactForTrace + 测试断言
- [x] 可序列化、反序列化：serializeSnapshot/deserializeSnapshot round-trip 测试
- [x] 原测试通过：受限门禁 407 pass（含 workflow 25 项新测试）

### 3.6 测试

```text
tests/workflow/
├── result-hash.test.ts       # 稳定序列化（键序无关/递归排序/类型保持）+ sha256
├── projector.test.ts         # 全事件流投影断言：节点种类/边/状态/metrics/红名单/容错
└── graph-snapshot.test.ts    # round-trip/非法载荷拒绝/无敏感材料泄漏
```

---

## 4. G1 详细任务单（v0.5.24，Read-only DAG Scheduler）

参考稿 PR-G1 验收：四个无依赖只读节点并行 / 任何写工具被拒绝 / 单节点失败不影响其他节点 / 下游依赖正确等待 / Graph 可 checkpoint / Scheduler 无死锁。

### 4.1 设计决策（融合特色架构）

| 参考稿 | 融合决策 |
|---|---|
| 新增独立 tool-executor | 复用 `ToolDef`（`isReadonly` + `category` 现成），工具执行桥走 `defn.execute()`；**不新造执行器** |
| 写工具拒绝 | 两层：handler 注册表只暴露 6 个只读工具 + 执行桥再验 `isReadonly`（fail-closed） |
| Graph checkpoint | result-store 序列化到 `.orcana/workflow/checkpoints/<specId>.json`（redact 边界） |
| 输入来源 | 新增 `compileFromSnapshot()`：G0 快照的只读子图 → 可执行 WorkflowSpec（G2 才接 MasterPlan compiler） |
| workflow.mode | 扩展为 `"off" \| "shadow" \| "readonly"`；readonly = shadow 记录 + 只读节点真实执行（发布策略阶段二） |
| 并行边界 | 同批次只读节点并发（并发上限 `workflow.maxParallel`，默认 4）；与 agentLoop 主链完全隔离（G3 前不接入主执行链） |

### 4.2 新增文件

```text
src/workflow/
├── types.ts                        # + WorkflowSpec / WorkflowNodeSpec / WorkflowNodeResult
├── scheduler/
│   ├── ready-queue.ts              # 拓扑就绪队列（入度 0 + 依赖已完成）
│   ├── concurrency-controller.ts   # 只读并发池（上限、调度、死锁守卫）
│   └── scheduler.ts                # 并行调度器（Promise 池、失败隔离、checkpoint 钩子）
├── execution/
│   ├── handler-registry.ts         # 只读 handler 白名单（6 工具；写工具注册即抛错）
│   ├── tool-executor.ts            # ToolDef 执行桥（isReadonly 复验 + writable-root policy）
│   └── node-executor.ts            # 单节点执行（状态机 pending→running→done/failed）
├── results/
│   ├── result-store.ts             # 节点结果（内存 + checkpoint 落盘/恢复）
│   └── edge-store.ts               # 边依赖查询（入度/后继/环检测）
└── compiler/
    └── snapshot-compiler.ts        # WorkflowSnapshot 只读子图 → WorkflowSpec（G1 输入桥）
```

### 4.3 首批 Handler（只读白名单）

| Handler | 工具 | 来源 |
|---|---|---|
| `tool.read_file` | read_file（isReadonly） | src/tools/file.ts |
| `tool.find_symbol` | find_symbol | src/tools/codegraph.ts |
| `tool.find_references` | find_references | src/tools/codegraph.ts |
| `tool.project_structure` | project_structure | src/tools/codegraph.ts |
| `tool.git_diff` | git_diff | src/tools/git.ts |
| `tool.git_status` | git_status | src/tools/git.ts |
| `reduce.dedupe` | 去重 reducer（确定性逻辑，G1 一并交付） | src/workflow/reducers/ |
| `reduce.merge_diagnostics` | 诊断合并 reducer | src/workflow/reducers/ |

写工具（apply_patch / write_file / run_process / shell / git_add / service_* 等）在 handler 注册阶段即拒绝（注册表 build 时校验 `isReadonly !== true` → 抛错）。

### 4.4 调度语义

```text
Ready Queue（入度 0）
  └─ 并发池（maxParallel=4）→ node-executor → handler
        ├─ done  → 更新后继入度 → 入队
        ├─ failed → 标记 failed（结果保留）→ 后继仍按依赖跑（失败隔离）
        └─ 无 Ready 且无 running 且有 pending → 环 → 拒绝（死锁守卫）
完成 → result-store.flush()（checkpoint）
```

- 失败隔离：兄弟节点不受影响；失败节点后继照常执行（依赖其 output 的边照常传 failed 结果）
- checkpoint：每节点完成后增量落盘；`restore()` 恢复（G1 验收"Graph 可以 checkpoint"）

### 4.5 接入与配置

- `src/config/config-schema.ts`：`workflow.mode` 加 `"readonly"`；新增 `workflow.maxParallel`（默认 4）
- **不接入 agentLoop**（G3 前只读并行器独立可用，供测试/未来研究任务）
- G0 投影器在 readonly 模式下保持记录（观察者不动）

### 4.6 G1 验收测试

```text
tests/workflow/
├── scheduler-parallel.test.ts    # 4 无依赖只读节点并发（wall-time < 串行，并发>1）
├── scheduler-write-reject.test.ts # 写工具注册拒绝 + 执行桥 isReadonly 复验
├── scheduler-isolation.test.ts   # 单节点失败不影响兄弟；后继照常
├── scheduler-deps.test.ts        # 下游依赖等待；结果可达
├── scheduler-deadlock.test.ts    # 环 → 拒绝；无死锁
├── result-store.test.ts          # checkpoint 落盘/恢复 round-trip
├── reducers.test.ts              # dedupe / merge_diagnostics
└── snapshot-compiler.test.ts     # 快照只读子图 → spec 编译
```

### 4.7 G1 验收映射

- [ ] 四个无依赖只读节点能够并行 → scheduler-parallel.test.ts
- [ ] 任何写工具均被拒绝 → scheduler-write-reject.test.ts（注册拒绝 + 复验）
- [ ] 单节点失败不影响其他节点 → scheduler-isolation.test.ts
- [ ] 下游依赖正确等待 → scheduler-deps.test.ts
- [ ] Graph 可以 checkpoint → result-store.test.ts
- [ ] Scheduler 无死锁 → scheduler-deadlock.test.ts

---

## 5. G2 详细任务单（v0.5.25，Workflow Compiler + Templates）

参考稿 PR-G2 验收：相同输入产生稳定 Graph / Graph Schema 有版本 / 循环、未知 Handler、非法副作用被拒绝 / MasterPlan 可转换为 WorkflowSpec / WorkflowSpec 可展示回 MasterPlan 状态。

### 5.1 设计决策（融合特色架构）

| 参考稿 | 融合决策 |
|---|---|
| 修改 `src/agent/master-plan.ts` / `task-packet.ts` / `plan-validator.ts` | **不改 kernel**。新增 adapter 只读消费 `MasterPlan` / `TaskPacket` 类型（PlanNode.dependsOn → edge；`_packet` → node input） |
| 新写 dag-validator | 复用 G1 `edge-store`（buildTopology/detectCycle）+ 新增未知依赖检查 |
| 修改 context-map.ts | 不做（G5 接 Context Slice 时再说） |
| 首批模板全部只读 | code_explain / security_audit / research_report，handler 全走 G1 只读白名单 |
| 验证节点 | G2 模板不含验证子图（G3 接）——节点 input 可声明 `verify` 字段但只读模式下被忽略并记录 |

### 5.2 新增文件

```text
src/workflow/
├── validation/
│   ├── index.ts                   # validateSpec 聚合入口（全量校验，返回报告）
│   ├── schema-validator.ts        # node input 浅校验（对象/数组/标量类型 + handler schema 存在性）
│   ├── dag-validator.ts           # 未知依赖 + 环（复用 edge-store）
│   ├── capability-validator.ts    # handler 已注册 + 存在性
│   ├── budget-validator.ts        # 节点数上限（默认 200）+ maxParallel ≥ 1
│   └── side-effect-validator.ts   # 只读模式：全部 handler ∈ 只读白名单
├── compiler/
│   ├── master-plan-adapter.ts     # MasterPlan（含 TaskPacket）→ WorkflowSpec
│   ├── template-compiler.ts       # 模板 id → WorkflowSpec（输入插值）
│   └── graph-normalizer.ts        # id 稳定化 / 去重边 / 拓扑序输出
├── templates/
│   ├── registry.ts                # 模板注册表 + list/get
│   ├── code-explain.ts            # read_file + find_symbol + find_references → 解释节点
│   ├── security-audit.ts          # project_structure + read_file ×N + reduce.merge_diagnostics
│   └── research-report.ts         # git_status + git_diff + find_symbol + read_file
└── projection/
    └── plan-projection.ts         # WorkflowRunResult → PlanNode 状态回写（spec → plan）
```

### 5.3 编译映射

```text
MasterPlan
  └─ node.dependsOn → WorkflowNodeSpec.dependsOn（blockedBy 反向推导，重复边折叠）
  └─ node._packet（TaskPacket）
       ├─ goal/title → 节点 input.tag（稳定编译：goal 哈希进 specId）
       ├─ scope/doneCriteria → input.scope（只读模板忽略执行，G3 接）
       └─ contextBudget.maxToolCalls → budget 元数据
  └─ 无 packet 节点 → handler 由 intent 推断（research/audit 模板场景）
       ├─ "research"/"explain" → tool.read_file / tool.find_symbol 组合
       └─ 无法推断 → 编译失败（明确报错，不静默降级）
```

- 稳定 Graph：specId = stableHash(goal + node 标题序列 + dependsOn)；同输入必同输出
- Graph Schema：`WorkflowSpec.schemaVersion = "0.1"`（G1 已定义，G2 不改结构）

### 5.4 模板（首批，全部只读）

| 模板 | 节点序列（handler） | 输入 |
|---|---|---|
| code_explain | find_symbol → find_references → read_file → read_file | {query, path} |
| security_audit | project_structure → read_file ×N（glob 展开）→ merge_diagnostics | {path} |
| research_report | git_status → git_diff → find_symbol → read_file | {path, scope} |

模板 = 静态 WorkflowSpec 生成器（输入插值），可叠加 maxParallel。注册表校验：模板输出必须通过 validateSpec（写 handler 直接编译失败）。

### 5.5 反向投影（spec → plan）

```text
WorkflowRunResult + MasterPlan
  └─ node.id ↔ plan.node.id（adapter 保留原始 id）
  └─ status: done → "done"；failed → "blocked"（reactCount+1 由调用方决定）
  └─ result.output.metadata → node.evidence 摘要
```

### 5.6 G2 验收测试

```text
tests/workflow/
├── compiler-master-plan.test.ts   # 稳定编译（同输入同 spec）/ packet 编译 / 无 packet 推断
├── validation.test.ts             # 环/未知依赖/未知 handler/写 handler/预算界 全拒绝
├── templates.test.ts              # 三模板编译 + 只读性 + validateSpec 通过
└── plan-projection.test.ts        # run result → plan 状态回写
```

### 5.7 G2 验收映射

- [ ] 相同输入产生稳定 Graph → compiler-master-plan.test.ts
- [ ] Graph Schema 有版本 → schemaVersion 断言
- [ ] 循环、未知 Handler、非法副作用被拒绝 → validation.test.ts（dag/capability/side-effect）
- [ ] MasterPlan 可转换为 WorkflowSpec → compiler-master-plan.test.ts
- [ ] WorkflowSpec 可展示回 MasterPlan 状态 → plan-projection.test.ts

---

## 6. 发布流程与版本线（2026-08-05 调整）

- **版本线调整**：0.6.0 已发布（Tool Runtime 2.0 完整 + TUI 收敛汇总）。**Graph Runtime 系列从 0.7.0 开始**：G3 完成 → v0.7.0（Graph Runtime 首个真实可用版），G4..G7 依次 0.7.x。
- 每阶段流程固定：五门禁（typecheck / test / build / `npm pack --dry-run` / `git diff --check`）→ `feat:` commit → `chore: release v0.7.x` commit → push → gh release → npm publish。显式 git add（禁 `git add -A`），绝不触碰 `src/tui/**`、`tests/tui/**`。

---

## 7. G3 详细任务单（v0.7.0，Single Writer Transaction Graph）

参考稿 PR-G3 验收：任何时间最多一个写节点 / 写节点必须持有 WorkspaceWriteLock / 失败自动 rollback / 验证结果绑定事务和节点 / 无 Evidence 不能完成 / 非 Workflow 模式无回归。完成 G3 后 Graph Runtime 具备真实可用价值。

### 7.1 设计决策（融合特色架构）

| 参考稿 | 融合决策 |
|---|---|
| 修改 `src/agent/patch-transaction.ts` / `evidence-ledger.ts` / `completion-orchestrator.ts` | **不改 kernel**。写节点复用既有事务链：`apply_patch` 工具（executeApplyPatchTransaction：dry-run 全验证 → 原子提交 → 失败回滚）+ `run_targeted_verification`（验证）+ `run_process`（测试执行） |
| 新建 transaction-executor | 包装写 handler：**WorkspaceWriteLock 获取 → 执行 → 释放**；无锁直接拒绝 |
| 单写者 | concurrency-controller：读节点并行（maxParallel），写节点全局串行（写槽位 = 1） |
| 无 Evidence 不能完成 | run 结束聚合检查：read-write spec 必须有写节点对应的 passed 验证 evidence，否则 run 状态 `blocked_no_evidence`（不抛错，结构化返回） |
| 首批写模板 | `narrow_fix`（定位→读→修复→定向验证）、`test_repair`（跑测试→读→修复→再验证） |

### 7.2 新增/修改文件

```text
src/workflow/
├── types.ts                        # + WorkflowSpec.mode: "readonly" | "read-write"；WorkflowRunResult.evidence
├── execution/
│   ├── transaction-executor.ts     # 写节点执行器（写锁 + handler 包装）
│   └── handler-registry.ts         # + registerWriteTool（read-write 白名单，仅 3 个）
├── scheduler/
│   ├── concurrency-controller.ts   # 读/写槽位控制（写槽位恒 1）
│   └── scheduler.ts                # 增强：写节点排队 + evidence 完成门
├── reducers/
│   └── aggregate-evidence.ts       # 验证节点结果 → evidence 汇总（绑定节点 + 事务）
├── templates/
│   ├── narrow-fix.ts               # 写模板
│   └── test-repair.ts              # 写模板
└── validation/
    └── capability-validator.ts     # + read-write 白名单校验（WRITE_HANDLERS）
```

### 7.3 写白名单（read-write 模式）

| handler | 工具 | 语义 |
|---|---|---|
| `tool.apply_patch` | apply_patch | 统一 diff 事务（dry-run 全验证 → 原子提交 → 回滚） |
| `tool.run_process` | run_process | 测试/验证命令（受控参数化，无 shell） |
| `tool.run_targeted_verification` | run_targeted_verification | 定向验证（typecheck/测试集） |

readonly 模式（G1/G2）行为不变：以上 handler 在只读 spec 中被 validation 拒绝。

### 7.4 单写者语义

```text
scheduler 主循环（读节点照旧并行）
  └─ write 节点：concurrency-controller.acquireWrite()
       ├─ 已有写节点在跑 → 等待（FIFO）
       └─ 获得写槽 → transaction-executor（锁内执行）
             ├─ handler 拒绝（未注册写白名单）→ failed
             └─ 完成 → releaseWrite() → 后继读节点继续
完成 → evidence 门：写节点存在 ⇒ 必须有 passed 验证 evidence
```

### 7.5 验证与 Evidence

- narrow_fix / test_repair 模板强制"写节点 → 验证节点"结构（编译期保证：写 handler 节点 must have 后继验证节点，否则模板编译失败）
- `aggregate-evidence` reducer：收集验证节点输出（passed/issues）→ 绑定写节点 id 列表 → run 结果 `evidence[]`
- 完成门：写节点且验证全未通过 → `blocked_no_evidence`

### 7.6 G3 验收测试

```text
tests/workflow/
├── transaction-executor.test.ts     # 写锁强制（无锁拒绝）/ apply_patch 事务成功/失败回滚
├── scheduler-write-serial.test.ts   # 多写节点串行（写槽位 1，读仍并行）
├── evidence-gate.test.ts            # 写节点无 passed 验证 → blocked_no_evidence
├── aggregate-evidence.test.ts       # reducer 汇总 + 绑定
└── write-templates.test.ts          # narrow_fix / test_repair 编译 + 写→验证结构强制
```

### 7.7 G3 验收映射

- [ ] 任何时间最多一个写节点 → scheduler-write-serial.test.ts（时间戳断言不重叠）
- [ ] 写节点必须持有 WorkspaceWriteLock → transaction-executor.test.ts（无锁调用被拒）
- [ ] 失败自动 rollback → transaction-executor.test.ts（apply_patch 冲突 → 文件恢复原状）
- [ ] 验证结果绑定事务和节点 → aggregate-evidence.test.ts
- [ ] 无 Evidence 不能完成 → evidence-gate.test.ts
- [ ] 非 Workflow 模式无回归 → 受限门禁全量（workflow.mode 默认 off）

---

## 8. G4 详细任务单（v0.7.1，Convergent Repair Graph）

参考稿 PR-G4 验收：重复失败不无限重试 / seen 与 confirmed 分离 / 两轮 dry 后退出 / 指标改善能继续执行 / 预算耗尽输出结构化阻塞报告 / 同一错误不会通过改变措辞绕过检测。

融合架构决策：**kernel 零改动**（参考稿列出的 meta-agent/loop/completion-orchestrator 修改全部由 workflow 层能力取代，与 G0–G3 一致）；收敛循环构建在 G3 单写者 + evidence 门之上。

### 8.1 设计决策

| 参考稿 | 融合决策 |
|---|---|
| 改 meta-agent/loop | 不动；新增 `src/workflow/convergence/repair-loop.ts` 闭环（执行修复图 → 校验 evidence → 判定收敛） |
| 失败重试语义 | 失败签名指纹（handler + 错误类别，**非 message 全文**）入 `seen`；同签名不再重复执行同一修复手段 |
| "两轮 dry 后退出" | 连续 2 轮无新签名且无指标改善 → 退出 `dry` |
| "指标改善能继续执行" | 每轮 verified passed 数 / 失败数变化 → 改善重置 dry 计数 |
| 预算耗尽 | `ConvergenceReport` 结构化输出（阻塞节点 + seen 签名 + 尝试次数 + 剩余预算） |
| 措辞绕过 | `classifyError` 正则白名单 → 有限错误类别集合；同类别不同措辞 → 同签名，dedupe 命中 |

### 8.2 新增文件

```text
src/workflow/convergence/
├── failure-signature.ts    # classifyError（类别白名单）+ fingerprintFailure（handler|类别）
├── repair-loop.ts          # RepairLoop：attempts/dryRounds/budget/seen/confirmed + 每轮执行
└── index.ts                # barrel
```

### 8.3 循环语义

```text
RepairLoop.run(初始修复图 spec) → ConvergenceReport
每轮:
  1. 执行修复图（runScheduler，read-write）
  2. 失败节点 → fingerprint → seen 集合（重复签名 → dryRound 计数）
  3. evidence 中 passed 数 > 上一轮 → 指标改善，dryRounds 归零
  4. run.status done → confirmed（写节点 + 绑定 evidence）→ 退出 done
  5. dryRounds >= 2 → 退出 dry
  6. attempts >= maxAttempts → 退出 max_attempts
  7. budget 耗尽 → 退出 budget_exhausted（附报告）
```

签名去重语义：同签名第 2+ 次出现**不重复执行同一修复**（跳过该节点变体），保证"重复失败不无限重试"。

### 8.4 G4 验收映射

- [x] 重复失败不无限重试 → repair-loop.test.ts（maxAttempts 硬上限 + 同签名 dedupe 计数）
- [x] seen 与 confirmed 分离 → repair-loop.test.ts（seen 只收失败签名；confirmed 只收带 evidence 的写节点）
- [x] 两轮 dry 后退出 → repair-loop.test.ts（dryRounds=2 → outcome dry）
- [x] 指标改善能继续执行 → repair-loop.test.ts（第 2 轮 verified passed 增加 → 继续，非 dry 退出）
- [x] 预算耗尽输出结构化阻塞报告 → repair-loop.test.ts（budget_exhausted + blocked 清单非空）
- [x] 同一错误不会通过改变措辞绕过检测 → failure-signature.test.ts（同类别不同 message → 同签名）

| 阶段 | 版本 | 落地 | 验证 |
|---|---|---|---|
| G4 | v0.7.1 | Convergent Repair Graph：convergence/failure-signature（错误类别白名单，措辞变体归并）、convergence/repair-loop（RepairLoop：seen/confirmed 分离、同签名 dedupe、两轮 dry 退出、指标改善继续、maxAttempts 硬上限、预算耗尽结构化报告）；scheduler 完成门补强（写节点 failed → 即使验证节点 passed 也不 done，G3 语义缺口修复）；kernel 零改动 | 受限门禁 442 pass（新增 12 项 G4 验收） |

**G4 验收映射（§8.4）：**
- [x] 重复失败不无限重试 → repair-loop.test.ts（maxAttempts 硬上限 + 同签名 dedupe 计数）
- [x] seen 与 confirmed 分离 → repair-loop.test.ts（seen 只收写节点失败签名；confirmed 只收带 passed evidence 的写节点）
- [x] 两轮 dry 后退出 → repair-loop.test.ts（dryRounds=2 → outcome dry）
- [x] 指标改善能继续执行 → repair-loop.test.ts（第 2 轮写失败数下降 → done，dryRounds=0）
- [x] 预算耗尽输出结构化阻塞报告 → repair-loop.test.ts（budget_exhausted + blocked 清单非空）
- [x] 同一错误不会通过改变措辞绕过检测 → failure-signature.test.ts（同类别不同 message → 同签名）

## 10. G5 详细任务单（v0.7.2，Context Slice / 缓存与 Replay）

参考稿 PR-G5 验收：节点不继承无关历史 / 只读节点可按输入哈希命中缓存 / 修改文件后相关缓存失效 / Checkpoint 可从中断节点恢复 / Replay 不重新执行已成功确定性节点 / 旧会话兼容。

融合架构决策：**kernel 与 context/、session/ 零改动**（参考稿列出的 staged/context-map/context-epoch/checkpoint/migration 修改全部由 workflow 层能力取代）；G5 建立在 G1 checkpoint（ResultStore.restore 已有但 scheduler 未接线）之上。

### 10.1 设计决策

| 参考稿 | 融合决策 |
|---|---|
| Context Slice（staged/context-map） | `src/workflow/context/context-slice.ts`：`buildContextSlice` 显式化 scheduler 已隐含的依赖语义——节点上下文 = 自身 input + 直接 dependsOn 结果，无关节点/历史不进入 |
| 只读节点按输入哈希命中 | `src/workflow/results/result-cache.ts`：key = `stableHashString({ handler, input })`（G0 stableHash 消费）；读节点 done 后写缓存 |
| 修改文件后失效 | **写节点成功完成 → `invalidateAll()`**（超集失效：写后的只读结果全部重算，满足"相关缓存失效"且无逐文件追踪复杂度） |
| Checkpoint 中断恢复 | scheduler 接线 `store.restore(checkpointDir)`（G1 已交付原语未接线）；恢复节点不重执行 |
| Replay 不重执行 | 两层：checkpoint 恢复的节点跳过执行；cache 命中节点以 `replayed` 标记 + durationMs 0 直接落结果 |
| 旧会话兼容 | 全部可选接入：`cache` 仅经 SchedulerOptions 注入（默认 undefined → 行为不变）；config/workflow 无新字段 |

### 10.2 新增文件

```text
src/workflow/results/result-cache.ts        # ResultCache（Map + hit/miss 计数 + snapshot/restoreEntries）
src/workflow/persistence/result-cache-store.ts  # 落盘/加载（best-effort，redactForTrace 同 checkpoint）
src/workflow/context/context-slice.ts       # buildContextSlice（依赖子图上下文，显式化）
```

### 10.3 接入点（scheduler）

```text
SchedulerOptions + cache?: ResultCache
runScheduler:
  1. 有 checkpointDir → store.restore()（中断恢复，恢复节点不再执行）
  2. restore 的只读节点结果 → 回填 cache（跨运行复用）
  3. launch 前：只读节点 cache 命中 → store.put(replayed)（durationMs 0 + metadata.replayed），跳过 executeNode
  4. 只读节点 done → cache.put(inputHash, result)
  5. 写节点成功完成 → cache.invalidateAll()（文件失效）
```

### 10.4 G5 验收映射

- [x] 节点不继承无关历史 → context-slice.test.ts（上下文只含直接依赖，无关节点断言缺席）
- [x] 只读节点按输入哈希命中缓存 → result-cache.test.ts（同 key 二次命中 + 不同 key miss）
- [x] 修改文件后相关缓存失效 → scheduler-replay.test.ts（写节点成功后同 input 只读节点重新执行）
- [x] Checkpoint 可从中断节点恢复 → scheduler-replay.test.ts（恢复后不重执行已完成节点）
- [x] Replay 不重新执行已成功确定性节点 → scheduler-replay.test.ts（replayed 标记 + durationMs 0 + handler 执行计数不增）
- [x] 旧会话兼容 → 默认无 cache/checkpointDir 时全量门禁无回归（442 pass 基线）

| 阶段 | 版本 | 落地 | 验证 |
|---|---|---|---|
| G5 | v0.7.2 | Context Slice / 缓存与 Replay：results/result-cache（inputHash = stableHash({handler, input})，G0 stableHash 正式消费；写节点成功 → invalidateAll 超集失效）、persistence/result-cache-store（落盘/加载，redactForTrace 同 checkpoint）、context/context-slice（依赖子图上下文显式化）、scheduler 接线（restore 中断恢复 + 恢复结果回填 cache + 只读命中 replayResult 标记 replayed/durationMs 0 + 写完成失效）；全部可选注入，默认行为不变 | 受限门禁 455 pass（新增 13 项 G5 验收） |

**G5 验收映射（§10.4）：**
- [x] 节点不继承无关历史 → context-slice.test.ts（上下文只含直接依赖，兄弟/无关节点断言缺席）
- [x] 只读节点按输入哈希命中缓存 → result-cache.test.ts（同 key 二次命中 + 不同 key miss + failed 不缓存）
- [x] 修改文件后相关缓存失效 → result-cache.test.ts（写节点完成后同 input 只读节点重新执行，读到的内容为写后值）
- [x] Checkpoint 可从中断节点恢复 → scheduler-replay.test.ts（恢复节点不重执行，结果回填 cache）
- [x] Replay 不重新执行已成功确定性节点 → scheduler-replay.test.ts（replayed 标记 + durationMs 0 + 工具调用计数不增）
- [x] 旧会话兼容 → 无 cache/checkpointDir 时全量门禁 455 pass 无回归

## 12. 实施记录

| 阶段 | 版本 | 落地 | 验证 |
|---|---|---|---|
| G0 | v0.5.23 | src/workflow/ 4 文件 + config.workflow.mode + bootstrap/cli 接线（runTrace 包装器，kernel 零改动） | 受限门禁 407 pass；build/pack 通过 |
| G1 | v0.5.24 | Read-only DAG Scheduler：scheduler/（ready-queue、scheduler、并发池+死锁守卫）、execution/（handler-registry 白名单 6 工具 + 双层写保护、tool-executor isReadonly 复验、node-executor 状态机）、results/（result-store checkpoint、edge-store 拓扑/环检测）、compiler/snapshot-compiler、reducers（dedupe/merge_diagnostics）；workflow.mode 加 "readonly" + maxParallel | 受限门禁 391 pass（新增 25 项 G1 验收） |

**G1 验收映射（§4.7）：**
- [x] 四个无依赖只读节点能够并行 → scheduler-parallel.test.ts（wall < 串行界）
- [x] 任何写工具均被拒绝 → scheduler-write-reject.test.ts（注册抛错 + 执行桥复验）
- [x] 单节点失败不影响其他节点 → scheduler-isolation.test.ts
- [x] 下游依赖正确等待 → scheduler-deps.test.ts（diamond/chain 顺序断言）
- [x] Graph 可以 checkpoint → result-store.test.ts（增量落盘 + restore + redact）
- [x] Scheduler 无死锁 → scheduler-deadlock.test.ts（环/自环预检 + restored 全量不挂起）

| 阶段 | 版本 | 落地 | 验证 |
|---|---|---|---|
| G2 | v0.5.25 | Compiler + Templates：validation/（dag/capability/budget/side-effect/schema 五合一 validateSpec）、compiler/（master-plan-adapter 含 TaskPacket 编译 + 中英推断、graph-normalizer 稳定序、template-compiler）、templates/（code_explain / security_audit / research_report 全只读）、projection/plan-projection（spec → plan 状态回写）；kernel 零侵入 | 受限门禁 415 pass（新增 24 项 G2 验收） |

**G2 验收映射（§5.7）：**
- [x] 相同输入产生稳定 Graph → compiler-master-plan.test.ts（specId + 节点序双稳定）
- [x] Graph Schema 有版本 → schemaVersion "0.1" 断言
- [x] 循环、未知 Handler、非法副作用被拒绝 → validation.test.ts（dag/capability/side-effect/schema/budget）
- [x] MasterPlan 可转换为 WorkflowSpec → compiler-master-plan.test.ts（packet + 推断 + dependsOn 前缀化）
- [x] WorkflowSpec 可展示回 MasterPlan 状态 → plan-projection.test.ts（done/blocked/evidence 摘要）

| 阶段 | 版本 | 落地 | 验证 |
|---|---|---|---|
| G3 | v0.7.0 | Single Writer Transaction Graph：execution/transaction-executor（写白名单 3 工具 + 锁内执行）、scheduler/concurrency-controller（写槽位=1 FIFO）、scheduler 增强（写节点串行 + readonly 模式运行时拒绝 + evidence 完成门 blocked_no_evidence）、reducers/aggregate-evidence（验证绑定写节点）、templates/narrow-fix + test_repair（write→verify 结构强制）、validation read-write 模式；kernel/patch-transaction 零改动（写节点走 APPLY_PATCH_TRANSACTION_TOOL 既有事务/回滚语义） | 受限门禁 430 pass（新增 15 项 G3 验收） |

**G3 验收映射（§7.7）：**
- [x] 任何时间最多一个写节点 → scheduler-write-serial.test.ts（重叠断言）
- [x] 写节点必须持有 WorkspaceWriteLock → transaction-executor.test.ts（单槽互斥 + 锁释放）
- [x] 失败自动 rollback → transaction-executor.test.ts（hunk 不匹配 → 文件原样）
- [x] 验证结果绑定事务和节点 → aggregate-evidence.test.ts
- [x] 无 Evidence 不能完成 → evidence-gate.test.ts（blocked_no_evidence）
- [x] 非 Workflow 模式无回归 → 全量受限门禁 430 pass（workflow.mode 默认 off）
