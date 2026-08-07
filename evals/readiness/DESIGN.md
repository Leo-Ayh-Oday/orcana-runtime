# Orcana Benchmark Readiness Diagnostic Suite

**简称：OBRDS v0.1**

> 本文档为 OBRDS 设计原文（用户定义，2026-08-07）。实现状态见各 scenario 目录与
> `PROGRESS.md`（evals/readiness/）。目标：运行 TB2.1 / SWE-bench 前的
> Harness/Runtime/模型分层诊断，失败自动归因，只修阻碍真实 Benchmark 的最短链路。

## 0. 目标

OBRDS 不要求先修完全部基础设施缺陷。它的目标是：

```text
运行少量高信息密度场景
→ 观察完整执行轨迹
→ 区分模型失败与 Runtime 失败
→ 只修阻碍 TB2.1 / SWE-bench 的关键链路
→ 重跑确认
```

Terminal-Bench 2.1 是 89 个真实终端任务组成的执行型基准；其 2.1 修订重点包括
外部依赖漂移、资源配置错误和任务说明与测试不一致，说明"环境和 Harness 可信度"
会直接改变排行榜结果。SWE-bench Verified 要求 Agent 在指定仓库基线提交上生成
补丁，并由 Docker 内的真实测试判定（500 个经人工确认可解决的实例）。

OBRDS 必须同时测试：任务结果 / Runtime 完整性 / 证据真实性 / 可恢复性 / 成本和延迟。

## 1. 四条执行 Lane

- **Lane A Oracle**：确定性脚本执行已知正确步骤 → 验证 fixture/容器/依赖/verifier
  本身正确。Oracle 失败 = `HARNESS_FAIL`，不得归因 Orcana。
- **Lane B Scripted Runtime**：不使用 LLM，脚本通过 Orcana 真实 Harness/Tool
  Registry/Permission/Process Executor/Evidence Ledger/Persistence/Checkpoint/
  Context Pipeline 执行固定 Tool Call。Oracle 通过、Scripted 失败 = `INFRA_FAIL`。
- **Lane C Live Ceiling**：真实 DeepSeek V4-Flash，能力上限配置
  （thinking: max / max_tokens_per_call: 32768 / max_generated_tokens_per_run:
  160000 / max_rounds: 20 / cost_policy: disabled）。Scripted 通过、Ceiling 失败
  = 模型理解/Prompt/Tool 路由/Context 选择/规划策略。
- **Lane D Live Production**：正式生产配置（thinking: auto/high dynamic /
  triage: auto / skill_routing: enabled / context_compaction: enabled / cache:
  enabled / cost_policy: enabled）。Ceiling 通过、Production 失败 = 预算策略/
  自动路由/压缩/缓存/成本治理。

## 2. 统一结果状态

```typescript
type DiagnosticVerdict =
  | "PASS" | "MODEL_FAIL" | "INFRA_FAIL" | "HARNESS_FAIL" | "ENV_BLOCKED" | "INCOMPLETE"
```

归因规则：

| 结果 | 判断 |
|---|---|
| Oracle 失败 | HARNESS_FAIL |
| Oracle 通过，Scripted 失败 | INFRA_FAIL |
| Scripted 通过，Ceiling 失败 | MODEL_FAIL 或 Agent 策略问题 |
| Ceiling 通过，Production 失败 | 成本、压缩、Triage、Skill 或缓存问题 |
| 最终任务成功但有硬违规 | INFRA_FAIL |
| Runtime 报 Completed，但 verifier 失败 | INFRA_FAIL / FALSE_COMPLETION |
| 环境缺少必须能力 | ENV_BLOCKED，不得假绿 |

## 3. 六个 Observer

1. **RecordingProvider**：包装真实 Provider，记录每次请求
   （requestId/round/model/thinking/maxTokens/systemHash/messageHashes/
   toolSchemaHash/toolCount/estimatedInputTokens/providerInputTokens/
   reasoningTokens/outputTokens/startedAt/firstEventAt/finishedAt/stopReason/
   retryCount/aborted）；Eval 目录保存脱敏完整 Provider Request。
2. **ToolObserver**：toolCallId/toolName/argsHash/startedAt/finishedAt/success/
   exitCode/resultHash/resultChars/sideEffectKey/duplicateOf/artifactId/evidenceIds。
3. **WorkspaceObserver**：每次 Tool 前后记录 Git status/文件 hash/新增/删除/修改/
   符号链接/generation → 识别 Tool 谎报成功、意外修改测试、越界写入、Stale Patch、
   重复副作用。
4. **ProcessObserver**：PID/PPID/process group/cgroup/容器 ID/监听端口/临时文件/
   锁/资源预留；Run 结束后继续观察 5~10 秒检测孤儿资源。
