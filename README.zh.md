# DeepSeek Orcana

> Constraint-first DeepSeek coding agent runtime for terminal workflows.

DeepSeek Orcana 是一个面向本地代码库的终端编码智能体。它基于 **Bun + TypeScript + Ink** 构建，默认使用 DeepSeek 的 Anthropic-compatible API，并围绕工具治理、权限控制、代码影响分析、沙箱、记忆、MCP 和验证闭环构建了一套 coding agent runtime。

Orcana 的目标不是简单地把大模型接到 shell 上，而是让智能体在每一轮执行中都经过约束、审计和验证，从而更难写坏代码、更难误判完成、更容易从失败中恢复。

<p align="center">
  <strong>DeepSeek Native</strong> ·
  <strong>Terminal Coding Agent</strong> ·
  <strong>Tool Governance</strong> ·
  <strong>MCP</strong> ·
  <strong>Ripple Analysis</strong> ·
  <strong>Verification Loop</strong>
</p>

## 为什么值得关注？

Orcana 聚焦的是 Claude Code / Codex / Cursor Agent 这类编码智能体背后的核心问题：
**当模型拥有文件、终端、搜索、Git、MCP 等工具时，怎样让它可靠地完成真实工程任务？**

因此 Orcana 把重点放在几个底层能力上：

* **Constraint-first Agent Loop**：多层门控约束每一轮模型行动，避免盲目循环和过早完成。
* **Tool Governance**：工具注册、权限分类、确认机制、只读工具、并发安全、流式执行与错误处理。
* **Ripple Engine**：TypeScript-aware 代码变更影响分析，追踪 API 变更、调用方、测试与验证义务。
* **Permission & Sandbox**：路径守卫、环境变量白名单、命令风险控制、Windows Job Object 沙箱。
* **Verification Loop**：通过测试、类型检查、Flash Judge 和证据账本降低“口头完成”的风险。
* **Memory & Context System**：长上下文预算、压缩、记忆回召、跨会话经验沉淀。
* **MCP Ready**：支持 MCP 工具桥接，为外部工具、代码图谱和项目上下文扩展预留接口。
* **Research-friendly Runtime**：适合研究 coding agent 的工具层、规划层、上下文层和自我修复机制。

## 当前状态

Orcana 仍是一个快速演进中的开源项目。部分能力已经可用，部分能力仍处于 partial 或 planned 状态。README 只展示核心方向；具体实现状态请以 `ARCHITECTURE.md` 和源码为准。

## Quick Start

```bash
npm install -g deepseek-orcana
```

```bash
export DEEPSEEK_API_KEY="sk-your-key-here"
orcana
```

可用命令：

```bash
orcana
orcana "explain this codebase"
orcana --cli
orcana list
orcana last
```
当前状态

DeepSeek Orcana 目前处于早期快速演进阶段，定位是一个 constraint-first terminal coding agent runtime，而不是普通的命令行聊天工具。项目已经具备较完整的单智能体运行时骨架，包括 Agent Loop、工具层、权限控制、Ripple 代码影响分析、上下文预算、记忆系统、沙箱、TUI 和验证闭环。

为了避免把 planned 能力误写成已完成能力，Orcana 使用以下状态标记：

状态	含义
Stable	已接入主流程，可在常规任务中使用
Partial	已有实现，但仍存在边界条件、平台限制或体验缺口
Experimental	可用于研究和验证，但接口或行为可能变化
Planned	路线图能力，尚未作为稳定功能提供
已具备的核心能力
模块	当前状态	说明
Agent Loop	Stable	多轮执行、工具调用、上下文预算、完成度判断和失败恢复
Tool Registry	Stable	文件、搜索、Shell、Git、LSP、TypeScript、WebFetch、MCP 等工具注册与调用
Permission Gate	Stable	按工具类别控制 safe / file / network / shell / git 等风险调用
Ripple Engine	Stable / Experimental	TypeScript-aware 变更影响分析，用于追踪 API 变更、调用方和验证义务
Verification Loop	Stable / Partial	结合测试、typecheck、Flash Judge 和证据记录降低“口头完成”风险
Memory System	Partial	支持压缩、召回和跨会话经验沉淀，仍在演进中
MCP Bridge	Partial	当前重点支持 MCP tools，resources / prompts / elicitation 等能力仍在规划中
Sandbox	Partial	Windows Job Object + PathGuard 已接入；macOS / Linux 沙箱仍为降级模式
TUI	Partial	基于 Ink 的终端界面可用，但长输入、滚动、计划审批、证据回放等体验仍需增强
Multi-Agent	Planned	当前主线仍是高约束单 Agent，多 Agent 会在单 Agent runtime 足够稳定后再推进
当前阶段的设计重点

Orcana 当前最重要的目标不是堆更多工具，而是把单 Agent 做到更可靠：

更强的工具治理和风险评估
更可靠的 patch / diff / rollback 工作流
更清晰的验证证据链
更强的上下文预算和压缩策略
更可观测的 agent 执行轨迹
更适合真实项目的 TUI 交互体验
未来发展路线

Orcana 的长期目标是成为一个 DeepSeek-native 的本地编码智能体运行时，在终端中提供接近 Claude Code / Codex / Cursor Agent 的真实工程任务能力，同时保持开放、可研究、可扩展。

核心原则：

先可靠，再自主。
先单 Agent 闭环，再多 Agent 协作。
先工具治理，再工具数量。
先验证证据，再模型自述。
先真实代码能力，再生态包装。
