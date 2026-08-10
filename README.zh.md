# Orcana Runtime

<p align="center">
  <strong>让 Coding Agent 的执行更可控，让完成声明更可验证。</strong><br>
  一个面向长期编码任务的开源、模型无关 Agent Runtime。
</p>

<p align="center">
  状态一致性 · 受控执行 · 变更影响 · 证据约束 · 中断恢复
</p>

<p align="center">
  <a href="https://github.com/Leo-Ayh-Oday/orcana-runtime/actions/workflows/ci.yml"><img src="https://github.com/Leo-Ayh-Oday/orcana-runtime/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/orcana-runtime"><img src="https://img.shields.io/npm/v/orcana-runtime" alt="npm"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/runtime-Node.js-339933" alt="Node.js"></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/dev-Bun-%23f9f1e4" alt="Bun"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/lang-TypeScript-%233178c6" alt="TypeScript"></a>
</p>

<p align="center">
  <a href="./README.md">English</a>
</p>

> [!IMPORTANT]
> Orcana Runtime 当前是一套可运行、研究级的 Coding Agent Runtime，而不是已经成熟的通用 Agent 平台。项目已经建立单 Agent 的状态、执行、验证与恢复基础，并实现 G0-G6 Typed Execution Graph 核心；当前工作是闭环 Durable Execution、Graph 权威边界和受约束 Multi-Agent。

## Orcana Runtime 是什么？

Orcana Runtime 是一个开源、模型无关、约束优先的 Coding Agent 执行运行时。

它位于模型与真实开发环境之间，统一协调：

- 模型调用与上下文；
- 计划、任务和运行状态；
- 文件读取、代码修改与 Shell 工具；
- 权限、预算、取消和人工中断；
- 变更影响分析；
- Typecheck、测试、构建与其他验证；
- Evidence、Trace、Snapshot 和恢复；
- 最终完成判断。

Orcana 不把模型的一句"已经完成"视为充分条件。它尝试让代码修改、验证结果和完成声明与当前工作区状态建立可追踪的关系，再由 Runtime 决定是否接受完成。

Orcana 的长期目标，是成为连接模型、工具和真实计算环境的执行与治理层；Coding Agent 是它目前的第一个验证场景。

## 快速开始

### 环境要求

- Node.js 20+
- npm
- 一个受支持 Provider 的 API Key
- Bun 仅用于源码开发、测试和构建

### 安装

```bash
npm install -g orcana-runtime
```

### 配置 Provider

当前 Quickstart 以 DeepSeek 为例：

```bash
# Linux / macOS / Git Bash
export DEEPSEEK_API_KEY="sk-your-key-here"

# Windows PowerShell
$env:DEEPSEEK_API_KEY="sk-your-key-here"

# Windows CMD
set DEEPSEEK_API_KEY=sk-your-key-here
```

Provider、模型、预算、权限、沙箱和 MCP 等高级配置，请参考：

- [中文使用指南](./docs/awesome-deepseek-agent/orcana.zh-CN.md)
- [settings.example.json](./settings.example.json)
- [.env.example](./.env.example)

### 运行

```bash
# 交互式 TUI
orcana

# 单次任务
orcana "修复失败的测试"

# 查看已保存会话
orcana list

# 环境诊断
orcana doctor
```

> [!NOTE]
> 旧命令 `deepseek-orcana`、`deepseek-code` 和 `deepseek` 仅作为迁移期兼容别名保留，后续版本将逐步移除。新脚本和文档应统一使用 `orcana`。

## 为什么需要 Orcana？

现代 Coding Agent 已经能够读取仓库、调用工具、修改代码并运行测试，但任务一旦变长，Runtime 会遇到一组不能只靠提示词解决的问题。

### 1. 模型上下文可能已经过期

Agent 读取文件后，工作区可能被其他工具、用户或上一轮操作改变。

如果 Runtime 不追踪文件状态，模型可能继续基于旧内容推理和写入。

### 2. 验证结果可能不再对应当前代码

测试曾经通过，不代表后续修改后的工作区仍然通过。

