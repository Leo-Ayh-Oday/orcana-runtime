# DeepSeek Orcana

DeepSeek Orcana is a Bun + TypeScript + Ink terminal coding agent. It is designed for local codebase workflows: reading code, editing files, calling tools, running verification commands, and reducing the risk of broken edits or false completion through layered runtime constraints.

Orcana is not designed as a free-form chatbot wrapped around shell access. It is a constraint-first coding agent runtime: the agent loop, tool layer, permission gates, context budget, verification checks, and recovery paths are treated as first-class runtime components.

## Current Position

Orcana is currently a single-agent terminal coding runtime powered by DeepSeek’s Anthropic-compatible API by default. It is suitable for:

* Understanding and modifying TypeScript / JavaScript projects
* Multi-round coding tasks with verification
* Local tool-based development workflows
* Researching coding-agent runtime design, tool governance, context management, and verification loops

It should not yet be described as a fully mature Claude Code equivalent. The repository already contains a strong agent-runtime foundation, but several capabilities are still partial or planned, including full MCP resources/prompts, full hook lifecycle events, IDE integration, checkpoint/rewind UX, and multi-agent execution.

## Quick Start

### Requirements

* Bun >= 1.3.0
* Node.js >= 18
* DeepSeek API key

### Install

```bash
npm install -g deepseek-orcana
```

Available commands:

```bash
orcana
deepseek-orcana
deepseek-code
deepseek
```

### Configure

```bash
export DEEPSEEK_API_KEY="sk-your-key-here"
```

Or copy the example environment file:

```bash
cp .env.example .env
```

### Use

```bash
orcana
orcana "explain this codebase"
orcana --cli
orcana list
orcana last
```

## Core Capabilities

* Agent Loop: multi-round execution, tool calls, context budget, verification, and completion control
* Tool Layer: file, search, shell, git, MCP, LSP, TypeScript, WebFetch, and transaction tools
* Permission Gate: category-based and project-level control over risky tool calls
* Ripple Engine: TypeScript-aware change-impact analysis and cascade-risk detection
* Provider Layer: DeepSeek by default, with Anthropic / OpenAI / multi-provider extension points
* Context System: context budgeting, caching, compaction, and task-relevant context organization
* Sandbox: Windows Job Object + PathGuard; degraded sandbox mode on macOS/Linux
* TUI: Ink-based terminal user interface

## Documentation

* [Getting Started](docs/en/getting-started.md)
* [Configuration](docs/en/configuration.md)
* [CLI Reference](docs/en/cli-reference.md)
* [Architecture Overview](docs/en/architecture/overview.md)
* [Agent Loop](docs/en/architecture/agent-loop.md)
* [Tool Layer](docs/en/architecture/tool-layer.md)
* [Ripple Engine](docs/en/architecture/ripple-engine.md)
* [Sandbox and Permissions](docs/en/architecture/sandbox-and-permissions.md)
* [Testing](docs/en/development/testing.md)
* [Security](docs/en/security.md)
* [Roadmap](docs/en/roadmap.md)

## Project Status

Orcana is currently in the 0.3.x stage. Stable, partial, and planned capabilities are explicitly marked in the architecture documentation. Treat the status table as the source of truth.

## License

MIT
