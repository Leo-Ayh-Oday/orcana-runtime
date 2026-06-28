# 我做了一个 DeepSeek-native Coding Agent：从 Tool Loop 到 Evidence Ledger

一个真正能长期写代码的 Agent，不应该只是"模型 + 工具调用 + 文件编辑"。

过去一段时间，我一直在做一个终端 Coding Agent 项目：**DeepSeek Orcana**。它不是一个普通的聊天壳，也不是简单把 DeepSeek API 接到命令行里。我的目标是做一个 **DeepSeek-native、Constraint-first、Evidence-first 的终端编码智能体 runtime**。

简单说，Orcana 想解决的问题是：

> 当一个大模型被允许读取代码、修改文件、执行命令、运行测试，并在多轮任务里持续工作时，runtime 应该如何约束它，让它更可靠地完成真实工程任务？

这个问题比"让模型写代码"更难。

模型会写代码，但真实开发不是一次补全。真实开发包含需求理解、项目定位、任务拆解、工具选择、代码修改、验证反馈、失败修复、上下文管理、回滚和最终汇报。任何一个环节失控，都会出现常见的 Coding Agent 问题：

- 没搞清楚需求就开始改；
- grep 到一个关键词就盲目编辑；
- 改完没有验证，却说"完成了"；
- 测试失败后继续瞎修；
- 长任务上下文越来越脏；
- 代码修改无法回滚；
- 工具调用没有权限边界；
- 最终报告和真实执行记录不一致。

Orcana 的设计方向，就是把这些问题从"提示词建议"变成"运行时约束"。

---

## 1. 为什么我不想再做一个普通代码助手

很多早期 Coding Agent 的结构大概是：

```
User Prompt → LLM → Tool Call → Read / Edit / Shell → LLM Summary
```

这个结构能跑，但不够可靠。

因为模型的自然语言输出不等于工程事实。模型说"我已经完成"，不代表任务真的完成；模型说"测试通过"，不代表测试真的运行过；模型说"只改了一个小地方"，不代表影响面真的可控。

所以 Orcana 的核心思想不是让模型更自由，而是让模型在一个更强的 runtime 里工作：

```
User Prompt → Task Understanding → Planning Gate → MasterPlan / TaskPacket
  → Tool Loop → PatchTransaction → EvidenceLedger → Completion Gates → Final Report
```

这也是我给 Orcana 定的关键词：

> **Constraint-first coding agent runtime.**

它不是让模型想做什么就做什么，而是让模型在明确的任务、范围、证据和状态机里完成任务。

---

## 2. 为什么是 DeepSeek-native

Orcana 不是"换个 base_url 就叫 DeepSeek 支持"。

我更关心的是 DeepSeek 模型特性会怎样影响 Agent runtime 的设计。

DeepSeek 的几个能力对 Coding Agent 很关键：

1. **Thinking mode**：复杂任务可以使用更高推理强度。
2. **Tool-use reasoning transcript**：当 thinking mode 和 tool call 结合时，runtime 需要正确维护推理链和工具调用上下文。
3. **Context caching**：稳定的 prompt 前缀可以提高复用效率，降低长任务成本。
4. **FIM**：适合局部代码编辑，但必须被事务系统保护。
5. **Flash / Pro 分层**：便宜模型适合 triage、judge、distill，强模型适合 planning、coding、review。

这意味着一个 DeepSeek-native agent 不能只做一件事：

```
把所有上下文塞给模型 → 让模型自由调用工具
```

更合理的结构应该是：

```
Stable Prefix（system rules + project rules + stable skills + tool schema）
Dynamic Context（active task + current plan + evidence + recent tool results + current failures）
```

稳定部分应该尽量保持顺序和内容稳定，动态部分应该靠近当前任务。这样既有利于长任务上下文管理，也有利于 context cache 的命中。

这就是 Orcana 后面做 Context Epoch、stable prefix、plan state、task epoch、volatile tail 的原因。