Orcana 尝试把验证结果与写入代际、事务、Artifact 和文件状态关联，避免把历史结果误当成当前证据。

### 3. "模型说完成"不等于任务真的完成

最终回答可能声称：

- 已实现全部需求；
- 测试已经通过；
- 没有遗漏调用方；
- 修改可以安全交付。

Runtime 需要检查这些声明是否有对应的计划状态、验证记录和未解决义务，而不是只接受自然语言结论。

### 4. 长任务必须能够被治理

长期运行的 Agent 需要明确的：

- 生命周期；
- 预算；
- 取消传播；
- 人工审批；
- 持久化；
- Trace；
- 恢复边界；
- 副作用控制。

Orcana 正在把这些能力从 Agent Loop 内部提取为显式 Runtime 语义。

## 核心运行模型

```
Human Intent
     │
     ▼
Agent Harness
     │
     ├── Lifecycle / Outcome
     ├── Budget / Cancellation
     ├── Interrupt / Resume
     ├── Persistence / Trace
     └── Run Scope / Sandbox
     │
     ▼
Agent Kernel
     │
     ├── Provider
     ├── Planning
     ├── Tool Execution
     ├── File State
     ├── Ripple Analysis
     ├── Verification
     └── Completion Gates
     │
     ▼
Files · Shell · Tests · Build · MCP · External Tools
```

> [!NOTE]
> 当前 Harness 已成为统一控制入口，底层 Agent Kernel 仍承担主要编码执行。两者之间的状态所有权、Evidence、事务和恢复语义仍在持续收敛。

### 一次代码修改的理想链路

```
读取工作区状态
→ 检查上下文是否新鲜
→ 建立 Patch Transaction
→ 执行受控修改
→ 分析下游影响
→ 运行可用验证
→ 生成并绑定 Evidence
→ 检查未完成义务
→ Runtime 决定是否接受完成
```

这条链路的目标不是"证明代码绝对正确"，而是减少以下不一致：

- 修改基于过期状态；
- 验证对应旧版本；
- 回滚后沿用旧证据；
- 最终声明超过现有证据能够支持的范围。

## 核心能力

### Agent Harness

Harness 为一次 Agent Run 提供显式控制面：

- 类型化生命周期；
- 结构化 Run Outcome；
- 独立 Run Scope；
- 模型、工具、Token 和时间预算；
- 取消与超时；
- 事件流和 JSONL Trace；
- Snapshot 与持久化；
- Plan Approval 和 Clarification 中断；
- 显式等待点后的跨实例恢复。

> [!NOTE]
> 当前恢复能力以显式等待点和持久化状态为主，不等价于任意指令级断点恢复。

### File State 与 Freshness

Orcana 记录文件指纹和运行期观察到的写入，用于识别：

- 读取后发生变化的文件；
- 可能基于旧状态生成的修改；
- Shell 或外部工具引起的工作区变化；
- 验证后发生的新写入。

### Patch Transaction

代码修改逐步从"直接写文件"收敛为带上下文的事务：

- 输入状态；
- 修改范围；
- 事务身份；
- 写入代际；
- 回滚关系；
- 相关 Evidence。

> [!NOTE]
> 当前事务和回滚语义仍在继续加强，目标是让写入、验证、回滚和恢复共享同一事实来源。

### Ripple Engine

Ripple Engine 面向 TypeScript 代码变更分析下游影响，包括：

- API 表面变化；
- 符号引用；
- 调用方；
- 使用方式；
- 相关测试；
- 必须继续处理的 Obligation。

它的目标不是只给出"可能受影响"的提示，而是把部分变更影响转化为可以阻止完成的运行时义务。

> [!NOTE]
> 当前 Ripple 主要针对 TypeScript，仍可能出现误报、漏报和降级路径。

### Evidence Ledger

Evidence Ledger 用于记录可验证执行结果，例如：

- Typecheck；
- 测试；
- 构建；
- 命令和退出码；
- 输出摘要；
- 关联 Artifact；
- 写入代际；
- 事务和文件状态；
- 新鲜或失效状态。

