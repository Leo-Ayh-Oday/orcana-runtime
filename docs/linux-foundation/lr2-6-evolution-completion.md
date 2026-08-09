# Evolution Lab 完成记录（LR2-6）

**计划编号：** LR2-6
**英文名称：** Evolution Lab — 不可变评测清单 + 重放差异报告 + 晋升管线
**基线：** `b6e253d` → 完成于 `ba73e50`（含独立审核修复）
**状态：** ✅ 完成（P6-A~E + 独立审核闭环）

## 交付内容

| 阶段 | Commit | 内容 |
| --- | --- | --- |
| 计划 | `5952f18` | P6-A~E 阶段划分 |
| P6-A | `972a0ed` | EvolutionManifest（内容寻址 manifestId + 校验）+ Environment Digest（摘要/漂移检测） |
| P6-B | `8bf79a9` | Replay（基线/候选同一清单重放 + 环境漂移拒绝）+ DifferentialReport 差异矩阵 |
| P6-C | `a889710` | Security Gate 对比 + 性能回归评估（p50/p95，阈值取自基线） |
| P6-D | `484267d` | 晋升管线状态机（PROPOSED→EVALUATED→CANARY→APPROVED→PROMOTED） |
| P6-E | `9e7d47b` | 9 项 Gate 逐条验收测试 |
| 审核修复 | `ba73e50` | B1 + M2-M7 + MINOR 全处置 |

## 独立审核（1 BLOCKER + 6 MAJOR + 2 MINOR，全部处置）

- **B1（BLOCKER）**：差异矩阵单向遍历 → NEW_FAILURE 分类不可达 → 候选
  新增失败样本不可见、HIDDEN_FAILURE_PROMOTED 门禁假绿。修复：双向遍历
  union of caseIds —— 候选删 case（隐藏失败）与候选新增失败 case 均归为
  NEW_FAILURE 并阻断晋升；MISMATCH 降级为信息类（不再自动阻断）。
- **M2**：manifest 缺 environment 校验 → 补必填/64-hex/布尔类型校验。
- **M3**：持久化 environmentDigest 不参与 id 校验 → parseManifest 强制与
  facts 重算一致。
- **M4**：runReplay 漂移检测对真实候选恒拒绝/可完全跳过 → 候选环境必填
  + allowCandidateEnvironmentDiff 逐字段漂移检测（默认仅 sourceDigest）。
- **M5**：状态机终态死出边（注释声称"可重新提案"实际不可用）→ 删除，
  重新提案 = createPromotion 新记录。
- **M6**：Security Gate 候选缺项视为 0（未评估=安全）→ 缺项即拒绝。
- **M7**：性能回归只遍历候选侧（基线缺项/空采样静默通过）→ 拒绝。
- **MINOR**：p95 nearest-rank（小样本不坍缩到 max）、criteria 字段消费
  （requireSecurityGateNonRegression）、watchRegressions 落账。

## Gate 状态

```text
CANDIDATE_CONTROLS_BENCHMARK      = 0 ✅
ENVIRONMENT_DRIFT_UNDETECTED      = 0 ✅
REGRESSION_PROMOTED               = 0 ✅
HIDDEN_FAILURE_PROMOTED           = 0 ✅（真检测：删 case/新增失败 case）
SECURITY_GATE_REGRESSION          = 0 ✅（含缺项拒绝）
PERF_REGRESSION_IGNORED           = 0 ✅（含空采样/缺项拒绝）
CANDIDATE_WRITES_BASELINE         = 0 ✅
PROMOTION_WITHOUT_HUMAN_APPROVAL  = 0 ✅
CANARY_REGRESSION_UNWATCHED       = 0 ✅（监视落账）
```

## 测试

`tests/evolution/` 5 个文件 69 测试全绿；全量门禁（typecheck/test/build/
diff-check）通过。

## 与现有 Evolution OS 的关系

- 现有 `src/evolution/evolution-os.ts` = 提案侧（能力缺口检测 → Proposal）；
- LR2-6 = 评测侧（Proposal → 不可变清单 → 重放 → 评估 → 晋升）；
- 两者通过 EvolutionManifest 衔接（evolution-os 产出候选引用，
  LR2-6 负责验证与晋升），尚未硬接线 —— 接线在后续线（LR2-7 或独立线）。

## 遗留（v2 范围）

- evolution-os 与 LR2-6 晋升管线的硬接线；
- execd 沙箱评测后端（当前为函数评测后端，Cell 执行后端接口已留）。
