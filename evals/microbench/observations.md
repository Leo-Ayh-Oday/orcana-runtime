# ORMB 观察记录（Observations Log）

每轮测试的关键提炼结论：模型行为亮点、暴露的 bug、测试设计修复、性能/成本观察。
数据溯源到 `evals/microbench/reports/` 下的存档 JSON。

---

## 2026-08-06 · P0 ORMB-PP（provider 协议）+ P1 ORMB-TU（工具调用）

commit: `abbeabb`(P0 骨架) `83bcba9`(修复) `921df85`(max 思考) `712c321`(存档层) `7ed0391`(P1)
存档: `ORMB-PP-921df85-20260806-083733.json` / `ORMB-PP-live-921df85-20260806-083759.json` / `ORMB-TU-712c321-20260806-084818.json`

### 结论 1：真实 provider bug（P0, mock M09 抓出）

`content_block_stop` 里合法 JSON 直接 `JSON.parse` 成功会**跳过字段别名修复**——
`{"filePath":"x"}` 是合法 JSON 但字段名需规范化为 `{"path":"x"}`，导致工具输入错配。
修复：一律走 `repairToolCall`（其内部先做字段别名 + Python 字面量预处理）。`src/provider/deepseek.ts:193`。

### 结论 2：thinking config 曾不诚实，现已验证 max 真实生效

live 最初实际传 `adaptive/high`，header 却标 `reasoningEffort:"max"`。
修复后：LV-02 传 `adaptive/max`，真实产出 thinking_blocks，`cacheRead` 升到 896。
**规则：header 必须按真实配置标注**（mock 标 none，live 标 max）。

### 结论 3：前缀缓存全程生效，无静默模型切换

live 5 用例 cacheMiss=0（cacheRead 384-896），前缀缓存有效，多轮/重跑更便宜。
actualModel 恒为 deepseek-v4-flash，无 SILENT_MODEL_SWITCH。

### 结论 4：schema 字段名必须符合模型习惯（P1 第一轮 18/20 的教训）

模型 3 次调 `run_process` 全传 `{"command":"test"}`，schema 字段名是 `cmd` → 参数校验全拒 → 链路断。
**工具 schema 的字段名若与模型习惯不一致，即使意图正确也会执行失败。**
修复：参数名改 `command`。设计工具时优先用最常见命名，而非任意缩写。

### 结论 5：工具行为必须自洽，不能留绕过后门（P1）

`read_file` 对 big.log 截断、`read_files` 却不截断 → read_files 成了绕过截断的后门。
修复：两处一致截断，并给 `read_file` 增加 `range` 参数作为**明确**的完整读取路径。
模型两种恢复方式都展示过：`range="490-510"` 一次直达（更优）、截断后 `range="500-500"` 重试。

### 结论 6：重复副作用 gate 只应统计"实际生效"的写（gate 误报修复）

两次 `apply_patch` 写同一路径，第一次格式错误被拒（未生效），gate 误记为重复副作用。
修复：`REDUNDANT_SIDE_EFFECT` 只统计 `ok` 调用。被拒/失败的写不产生副作用。

### 模型行为亮点（calls 明细在存档 JSON 各 case 的 toolCalls 字段）

| 用例 | 亮点 |
|---|---|
| TU-B02 | read 失败→search_files 定位→apply_patch 格式错**自修复重试成功**→test→git_diff 全链路 8 轮 7 调用 |
| TU-C01 | 路径不存在后主动 search_files 找真实文件继续，最终有答案 |
| TU-C03 | compute 瞬时故障（仅一次）后重试成功，答案 420 正确 |
| TU-C04 | 明确只读任务零写调用，状态机 gitLog 零改动 |
| TU-C05 | 拿到答案后立即停止，无冗余重复读/重复副作用 |
| PP-LV01/02 | 工具路由合理（read 前先 search），多轮轮间 reasoning 连续，tool call id 无重复 |

### 成本/性能观察

