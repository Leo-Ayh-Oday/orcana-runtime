# Orcana Runtime Micro Benchmark v0.1

> 模块级微基准（ORMB）—— 定位每一个模块到底带来了多少质量、成本和时延收益。
> 与 Terminal-Bench 分开：Terminal-Bench 测综合任务成功率；OTS 测 Runtime 安全性与稳定性；专项难题测架构边界；**Micro Benchmark 测单个模块的贡献。**

第一版不要铺几十个模块。先集中做六套最有价值、最能影响真实 Agent 成绩的微基准：

```text
ORMB-CX  上下文压缩与长期记忆
ORMB-EC  Token 经济性与缓存效率
ORMB-TU  工具选择和调用
ORMB-SR  Skill 路由
ORMB-TR  任务分诊和执行模式路由
ORMB-PP  Provider/思考/Tool Loop 协议
```

每套微基准都必须同时输出四个维度：

```text
质量 Correctness
成本 Cost
时延 Latency
稳定性 Reliability
```

不能只输出一个综合分，否则会掩盖"Token 很省，但任务做错"或"能力很强，但成本爆炸"的情况。

---

## 一、ORMB-CX：上下文压缩能力

### 要回答的问题

> Orcana 压缩了多少上下文？丢失了什么？压缩后还能不能继续正确完成任务？

当前 Context Epoch 使用字符数作为触发依据，并用约 `字符数 ÷ 3` 估计 Token；默认约在 120k、220k、300k 字符触发压缩、强制压缩和 Epoch Rollover。它会保留 Plan、TaskTracker、决策和 Ripple 等状态。

Memory Compactor 也使用字符估算 Token，并维护 hot、warm、cold、anchor 和 delta 多层记忆。

真正需要测试的是：这些设计在真实模型上下文中是否有效。

### 测试数据

准备 8 类长会话，每类生成四个长度档位：

```text
0.8 × compress threshold
1.1 × compress threshold
1.1 × force-compress threshold
1.1 × rollover threshold
```

总计 32 个测试实例。

八类内容包括：

1. **决策演化**：先选择 A，后来明确废弃 A 改为 B；
2. **强约束**：不得修改公开 API、不得删除测试；
3. **未完成义务**：三个任务完成两个，保留一个；
4. **代码状态**：多个文件、函数、版本和变更关系；
5. **Tool Chain**：assistant tool call 与 tool result 必须保持配对；
6. **长日志噪音**：大量无关测试输出中隐藏一个关键错误；
7. **中英代码混合**：中文、英文、TypeScript、JSON；
8. **多 Agent 交接**：Planner、Coder、Reviewer 的不同状态。

每个实例包含一个私有 `fact-manifest.json`：

```json
{
  "criticalFacts": [],
  "supersededFacts": [],
  "negativeConstraints": [],
  "openObligations": [],
  "completedActions": [],
  "toolChains": []
}
```

### 验证方法

压缩之后执行两轮验证。

#### 第一轮：信息探针

要求模型输出严格 JSON：

```json
{
  "currentDecision": "",
  "forbiddenActions": [],
  "openObligations": [],
  "completedActions": [],
  "relevantFiles": []
}
```

由确定性 verifier 对照 manifest，不用 LLM Judge。

#### 第二轮：继续完成任务

让 Agent 在压缩后的上下文中完成剩余修改，检查它是否：

* 重复执行已经完成的步骤；
* 恢复已经被废弃的旧决策；
* 忘记禁止事项；
* 修改错误文件；
* 丢失验证要求。

### 核心指标

| 指标                        | 含义                    |
| ------------------------- | --------------------- |
| Critical Fact Recall      | 关键事实保留率               |
| Superseded Fact Rejection | 是否正确拒绝旧决策             |
| Obligation Recall         | 未完成义务保留率              |
| Constraint Violation      | 是否违反负面约束              |
| Tool Chain Integrity      | Tool Call/Result 是否完整 |
| Continuation Pass Rate    | 压缩后任务完成率              |
| Compression Ratio         | 压缩后/压缩前 Token         |
| Recovery Overhead         | 压缩后重新搜索和读取的 Token     |
| Duplicate Work Rate       | 重复执行已完成步骤比例           |