Evidence 代表"某个检查在某个状态下发生过"，不自动等价于"代码完全正确"。

### Completion Gates

模型可以提出完成，但 Runtime 需要综合检查：

- Task 与 Plan 状态；
- 未解决 Ripple Obligation；
- 当前可用验证；
- Evidence 是否仍然有效；
- 最终声明是否有对应依据；
- 是否触发预算、权限或失败边界。

无法验证、验证失败和验证已过期，应被视为不同状态，而不是统一投影成"通过"。

### Tool Runtime 2.0

工具表面之下的生产级能力层（RT-1..13）：

- **契约** — 26 个标准错误码（`INVALID_INPUT`、`SSRF_BLOCKED`、`MCP_UNTRUSTED_TOOL`、`STALE_FILE` 等）、6 状态 `ToolExecutionResult`（`succeeded` / `domain_failed` / `execution_failed` / `blocked` / `cancelled` / `timed_out`）、重试元数据与共享 JSON Schema 输入/输出校验器。
- **迁移开关** — `capabilities.mode`（`legacy` / `shadow` / `enabled`）+ shadow 差异事件（`capability.shadow_mismatch`），新契约可在不打扰用户任务的前提下观察。
- **统一策略链** — 模块化门禁（`writable-root` / `network` / `risk` / `approval` / `concurrency`），单一执行顺序；Shell、文件、Patch、Git 与 MCP 写工具共用同一边界——不存在"Shell 被拦但 Patch 可写"的路径。
- **工具集** — `apply_patch` / `apply_patch_transaction`（baseHash 新鲜度、路径逃逸拒绝、多文件原子回滚）、`edit_symbol`（编译器 AST 锚定）、`read_file` selector + `expectedHash`、`run_process` / `run_shell_script`（参数化、`shell:false`）、结构化 Git（`--porcelain=v2` + `--numstat`）、repo map 代码智能、验证工具链（`discover_verification` / `run_targeted_verification` / `classify_command_failure` / `verify_claim`）、run 绑定服务监督（`service_start` / `service_status` / `service_logs` / `service_stop`，`cleanupPolicy=run-end` 自动停止）。
- **安全硬化** — `web_fetch` 在每次重定向跳重新做 DNS/IP 策略校验（私网/回环/云 metadata 一律拒绝，fail-closed），流式读取带字节预算与即时解压（压缩炸弹防护），缓存 key 按 summarize 模式分离，并标记提示注入措辞。MCP 服务器带每服务器信任策略（未知工具默认非只读高风险 + 首次执行审批；annotations 仅作提示）。
- **Capability Router** — 分层动态披露：常驻稳定核心（`read_file` / `run_process` / `apply_patch` / `git_status` / `verify_claim`）+ 按任务选择的专业组，带 token 估算与按需披露 fallback 集合（简单任务不为 Web/MCP/LSP schema 付费）。
- **生产评测** — 20 个 Tool 层场景（TL-001..020），覆盖隔离、取消、Patch 安全、验证门禁、Artifact、SSRF、MCP 信任、服务清理、新鲜度、Router 经济性与 Trace 成对性。

### Provider Layer

Orcana Runtime 不再以某一家模型供应商定义自身。

当前项目通过 Provider 层接入模型，仓库文档包含 DeepSeek、Anthropic 和 OpenAI 等 Provider 的支持与配置路径。不同 Provider 的工具调用、上下文、流式输出和错误恢复能力可能并不完全一致，具体兼容性以当前版本和测试结果为准。

### Context 与 Memory

Orcana 具备多层上下文管理能力，包括：

- 上下文预算；
- Tool 结果裁剪；
- 历史压缩；
- Context Epoch；
- 本地知识与记忆存储；
- 面向长任务的上下文降级和阻断策略。

> [!NOTE]
> 这些机制用于控制上下文增长，但不能保证任意长度任务都能无损持续运行。

## 当前项目状态

