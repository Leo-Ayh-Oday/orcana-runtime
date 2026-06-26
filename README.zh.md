# DeepSeek Orcana

<p align="center"><strong>基于 Bun 的终端编码智能体，约束优先架构，DeepSeek 驱动。</strong></p>

<p align="center">
  中文 | <a href="./README.md">English</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/deepseek-orcana"><img src="https://img.shields.io/npm/v/deepseek-orcana" alt="npm 版本"></a>
  <a href="https://www.npmjs.com/package/deepseek-orcana"><img src="https://img.shields.io/npm/dw/deepseek-orcana" alt="npm 周下载量"></a>
  <a href="https://github.com/Leo-Ayh-Oday/deepseek-orcana"><img src="https://img.shields.io/github/stars/Leo-Ayh-Oday/deepseek-orcana?style=flat" alt="GitHub stars"></a>
  <a href="https://github.com/Leo-Ayh-Oday/deepseek-orcana/issues"><img src="https://img.shields.io/github/issues/Leo-Ayh-Oday/deepseek-orcana" alt="GitHub issues"></a>
  <br>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="协议: MIT"></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/runtime-Bun-f9f1e4" alt="运行时: Bun"></a>
  <a href="./CONTRIBUTING.zh.md"><img src="https://img.shields.io/badge/贡献-欢迎-brightgreen.svg" alt="欢迎贡献"></a>
</p>

---

DeepSeek Orcana 是一个单智能体终端编程助手。它能读、写、推理代码——通过**约束优先设计**，让 AI 更难写出坏代码。

基于 Bun + TypeScript + Ink（React TUI），默认使用 DeepSeek 的 Anthropic 兼容 API。

## 为什么叫 Orcana？

Orcana = Orca + Arcana + NA,Orca是虎鲸的意思,而Arcana代表深层的知识,如果你不仔细看,仅仅只是浮于表面,你就无法寻得真理,NA就是Native Agent,原生智能体,寓意"像虎鲸一样穿行代码深海，理解系统暗流，并把复杂工程变成可执行结果。"。

## 亮点

**每轮 26 道安全机制。** 每次 agent 循环都穿过一系列独立门控。不信任任何单一机制。基于 **DeepSeek V4 独有能力**——思考令牌、Flash 子处理、FIM、1M 上下文、前缀缓存——其他模型无法组合提供。

| 层次 | 机制 | 源码 |
|------|------|------|
| **思考** | 推理链捕获 → 持久化、压缩、跨会话回召（V4 专有） | `deepseek.ts:145-184` |
| **Flash 子处理** | 6 个独立 Flash 角色：Judge、Triage、Compaction、Recall、Distill、Plan-Judge | `flash-judge.ts`, `flash-triage.ts` |
| **FIM** | 填空编辑，通过 V4 `/beta/completions` 端点 | `provider/fim.ts` |
| **预算** | 1M 上下文窗口：524K 警告，629K 阻止 | `loop.ts:684` |
| **缓存** | 前缀自动缓存 → 冻结稳定前缀一次计算全会话命中 | `deepseek.ts:42`, `loop.ts:733` |
| **思考升级** | 错误级联（≥3）或大范围编辑（≥5）→ 自动升级到 32K max thinking | `router.ts:62-70` |
| **入口** | Flash Triage——一次 Flash 调用替代 4 个关键词分类器 | `agent/flash-triage.ts` |
| **安全** | 门控溢出：拦截 3 次→强制换策略，5 次→BLOCKED | `loop.ts:1562-1607` |
| **自学习** | 错误追踪器：重复 2 次→提示搜索解决方案，4 次→承认失败 | `loop.ts:96-123` |
| **验证** | Flash Judge——独立模型评估完成度（SATISFIED/NOT_SATISFIED/IMPOSSIBLE） | `agent/flash-judge.ts` |
| **证词** | 证词账本——追踪承诺 vs 交付，检测循环空头支票 | `flash-judge.ts:196-249` |
| **依赖** | Ripple 引擎 2.0 — 7 层 TS 感知级联检测，8.5/10 | [docs/ripple-engine.md](docs/ripple-engine.md) |
| **沙箱** | Job Object（kernel32）+ PathGuard + 环境变量白名单 + 超时 | `src/sandbox/` |
| **记忆** | CJK bigram+trigram 分词器，思考压实，知识协调 | `src/memory/` |

→ 详见 [ARCHITECTURE.md](./ARCHITECTURE.md)，包含完整 26 门循环解剖。详见 [docs/ripple-engine.md](docs/ripple-engine.md)，包含 7 层 Ripple 引擎 2.0 架构。

## 快速开始