### 成本指标

不要只计算压缩后的上下文长度，而要计算净收益：

```text
净 Token 节省
=
未压缩方案后续总输入 Token
-
压缩方案后续总输入 Token
-
压缩本身消耗
-
因遗忘产生的重新读取 Token
```

还要计算：

```text
Break-even Round
```

即压缩多少轮后才真正回本。

### v1.0 建议 Gate

```text
关键事实保留率 ≥ 99%
旧决策复活率 = 0
未完成义务保留率 = 100%
Tool Chain 破坏 = 0
压缩后任务成功率下降 ≤ 2 个百分点
长任务净 Token 节省 ≥ 35%
重复工作率 ≤ 5%
```

另外专门输出字符估算误差：

```text
estimatedTokens vs providerReportedInputTokens
```

中文、英文、代码和 JSON 应分别统计。不能继续默认所有内容都是稳定的 `chars/3`。

---

## 二、ORMB-EC：Token 经济性与消耗速度

### 要回答的问题

> Orcana 每完成一步要烧多少 Token？Token 是花在推理、历史、工具结果、Skill，还是无效重试上？

当前 live runner 已经记录：

* input tokens；
* output tokens；
* cache read；
* cache miss；
* cache creation；
* cache hit rate；
* rounds；
* wall time。

但这些指标需要进一步拆成可解释成本。

### 测试任务

选 12 个中小型固定任务：

```text
3 个单文件修复
3 个跨文件修复
2 个测试编写
2 个调试任务
1 个重构任务
1 个只读分析任务
```

每个任务运行以下配置：

| 配置 | Triage | Skill | Compaction | Cache |
| -- | ------ | ----- | ---------- | ----- |
| A  | off    | off   | off        | cold  |
| B  | on     | off   | off        | cold  |
| C  | off    | on    | off        | cold  |
| D  | on     | on    | off        | cold  |
| E  | on     | on    | on         | cold  |
| F  | on     | on    | on         | warm  |

每个配置重复 3～5 次。

### Token 分类

所有 Token 必须被归属到以下类别：

```text
stable_system_prefix
skill_prompt
triage_prompt
conversation_history
memory_context
tool_schema
tool_result
model_reasoning
model_final_output
retry_duplicate
verification_output
```

任何无法解释的 Token 进入：

```text
unattributed_tokens
```

### 核心指标

#### 每轮燃烧速度

```text
Round Burn Rate(r)
=
第 r 轮新增总 Token
```

#### 上下文增长加速度

```text
Context Growth Slope
=
每轮输入 Token 随轮次增长的斜率
```

健康的压缩系统应在压缩后让斜率明显下降，而不是仅减少一次上下文。

#### 每成功任务成本

```text
Cost per Passed Task
=
全部重复运行总成本
/
成功运行数
```

这个指标比"单次平均 Token"更重要。一个便宜但经常失败的 Agent，实际成功成本可能更高。

#### 无效 Token 比例

```text
Wasted Token Ratio
=
重复读取
+ 无效重试
+ 错误 Tool 调用
+ 重复规划
+ 已完成工作重做
/
总 Token
```

#### 治理开销

```text
Governance Overhead
=
Skill + Triage + Evidence + Policy Token
/
总 Token
```

治理机制必须证明它带来的成功率提升值得其成本。

### 结果展示

不要一开始合成总分，先画 Pareto Frontier：

```text
X 轴：Cost per Passed Task
Y 轴：Pass Rate
气泡大小：Wall Time
```

最好的配置不是 Token 最低，而是处于质量—成本 Pareto 前沿。

