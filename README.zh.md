# DeepSeek Orcana

<p align="center">
  <strong>不允许交付烂代码的编码智能体。</strong><br>
  28 道安全门控按生命周期自动匹配 · 7 层变更影响分析 · 没证据不能 claim done
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/deepseek-orcana"><img src="https://img.shields.io/npm/v/deepseek-orcana" alt="npm"></a>
  <a href="https://github.com/Leo-Ayh-Oday/deepseek-orcana"><img src="https://img.shields.io/github/stars/Leo-Ayh-Oday/deepseek-orcana?style=flat" alt="stars"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="license"></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/runtime-Bun-%23f9f1e4" alt="Bun"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/lang-TypeScript-%233178c6" alt="TypeScript"></a>
</p>

<p align="center">
  <a href="./README.md">English</a>
</p>

---

## Orcana 是什么？

Orcana 是一个**约束优先的终端编码智能体**。它能读代码、写代码、推理架构——但和那些"把大模型接到 shell 上"的工具不同，Orcana 的每一次行动都穿过独立安全门控，每一次编辑都检查下游影响，完成交付需要可验证的证据。

```
你说："帮我加个退出登录按钮"
Orcana：读文件 → 追踪调用方 → 写代码 → 跑 typecheck → 跑测试 → Flash Judge 验证 → 交付
         ↑            ↑           ↑          ↑            ↑              ↑
      权限门       涟漪引擎    沙箱守卫    证据账本     独立法官       完成门控
```

> **Orcana** = Orca（虎鲸）+ Arcana（奥术）+ NA（Native Agent）。像虎鲸穿行深海——感知暗流，把复杂工程变成可执行结果。

## 安装

```bash
npm install -g deepseek-orcana
```

配置 API Key：

**macOS / Linux / Git Bash**
```bash
export DEEPSEEK_API_KEY="sk-your-key-here"
```

**Windows PowerShell**
```powershell
$env:DEEPSEEK_API_KEY="sk-your-key-here"
```

**Windows CMD**
```cmd
set DEEPSEEK_API_KEY=sk-your-key-here
```

然后启动：

```bash
orcana
```

可用命令：`orcana`、`deepseek-orcana`、`deepseek-code`、`deepseek`。

```bash
orcana "重构认证模块"        # 单次任务
orcana --cli                 # 经典 CLI 模式
orcana list                  # 查看历史会话
orcana last                  # 恢复最近会话
```

## 为什么选 Orcana

多数 coding agent 只有 3-5 个防护。Orcana 有 **28 道独立安全机制**——按生命周期分布在五个阶段。不信任任何单一机制。

| 时机 | 机制 | 防止什么 |
|------|------|---------|
| **模型开口前** | Context Budget Gate | 静默超出上下文（524K WARN / 629K BLOCK） |
| | Flash Triage | 任务分类错误（1 次调用替代 4 个关键词分类器） |
| | Thinking Escalation | 固执重试——≥3 错误自动升级到 32K max thinking |
| **工具执行前** | Permission Gate | 越权操作——按类别 + 项目级控制风险调用 |
| | Ripple Block Gate | 写崩调用方——所有受影响调用点处理完才放行 |
| | ContextReadiness Gate | 没读就改——项目上下文没获取够就禁止写入 |
| | Rate Limiter | 工具滥刷——每轮每类有上限（shell=5, file=10, network=3） |
| | Mode Contract | 角色越界——planner 不能写代码，reviewer 不能执行 |
| **工具执行后** | Error Tracker | 无脑重试——重复 2 次触发强制搜索学习，4 次承认失败 |
| | Parallel Readonly Execution | 信息收集慢——同轮所有只读调用通过 `Promise.all` 并发执行 |
| | Shell Side-Effect Guard | 危险命令——18 种模式检测递归删除、强制推送、系统变更 |
| | Write Guard | 未读即改——strict 模式禁止编辑未曾读取的文件 |
| | Journal Veto | 铁律违规——元 Agent 一票否决写操作 |
| **宣称"完成"前** | Ripple Exit Gate | 级联未解决——涟漪义务未清不能结束 |
| | Task Tracker Gate | 任务未完成——清单项没勾完就阻止 |
| | Quality Gate | 低质量交付——置信度不足时阻止完成 |
| | Flash Judge | 虚假完成——独立 Flash 模型验证声称的完成 |
| | Evidence Gate | 无证据声称——没跑过 typecheck/test/build 就不能 `canClaimDone()` |
| | Truthfulness Gate | 验证撒谎——交叉检查最终文本和证据账本 |
| **紧急** | Gate Overflow | 无限循环——3 次拦截→策略提示，5 次→硬 BLOCKED |

