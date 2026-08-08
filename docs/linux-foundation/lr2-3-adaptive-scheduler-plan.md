# Adaptive Scheduler 实现计划（LR2-3）

**计划编号：** LR2-3
**英文名称：** Adaptive Scheduler — Statistical Resource Estimation + PSI Backpressure + Fair Scheduling
**上一版：** [LR2-2 Performance Plane](lr2-2-performance-plan.md)（P2-A~F 完成，含独立审核）
**基线：** `f197989`（LR2-2 Gate 验收，门禁 323/323）
**定位：** 调度层：可解释统计资源估算（不用机器学习）+ PSI 背压 + 关键路径优先级 + 公平性 + Work Stealing + 只读推测执行。

> 记录说明：push/release 按 LR2 计划线点名拆分。LR2-0 已通过（阶段禁止项解除：PSI 调度/推测执行/Work Stealing 现在可进主线）。

## 零、现状盘点（2026-08-09）

- 已有：`FairQueue`（scheduler/queue.ts）——6 级优先级权重 + 同优先级 agent 公平；
- 已有：`ResourceLedger`（scheduler/resource-ledger.ts）——CPU/memory/pids 预留 + 宿主保留；
- 无：WorkloadFingerprint / 历史资源画像 / 分位数估算 / PSI / 优先级模型 / Work Stealing / 推测执行。

## 一、阶段划分

### P3-A WorkloadFingerprint + HistoricalResourceProfile（`src/runtime/linux/scheduler/profile.ts`）

- `WorkloadFingerprint`：tool kind / command family / repository class / file-count bucket / lockfile digest / test-count bucket / backend / profile / cache state / runtime family / previous failure class。**不使用完整命令参数**（样本碎片化）。
- `HistoricalResourceProfile`：sampleCount / cpuUsec p50-p90-p99 / peakMemory p50-p90-p99 / wallTime p50-p90-p99 / peakPids / read-write bytes / failureRate / oomRate / cacheHitRate / lastUpdatedAt。
- 估算规则：无历史 → 保守模板；少量历史 → max(default, observed max × safety)；稳定历史 → p90/p95 + margin；OOM → 快速提高 memory；连续稳定 → 缓慢降低（"升得快降得慢"）。
- 存储：`~/.orcana/runtime/linux/profiles/<fingerprint>.json`（原子写）。
- 验收：指纹稳定性（同类请求同指纹）、分位数计算、估算规则迁移（OOM 快升/稳定慢降）、持久化。

### P3-B PSI 背压（`src/runtime/linux/scheduler/psi.ts`）

- 读取 `/proc/pressure/{cpu,memory,io}` + cell cgroup 级压力（有委托时）。
- 策略状态机：NORMAL → CONSTRAINED → CRITICAL → RECOVERY（阈值从基线校准，不复制云参数）。
- 行为接口：`schedulerDecision()` → 允许/暂停新 build-test/保留交互/逐步恢复并发（防振荡）。
- 验收：PSI 解析（真实文件）、状态迁移（模拟阈值）、决策输出、RECOVERY 防振荡（滞后阈值）。

### P3-C 优先级模型（`src/runtime/linux/scheduler/priority.ts`）

- 显式字段：criticalPathLength / downstreamBlockedCount / userVisibility / verificationImportance / estimatedDuration / estimatedResourceCost / cacheHitProbability / retryRisk。
- `priority = criticality + userVisibility + downstreamUnlockValue + verificationValue + cacheOpportunity - resourcePressureCost - retryRisk`。
- 决策日志：每次调度记录字段值与结果（不隐藏成不可解释评分）。
- 验收：字段显式化、公式可测、日志完整、resourcePressureCost 在 CRITICAL 时压过新任务。

### P3-D 公平性扩展（`src/runtime/linux/scheduler/fairness.ts`）

- 在 FairQueue 基础上：Run-level weighted fair queue（run 级权重）+ Agent concurrency budget（现有）+ **Evolution hard quota** + **Interactive reserved capacity**（交互任务保留槽位）。
- 验收：大 Run 不占满全部槽位；Evolution 不超配额；交互任务始终有槽位。

### P3-E Work Stealing + 推测执行（`src/runtime/linux/scheduler/stealing.ts` + `speculative.ts`）

- Work Stealing：7 条件全成立才迁移（节点未开始 / 新 Agent 同 capability / 重新生成 ParticipantAssignment / 文件所有权不扩大 / 秘密重新授权 / 私有上下文依赖为 false / 生成新 Node Attempt）。
- 推测执行：只读白名单（测试发现/依赖扫描/Repo Map/Reviewer 预分析/缓存预热/只读索引）；提交前 re-verify `inputDigest/workspaceDigest/policyDigest/toolchainDigest`——不一致丢弃，不写 Evidence。
- 验收：7 条件守卫（任一不满足不迁移）、白名单外拒绝推测、digest 不一致丢弃。

### P3-F LR2-3 Gate 验收 + 独立审核

```text
SAMPLE_FRAGMENTATION（指纹不使用完整命令参数）        = 0
OOM_ESTIMATE_LAGS（OOM 后快速提高）                  = 0
PSI_THRESHOLD_UNCALIBRATED（阈值来自本机基线）        = 0
STARVATION_BY_RUN（大 Run 不占满）                    = 0
EVOLUTION_QUOTA_EXCEEDED                             = 0
STEALING_CONDITION_VIOLATED                          = 0
SPECULATIVE_STALE_COMMIT（digest 不一致不提交）        = 0
```

每项一条验收测试 + 独立 subagent 审核（同 LR2-1/2 流程）。

## 二、文件布局

```text
src/runtime/linux/scheduler/
├── profile.ts       WorkloadFingerprint + HistoricalResourceProfile + 估算
├── psi.ts           PSI 读取 + 策略状态机
├── priority.ts      优先级模型（显式字段 + 决策日志）
├── fairness.ts      公平性扩展（run WFQ + quota + reserved）
├── stealing.ts      Work Stealing 7 条件守卫
└── speculative.ts   只读推测执行 + digest re-verify
tests/runtime/linux/scheduler/   验收测试
```

## 三、风险与决策

- **PSI 阈值校准**：本机基线（压力读数 + 负载场景）——不复制云参数；校准脚本进 evals/perf。
- **估算不精确**：可解释优先（保守模板 + 显式安全系数），宁高勿低（OOM 快升）。
- **Work Stealing v1**：只做决策函数 + 守卫（不实际迁移执行——迁移执行属 Graph Runtime 集成，后续线）。