- Zen 按 token 计费（非按调用数）：P0 live 全量 12 次调用 ≈ $0.0008；Go 会员按请求限额（v4-flash ~31,650 次/5h），用量可忽略。
- Token per Task 均值 188（TU），每次用例 3-8 轮、2-7 次工具调用。
- 模型倾向于先 search 再 read（合理前缀），不宜在断言里要求"只读目标文件"。

---

## ORMB-SR/TR/MTR（P2）：Skill 路由 + Mode 分诊 + 多轮切换

### 结果（run3 全量，commit 5da2e90，报告 ORMB-SR/TR/MTR-5da2e90-20260806-0930xx.json）

| 套件 | 通过 | 关键指标 | 计划 v1.0 目标 |
|---|---|---|---|
| ORMB-SR | 48/50 | 语义 F1=86.1%（P 79.5 R 93.9）、Exact Set 79.6%、No-Skill 7/7 | Macro F1 ≥ 90 |
| ORMB-TR | 36/40 | Mode Macro F1=90.2%、Under 2/Over 0、needsWeb P=100% R=25%、Risk High Miss 0/7 | Macro F1 ≥ 93、高险漏判 0 |
| ORMB-MTR | 5/5 | 真实/理想路径全对，Turn3 无继承 | 切换准确率 ≥ 90 |

### 结论 7：语义分诊显著优于关键词路由（P2 核心结论）

同 50 用例：关键词路径 F1=65.1%（P 54.0 R 81.8，关键词误触发是主要污染源）vs 语义路径 F1=86.1%（P 79.5 R 93.9）。
语义路径召回 93.9% vs 关键词 81.8%——隐含需求（无触发词）只有语义路径能接住。
代价：每次 triage 一次模型调用（实测 2-19s 波动，均值 ~5s）。

### 结论 8：triage 可见技能集必须与 registry 单一事实源同步（生产缺陷）

`buildTriagePrompt` 硬编码 6 个技能名：含 phantom `design-quality`（registry 不存在——
模型选中后激活静默丢失），缺 ui-ux-pro-max/motion-pro-max（语义路径结构不可达，
这 8 个用例永远路由不到）。`SKILL_TRIGGER_MAP`（fallback 关键词）同样 6 个含 phantom。
修复：两处均从 registry `SKILLS` 动态生成（autoTrigger 子集）。修复后 ui-ux/motion
从"结构不可达"变为可达，MTR-01 Turn3（CSS 动效）正确激活 motion-pro-max。

### 结论 9：空响应必须诚实失败，伪成功会污染全部指标（生产缺陷）

文本 fallback 在空响应时返回 `{mode:narrow_edit, risk:low, skills:[]}` 兜底值：
40 个 mode 用例 12 个被污染（30%），Mode Macro F1 被拖到 63.9%（真实 90.2%），
Risk High Miss 6/7 里有 6 个是兜底值假漏判（真实 0/7）。修复：空响应返回 null → 关键词 fallback。
教训：**兜底值的"看起来正常"比明显错误更危险**——调用方无法区分"模型真判断"和"分诊失败"。

### 结论 10：deepseek-v4-flash 强制 thinking + 512 max_tokens = 空响应（基础设施）

- thinking 实测：disabled 2.4s/0 字符，默认 4.0s/385 字符，enabled(1024) 7.3s/797 字符
- maxTokens 512 时 thinking 吃满 → `stop_reason=max_tokens` + 零 text → 空响应
- 慢请求 12-19s（连续请求时段 zen/go 延迟波动），8s/15s 超时把慢请求误杀成空响应
- 修复组合：maxTokens 2048 + 超时 30s + 测试并发 50→4。失败率 62% → 2%（1/50）
- 最终 thinking 配置：不传参数（模型自决）——run3 验证 F1 90.2%/失败率 2%，待 A/B 对比 enabled 小预算

### 结论 11：剩余误判全部是边界分歧，无系统性缺陷