### v1.0 建议 Gate

```text
Token 归属率 ≥ 99%
无效 Token 比例 ≤ 15%
长任务启用压缩后成本/成功任务下降 ≥ 25%
Warm Cache 缓存未命中 Token 下降 ≥ 40%
治理开销必须带来正向任务成功率收益
不存在无限或乘法式重试
```

---

## 三、ORMB-TU：工具调用能力

### 要回答的问题

> 模型能否选对工具、填对参数、按正确顺序调用，并在错误后恢复？

必须把工具能力拆成三个层面：

```text
模型选择能力
Runtime 执行能力
端到端任务能力
```

否则 Tool 失败后无法判断是模型选错，还是 Orcana 执行错误。

### 测试环境

创建一个确定性虚拟工作区和 20～30 个工具，其中加入相似的干扰项：

```text
read_file / read_files
write_file / apply_patch
run_process / run_shell_script
service_start / service_status
search_files / search_symbols
git_diff / git_status
web_search / web_fetch
```

每个 Tool 修改一个可观察状态机，最终结果由状态验证，不依赖模型自报。

### 80 个测试案例

#### A. 单工具选择：20 题

例如：

```text
"读取 config.json，不能修改文件"
```

检查是否选择 `read_file`，而不是 Shell 或写工具。

#### B. 参数正确性：20 题

覆盖：

* 数组参数；
* 嵌套对象；
* 路径转义；
* 中文和空格；
* 可选参数；
* 必填参数；
* 无效 enum；
* 超长参数。

#### C. 多工具顺序：20 题

例如：

```text
读取失败测试
→ 定位源码
→ 修改文件
→ 运行局部测试
→ 检查 diff
```

顺序错误会导致确定性失败。

#### D. 恢复、安全和停止：20 题

覆盖：

* Tool 第一次超时；
* 返回部分结果；
* 参数 Schema 错误；
* Tool 不存在；
* 需要确认；
* 只读任务不应写入；
* 成功后必须停止；
* 不允许重复产生副作用。

### 核心指标

| 指标                             | 含义                 |
| ------------------------------ | ------------------ |
| Tool Selection Accuracy        | 工具选择准确率            |
| Argument Validity              | 参数 Schema 合法率      |
| Argument Semantic Accuracy     | 参数内容正确率            |
| Sequence Success               | 多工具顺序成功率           |
| Hallucinated Tool Rate         | 调用不存在工具比例          |
| Redundant Call Ratio           | 实际调用数/Oracle 最少调用数 |
| Recovery Success               | Tool 失败后恢复率        |
| Stop Accuracy                  | 完成后正确停止比例          |
| Unsafe Side Effect             | 越权副作用次数            |
| Token per Successful Tool Task | 每个成功 Tool 任务成本     |

### 额外维度：Tool 数量压力

同样的测试分别提供：

```text
8 个工具
20 个工具
50 个工具
```

观察工具越多时：

* 选择准确率下降多少；
* Tool Schema Token 增加多少；
* 响应延迟增加多少。

这可以指导 Orcana 是否应该按任务动态裁剪 Tool 集，而不是每次把全部工具塞给模型。

### v1.0 建议 Gate

```text
单工具选择准确率 ≥ 97%
参数 Schema 合法率 ≥ 99%
多工具任务成功率 ≥ 90%
虚构 Tool 比例 ≤ 1%
冗余调用比 ≤ 1.25
成功后继续调用比例 ≤ 2%
高风险错误调用 = 0
瞬时失败恢复率 ≥ 85%
```

---

## 四、ORMB-SR：Skill 路由能力

### 当前需要重点测试的地方

Orcana 当前存在两条 Skill 路径：

1. `activateSkills()`：关键词匹配，最多激活三个；
2. Flash Triage：通过一次语义模型调用选择 Skill，失败后回退关键词。

这很容易出现：