> [!IMPORTANT]
> 当前公开版本与源码版本已经分叉：npm 和 GitHub Latest Release 仍为
> `0.8.16`，`origin/main` 声明 `0.8.26.1`，活动修复线声明尚未发布的
> `0.8.26.2` 候选。修改源码中的版本号不等于 npm 包或 GitHub Release
> 已经发布。

| 子系统 | 当前状态 | 说明 |
|---|---|---|
| CLI / TUI | 可运行 | 支持交互式与单次任务入口 |
| Agent Kernel | 可运行，正在收敛 | 仍承担主要编码执行逻辑 |
| Agent Harness | 已建立，持续优化 | 生命周期、Outcome、预算、取消、Trace、持久化和中断已接入 |
| Run Isolation | 已实现主要隔离 | 部分权威状态仍需从 Kernel ALS 继续迁移到统一 Run Scope |
| File State / Freshness | 已实现 | 继续加强与事务、Shell 写入和 Evidence 的绑定 |
| Patch Transaction | 部分实现 | 原子提交、完整回滚失效和 Durable Step 仍需加强 |
| Ripple Engine | 已实现 | 当前以 TypeScript 为主要验证场景 |
| Evidence Ledger | 已实现，完整性收敛中 | 需要确保 Harness 与 Kernel 使用唯一权威实例 |
| Completion Gates | 已实现，统一入口收敛中 | 目标是 fail-closed，而不是无法验证时默认通过 |
| Interrupt / Resume | 已实现显式等待点恢复 | 不是任意调用栈或指令级恢复 |
| Trace / Snapshot | 已实现 | 继续补足稳定重放和 Durable Execution 语义 |
| Tool Runtime 2.0 (RT-1..13) | 已实现 | 契约、统一策略链、Patch/进程/Git/repo map/验证工具、SSRF 硬化 Web、MCP 信任策略、Capability Router、TL-001..020 评测 |
| Linux Sandbox | 真实后端已实现，强制能力取决于宿主 | Linux 短进程已进入 Broker；Host Audit 仍是降级路径，service/MCP/LSP 和若干生命周期边界尚未完全由 Broker 管理，见下文 |
| Typed Execution Graph | 核心已实现，权威闭环中 | `src/workflow/` 已包含类型契约、编译/校验、DAG 调度、读写串行、结果缓存/重放、修复循环、动态编译、中断与 Harness 节点执行；严格重放、不可变审批、缓存溯源以及资源/重试权威仍需闭环 |
| Multi-Agent | 延后 | 单 Agent Runtime 语义稳定后再进入受约束 Subagent 阶段 |
| Recursive Self-Evolution | 研究方向 | 不应被视为当前已经稳定交付的能力 |

## Orcana 目前不是什么

为避免把研究目标误写成现有能力，当前 Orcana 不是：

- 已成熟的通用 Agent 平台；
- 能证明任意代码修改绝对正确的系统；
- 完整的 Durable Execution Engine；
- 已具备生产级 exactly-once 语义的完全分布式、通用 Graph Runtime；
- 多个 Agent 共享工作区自由写入的 Multi-Agent Framework；
- Linux 内核级安全沙箱的完整替代品；
- 已完成的递归自我进化系统；
- 对所有模型 Provider 具有完全一致语义的统一接口。

Orcana 当前最适合被理解为：

> 一套正在通过真实 Coding Agent 场景，研究状态一致性、受控执行、Evidence、恢复和可信完成语义的开源 Runtime。

## Linux 优先开发与沙箱状态

Linux 现在是权威开发与运行环境。普通 Linux 短进程路径已经是：

```text
ProcessExecutor → LinuxExecutionBroker → Host Audit | Bubblewrap | Rootless Podman
```

这并不代表所有运行都具有同一种安全等级：

- **Host Audit** 提供环境过滤、超时/进程组处理和执行后文件差异审计；
  它是可观察的降级路径，不是文件系统或网络安全边界。
- **Bubblewrap** 在宿主支持非特权 namespace 且真实后端实际运行时，可以
  提供 namespace、挂载、空 Home 和网络隔离。