4 个 MODE_MISMATCH：TR-19 模糊任务保守化（"重命名这个文件"→discussion）、
TR-25/28 讨论/规划边界（接口规范设计、TS 大版本评估判 discussion——但 needsWeb 判对）、
TR-40 单模块判 plan 档（web/风险识别全对，只差档位）。2 个 SR：SR-17 隐含
architecture 漏选、SR-42 弹跳按钮只选 motion 漏 ui-ux（GT 双 required 偏严）。
均属 GT 标注粒度 vs 模型分类粒度的边界摩擦，不触发"修复 prompt"式调优。

### 模型行为亮点

| 用例 | 亮点 |
|---|---|
| MTR-01 | Turn3 "只改 hover 动效" 正确路由 motion，未继承 Turn1 的 architecture（breaker 未造成继承污染） |
| TR-28 | TS 大版本升级 needsWeb=true + 搜索词质量高（"breaking changes/migration guide"），仅 mode 档位偏 discussion |
| TR-40 | 支付模块 web 搜索词对准支付宝/微信/Stripe 官方文档，风险 high 未漏判 |
| SR 语义路径 | 隐含需求（无触发词）召回 93.9%，"接口各种奇怪输入→edge-case-hunter" 等语义匹配准确 |

### 成本/性能观察（P2）

- 单次 triage：~1.5-2K tokens（2048 上限，thinking 385-797 字符），延迟均值 ~5s
- P2 全量 110 次 triage 调用，Go 会员限额内可忽略（v4-flash ~31,650 次/5h）
- 4 并发限流后空响应率 2%（50 并发时更高）——provider 端对突发请求有延迟惩罚
- fallback 与关键词路径同源后（registry triggers），fallback F1 = 关键词 F1 = 65.1%——
  fallback 的成功率（100%）是计划 §五 gate，准确率与关键词路径相同

### 结论 12：Thinking A/B 三组对比——auto 定稿，enabled1024 明确不值得（2026-08-06）

同用例集、同时段串行实测三组（并发 4 / maxTokens 2048 / 超时 30s）：

| 指标 | disabled | auto（定稿） | enabled1024 |
|---|---|---|---|
| Mode Macro F1 | 92.4% | 89.7% | 92.0% |
| per-mode F1 (dis/narrow/plan/full) | 95.2/100/84.2/90.0 | 87.0/100/77.8/94.1 | 85.7/100/82.4/100 |
| Under-routing / Over-routing | 1/0 | 3/0 | 3/0 |
| Risk High Miss | 0/7 | 0/7 | 0/6（TR-38 被 max_tokens 杀死未计入）|
| triage P50 / P95 | 3484 / 6118 ms | 4922 / 16971 ms | 4736 / 20521 ms |
| 分诊失败（TR）| 0/40 | 1/40 | 2/40 |
| SR 语义 Exact Set | 82.0% | 81.3% | 79.2% |
| SR 分诊失败 | 0/50 | 2/50 | 2/50 |

**结论：**
1. **thinking 对 accuracy 无实质影响**（差距 ≤2.7pp 且方向不稳定，禁用时反而略高）——
   GPT 讨论预测应验：enabled 只加 ~1-2pp 不值得。**auto（不传参数）定稿**：模型自决、
   简单请求省延迟，复杂请求自动思考；不设 enabled 分层，避免复杂性（opencode 式简单设计）。
2. **enabled1024 明确排除**：Exact Set 最低（79.2%）、P95 延迟最高（20.5s，比 disabled 3.4×）、
   且 thinking 1024 + 2048 max_tokens 组合把 high 风险用例 TR-38 分诊杀死（stop_reason=max_tokens）。
3. **真实缺陷：2048 max_tokens 仍有 thinking 吃满窗口**——auto 组 TR-36（full_complex）、
   enabled1024 组 TR-38（full_complex high）均死于 `max_tokens`（零 text）。修复：2048 → 4096。
4. **错误集跨组几乎不重叠**（disabled: TR-24/30/38；auto: TR-25/28/29/38；enabled: TR-25/27/28），
   但 **TR-38（权限系统）三组全错**——判 plan_before_code/discussion 而非 full_complex，
   是稳定边界分歧（GT 粒度 vs 模型粒度），维持结论 11 不调优。