* 关键词误触发；
* 隐含需求漏触发；
* 多个 Skill 冲突；
* Skill Prompt 太长，成本超过收益；
* 会话中任务变化后不重新路由；
* 错误 Skill 对结果产生负迁移。

### 数据集设计

从实际 Registry 动态读取所有 Skill，不在测试里硬编码名称。

每个 Skill 建立四类 Prompt：

```text
直接明确匹配
语义隐含匹配
容易混淆的近邻任务
包含关键词但不应匹配
```

例如：

```text
"帮我写一个安全模块"                 → security
"这段错误日志为什么偶尔出现"           → debugging
"README 里出现了 security 这个单词"    → 不应激活 security
"不要进行架构评审，只修这个拼写"        → 不应激活 architecture
```

第一版建议：

```text
每个 Skill 30～40 条
No-Skill 40 条
多 Skill 组合 40 条
多轮任务切换 30 组
```

总规模约 250～350 条。

### Ground Truth

每条 Prompt 的标签不能只有"正确 Skill"，而应该是：

```json
{
  "required": [],
  "optional": [],
  "forbidden": []
}
```

这样才能区分：

* 必须激活；
* 激活有帮助但非必须；
* 激活会产生负面效果。

### 核心指标

```text
Macro / Micro Precision
Macro / Micro Recall
Exact Set Accuracy
Top-3 Coverage
False Activation Rate
Forbidden Skill Activation
Paraphrase Stability
Multilingual Stability
Multi-turn Task Shift Accuracy
Skill Prompt Token Overhead
```

### 关键指标：Skill 是否真的有用

路由准确并不意味着 Skill 有价值。

从数据集中选择 30 个下游任务，分别运行：

```text
无 Skill
自动选 Skill
Oracle Skill
随机错误 Skill
```

计算：

```text
Skill Lift
=
自动 Skill 任务得分
-
无 Skill 任务得分
```

以及：

```text
Token-adjusted Skill Lift
=
Skill Lift
/
新增 Skill Prompt Token
```

如果自动 Skill 路由准确率很高，但实际不提高任务成功率，只增加 Token，那么 Skill 系统仍然没有价值。

### 必测特殊场景

Flash Triage 当前采用一次调用的 Circuit Breaker。必须测试一个会话中任务发生变化：

```text
Turn 1：设计架构
Turn 2：修复安全漏洞
Turn 3：只修改 CSS 动效
```

检查每轮是否使用正确 Skill，而不是永远继承第一次分诊结果。

### v1.0 建议 Gate

```text
Macro F1 ≥ 0.90
No-Skill 场景精确率 ≥ 97%
Top-3 必要 Skill 覆盖率 ≥ 95%
Forbidden Skill 激活率 ≤ 1%
同义改写路由一致率 ≥ 95%
多轮任务切换准确率 ≥ 90%
自动 Skill 的平均下游收益 > 0
Skill Token 增量必须有正 ROI
```

---

## 五、ORMB-TR：任务分诊与模式路由

Skill 路由和执行模式路由不能混为同一项。

Flash Triage 当前一次输出：

* discussion；
* narrow_edit；
* plan_before_code；
* full_complex；
* needsWeb；
* researchQueries；
* Skill；
* planSteps；
* verification；
* riskLevel。

这一个入口决定后续大量成本。

### 测试集

准备 160 个 Prompt，四种 mode 各 40 个，再交叉加入：

* 是否需要 Web；
* 是否需要测试；
* 是否需要计划；
* 是否高风险；
* 是否只是讨论；
* 是否表面简单但实际跨模块；
* 是否表面复杂但只需一行修改。

### 要测的错误

#### 过度路由

```text
一行拼写修改
→ full_complex
→ 生成计划、TaskTracker、多轮验证
```

质量没提高，成本大幅上升。

#### 路由不足

```text
数据库迁移 + API 改造
→ narrow_edit
```