5. **SessionObserver**：messageId/sequence/sessionId/checkpoint/WAL-SHM/
   compactor state/high-water mark/resume generation。
6. **EvidenceObserver**：evidenceId/kind/status/toolCallId/artifactId/
   producedGeneration/currentGeneration/fresh/acceptedByCompletion。

## 4. Trace 格式

沿用 `AgentRunTrace`（runId/timestamp/type/data JSONL），固定事件名与必填字段：

```text
run.started / provider.request.started / provider.event / provider.request.finished
context.compiled / context.compacted / tool.call.started / tool.call.finished
workspace.changed / verification.ingested / gate.decided / checkpoint.written
checkpoint.restored / process.started / process.exited / cleanup.finished
run.finished / verifier.finished
```

输出目录 `.orcana/evals/readiness/<run-id>/`：
manifest.json / trace.jsonl / provider-requests/ / tool-events.jsonl /
workspace-events.jsonl / process-events.jsonl / evidence.json / verifier.json /
verdict.json / report.md

## 5. 全局 Hard Gates

功能通过但触发以下任一 → 整体 `INFRA_FAIL`：

```text
FALSE_COMPLETION > 0
DUPLICATE_SIDE_EFFECT > 0
STALE_EVIDENCE_ACCEPTED > 0
INVALID_TRANSCRIPT > 0
USER_CONSTRAINT_VIOLATION > 0
TOOL_FALSE_SUCCESS > 0
ORPHAN_PROCESS > 0
CROSS_WORKSPACE_WRITE > 0
UNARCHIVED_LOSSY_COMPACTION > 0
SESSION_MESSAGE_LOSS > 0
```

## 6~16. 正式测试（BRD-000 ~ BRD-010）

详见各 scenario 目录：`scenarios/brd-000/` ~ `scenarios/brd-010/`
（BRD-000 Harness Calibration / 001 Patch Truth Chain / 002 Repository
Navigation Maze / 003 Context Authority Marathon / 004 Evidence Tail Furnace /
005 Provider Fracture Chamber / 006 Completion Mirage / 007 Recovery Fork /
008 Service Lifecycle Gauntlet / 009 Parallel Workspace Collision / 010
Benchmark Proxy Mix）。

## 17~18. 统一效率指标与派生指标

Token（input/reasoning/output/cache_read/cache_miss/tool_result/tokens_per_pass）、
时间（triage_ms/time_to_first_model_event/time_to_first_tool/provider_ms/
tool_ms/verification_ms/cleanup_ms/wall_ms）、行为（rounds/tool_calls/
unique_tool_calls/duplicate_tool_calls/file_reads/duplicate_file_reads/writes/
retries/context_compactions/checkpoint_count）、质量（task_pass/
constraint_violations/stale_evidence_count/false_completion/
duplicate_side_effects/orphan_resources）。

派生：Cost per Passed Task / Tool Efficiency（Oracle 最少调用数 ÷ 实际调用数）/
Duplicate Read Ratio / Context Growth Slope / Evidence Freshness Lag（≥0）/
Recovery Duplicate Work（=0）。

## 19~21. Runner 与命令

```text
evals/readiness/
├── runner.ts / contracts.ts / reporters/ / observers/
├── fault-injection/ / actors/（oracle/scripted-runtime/live-agent）
├── scenarios/brd-0XX/ / pilot/
```

package.json scripts：
`eval:readiness` / `eval:readiness:core`（--suite core --strict）/
`eval:readiness:live` / `eval:readiness:pilot`。

退出码：0 全部 Hard Gate 通过 / 1 功能失败 / 2 Infrastructure Integrity 失败 /
3 Harness/Fixture 失败 / 4 环境能力不足 / 5 Runner 自身错误。

## 22~23. 定位矩阵与进入基准前的 Gate

见上文原始设计（automatic diagnosis matrix）；进入完整 TB2.1/SWE 前的五道 Gate：
Harness Valid（Oracle 3/3）→ Infrastructure Valid（BRD-001/005/006/007/008/009
Scripted 100%）→ Context Valid（BRD-003/004 Hard Gate 100%）→ Live Ceiling
Stable（连续 3 轮 INFRA_FAIL=0/FALSE_COMPLETION=0/DUPLICATE_SIDE_EFFECT=0）→
Pilot Worth Running（TB ≥4/6、SWE ≥12/20、无基础设施 Hard Gate）。

## 24. 实施优先级

第一批：BRD-000 / BRD-001 / BRD-005 / BRD-006 / BRD-007（工具真实执行 / Provider
不重复调用 / 验证可信 / 完成判定可信 / 崩溃可恢复）。
第二批：BRD-003 / BRD-004。第三批：BRD-008 / BRD-009。最后：BRD-002 / BRD-010。