- **Rootless Podman** 可通过 digest 审批镜像、显式挂载和默认断网形成更
  严格的容器边界，但仍共享宿主内核，不等于 VM。
- **cgroup v2** 只有在委托、进程 attach 和 cleanup 被真实观测后才能
  宣称生效；安装了二进制或写入了配置值都不是充分证据。
- **Landlock** 尚未进入当前生产执行路径，并且当前 WSL2 开发内核不可用。
- service、MCP、LSP 长期进程使用过渡期 `ServiceCell`：环境已净化、可记录
  lease，但尚未进入 Broker/cgroup 权威，因此不能套用普通 Cell 的强隔离
  声明。

`inspect`、`build` 可显式降级为 Host Audit；`test`、`dependency`、
`service`、`untrusted`、`evolution` 是严格 Profile，缺少必要边界时必须
fail closed。某次运行实际获得了什么边界，应以该次 `SandboxReceipt` 为
权威，不能仅依据启动横幅或单元测试推断。

完整后端/Profile 矩阵、WSL 实测、已知缺口和声明规则见
[Linux 沙盒当前状态与降级矩阵](./docs/linux-foundation/current-status.md)。
更广的安全模型见 [SECURITY.md](./SECURITY.md)。

## 配置目录

新的默认配置目录：

```
~/.orcana/
```

常见文件：

```
~/.orcana/settings.json
~/.orcana/mcp.json
~/.orcana/permissions.json
<project>/.orcana/
```

> [!NOTE]
> 旧目录和旧环境变量可能在迁移期继续兼容，但新配置应优先使用 Orcana 命名空间。

复制配置模板：

```bash
mkdir -p ~/.orcana
cp settings.example.json ~/.orcana/settings.json
```

## 从源码开发

### 克隆与安装

```bash
git clone https://github.com/Leo-Ayh-Oday/orcana-runtime.git
cd orcana-runtime
bun install
```

### 开发运行

```bash
bun run dev
```

### 类型检查

```bash
bun run typecheck
```

### 测试

```bash
# 默认仓库门禁（Provider/Live 测试保持显式隔离）
bun run test

# 不含 Provider 的集成测试
bun run test:integration

# 完整本地门禁别名；不会执行 Live/Provider 测试
bun run test:all
```

付费 Provider 测试只通过受保护默认分支上的手动 `Live Provider Lane`
workflow 执行。`code_as_action.test.ts` 在模型生成代码尚未获得无凭据、
网络隔离的执行沙箱前继续保持阻断。

### 构建与发布检查

```bash
bun run build
npm pack --dry-run
```

> [!NOTE]
> 发布、CI 和测试数量会随仓库变化。README 不使用静态"全部绿色"或固定测试数作为永久承诺，应以当前 CI 和对应 commit 的实际结果为准。

## 文档导航

| 文档 | 内容 |
|---|---|
| [中文使用指南](./docs/awesome-deepseek-agent/orcana.zh-CN.md) | 安装、Provider 配置与首次运行 |
| [当前状态](./docs/status.md) | 公开/源码版本、能力状态与发布门禁 |
| [Linux 沙盒状态](./docs/linux-foundation/current-status.md) | 后端强制、降级矩阵与声明规则 |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Runtime、Agent Loop、Gate 与子系统架构 |
| [SECURITY.md](./SECURITY.md) | 权限、凭据、沙箱和安全边界 |
| [CHANGELOG.md](./CHANGELOG.md) | 版本变更记录 |
| [CONTRIBUTING.zh.md](./CONTRIBUTING.zh.md) | 中文贡献指南 |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | English contribution guide |
| [ACKNOWLEDGMENTS.md](./ACKNOWLEDGMENTS.md) | 致谢与参考项目 |

## 发展路线

Orcana 采用"先收敛执行语义，再增加执行单元"的路线。

### 当前：Runtime Integrity

重点包括：

