# 上下文工程审计报告（Context Audit，0.8.26.2 基线，2026-08-07）

> 总指挥为"上下文工程升级计划"做的现状审计。**独立保留**——不构成计划本身，
> 用户的升级计划另行独立制定。审计结论如与计划冲突，以计划为准。

**审计源**：P3 探针 8 case 实测（evals/microbench/context/run.ts）+ defect-register（119 项）+ K 系列 55 项全景（execution-plan §RC-18）+ Harness H10/H11 技术债记录 + 代码点验证。

## A. 结构性缺陷（升级价值最高，5 项）

### A1. Token 估算无单一事实源（K48 TOKEN_ESTIMATE_UNIFIED，P1，open）

- 证据：`src/agent/kernel/round.ts:508`（`finalText.length / 3`）、`:673`（`/ 3`）、`src/harness/context/budget-allocator.ts:72/143`（`/ 3`）——各点独立除法，无集中估算函数
- 双轨制：压缩 epoch 阈值用 **chars**（`epochState.thresholds.forceCompressChars`），预算 gate 用 **tokens**——两套度量不互通；P3 实测 32k 窗口首轮 ~37% 占用，真实 chars↔tokens 换算关系无权威层
- 升级方向：集中 `estimateTokens()` + chars↔tokens 换算权威层（按 model 配置）

### A2. 预算裁剪未接线生产（K30/K33，H10 技术债，open）

- 证据：`src/harness/context/pipeline.ts:13-18` 注释"budget disabled by default；absent 时字节冻结"——裁剪/分配是死代码路径
- 影响：ContextBudgetGate 只超限拦截，从不主动裁剪——长任务靠被动 rollover
- 升级方向：预算裁剪启用 + Golden 重基线（H10 记录明确"开启需独立 PR + Golden 更新"）

### A3. Tool Schema 不计入预算（K49，open）

- 证据：P3 记录"K49 schema 计入预算后 16k 窗口首轮即 ~75%"——JSON schema 披露体积大
- 影响：预算虚低 → 首轮即超预算 → gate 误判压力
- 升级方向：schema 预披露预算化（K49）+ 动态披露（K51）

### A4. 流程指令无蒸馏保护（P3 探针新发现，未登记 defect）

- 证据：X1 蒸馏（`src/agent/kernel/round.ts:225`）只处理**用户硬约束**（`distillUserConstraints`）；epochRollover 归档首条 user prompt → **收尾/流程指令（输出格式契约、最终报告要求）确定性丢失**——P3 两次验证（33/39 轮均 PROBE_MISSING，指令强化无效）
- 影响：真实长任务最后一步"按格式输出结果"丢失 → 拿不到最终产物
- 升级方向：蒸馏层加入**流程指令保真**（收尾契约、输出格式、步骤序列摘要）

### A5. conversation-tail 仍是 metadata-only（H10 技术债延续，open）

- 证据：`src/harness/context/providers/volatile.ts:150-165` `content: ""`、`estimatedTokens: 0`——H11/H12 均未接真 tail 预算
- 影响：最近轮次对话不参与预算分配 → done 后长尾轮次（P3 观察常见）预算失真
- 升级方向：tail 真实预算（最近 N 轮真实内容计入 volatile 预算）

## B. 登记 open 但已修（register 过时，清理项）

### B1. CHECKPOINT_USES_REAL_SESSION_ID（P0，register 标 open，实际已修）

- 证据：`src/agent/maintenance/coordinator.ts:135-160` D3 注释 + `runState.identity.sessionId ?? ORCANA_SESSION_ID ?? "ds-default"`——已接线，register 未更新

## C. P0 gate TBD 未回填（context 相关）

- **C1. SESSION_MESSAGE_DUPLICATION（D1）**——会话保存消息膨胀，gate-matrix 仍 TBD
- **C2. DUPLICATE_PROVIDER_SIDE_EFFECT（G3）**——流重试重复输出，gate-matrix 仍 TBD（provider 域，是 C1 的源）

## D. 已登记 open 的生产隐患

- **D1. TOOL_PATH_BASE_BOUND（D7，P2，open）**——`src/tools/file.ts` 纯 Node 工具用 `process.cwd()` 解析相对路径，未绑 projectRoot（P3 评测污染事故根因；生产 ToolExecutionContext 缺 projectRoot 字段）

## E. 评测/观测侧（低优先级）

- **E1. DUPLICATE_WRITE 误报模式**——manifest 需显式"允许重写路径"声明（P3 两处误报：C5 package.json、C6 .npmrc）
- **E2. done 后长尾收尾**——completion 层处理方向（非状态机）

## 升级主线参考（非计划，仅依赖关系提示）

A1（估算权威层）→ A2（预算裁剪启用）→ A3（schema 入预算）构成"预算真实性"线；
A4（流程指令蒸馏保真）→ A5（tail 真预算）构成"指令与长尾保真"线。两线可在 A1 后并行。
