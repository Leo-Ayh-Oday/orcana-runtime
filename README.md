# DeepSeek Orcana

DeepSeek Orcana 是一个基于 Bun + TypeScript + Ink 的终端编码智能体。它面向本地代码库工作流，能够读取代码、编辑文件、调用工具、运行验证命令，并通过多层约束机制降低智能体在长任务中写坏代码、误判完成或破坏仓库状态的风险。

Orcana 的设计重点不是“让模型自由发挥”，而是把编码智能体的执行过程拆成可约束、可观察、可验证、可恢复的运行时系统。

## 当前定位

Orcana 目前是一个单智能体 terminal coding agent runtime，默认使用 DeepSeek 的 Anthropic-compatible API。它适合用于：

* 理解和修改 TypeScript / JavaScript 项目
* 多轮代码编辑与验证
* 工具调用受控的本地开发任务
* 研究 coding agent 的工具层、约束层、上下文层和验证闭环

它暂时不应该被描述为“完全等同 Claude Code 的成熟产品”。当前仓库已经具备较完整的 agent runtime 骨架，但部分能力仍处于 partial 或 planned 状态，例如完整 MCP resources/prompts、完整 hooks 生命周期、IDE 集成、checkpoint/rewind 用户界面、多智能体系统等。

## 快速开始

### 环境要求

* Bun >= 1.3.0
* Node.js >= 18
* DeepSeek API Key

### 安装

```bash
npm install -g deepseek-orcana
```

安装后可使用以下命令：

```bash
orcana
deepseek-orcana
deepseek-code
deepseek
```

### 配置

```bash
export DEEPSEEK_API_KEY="sk-your-key-here"
```

也可以复制示例配置：

```bash
cp .env.example .env
```

### 使用

```bash
orcana
orcana "explain this codebase"
orcana --cli
orcana list
orcana last
```

## 核心能力

* Agent Loop：多轮执行、工具调用、上下文预算、验证与退出判断
* Tool Layer：文件、搜索、Shell、Git、MCP、LSP、TypeScript、WebFetch 等工具
* Permission Gate：按工具类别与项目规则控制风险调用
* Ripple Engine：TypeScript-aware 的变更影响分析与级联风险检测
* Provider Layer：DeepSeek 默认 provider，并保留 Anthropic / OpenAI / multi-provider 扩展
* Context System：上下文预算、缓存、压缩与任务相关信息组织
* Sandbox：Windows Job Object + PathGuard；macOS/Linux 当前为降级沙箱模式
* TUI：基于 Ink 的终端交互界面

## 文档导航

* [Getting Started](docs/zh/getting-started.md)
* [Configuration](docs/zh/configuration.md)
* [CLI Reference](docs/zh/cli-reference.md)
* [Architecture Overview](docs/zh/architecture/overview.md)
* [Agent Loop](docs/zh/architecture/agent-loop.md)
* [Tool Layer](docs/zh/architecture/tool-layer.md)
* [Ripple Engine](docs/zh/architecture/ripple-engine.md)
* [Sandbox and Permissions](docs/zh/architecture/sandbox-and-permissions.md)
* [Testing](docs/zh/development/testing.md)
* [Security](docs/zh/security.md)
* [Roadmap](docs/zh/roadmap.md)

## 项目状态

Orcana 当前处于 0.3.x 阶段。稳定能力、部分接入能力和尚未实现能力会在架构文档中明确标注。请以文档中的 status 表为准，不要把 planned 能力当作已完成能力使用。

## License

MIT
