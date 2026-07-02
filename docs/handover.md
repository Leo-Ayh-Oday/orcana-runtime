# deepseek-code 项目交接文档

> 版本 0.1.0 → 0.2.0 (3-Agent 架构迁移)
> 最后更新: 2025-06-09

## 1. 项目定位

**deepseek-code** 是一个终端 AI 编程助手，运行在 Windows/WSL 环境，基于 Bun + TypeScript。
目标：成为 "AI pair programmer"，提供从理解代码、编写代码到验证代码的完整闭环。

## 2. 当前架构概览

```
┌──────────────┐    ┌─────────────────┐    ┌──────────────────┐
│  src/ui/cli  │───▶│  src/agent/loop  │───▶│  src/provider/    │
│  (终端交互)   │    │  (单Agent循环)    │    │  deepseek.ts      │
└──────────────┘    └────────┬────────┘    │  (DeepSeek V4 API) │
                             │              └──────────────────┘
                             ▼
              ┌──────────────────────────────┐
              │  Tools (src/tools/)           │
              │  file | shell | git | search  │
              │  codegraph | mcp              │
              └──────────────────────────────┘
                             │
                             ▼
              ┌──────────────────────────────┐
              │  Ripple Engine (影响分析)      │
              │  + Hybrid Memory (混合记忆)    │
              │  + Context Kernel (上下文)     │
              └──────────────────────────────┘
```

## 3. 模块清单

| 模块 | 路径 | 状态 | 职责 |
|------|------|------|------|
| CLI | `src/ui/cli.ts` | ✅ 完成 | 交互式终端 UI，会话管理 |
| Agent Loop | `src/agent/loop.ts` | ✅ 完成 | 单Agent工具循环(≤30轮) |
| Router | `src/agent/router.ts` | ✅ 完成 | 思考模式路由(flash/pro) |
| Prompts | `src/agent/prompts.ts` | ✅ 完成 | 系统提示词 |
| Tool Disclosure | `src/agent/tool-disclosure.ts` | ✅ 完成 | 动态工具选择(省token) |
| Provider | `src/provider/deepseek.ts` | ✅ 完成 | Anthropic兼容API |
| Cache Tracker | `src/provider/cache-tracker.ts` | ✅ 完成 | 前缀缓存命中率 |
| FIM Editor | `src/provider/fim.ts` | ✅ 完成 | Fill-in-Middle 编辑 |
| Tools | `src/tools/*.ts` | ✅ 完成 | 工具注册和执行 |
| Repair | `src/tools/repair.ts` | ✅ 完成 | JSON修复(LLM输出纠错) |
| Context Kernel | `src/context/kernel.ts` | ✅ 完成 | 项目上下文哈希摘要 |
| Staged Context | `src/context/staged.ts` | ✅ 完成 | 分层上下文(冷/温/热) |
| Ripple | `src/ripple/*.ts` | ✅ 完成 | 修改影响分析 |
| Hybrid Memory | `src/memory/hybrid.ts` | ✅ 完成 | 项目/全局规则记忆 |
| Knowledge | `src/memory/knowledge.ts` | ✅ 完成 | 知识库(自学习) |
| Distiller | `src/memory/distiller.ts` | ✅ 完成 | 搜索结果提炼 |
| Thinking Store | `src/memory/thinking-store.ts` | ✅ 完成 | 思考链存储 |
| Session | `src/session/index.ts` | ✅ 完成 | 会话持久化(JSON) |
| Summarizer | `src/session/summarizer.ts` | ✅ 完成 | 历史会话压缩 |
| Hooks | `src/hooks/index.ts` | ✅ 完成 | 工具调用拦截 |

## 4. 当前瓶颈

**单Agent循环的核心局限：**

1. **一轮一判** — Planner/Coder/Reviewer 三个角色压缩在一个 for 循环里，缺乏角色分工
2. **无契约约束** — 计划只是自由文本，没有结构化 JSON Plan，Review 无法逐项打勾
3. **无置信度机制** — Agent 输出的东西没有评分，高估/低估无法区分
4. **无元仲裁** — 出错后只有重试，没有独立的 Meta-Agent 来决策

## 5. 即将到来的变更 (P1 — 3-Agent 架构)

**新增三个独立 Agent：**
- **Planner** — 只读分析，产出结构化 JSON Plan
- **Coder** — 按 Plan 执行修改，自验证
- **Inspector** — 对照 Plan Checklist 打勾审查

**新增 Meta-Agent：**
- 主持协商
- 置信度仲裁(<80% 上限)
- 最终裁定

**新增协议文件：**
- `docs/contract.md` — Agent 间接口契约
- `docs/P1-plan.md` — 实施计划

## 6. 运行与开发

```bash
# 全局安装
npm install -g deepseek-orcana

# 交互模式
orcana

# 单次提问
orcana "你的问题"

# 恢复会话
orcana last
orcana <session-id>

# 列出会话
orcana list

# 源码开发
bun install
bun test
bun run typecheck
bun run build
```

## 7. 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `DEEPSEEK_API_KEY` | DeepSeek API 密钥 | — |
| `DEEPSEEK_BASE_URL` | API 地址 | `https://api.deepseek.com/anthropic` |
| `CONFIRM_WRITES` | 写文件是否需要确认 | `auto` |

## 8. 设计原则

- **无框架依赖** — 零外部框架，只依赖 `@anthropic-ai/sdk`、`chalk`、`ora`
- **Windows 优先** — shell 命令适配 Windows (dir/type/findstr)
- **先读再改** — 禁止猜测文件内容
- **不编造** — 文件不存在就说找不到
- **测试驱动** — 修改后跑 `bun test` 验证
