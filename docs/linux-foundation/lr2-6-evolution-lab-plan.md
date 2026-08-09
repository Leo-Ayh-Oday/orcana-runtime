# Evolution Lab 实现计划（LR2-6）

**计划编号：** LR2-6
**英文名称：** Evolution Lab — 不可变评测清单 + 重放差异报告 + 晋升管线
**上一版：** [LR2-5 Durable Service Cell](lr2-5-durable-service-plan.md)（P5-A~E 完成，含独立审核）
**基线：** `b6e253d`（LR2-5 审核修复，门禁全绿）
**定位：** 让"候选版本跑测试"成为受控工程：不可变评测清单、环境摘要、
重放、差异报告、安全/性能评估、Canary → 人工批准 → 晋升 → 回归监视。

> 记录说明：push/release 按 LR2 计划线点名拆分。

## 零、现状盘点（2026-08-09）

- 已有：`src/evolution/evolution-os.ts`（512 行）——能力缺口检测 + 提案侧
  （CapabilityGapReport / detectCapabilityGap / knowledge acquisition），
  **只产出 Proposal，不评测、不晋升**；
- 已有：LR2-1 execd 的 cell 执行、LR2-2 缓存、LR2-4 cell-init/seccomp、
  LR2-5 service cell —— 全部可作为评测执行后端；
- 已有：evals/microbench（ORMB）——性能基准，可作性能评估输入；
- 无：不可变评测清单（Immutable Evaluation Manifest）、基线/候选环境
  分离、重放差异报告、安全 Gate 不下降检查、晋升决策、Canary、回归监视。

## 一、阶段划分

### P6-A EvolutionManifest（`src/evolution/manifest.ts`）

不可变评测清单——候选版本不得控制其内容：

- `manifestId`（sha256 摘要，内容寻址）、`schemaVersion`；
- `benchmarkSet`：评测用例集（replay cases）——引用不可变输入（测试集
  源 digest），**不允许候选改写**；
- `scorer`：评分器（正确性 + 失败样本跟踪），同 manifestId 绑定；
- `evaluatorVersion`：评测器自身版本（评测器变化 = 不允许晋升）；
- `environment`：Environment Digest（见下）；
- `promotionCriteria`：晋升要求快照（正确性不下降 / 安全 Gate 不下降 /
  性能阈值 / 失败样本未减少 / 评测器未变化 / 候选未写入基线）。

Environment Digest（digest.ts 提供）：

```text
source digest + lockfile digest + toolchain digest + rootfs/image digest
+ kernel capability digest + CellSpec digest + network policy digest
+ resource policy digest + evaluator version + benchmark manifest digest
```

- 清单一旦创建不可变（内容寻址 + 任何字段变更 → 新 manifestId）。
- 验收：manifest 校验（缺字段拒绝）、内容寻址幂等、变更产生新 id。

### P6-B Replay + Differential Report（`src/evolution/replay.ts` + `report.ts`）

- `BaselineEnvironment`：基线提交 + manifest.environment；
- `CandidateEnvironment`：候选提交 + 相同 manifest（环境必须一致，除
  source/lockfile/toolchain digest 是候选自身的）；
- `ReplayResult`：每个 case 的 exit/输出/耗时/通过标记（经 execd Cell
  执行，或纯函数评测两种后端）；
- `DifferentialReport`：基线 vs 候选逐 case 对比：
  - 通过→失败（回归，**必须阻止晋升**）；
  - 失败→通过（改进）；
  - 失败→失败（失败样本未减少时不允许晋升——按 criteria 判定）；
  - 通过→通过（中性）；
  - 新增失败样本（隐藏失败 = 不允许晋升）。
- 验收：逐 case 矩阵、回归/改进分类、新增失败检测、空清单拒绝。

### P6-C 安全 + 性能评估（`src/evolution/security.ts` + `performance.ts`）

- Security Gate：候选版本的 cell-init / seccomp / egress / service 安全
  约束不得低于基线（Gate 数字对比：任何项增大 → 不晋升）；
- 性能：复用 ORMB 风格基准（微基准 + 关键路径）——`WARM_START_REGRESSION`
  等 Gate 不回归；阈值来自基线快照而非硬编码；
- 两者都输出可解释的决策输入（不隐藏成黑盒分数）。
- 验收：安全 Gate 回归检测、性能回归检测、阈值取自基线。

### P6-D 晋升管线（`src/evolution/promotion.ts`）

- 状态机：`PROPOSED → EVALUATED → CANARY → APPROVED → PROMOTED`，
  异常：`REJECTED_CRITERIA / SECURITY_REGRESSION / PERF_REGRESSION /
  CANARY_FAILED / HUMAN_DECLINED / EVALUATOR_CHANGED`；
- 强制路径：Differential Report 全绿（无回归/无隐藏失败）→ Canary
  （小流量真实场景）→ **Human Approval** → Promotion；
- 候选晋升后进入 Regression Watch（监视窗口，新回归自动降级报告）；
- 候选**永远不能写入基线**（基线只由 Promotion 动作更新）。
- 验收：完整路径可走通；每个拒绝原因有独立路径；无 Human Approval
  无法晋升；候选不写基线。

### P6-E Gate 验收 + 独立审核

```text
CANDIDATE_CONTROLS_BENCHMARK      = 0（候选不可控评测清单）
ENVIRONMENT_DRIFT_UNDETECTED      = 0（环境摘要不一致即拒绝）
REGRESSION_PROMOTED               = 0（任何回归不得晋升）
HIDDEN_FAILURE_PROMOTED           = 0（失败样本减少/隐藏不得晋升）
SECURITY_GATE_REGRESSION          = 0
PERF_REGRESSION_IGNORED           = 0
CANDIDATE_WRITES_BASELINE         = 0（候选不得写入基线）
PROMOTION_WITHOUT_HUMAN_APPROVAL  = 0
CANARY_REGRESSION_UNWATCHED       = 0（晋升后回归监视缺失）
```

每项一条验收测试 + 独立 subagent 审核（同流程）。

## 二、文件布局

```text
src/evolution/
├── manifest.ts      EvolutionManifest + 校验 + 内容寻址
├── digest.ts        Environment Digest（统一摘要）
├── replay.ts        基线/候选重放 + ReplayResult
├── report.ts        DifferentialReport（逐 case 差异矩阵）
├── security.ts      Security Gate 对比（不下降）
├── performance.ts   性能回归评估（阈值取自基线）
└── promotion.ts     晋升状态机 + Canary + 人工批准 + 回归监视
tests/evolution/     验收测试
```

## 三、风险与决策

- **本机无真实双版本代码库**：重放后端用「函数评测」（同一 manifest 下
  对基线/候选两个函数引用跑同一组 case）+ 可选 execd Cell 执行（有
  cgroup 时）——两者都产出同一 ReplayResult 形状；
- **性能阈值不硬编码**：基线快照先跑一轮产生 p50/p95 基线，候选与之
  对比（延续 LR2-2 的"先基线后阈值"原则）；
- **评测器版本**：evaluatorVersion 进 digest —— 评测器本身改动必须
  重新生成 manifest（否则拒绝）；
- 生产主路径保持不可变清单；可变实验（spike）只允许在 manifest 外。

## 四、执行顺序

P6-A → P6-B → P6-C → P6-D → P6-E（每阶段：实现 → 门禁 → 提交）。
