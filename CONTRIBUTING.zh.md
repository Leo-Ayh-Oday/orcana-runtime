# 贡献指南 — Orcana Runtime

感谢你考虑为这个项目做贡献！

## 快速上手

```bash
# 克隆并安装
git clone https://github.com/Leo-Ayh-Oday/orcana-runtime.git
cd orcana-runtime
bun install
```

## 开发流程

```bash
# 类型检查
bun run typecheck

# 运行测试
bun run test

# 构建
bun run build

# 本地运行
bun run dev
```

## 项目结构

```
src/
├── agent/          # 主循环控制器、门控、任务追踪
├── context/        # 上下文组装、内核文件
├── evaluator/      # 置信度评分、计划判断
├── hooks/          # 安全策略、权限执行
├── lsp/            # TypeScript LSP 客户端
├── mcp/            # MCP 桥接、配置
├── memory/         # 混合记忆（SQLite + 压缩）
├── provider/       # DeepSeek/Anthropic API 适配
├── ripple/         # TypeScript 代码智能引擎
├── sandbox/        # 路径守卫、进程隔离
├── tools/          # 工具定义（Bash、Read、Write 等）
├── tui/            # 终端 UI 组件
├── ui/             # 斜杠命令、启动画面
└── verification/   # 构建/类型检查/代码检查收集器
```

## 提交流程

1. Fork 仓库，创建 feature 分支
2. 做出你的改动——保持聚焦，不要顺手格式化无关代码
3. 运行 `bun run typecheck && bun run test`——两者必须通过
4. 提交 PR，附上清晰的描述

需要模型 API Key 的 live/eval 检查可用 `bun run test:live` 单独运行。

## 代码风格

- TypeScript strict mode
- 不用 `any`，除非有注释说明原因
- 对象形状优先用 `interface` 而非 `type`
- 单任务模块优先，避免上帝文件
- 约束规则写进主循环，不要定义在独立模块"等待被调用"

## 设计原则

> 每个设计决策回答一个问题：**"这让 AI 更难写出坏代码了吗？"**

- 基础设施可以借鉴（provider/MCP/LSP/session），核心架构不搬
- 单 Agent 是默认模式，多 Agent 不是
- "讨论"和"执行"严格分开
- 所有生效的约束都是写死在 loop.ts 里的——独立模块定义但未接入的规则等于不存在

## Bug 报告

使用 GitHub Issues，包含：
- 操作系统和 Bun 版本（`bun --version`）
- 复现步骤
- 预期行为 vs 实际行为
- 相关错误日志

## 协议

通过贡献，你同意你的代码将在 MIT 协议下授权。