导致缺少规划、遗漏文件和验证。

#### Web 误判

* 已给出完整代码却仍然联网；
* 最新 API 问题却不联网。

#### 风险误判

高风险的 Secret、权限、删除操作被标记为 low。

### 核心指标

```text
Mode Macro F1
Under-routing Rate
Over-routing Rate
needsWeb Precision/Recall
Risk High Miss Rate
Verification Coverage
Plan Step Validity
Triage Latency
Triage Token Cost
Fallback Success
```

### Triage ROI

```text
Triage ROI
=
未分诊方案的下游成本
-
分诊方案的下游成本
-
分诊调用成本
```

还要比较三种方案：

```text
无分诊
关键词分诊
Flash Triage
```

不能默认模型分诊一定比规则更经济。

### v1.0 建议 Gate

```text
Mode Macro F1 ≥ 0.93
复杂任务 Under-route ≤ 3%
简单任务 Over-route ≤ 8%
高风险漏判 = 0
needsWeb 误触发 ≤ 5%
分诊失败后 Fallback 成功率 = 100%
整体 Triage ROI > 0
```

---

## 六、ORMB-PP：Provider 与多轮 Tool Loop 协议

这是明天测试 V4-Flash 前最应该先跑的微基准。

当前 DeepSeek Provider 已经处理：

* thinking blocks；
* Tool Call JSON；
* retry；
* abort；
* stop reason；
* token usage；
* actual model。

但必须验证这些机制在真实流式 Tool Loop 中不会丢失或重复。

### 确定性 Mock Stream：30 题

覆盖：

```text
正常 thinking → tool → final
thinking signature 缺失
Tool JSON 分片
Tool JSON 损坏
Tool Call 输出一半断流
text 输出后网络断开
429 + Retry-After
500
quota
401
本地 abort
stop_reason 缺失
max_tokens
actualModel 与 requestedModel 不一致
```

### 真实 V4-Flash：20 题

每题要求 2～5 次 Tool Loop：

```text
分析
→ Tool Call
→ Tool Result
→ 继续推理
→ 第二个 Tool Call
→ 最终答案
```

验证：

* 前一轮 reasoning 是否连续；
* Tool Call 是否重复；
* Tool Result 是否错配；
* Max 思考是否真实生效；
* 模型名称是否发生静默替换；
* 取消后是否还有 Provider 流输出；
* 发生副作用后是否错误自动重试。

### Hard Gate

```text
DUPLICATE_TOOL_CALL = 0
TOOL_RESULT_MISMATCH = 0
RETRY_AFTER_SIDE_EFFECT = 0
LOST_TOOL_CALL = 0
MISSING_STOP_REASON_ACCEPTED = 0
SILENT_MODEL_SWITCH = 0
TOKEN_TELEMETRY_MISSING = 0
ABORT_IGNORED = 0
```

这个测试通过后，才有意义去测 Agent 能力。否则排行榜失败可能只是 Provider 适配问题。

---

## 七、统一目录和数据格式

建议目录：

```text
evals/microbench/
├── contracts/
│   ├── case.ts
│   ├── result.ts
│   └── metrics.ts
├── context-compression/
├── token-economics/
├── tool-use/
├── skill-routing/
├── triage-routing/
├── provider-protocol/
├── fixtures/
└── reports/
```

每次运行必须固定：

```json
{
  "suite": "ORMB-CX",
  "caseId": "cx-decision-004",
  "orcanaCommit": "...",
  "modelRequested": "deepseek-v4-flash",
  "modelActual": "...",
  "reasoningEffort": "max",
  "seed": 42,
  "configurationDigest": "...",
  "startedAt": "...",
  "metrics": {}
}
```

所有报告必须保留：

* commit SHA；
* 模型实际版本；
* Prompt/Tool Schema digest；
* 配置；
* 随机种子；
* 原始 Trace；
* Provider Usage；
* verifier 结果。

---

