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

## 4. 发布流程（每阶段固定）

一个阶段一个 patch 版本：五门禁（typecheck / test / build / `npm pack --dry-run` / `git diff --check`）→ `feat:` commit → `chore: release v0.5.x` commit → push → gh release → npm publish。显式 git add（禁 `git add -A`），绝不触碰 `src/tui/**`、`tests/tui/**`。

---

## 5. 实施记录

| 阶段 | 版本 | 落地 | 验证 |
|---|---|---|---|
| G0 | v0.5.23 | src/workflow/ 4 文件 + config.workflow.mode + bootstrap/cli 接线（runTrace 包装器，kernel 零改动） | 受限门禁 407 pass；build/pack 通过 |
