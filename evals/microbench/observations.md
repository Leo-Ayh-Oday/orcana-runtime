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