门控按生命周期自动匹配，不是每轮全量触发：~7 道每轮必过，其余按阶段目标激活（流恢复 1、完成判定 6、工具执行 7、周期维护 7）。

→ [ARCHITECTURE.md](./ARCHITECTURE.md) 有完整 28-gate 回路解剖和 DeepSeek V4 机制深潜。

> **沙箱说明**：macOS/Linux 上沙箱运行在降级模式——PathGuard 是事后审计（检测+记录），不是实时拦截。只有 Windows 有内核级 Job Object 隔离。README 表格描述的是*设计意图*；平台差异详见 [SECURITY.md](./SECURITY.md)。

## 已知限制

真实取舍，不隐藏：

- **Thinking Compaction** 每会话只触发一次（40% 上下文时）。在极长任务上，上下文仍会增长到 60% Budget Gate 阻断，中间没有第二次 compaction。
- **Flash Judge** 每任务最多 3 次评估即熔断。如果 3 次后仍是 NOT_SATISFIED，会话阻断——不会沉默接受无验证的完成。
- **双配置路径**：`settings.json` 的 `loop.maxSteps` 优先于 `DEEPSEEK_MAX_ROUNDS` 环境变量。同时设置时 JSON 值生效。

## Ripple Engine 2.0 — 代码变更影响分析

**每次文件写入前，Orcana 都会问："谁在调用它？"** Ripple Engine 通过 7 层追踪 TypeScript 依赖——从 API 差异到语义引用解析到义务门控——在所有受影响调用方更新完之前阻断写入。

```
API 变更 ──► L1 Diff（8 种变更类型）──► L2 TypeChecker.findReferences ──► L3 用法分类（14 种）
                                                │
                                                ▼
                                    L4 测试发现 ──► L5 义务门控
                                                │
                                    L7 AstGrep（补充）
                                                │
                                                ▼
                                        allow / warn / block
```

212 tests。自评 8.5/10。→ [docs/ripple-engine.md](docs/ripple-engine.md)

## 项目状态

**v0.3.x** — 单 Agent 运行时骨架已完整，部分能力还在打磨。不虚标，不画饼。

| 状态 | 含义 |
|------|------|
| 🟢 Stable | 已接入主流程，日常任务可靠 |
| 🟡 Partial | 已实现但有限制——平台差异、交互糙、或覆盖窄 |
| 🔵 Planned | 在路线图上，还没做 |

详见 [docs/v1.0-roadmap.md](./docs/v1.0-roadmap.md)——10 Phase 路线图到 v1.0。

## 卸载

```bash
npm uninstall -g deepseek-orcana
```

## 文档导航

**刚来？** 先读设计哲学，再看架构。

| 文档 | 你会了解到 |
|------|-----------|
| [docs/design-philosophy.md](./docs/design-philosophy.md) | 为什么约束优先——从工具循环到证据账本 |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | 完整 28-gate 回路、DeepSeek V4 机制、反循环模式 |
| [docs/v1.0-roadmap.md](./docs/v1.0-roadmap.md) | 10 Phase 路线图、P0/P1/P2 优先级 |
| [docs/ripple-engine.md](./docs/ripple-engine.md) | 7 层变更影响分析深度解析 |
| [docs/gate-scenario-matrix.md](./docs/gate-scenario-matrix.md) | 每个 gate、每个场景、验证行为 |
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
