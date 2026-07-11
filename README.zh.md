# DeepSeek Orcana

<p align="center">
  <strong>不允许交付烂代码的编码智能体。</strong><br>
  约束优先运行时——每次写入检查下游影响，每次完成交付需要证据支撑。
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/deepseek-orcana"><img src="https://img.shields.io/npm/v/deepseek-orcana" alt="npm"></a>
  <a href="https://github.com/Leo-Ayh-Oday/deepseek-orcana"><img src="https://img.shields.io/github/stars/Leo-Ayh-Oday/deepseek-orcana?style=flat" alt="stars"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="license"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/runtime-Node.js-339933" alt="Node.js"></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/dev-Bun-%23f9f1e4" alt="Bun"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/lang-TypeScript-%233178c6" alt="TypeScript"></a>
</p>

<p align="center">
  <a href="./README.md">English</a>
</p>

---

## 安装

普通用户只需要 Node.js 20+ 和 npm。Bun 只在参与开发时需要。

```bash
npm install -g deepseek-orcana
```

配置密钥：

```bash
# macOS / Linux / Git Bash
export DEEPSEEK_API_KEY="sk-your-key-here"

# Windows PowerShell
$env:DEEPSEEK_API_KEY="sk-your-key-here"

# Windows CMD
set DEEPSEEK_API_KEY=sk-your-key-here
```

```bash
orcana                          # 交互式 TUI
orcana "修复失败的测试"          # 单次任务
orcana list                     # 历史会话
```

可用命令：`orcana`、`deepseek-orcana`、`deepseek-code`、`deepseek`。

---

## 工作机制

Orcana 不会对所有任务一视同仁。一个简单问题和一次复杂重构走的是完全不同的路径：

```
你问："这个文件是干什么的？"
  ──► 读文件 ──► 回答
       ↑
    权限门（风险 0 级 — 自动放行）
    只过 ~3 道门控。不写文件，不触发涟漪，不需要证据。

你说："帮我加个退出登录按钮"
  ──► 读文件 ──► 追踪调用方 ──► 写代码 ──► typecheck ──► 跑测试 ──► 验证 ──► 交付
       ↑            ↑              ↑           ↑             ↑          ↑
    权限门       涟漪引擎       沙箱守卫    证据账本      Flash     完成门控
                                                         Judge
    过 ~15 道门控。每次写入检查影响范围；完成交付要有证据。
```

**门控按风险自动匹配。** 只读任务快速通过。代码变更逐步加码——写入检查、涟漪分析、证据收集、独立验证。卡在循环里？溢出门控在连续 5 次拦截后硬停，请求人工介入。

这就是"约束优先"的意思——不是每步都慢，而是运行时知道什么时候该松、什么时候该严。

→ [ARCHITECTURE.md](./ARCHITECTURE.md) 有完整 28-gate 回路解剖。

---

## 核心能力

**Ripple Engine（涟漪引擎）** — 每次写入文件前，Orcana 追问：*谁在调用它？* 通过 7 层追踪 TypeScript 依赖链，从 API 差异到语义引用，在所有受影响调用方处理完之前阻断写入。212 个测试。→ [docs/ripple-engine.md](./docs/ripple-engine.md)

**Evidence Ledger（证据账本）** — 完成不是一个声称，是一份记录。Typecheck 过了？测试绿了？构建成功了？账本记录每项验证结果，并与最终输出交叉比对。如果模型说"测试全过"但账本显示根本没跑，Truthfulness Gate 直接拦截。

**Flash Judge（独立法官）** — 用更便宜的独立模型重新评估完成声明。主模型自信宣布完成但法官判定 NOT_SATISFIED？任务继续。每任务最多 3 次评估即熔断——不会沉默接受未验证的交付。

> **沙箱说明**：macOS/Linux 运行在降级模式（仅环境过滤 + 超时 + 事后审计）。仅 Windows 有内核级 Job Object 隔离。平台差异详见 [SECURITY.md](./SECURITY.md)。

---

## 已知限制

真实取舍，不隐藏：

- **Thinking Compaction** 每会话仅触发一次（上下文 40% 时）。极长任务下，上下文仍会涨到 60% Budget Gate 阻断，中间没有第二次压缩。
- **Flash Judge** 每任务最多 3 次评估即熔断。仍为 NOT_SATISFIED 则会话阻断——不会沉默接受坏结果。
- **macOS/Linux 沙箱** 仅为环境过滤 + 超时。无内核级隔离。生产环境建议放在容器里跑。
- **双配置路径**：`settings.json` 的 `loop.maxSteps` 优先于 `DEEPSEEK_MAX_ROUNDS` 环境变量。同时设置时 JSON 值生效。

---

## 项目状态

**v0.3.x** — 单 Agent 运行时骨架完整。部分能力还在打磨，不虚标。

| 状态 | 含义 |
|------|------|
| 🟢 Stable | 已接入主流程，日常任务可靠 |
| 🟡 Partial | 已实现但有限制——平台差异、交互糙、覆盖窄 |
| 🔵 Planned | 路线图上，还没做 |

→ [docs/v1.0-roadmap.md](./docs/v1.0-roadmap.md) — 10 Phase 到 v1.0。

---

## 卸载

```bash
npm uninstall -g deepseek-orcana
```

---

## 文档导航

| 文档 | 你会了解到 |
|------|-----------|
| [docs/design-philosophy.md](./docs/design-philosophy.md) | 为什么约束优先——从工具循环到证据账本 |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | 完整 28-gate 回路、DeepSeek V4 机制 |
| [docs/v1.0-roadmap.md](./docs/v1.0-roadmap.md) | 10 Phase 路线图、P0/P1/P2 优先级 |
| [docs/ripple-engine.md](./docs/ripple-engine.md) | 7 层变更影响分析深度解析 |
| [docs/gate-scenario-matrix.md](./docs/gate-scenario-matrix.md) | 每个 gate、每个场景、验证行为 |
| [docs/model-provider-runtime.md](./docs/model-provider-runtime.md) | 模型配置、中转站兼容、持久化与 provider 故障排查 |
| [docs/skill-template/](./docs/skill-template/) | 黄金标准 Skill 模板——面向人类、AI、Orcana Runtime |
| [SECURITY.md](./SECURITY.md) | 沙箱能力、漏洞报告 |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | 环境搭建、代码规范、PR 流程 |

## 开发

```bash
bun install
bun run typecheck    # tsc --noEmit
bun test             # 运行测试
bun run build        # tsc → dist/
```

## 基于

| 项目 | 角色 |
|------|------|
| [OpenCode](https://github.com/anomalyco/opencode) (MIT) | 架构基础——MCP bridge、配置系统、TUI 模式、Agent Loop |
| [CodeGraph](https://github.com/colbymchenry/codegraph) (MIT) | MCP 代码智能——符号搜索、引用追踪 |
| [Reasonix](https://github.com/esengine/reasonix) (MIT) | 缓存优先上下文压缩——分层阈值、冻结稳定前缀 |

[ACKNOWLEDGMENTS.md](./ACKNOWLEDGMENTS.md) · [LICENSE](./LICENSE) (MIT)