---

## 3. 从用户输入到任务完成，Orcana 如何工作

```
User Input → Flash Triage → Skill Activation → Planning Gate → MasterPlan
  → TaskPacket → ModeContract → Model Round → ToolPolicy / Hooks / Sandbox
  → Tool Execution → PatchTransaction → EvidenceLedger → Completion Gates
  → Final Report / Repair / Replan
```

每个模块都有明确职责：

- **Flash Triage**：快速识别任务类型——简单问答、代码解释、局部修改、bug 修复，还是复杂开发任务。
- **Skill Activation**：匹配相关技能（debugging、architecture review、security review、self-critique 等）。
- **Planning Gate**：阻止模型在计划不足时直接进入执行。
- **MasterPlan**：把复杂任务拆成多个节点。
- **TaskPacket**：把计划节点变成可执行任务包（scope、done criteria、verification、risk）。
- **ModeContract**：限制当前阶段可以做什么——Planner 不能写文件，Reviewer 不能改代码，Reporter 不能执行 shell。
- **ToolPolicy / Hooks / Sandbox**：控制工具风险，避免危险命令、敏感文件读取、未读文件覆盖。
- **PatchTransaction**：让代码修改变成事务，而不是裸写文件。
- **EvidenceLedger**：记录真实验证证据。
- **Completion Gates**：最终回答前检查计划完成度、证据完整性、报告真实性。

五个模式有硬权限边界：**Planner** 只读规划、**Coder** 限定范围写入、**Reviewer** 只读审查、**Repair** 只修当前失败不扩 scope、**Reporter** 只输出报告不执行。模式切换由 MasterPlan 节点状态自动驱动，不是模型自己决定。

---

## 4. 为什么要 Planning Gate

Coding Agent 最常见的问题之一是：没有搞清楚任务就开始改。

有些任务很简单——解释一个函数、改一个 typo、补一个 import——不需要复杂计划。

但复杂任务不一样：修复 TUI 长文本输入卡顿、重构 tool execution policy、接入 PatchTransaction、修复跨文件 API 变化、修复测试失败但不知道根因。

这些任务如果没有计划，模型很容易做成"边看边改边猜"。

Orcana 的 Planning Gate 要求复杂任务必须先回答：目标是什么？范围是什么？有哪些假设和不确定点？有哪些风险？有哪些方案取舍？拆成哪些步骤？每一步如何验证？

这不是为了让模型写漂亮计划，而是为了防止它进入错误执行状态。

---

## 5. 为什么要 MasterPlan 和 TaskPacket

自然语言计划本身不够稳定。比如模型写：

```
1. 先检查输入组件
2. 修复滚动和长文本
3. 优化发送后的输入状态
4. 跑测试
```

这对人类能看懂，但对 runtime 来说还不够。runtime 需要知道：任务 ID、当前执行哪个节点、允许改哪些文件、完成标准、必须跑哪些验证、风险级别、上下文预算。

所以 Orcana 引入 TaskPacket——把"计划语言"变成"执行合约"：

```
TaskPacket { goal, scope, doneCriteria, verification, ripplePolicy, contextBudget }
```

Coder 不再拿着模糊计划自由发挥，而是消费一个明确的任务包。未来如果拆成多 agent，TaskPacket 也可以成为 Planner、Coder、Reviewer 之间的交接协议。但当前阶段，Orcana 坚持 single-agent first——先把单 Agent 的角色纪律和任务协议做清楚，再考虑拆真多 agent。

---

## 6. 为什么要 PatchTransaction 和 Ripple Engine

代码修改不能只是 `edit_file(path, old, new)`。真实项目里风险很多：文件可能被其他进程改过、模型可能改错范围、FIM 可能在错误位置补全、shell 命令可能产生额外副作用、多文件修改可能部分成功部分失败。

Orcana 的 PatchTransaction 把写入变成状态机：