### 环境要求
- **Bun** ≥ 1.3
- **Node.js** ≥ 18（npm shim 需要）
- **DeepSeek API Key**（[点此获取](https://platform.deepseek.com)）

### 安装

```bash
npm install -g deepseek-orcana
```

可用命令：`orcana`、`deepseek-orcana`、`deepseek-code`、`deepseek`。

> 注意：`deepseek-code` 在 npm 上已被占用。包名为 `deepseek-orcana`，推荐使用 `orcana` 命令。

### 配置

```bash
# 设置 API Key
export DEEPSEEK_API_KEY="sk-your-key-here"

# 或复制环境变量模板
cp .env.example .env   # 编辑 .env 填入你的 key
```

详见 [`.env.example`](./.env.example)。

### 使用

```bash
orcana                              # 启动 TUI
orcana "分析这个代码库"               # 一次性提问
orcana --cli                        # 经典 CLI 模式
orcana list                         # 列出所有会话
orcana last                         # 恢复上次会话
```

## 配置说明

Orcana 使用 `~/.deepseek-code/settings.json` 持久化配置。复制模板开始：

```bash
mkdir -p ~/.deepseek-code
cp settings.example.json ~/.deepseek-code/settings.json
```

### 配置文件

| 文件 | 位置 | 用途 |
|------|------|------|
| `settings.json` | `~/.deepseek-code/` | 提供商、TUI、记忆、沙箱、MCP |
| `mcp.json` | `~/.deepseek-code/` | MCP 服务器定义 |
| `permissions.json` | `~/.deepseek-code/` 或 `<项目>/.deepseek-code/` | 工具权限规则 |
| `.env` | 项目根目录 | API Key（切勿提交到 Git） |

## 架构

```
CLI/TUI (Ink React)
    │
    ▼
主循环控制器 (Loop Controller)
    ├─ 权限门 ──── 执行前拦截不安全调用
    ├─ Flash Judge ─ 每步完成度评估
    ├─ 状态机 ──── 强制阶段转换
    ├─ Ripple 引擎 ─ TypeScript 感知级联检测 (7 层, 8.5/10)
    ├─ 沙箱 ────── 路径守卫 + 进程隔离
    └─ 记忆 ────── SQLite 混合存储 + 压缩周期
```

### Ripple 引擎 2.0 — 变更影响分析

**防止写出坏代码。** 在任何文件写入之前，Ripple 引擎追踪变更如何传播到整个代码库，在所有受影响的调用方处理完之前阻止写入。

```
 旧代码 + 新代码
     │
     ▼
┌──────────────────────┐
│ L1  API 差异分析       │  8 种变更类型，预计算严重度
│     diffApiSurface    │  导出移除 · 签名变更 · 异步边界 · 类型变更 · 字段变更 …
└────────┬─────────────┘
     │
     ▼
┌──────────────────────┐
│ L2  语义引用（主路径）   │  TypeChecker.findReferences
│     findCallers       │  解析导入/导出，跟踪别名链
│ L7  AstGrep（补充）     │  每符号 6 种模式，file:line 去重
│     （文本扫描回退）     │  AST 遍历 + 语义验证
└────────┬─────────────┘
     │  RippleCaller[]（所有调用点）
     ▼
┌──────────────────────┐
│ L3  用法分类器          │  14 种用法 → 500+ 具体动作
│     classifyCallers   │  函数调用 · 方法调用 · extends · 解构 · JSX · 重导出 …
└────────┬─────────────┘
     │
     ▼
┌──────────────────────┐
│ L4  验证映射            │  测试发现（4 种约定）、覆盖率、严格度
│     buildVerifyMap    │  自动生成 typecheck + test 命令
└────────┬─────────────┘
     │
     ▼
┌──────────────────────┐
│ L5  义务门控            │  硬出口门：未豁免义务阻止完成
│     waive（需理由）      │  豁免需明确理由 — 无沉默放行
└────────┬─────────────┘
     │
     ▼
  RippleReport → 门控决策（允许 / 警告 / 阻止）
```

→ 详见 [docs/ripple-engine.md](docs/ripple-engine.md)——完整架构、7 层详解、212 测试覆盖图。

详见 [ARCHITECTURE.md](./ARCHITECTURE.md) —— 设计决策、约束哲学、"不重犯"知识库。

## 开发

```bash
bun install
bun run typecheck    # tsc --noEmit
bun run test         # 运行稳定测试套件
bun run build        # tsc → dist/
```

## 基于

| 项目 | 角色 |
|------|------|
| [OpenCode](https://github.com/anomalyco/opencode) (MIT) | 架构基础 — MCP 桥接、配置系统、TUI 模式、Agent 循环 |
| [CodeGraph](https://github.com/colbymchenry/codegraph) (MIT) | MCP 代码智能 — 符号搜索、引用查找、项目结构分析 |
| [Reasonix](https://github.com/esengine/reasonix) (MIT) | 缓存优先上下文压实 — 分层阈值、冻结前缀、微压缩 |

详见 [ACKNOWLEDGMENTS.md](./ACKNOWLEDGMENTS.md)。

## 协议

MIT — 详见 [LICENSE](./LICENSE)。

## 参与贡献

欢迎 PR！详见 [CONTRIBUTING.zh.md](./CONTRIBUTING.zh.md)。

## 安全

漏洞报告见 [SECURITY.md](./SECURITY.md)。