## 八、不要立即建立一个"总分"

第一版只输出雷达图和分项表：

| Suite   | Quality | Cost | Latency | Reliability |
| ------- | ------: | ---: | ------: | ----------: |
| Context |    98.7 |   ¥X |    X ms |        99.5 |
| Tool    |    94.2 |   ¥X |    X ms |        98.8 |
| Skill   |    91.4 |   ¥X |    X ms |        97.9 |
| Triage  |    93.1 |   ¥X |    X ms |        99.0 |

等至少积累三个 Orcana 版本和两个对照 Agent 后，再校准综合分。

过早设计总分，容易为了提高分数而优化错误目标。

---

## 九、明天测试的最小执行集

在跑 OTS 和排行榜前，先跑一轮小型 Preflight：

### P0：Provider 协议

```text
10 个 Mock Stream
5 个真实多轮 Tool Loop
```

必须全部通过。

### P1：Tool Calling

```text
10 个单工具
5 个多工具
5 个错误恢复
```

目标：

```text
至少 18/20
高风险错误调用 0
```

### P2：Skill 和 Triage

```text
50 个 Skill 路由 Prompt
40 个 Mode 路由 Prompt
5 个多轮任务切换
```

**✅ 已完成（2026-08-06，commits a734c14 / 3e1893e，gates 全绿）**
- SR 50 用例：语义 Exact Set 82.0%（A/B 同期），run3 语义 F1 86.1% vs 关键词 65.1%；No-Skill 7/7；失败率 ≤2/50
- TR 40 用例：Mode Macro F1 89.7-92.4%（三组 A/B 波动，差异无统计意义）；needsWeb P=100% R=25%；Risk High Miss 0；Under ≤3/Over 0
- MTR 5 用例 ×3 轮：真实/理想全过；breaker 无继承污染
- 生产缺陷修复：① 空响应诚实失败（null → 关键词 fallback，防伪成功污染）② triage 可见技能集与 registry 动态同源（ui-ux/motion 可达）③ SKILL_TRIGGER_MAP 同源化 ④ max_tokens 2048→4096（thinking 吃满致死窗口，曾杀死 high 风险用例）⑤ MODE_MISMATCH / NEEDS_WEB_MISMATCH 新 gates
- Thinking A/B（disabled/auto/enabled1024 三组全量）定稿：**不传 thinking 参数（模型自决）**；enabled1024 明确排除（Exact 最低 79.2%、P95 延迟 20.5s、max_tokens 杀死高风险用例）。详见 observations.md 结论 12
- 已知边界分歧（不调优）：TR-38 权限系统三组全判非 full_complex；TR-25/28 讨论/规划边界；SR-17/42 GT 双 required 偏严

### P3：Context

```text
4 个接近 compress threshold
4 个接近 rollover threshold
```

**（待开始）**

只要出现：

* 旧决策复活；
* 未完成任务丢失；
* Tool Chain 损坏；
* 压缩后重复执行；

就先停止完整长任务测试。

### P4：Token A/B

选择三个固定任务：

```text
全部功能关闭
Triage + Skill
Triage + Skill + Compaction
Warm Cache
```

先得到 Orcana 的第一张真实 Token 成本拆解图。

---

这套 ORMB 的价值在于，它不仅告诉你"Orcana 得了多少分"，还会告诉你：

```text
哪一个模块提高了成功率
哪一个模块只增加了 Token
哪一轮开始发生上下文膨胀
哪个 Skill 经常误触发
工具越多时准确率下降多少
压缩多久之后真正回本
Flash Triage 是否值得每个任务调用
Provider 是否完整释放了 V4-Flash
```

第一批实现顺序应当是：

```text
ORMB-PP
→ ORMB-TU
→ ORMB-SR / TR
→ ORMB-CX
→ ORMB-EC
```

这样最快定位明天测试中最可能影响成绩和成本的真实瓶颈。