- Harness 与 Kernel 共享唯一事实源；
- 统一 Evidence Ledger；
- 区分 passed / failed / unavailable / stale；
- Rollback 正确失效旧 Evidence；
- 统一生命周期、取消和 Cleanup；
- Linux Shell 与 Sandbox 基础一致性；
- 将 Runtime 关键路径纳入稳定 CI。

### 当前闭环线：Durable Execution

重点包括：

- 稳定 Step ID；
- 副作用声明；
- 幂等键；
- Prepared / Executing / Committed 状态；
- Crash Injection；
- 恢复时避免重复执行副作用；
- Trace Replay 和 Runtime Evaluation Lab。

### 当前：Typed Execution Graph 权威闭环

G0-G6 核心已实现并有专项测试。当前重点不是从零构建 Graph，而是完成生产权威闭环：

- 零实时副作用的严格 Replay；
- 溯源完整的缓存身份与失效；
- 与精确执行绑定的不可变审批授权；
- 权威资源、重试与活性预算；
- 跨进程崩溃的 Durable Checkpoint / Recovery；
- 不绕过现有 Gate 的更广生产集成。

### 再后续：Bounded Multi-Agent

第一阶段只考虑：

- Lead Agent；
- 只读或提案型 Subagent；
- Artifact 通信；
- 独立上下文和独立预算；
- 有限委派深度；
- 单一全局 Completion Authority；
- 单写入通道。

不会优先采用多个平级 Agent 在同一工作区自由写入的模式。

### 长期研究方向

- Agent Operating Layer；
- 模型无关执行治理；
- 长期任务和持续运行；
- 可验证的受控自我修改；
- 递归演化与回归门禁；
- 多工作区和分布式执行。

这些是研究方向，不代表当前版本已经完成。

## 研究与声明原则

Orcana 采用实现驱动的研究方式：

```
提出架构假设
→ 实现
→ 编写测试与失败注入
→ 检查真实运行语义
→ 公开限制
→ 修正设计
```

项目文档遵循以下原则：

- 不把计划中的架构写成已实现能力；
- 不把一次测试通过写成普遍正确性证明；
- 不把模型自评等同于独立验证；
- 不把降级沙箱描述为完整安全边界；
- 不把已实现的类型化 Graph 核心混同为已完成的分布式或 exactly-once 生产 Runtime；
- 不把多个角色提示词描述为成熟 Multi-Agent；
- 性能、质量和可靠性结论应附带可复现的评测条件。

欢迎从源码、测试、Trace 和失败案例直接挑战 Orcana 的设计。

## 贡献

Orcana Runtime 目前尤其欢迎以下方向的贡献：

- Agent Harness 与 Runtime 状态模型；
- Linux 沙箱、进程树和 cgroup；
- Durable Execution 与幂等恢复；
- TypeScript 变更影响分析；
- Evidence 与验证状态建模；
- Replay、Trace 和 Evaluation；
- Provider 兼容性测试；
- TUI 与开发者体验；
- 文档、示例和失败复现。

开始贡献前请阅读：

- [CONTRIBUTING.zh.md](./CONTRIBUTING.zh.md)
- [SECURITY.md](./SECURITY.md)
- [ARCHITECTURE.md](./ARCHITECTURE.md)

提交 Issue 时，请尽量包含：

- Orcana 版本或 commit SHA；
- 操作系统与运行时版本；
- Provider 和模型；
- 最小复现步骤；
- 期望行为与实际行为；
- 相关 Trace、日志或测试结果；
- 是否涉及工作区写入、凭据或外部副作用。

## 项目定位摘要

> Orcana Runtime 是一个模型无关、面向长期自主任务的可信 Agent Runtime，让 AI 能在真实代码库与计算环境中更可控地执行、验证、恢复并完成工作。

更严格地说，Orcana 当前正在研究：

> Runtime 如何确认操作所依据的状态仍然有效，验证结果仍对应当前工作区，并限制模型作出超过现有证据的完成声明。

这仍是一个需要通过真实运行、失败注入和可复现评测持续验证的研究问题，而不是已经被证明的最终答案。

## 许可证

Orcana Runtime 使用 [MIT License](./LICENSE) 开源。