```
read file → record baseHash → propose patch → check scope
  → check forbidden files → apply patch → record diff → run verification → commit / rollback
```

**Ripple Engine 2.0** 是变更影响分析引擎。在任何文件写入前，它会追踪变更如何传播——7 层：API Diff → 语义引用 → 用法分类 → 验证映射 → 义务门控。在所有受影响的调用方处理完之前，写入被阻止。目前 212 tests，评分 8.5/10。

---

## 7. 为什么要 EvidenceLedger

很多 Agent 的最终回答会出现这种情况："已完成修改，并通过测试。"但实际上没有运行测试、只运行了 typecheck、测试失败但模型忽略了、shell 命令报错但模型总结成成功。

Orcana 的原则是：**没有证据，就不能声称完成。**

EvidenceLedger 记录结构化证据（typecheck、test、build、manual inspection），每条包含：命令是什么、什么时候运行、是否通过、输出摘要、关联哪个任务、关联哪个 patch transaction。

最终 Completion Gate 检查的不是模型自述，而是 EvidenceLedger。这不是产品细节，这是 Agent 可信度的底线。

---

## 8. 为什么要 Completion Gates

Coding Agent 最危险的时刻不是它改代码的时候，而是它准备说"完成了"的时候。"完成"是一个状态声明，如果不被验证，就会污染用户判断。

Completion Gates 检查：计划是否合格、MasterPlan 是否完成、TaskTracker 是否完成、PatchTransaction 是否稳定、Evidence 是否满足要求、是否还有未解决风险、最终回答是否和证据一致。

不满足条件，agent 不能直接 final——要么继续执行，要么进入 repair，要么 blocked 并告诉用户需要什么。

---

## 9. 为什么要 Context Epoch

长任务里上下文会慢慢变脏——混入大量工具输出、失败日志、搜索结果、旧 patch、重复代码片段。

Orcana 的 Context Epoch 思路：上下文不应该无限增长，而应该分层。

```
Stable Prefix — system rules + tool schema + project constitution + stable skills
Plan State — MasterPlan + active node + decisions + risks（跨 epoch 保留）
Task Epoch — active TaskPacket + current patch + evidence summary + failure summary
Volatile Tail — recent tool output + raw logs + temporary search results
```

具体阈值：120K token 触发微压缩（单工具输出摘要化），220K 强制压缩，300K epoch 归档。Plan State 跨 epoch 不丢——MasterPlan、TaskPacket、DecisionRecord 始终保留。

---

## 10. TUI 和工具风险

Coding Agent 不是普通聊天机器人。长期任务需要看到：当前计划、当前阶段、正在运行的工具、修改了哪些文件、验证是否通过、哪个 gate 卡住了、是否可以回滚。

Orcana 选择做 TUI 作为 Agent runtime 的可观测窗口。展示 mode、MasterPlan 节点、TaskPacket、工具调用流、PatchTransaction 状态、EvidenceLedger 状态、Gate block 原因。

工具安全方面，按风险分五级：**Risk 0** 只读放行、**Risk 2** 文件写入做策略判定、**Risk 4-5**（git mutation、外部效应）必须用户确认且禁止 session allow。

---

## 11. 和 Claude Code 的关系

Claude Code 是成熟的终端 Agent 产品，拥有完整的生态、权限系统、hooks、skills、subagents、checkpoint。Orcana 走的是另一条路线：**DeepSeek-native、约束优先、单 agent 角色纪律先做实再拆多 agent**。两条路解决同一个问题，技术路线不同。

---

## 12. 当前不足

Orcana 还不是 production-ready。当前短板：

1. **HookSystem** 需要 lifecycle hooks（SessionStart、PreToolUse、PostToolUse、PostPatch、PostVerification、PreCompact、SessionEnd）
2. **Context Map Pipeline** 尚未完全落地——写代码前应先读文档、扫仓库结构、定位相关代码
3. **Memory OS** 需要 capsule 化，区分静态规则和动态经验，支持 active/stale/superseded/archived 状态
4. **Replay Harness** 需要升级到端到端 replay——在真实 fixture repo 上跑完整任务并检查 touched files、evidence、final decision
5. **TUI** 需要长输入、滚动、执行中继续输入、Plan Approval、Evidence Report
6. **Rewind** 需要产品化——支持只回滚代码、只回滚对话、两者一起回滚

这些是 Orcana 从 strong single v0.8 到 v1.0 的主线。

---

## 13. 为什么想把 Orcana 放进 DeepSeek Agent 生态

DeepSeek 官方生态里已经有面向 agent 和 coding assistant 工具的 integration guide。Orcana 如果只是另一个"支持 DeepSeek API 的工具"，没有太大意义。

我希望它贡献的是另一种视角：DeepSeek 模型进入真实 Coding Agent runtime 时，需要的不只是 API 接入，而是一整套任务理解、工具执行、证据验证、上下文管理和终端交互系统。

Orcana 的 runtime 设计考虑了 DeepSeek 的模型特性：thinking mode 的推理强度、tool-use 场景下的 transcript 管理、context cache 对稳定前缀的要求、FIM 在局部编辑中的价值和风险、Flash/Pro 分层调用的成本结构。

如果说模型是大脑，Coding Agent runtime 就是神经系统、手、眼睛、记忆、免疫系统和日志系统。

---

## 14. 下一步路线

优先把 strong single agent 做完整，再考虑多 agent：

1. HookSystem 2.0：修复 warning、writeGuard、CLI/TUI 统一 hooks
2. TaskPacket JSON/Zod：让任务包真正结构化
3. MasterPlan ↔ ModeContract：计划节点驱动五模式自动流转
4. Completion Orchestrator：统一 Evidence、Quality、Final Truthfulness
5. PatchTransaction Phase 2：apply-to-temp、verify、rollback
6. Unified Rewind：支持代码/对话/整体回滚
7. E2E Replay：真实 fixture repo 跑完整 agent loop
8. TUI：长输入、滚动、执行中输入、Plan Approval、Evidence Report
9. Context Map Pipeline：写代码前先建立上下文地图
10. Memory OS：长期记忆 capsule 化、按需召回

**路线：Strong Single First → Microagent for Locator/Verifier → T3R (Planner/Coder/Reviewer)**

计划规模：10 Phase / 32+ PR 组 / 20+ 条可验证验收标准。当前 v0.3.0 → v1.0 收口阶段。完整路线图见 [docs/v1.0-roadmap.md](./v1.0-roadmap.md)。

---

## 15. 结语

> Coding Agent 的核心不是"让模型写更多代码"，而是"让模型在工程约束里可靠地行动"。

模型会越来越强，但 runtime 仍然重要。因为真实工程任务永远需要：明确目标、理解上下文、控制修改范围、记录证据、处理失败、支持回滚、给用户可理解的状态反馈。

Orcana 还不是成熟产品，也不是 Claude Code 的替代品。它更像是一个 DeepSeek-native Coding Agent runtime 的实验：尝试把 planning、patch、evidence、context、hooks、TUI 这些东西放进同一个强单 agent 架构里。

如果你也在做 Coding Agent、DeepSeek integration、终端开发工具，或者对 agent runtime 感兴趣，欢迎来看这个项目。

- **GitHub**: https://github.com/Leo-Ayh-Oday/deepseek-orcana
- **npm**: https://www.npmjs.com/package/deepseek-orcana
- **架构文档**: https://github.com/Leo-Ayh-Oday/deepseek-orcana/blob/main/ARCHITECTURE.md
- **DeepSeek 官方生态 Guide PR**: https://github.com/deepseek-ai/awesome-deepseek-agent/pull/257
- **Demo**: https://v.douyin.com/CXaZ5l0vW_Q/
