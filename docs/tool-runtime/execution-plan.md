# Orcana 生产级 Tool 系统改造执行方案

**文档版本：** Tool Runtime 2.0 / Execution Plan v1.0 → **v1.1（本地现状对齐版，2026-08-04）**
**适用阶段：** ~~Loop 减重进行中，Harness 2.0 尚未全面接线~~ → **ALK-1.0 完成，Harness 2.0 已全面接线（H0–H12 + Closure R1 + Readiness R2 冻结），Node Runtime stable**
**执行对象：** 可直接交给 Codex、Claude Code、Orcana 或其他代码 Agent 分 PR 执行
**代码基线：** 以本地工作区为唯一事实来源（HEAD `fcf5c6e`，v0.5.9）；远程仓库 `2207db20eb284d8b2f695c13951a3078bbff3682` 仅用于历史结构参考
**核心原则：** 不大爆炸重写；先建立契约，再迁移核心工具；先完成隔离和安全，再增加高级能力。

---

## 0.5 本地现状对齐与计划修订（v1.1，2026-08-04）

本计划原文（v1.0）写于 v0.4.0 基线（Harness 2.0 之前）。本地已完成 ALK-1.0（loop.ts 132 行阶段编排器）、Harness 2.0（H0–H12）、Harness Closure R1（六项收口）、Graph Readiness R2（G0-1..G0-4，v0.5.6–v0.5.9）。**用 SocratiCode MCP 全量核对后**，原文 T1–T5 的目标语义大部分已落地，但存在真实缺口。修订原则：保留原文目标语义（§4 核心契约、§10 禁止事项、§11 DoD），按差距重排 PR 顺序。

### 0.5.1 已完成对照（不需要重建，按差距补强）

| 原文 PR | 现状（本地文件） | 状态 |
|---|---|---|
| T1 Capability Contract | `src/harness/contracts/capability.ts`（CapabilityDescriptor 已含 inputSchema/outputSchema/sideEffect/concurrencyGroup/permissions/riskLevel/retryable/idempotent/cancellable/producesEvidence）、`src/harness/capabilities/descriptor.ts`（createCapabilityDescriptor + TOOL_OUTPUT_SCHEMA） | ✅ 契约主体已有 |
| T2 Legacy Adapter + Executor | `src/harness/capabilities/tool-adapter.ts`（projectCapabilityDescriptor + toolCapabilityHandler + FIRST_BATCH 7 工具注册）、`executor.ts`（8 步链：Budget Reserve → Policy → Before Hook → Handler → After Hook → Schema → Artifact/Evidence → Budget Commit，R1 起强制 policy） | ✅ 主体已有 |
| T3 Run-scoped Context | `src/harness/runtime/run-scope.ts`（AgentRunScope：runId/sessionId/projectRoot/sandbox/artifactStore/evidenceLedger/trace/rippleSession/cancellation）+ H3 真实共享进程隔离测试 | ✅ 主体已有 |
| T4 Artifact/Evidence | `src/harness/artifacts/`（artifact-store + evidence-adapter + freshness + provenance，G0-3 起内容随 Run 持久化） | ✅ 主体已有 |
| T5 Unified Policy | `src/agent/tool-execution/policy.ts`（evaluateToolPolicy 8 层）+ `src/harness/capabilities/policy-adapter.ts`（node 模式）+ R1 强制 policy 无跳过路径 | ✅ 主体已有 |
| T13 Eval 基础设施 | `evals/harness/`（H12：12 场景 + rubric 8 维 + 质量地板 + CLI + summary.json） | ✅ 基础设施已有 |

### 0.5.2 真实缺口（修订后的 PR 顺序，沿用"一个 PR 一个 patch 版本"节奏）

| 修订 PR | 内容 | 差距性质 |
|---|---|---|
| RT-1 契约补强 | `errors.ts`（§4.4 的 26 个错误码）、`result.ts`（ToolExecutionStatus 6 状态枚举 + ToolExecutionResult）、`retry.ts`、`execution-context.ts`（ToolExecutionContext 类型）、独立 `schema-validator.ts`（从 interrupts/response-validator 抽出复用）→ 放 `src/harness/capabilities/` + `src/harness/contracts/` | 缺标准错误码与结构化结果类型 |
| RT-2 Feature Flag / Shadow | `capabilities.mode`（legacy/shadow/enabled）配置 + legacy 标记 + shadow 差异记录（`capability.shadow_mismatch`） | 缺迁移开关与对照机制 |
| RT-3 Context 显式化 | executor 收敛为显式 ToolExecutionContext 参数；readableRoots/writableRoots 声明；剩余 `process.cwd()` 清理（rewind.ts / kernel/prepare.ts / contract-freshness.ts / pre-loop.ts / task-tracker.ts / lsp/client.ts） | 部分工具仍隐式依赖 cwd |
| RT-4 输出限制与真实 Output Schema | output-limiter（maxOutputBytes → Artifact + preview/hash/ref）；`shell.ts:326` SHELL_RESULT_MAX_CHARS=8000 硬截断改为写 Artifact；首批 per-tool output schema（typecheck / git_status / git_diff / lsp_diagnostics / web_search）——替换统一占位 `TOOL_OUTPUT_SCHEMA` | 无 per-tool 输出 schema（descriptor.ts 注释自认）；大输出截断即丢弃 |
| RT-5 Policy 模块化 | 从 evaluateToolPolicy 拆出 `policy/writable-root-policy.ts`、`network-policy.ts`、`risk-policy.ts`、`approval-policy.ts`、`concurrency-policy.ts`；执行顺序文档化（§5 RT-5）；验收"Shell 被拦但 Patch 可写"路径不存在 | 单一函数未模块化，网络/writable-root 无显式策略 |
| RT-6 File/Edit 2.0 | `apply_patch`（unified diff + baseHash + scope + 路径逃逸拒绝）、`read_file` selector/expectedHash、`edit_symbol`（AST/LSP）、`apply_patch_transaction`（多文件原子 + idempotencyKey + dryRun + 真实 verify-before-commit + 回滚）——复用 `src/agent/patch-transaction.ts`（36k，已有 proposed→committed→rolled_back 与原子写） | patch-transaction 已有，缺统一 diff 入口与事务工具 |
| RT-7 Process/Shell 2.0 | `run_process`（shell:false + args 数组 + 进程组 + 超时杀树 + stdout/stderr 写 Artifact）；`run_shell_script`（显式审批 + SideEffect Plan）；收口 3 处 `shell:true`（shell.ts:102/232、service.ts:89）；复用 `src/sandbox/`（job-object 进程组已有） | 全部 shell 执行走字符串拼接 |
| RT-8 Git 2.0 | `git status --porcelain=v2 -z` 结构化解析；大 diff 写 Artifact；git_add/git_commit 等有副作用工具与只读分离风险级 | 现有 git_status 等为文本封装 |
| RT-9 Code Intelligence | `build_repo_map` / `query_repo_map` / `build_context_slice` + authority/confidence 结构——复用 `src/ripple/semantic-reference-provider.ts` + `astgrep-provider.ts` + `src/lsp/client.ts` + `src/tools/codegraph.ts`；find_symbol/find_references 已有 | 缺 repo map 与 authority 标注 |
| RT-10 Verification 2.0 | `discover_verification` / `run_targeted_verification` / `classify_command_failure` / `verify_claim`——复用 verification/ + evidence-adapter（H8 全链）+ getWriteGeneration | 缺验证规划与声明核查工具 |
| RT-11 Web/Service/MCP 硬化 | web_fetch 安全修复（SSRF/IP policy/重定向复查/压缩炸弹/缓存 key 含 summarize 模式）+ service lease + MCP trust policy（未知工具默认高风险；bridge.ts 现每调用新建 MCPClientV2，无信任模型） | 安全缺口 |
| RT-12 Capability Router | 分层动态披露（Stable Core 6 + Specialist）+ token 预算；H9 registry 现为静态 | 全新 |
| RT-13 Tool Production Eval | TL-001..020 场景（§5 RT-13），复用 evals/harness 基础设施 + trace-assertions | 全新 |

### 0.5.3 目录与命令修订（相对原文 §3 / §7）

- 目标目录改为 `src/harness/capabilities/`（已有）+ 新增 `policy/` 子目录 + `src/harness/contracts/`（契约补强）——**不新建 `src/capabilities/`**，避免重复模块（原文原则："不得机械创建重复模块"）。
- 本地测试命令：`bun run typecheck` / `bun run test`（全量，run-tests.cjs 逐文件）/ `bun run test:harness-replay` / `bun run eval:replay` / `bun run build` / `npm pack --dry-run` / `git diff --check`（五门禁 + HR 12 场景）。
- 发布节奏：每个 RT 一个 patch 版本（v0.5.10 起），每版五门禁全绿后 feature commit → `chore: release` → push → gh release → npm publish。

### 0.5.4 T0 基线任务（对齐后）

按 §2 执行，但清单落在**本地真实文件**上（见 0.5.2 表）：工具清单覆盖 `src/tools/*.ts` 全部 26 个生产工具（read_file / edit_file / edit_fim / multi_edit / write_file / shell / typecheck / git_status / git_diff / git_log / git_show / git_blame / git_add / git_commit / find_symbol / find_references / project_structure / web_search / web_fetch / start_service / task / todo_write / request_deeper_thinking / rollback_transaction / exa_web_search_exa / path）。已确认的模块级状态：无全局 sandbox/context；`shell:true` 3 处；`process.cwd()` 直接使用集中在 agent 层 6 文件（rewind / kernel/prepare / contract-freshness / pre-loop / task-tracker / lsp-client）。

---

## 0. 执行 Agent 总指令

你现在负责把 DeepSeek Orcana 的 Tool 层，从"可运行的工具集合"升级为"生产级 Capability Runtime"。

你必须遵守以下约束：

- 先读取本地代码，不得把远程仓库当作当前事实。
- 一次只实施一个 PR 范围。不允许同时改 Registry、Shell、File、MCP、Graph。
- 所有现有行为先兼容，再迁移。首轮不得删除 ToolDef、旧 ToolResult 或现有工具入口。
- 所有运行态必须 Run-scoped。禁止新增模块级可变状态、全局 Sandbox、全局 Patch、全局 Budget。
- 所有写入工具必须经过同一个 WritableRootPolicy、FreshnessGate、PatchTransaction 与 Evidence 路径。
- 所有工具必须有结构化输入、结构化结果、错误码、超时、取消、风险、副作用、幂等性和输出预算。
- 确定性工具优先。可以用 AST、LSP、Compiler API、Git、Hash、图算法、正则完成的任务，不调用模型。
- 大输出不得直接塞回模型。原始内容写入 Artifact，模型只接收摘要和引用。
- 不得在本计划期间实现 Execution Graph、多 Agent 或知识图谱。本次只建设其前置 Capability Runtime。
- 每个 PR 必须可回滚。使用 Legacy Adapter、Feature Flag 或双轨读取，禁止不可逆迁移。
- 每个 PR 结束必须运行规定测试并生成变更报告。
- 遇到本地结构与本文不一致时，保持目标语义不变，根据实际目录调整文件位置，不得机械创建重复模块。

## 1. 改造目标

### 1.1 最终目标

完成后，Orcana 的工具调用路径应统一为：

```text
Model / Node
   ↓
Capability Router
   ↓
Tool Contract + Input Schema Validation
   ↓
Run-scoped ToolExecutionContext
   ↓
Budget Reservation
   ↓
Permission / Risk / Approval / Scope Guard
   ↓
Tool Execute
   ↓
Output Schema Validation
   ↓
Artifact / Evidence / Metrics
   ↓
Structured ToolExecutionResult
```

### 1.2 预期收益

**能力**

- 更准确的代码定位与依赖判断；
- 更安全的文件与 Shell 执行；
- 更可靠的验证、回滚和完成声明；
- 支持未来 Graph、并发 Run 和多 Agent；
- 能在更小、更便宜的模型上保持较高工程能力。

**成本**

工程目标，不是当前实测承诺：

- 中大型任务输入 Token 降低 30%–60%；
- 强模型调用次数降低 20%–40%；
- 重复 Tool 调用降低 30%–70%；
- 无进展修复轮次降低 20%–50%；
- 中大型任务平均成本降低 25%–55%。

### 1.3 非目标

本轮不做：

- 多 Agent；
- DAG Scheduler；
- 动态 Workflow Compiler；
- Neo4j 或系统知识图谱；
- 分布式 Tool Worker；
- 远程执行集群；
- 插件市场；
- 全量语言语义分析；
- 一次性替换所有旧工具。

## 2. 当前基线审查任务

在写任何代码之前，先完成 T0 Tool Baseline。

### 2.1 搜索范围

检查本地实际存在的：

- `src/tools/**`
- `src/agent/tool-execution/**`
- `src/runtime/**`
- `src/file-state/**`
- `src/ripple/**`
- `src/sandbox/**`
- `src/verification/**`
- `src/mcp/**`
- `src/lsp/**`
- `src/agent/patch-transaction.ts`
- `src/agent/evidence-ledger.ts`
- `src/agent/completion-orchestrator.ts`

### 2.2 建立清单

创建：`docs/tool-runtime/tool-inventory.md`

每个工具记录：

| 字段 | 说明 |
|---|---|
| name | 工具名 |
| source | 定义文件 |
| handler | 执行函数 |
| input schema | 当前输入契约 |
| output | 当前返回格式 |
| readonly | 是否只读 |
| side effects | none/read/write/external/process |
| risk | 0–5 |
| confirmation | 是否需要审批 |
| timeout | 超时来源 |
| cancellable | 是否支持取消 |
| idempotent | 是否幂等 |
| concurrency | 是否可并发 |
| global state | 使用哪些全局状态 |
| artifact | 是否保存大结果 |
| evidence | 是否生成证据 |
| retry | 是否可重试 |
| known gaps | 当前缺陷 |

### 2.3 建立基线测试

新增或确认：

- `tests/tools/tool_inventory.test.ts`
- `tests/tools/tool_registry_legacy.test.ts`
- `tests/tools/tool_golden_trace.test.ts`

Golden Trace 至少覆盖：

- `read_file`
- `edit_file`
- `multi_edit`
- `shell`
- `typecheck`
- `git_status`
- `find_references`
- `web_fetch`
- 一个 MCP Tool

记录现有：输入；结果状态；content；metadata；Tool Policy 决策；Trace 事件。

### 2.4 T0 验收

- 所有生产工具进入清单；
- 找出全部模块级可变状态；
- 找出全部 `shell: true` 和字符串命令拼接；
- 找出全部直接 `process.cwd()`；
- 找出所有大输出截断点；
- 找出所有没有真实输出 Schema 的 Tool；
- 找出所有写入旁路；
- 不修改生产行为。

## 3. 目标目录结构

根据本地现状调整，但目标职责必须保持：

```text
src/capabilities/
├── index.ts
├── contract.ts
├── descriptor.ts
├── annotations.ts
├── execution-context.ts
├── result.ts
├── errors.ts
├── retry.ts
├── budget.ts
├── registry.ts
├── router.ts
├── executor.ts
├── legacy-adapter.ts
├── schema-validator.ts
├── output-limiter.ts
├── artifact-adapter.ts
└── policy/
    ├── risk-policy.ts
    ├── writable-root-policy.ts
    ├── network-policy.ts
    ├── approval-policy.ts
    └── concurrency-policy.ts

src/capabilities/builtin/
├── file/
├── process/
├── git/
├── code-intelligence/
├── verification/
├── web/
├── service/
└── mcp/
```

旧 `src/tools/**` 在迁移期间保留，通过 Adapter 接入。

## 4. 核心契约

### 4.1 CapabilityDescriptor

```ts
export interface CapabilityDescriptor {
  id: string
  version: string
  name: string
  title: string
  description: string

  inputSchema: Record<string, unknown>
  outputSchema: Record<string, unknown>

  behavior: {
    readOnly: boolean
    destructive: boolean
    idempotent: boolean
    openWorld: boolean
    sideEffect: "none" | "read" | "write" | "external" | "process"
  }

  execution: {
    timeoutMs: number
    cancellable: boolean
    concurrencyGroup: string
    retryPolicy: RetryPolicy
    taskSupport: "forbidden" | "optional" | "required"
  }

  security: {
    riskLevel: 0 | 1 | 2 | 3 | 4 | 5
    requiredPermissions: string[]
    approval: "never" | "conditional" | "always"
  }

  resourcePolicy: {
    maxOutputBytes: number
    maxArtifactBytes?: number
    maxFilesRead?: number
    maxNetworkRequests?: number
  }
}
```

### 4.2 ToolExecutionContext

```ts
export interface ToolExecutionContext {
  runId: string
  sessionId: string
  nodeRunId?: string

  projectRoot: string
  readableRoots: string[]
  writableRoots: string[]

  signal: AbortSignal
  budget: BudgetLedger
  approval: ApprovalContext

  sandbox: SandboxManager
  artifactStore: ArtifactStore
  evidenceLedger: EvidenceLedger
  trace: TraceWriter

  fileState: FileStateLedger
  rippleSession: RippleSession
  patchStore: PatchContextStore

  clock: Clock
}
```

### 4.3 ToolExecutionResult

```ts
export type ToolExecutionStatus =
  | "succeeded"
  | "domain_failed"
  | "execution_failed"
  | "blocked"
  | "cancelled"
  | "timed_out"

export interface ToolExecutionResult<O> {
  status: ToolExecutionStatus

  structuredContent?: O
  displayContent?: string

  error?: {
    code: string
    message: string
    retryable: boolean
    category:
      | "validation"
      | "permission"
      | "conflict"
      | "environment"
      | "network"
      | "timeout"
      | "internal"
  }

  artifacts: ArtifactReference[]
  evidence: EvidenceReference[]
  diagnostics: Diagnostic[]

  metrics: {
    startedAt: number
    durationMs: number
    outputBytes: number
  }
}
```

### 4.4 错误码规范

至少定义：

```text
INVALID_INPUT
SCHEMA_VALIDATION_FAILED
PERMISSION_DENIED
APPROVAL_REQUIRED
WRITABLE_ROOT_VIOLATION
READABLE_ROOT_VIOLATION
STALE_FILE
BASE_HASH_MISMATCH
PATCH_CONFLICT
RIPPLE_BLOCKED
TIMEOUT
CANCELLED
COMMAND_NOT_FOUND
PROCESS_EXIT_NONZERO
NETWORK_BLOCKED
SSRF_BLOCKED
RATE_LIMITED
REMOTE_UNAVAILABLE
OUTPUT_TOO_LARGE
ARTIFACT_WRITE_FAILED
LSP_UNAVAILABLE
LSP_STALE
VERIFICATION_FAILED
MCP_UNTRUSTED_TOOL
MCP_SCHEMA_INVALID
INTERNAL_ERROR
```

## 5. 分 PR 实施计划

### PR-T1：Capability Contract 2.0

**目标**：新增生产级契约，不改变现有工具行为。

**新增**

- `src/capabilities/contract.ts`
- `src/capabilities/descriptor.ts`
- `src/capabilities/result.ts`
- `src/capabilities/errors.ts`
- `src/capabilities/execution-context.ts`
- `src/capabilities/retry.ts`
- `src/capabilities/schema-validator.ts`
- `src/capabilities/index.ts`

**实施任务**

- 定义上述核心类型；
- 定义 `Capability<I,O>`；
- 定义 `CapabilityHandler<I,O>`；
- 实现输入和输出 Schema Validator；
- 不引入重量级依赖，优先使用已有 JSON Schema 能力；
- 若本地已有 Zod/Ajv，则复用，不新增第二套验证库；
- 编写类型级测试和运行时 Schema 测试。

**测试**

- `tests/capabilities/contract.test.ts`
- `tests/capabilities/schema_validator.test.ts`
- `tests/capabilities/result.test.ts`

**验收**

- Contract 不导入 loop.ts；
- Contract 不依赖 UI；
- 输入和输出都可 fail-closed；
- `domain_failed` 与 `execution_failed` 明确区分；
- 无生产行为变化。

**停止条件**：如果契约必须直接引用旧 Loop 内部局部状态，停止接线，先完成 RunState 抽离。

### PR-T2：Legacy Tool Adapter

**目标**：让旧 ToolDef 可通过新 CapabilityExecutor 执行。

**新增**

- `src/capabilities/legacy-adapter.ts`
- `src/capabilities/registry.ts`
- `src/capabilities/executor.ts`

**实施任务**

- 实现 `adaptLegacyTool(defn)`；
- 旧 ToolResult 映射为新 ToolExecutionResult；
- 保留 displayContent；
- 将原 metadata 临时放入 `structuredContent.legacyMetadata`；
- 增加 `legacy: true` 标记；
- CapabilityExecutor 统一执行：输入验证；预算预留；Trace 开始；调用 Legacy；结果转换；输出限制；Trace 完成；预算提交。

**Feature Flag**

```json
{
  "capabilities": {
    "mode": "legacy"
  }
}
```

支持：`legacy` / `shadow` / `enabled`。

**测试**

- 旧结果兼容；
- 旧阻塞结果转换；
- 异常转换；
- 超时；
- 预算；
- Trace；
- Feature Flag。

**验收**：现有 CLI/TUI 输出不发生用户可见回归。

### PR-T3：Run-scoped ToolExecutionContext

**目标**：消除 Tool 运行时全局状态，为并发 Run、Harness 和 Graph 做准备。

**必须消除**

- Shell 全局 Sandbox；
- 全局 Context Budget；
- 全局 Active Patch；
- 全局 Ripple Pending State；
- MCP 全局 Client；
- 工具对 `process.cwd()` 的隐式依赖。

**实施任务**

- CapabilityExecutor 显式接收 ToolExecutionContext；
- Runtime Bootstrap 为每个 Run 创建 Context；
- Shell 从 Context 获取 Sandbox；
- File 从 Context 获取 FileState、RippleSession、PatchStore；
- Tool 路径全部基于 projectRoot；
- 明确 readableRoots 和 writableRoots；
- 旧工具通过 AsyncLocalStorage 或 Adapter 注入过渡，但最终禁止全局 Setter；
- 添加两个并发 Run 的隔离测试。

**测试**

- `tests/capabilities/run_context.test.ts`
- `tests/capabilities/parallel_run_isolation.test.ts`
- `tests/capabilities/sandbox_isolation.test.ts`

**验收**

- Run A 的 Sandbox 不影响 Run B；
- Run A 的 Ripple 不影响 Run B；
- 取消 Run A 不影响 Run B；
- 工具不再依赖可变全局运行态。

### PR-T4：Structured Result、Artifact 与 Evidence

**目标**：将工具结果从文本主导升级为结构化结果主导。

**新增**

- `src/capabilities/artifact-adapter.ts`
- `src/capabilities/output-limiter.ts`
- `src/artifacts/tool-artifact-store.ts`

**实施任务**

- 输出超过 maxOutputBytes 时：原始内容写 Artifact；结果只返回 preview、hash、artifactId；
- Tool 结果绑定：runId；capabilityId；输入 Hash；workspace Hash；duration；
- Verification Tool 自动生成 Evidence Reference；
- 输出 Schema 校验失败时返回 `SCHEMA_VALIDATION_FAILED`；
- Artifact 写入失败不得误报工具成功；
- 增加 Secret Redaction。

**首批迁移**

- `typecheck`
- `git_status`
- `git_diff`
- `lsp_diagnostics`
- `web_search`

**验收**：模型不再收到大段原始日志；完整结果可通过 Artifact 追溯。

### PR-T5：统一 Policy 与安全边界

**目标**：所有工具使用统一策略链，禁止安全旁路。

**新增**

- `src/capabilities/policy/writable-root-policy.ts`
- `src/capabilities/policy/network-policy.ts`
- `src/capabilities/policy/risk-policy.ts`
- `src/capabilities/policy/approval-policy.ts`
- `src/capabilities/policy/concurrency-policy.ts`

**统一执行顺序**

```text
Input Schema
→ Permission
→ Read/Write Root
→ Risk
→ Approval
→ Freshness
→ Ripple
→ Budget
→ Execute
→ Output Guardrail
```

**硬性规则**

- Shell、File、Patch、Git mutation、MCP 写工具必须使用同一 WritableRootPolicy；
- 非交互模式不得自动绕过高风险审批；
- Risk 4/5 不允许 session-wide allow；
- 外部 MCP 注解不得直接决定安全级别；
- 网络工具必须经过 NetworkPolicy；
- 所有阻塞返回标准错误码和 Policy Trace。

**验收**：不存在"Shell 被拦但 Patch 可写"或"MCP 默认安全"的路径。

### PR-T6：File/Edit 2.0

**目标**：把文件写入升级为可验证、幂等、原子、可恢复的专业能力。

**目标能力**：`read_file`、`inspect_file`、`edit_exact`、`apply_patch`、`edit_symbol`、`write_file`、`apply_patch_transaction`

#### 6.1 read_file

支持：

```json
{
  "path": "string",
  "selector?": {
    "kind": "lines | symbol | byte_range",
    "start": "number",
    "end": "number",
    "name": "string",
    "length": "number"
  },
  "expectedHash?": "string"
}
```

返回：

```json
{
  "path": "string",
  "contentRef?": "string",
  "preview": "string",
  "contentHash": "string",
  "totalLines": "number",
  "selectedRange": "unknown",
  "complete": "boolean"
}
```

#### 6.2 edit_exact

- 保留唯一字符串匹配；
- 要求 baseHash；
- 返回匹配上下文和 Patch Preview；
- 支持 dryRun。

#### 6.3 apply_patch

- 支持标准 unified diff；
- 解析 Patch；
- 检查路径；
- 检查 baseHash；
- 检查 Scope；
- 生成结构化变更统计；
- 禁止二进制和路径逃逸。

#### 6.4 edit_symbol

优先 TypeScript：function；method；class；interface；type alias；object member。

使用 AST/LSP 确定位置，不使用模糊正则。

#### 6.5 apply_patch_transaction

执行：

```text
Validate
→ Read Current State
→ Base Hash
→ Writable Root
→ Ripple Preview
→ Apply to Temp/Overlay
→ Targeted Verification
→ Commit All or Rollback All
→ Record Artifact/Evidence
```

必须支持：

- idempotencyKey；
- workspaceHash；
- dryRun；
- 多文件原子；
- 真实 verify-before-commit；
- 失败自动回滚；
- 事务恢复。

**验收**

- 不再使用 `async () => true` 作为生产验证；
- 事务提交必须有真实 Verification Result 或显式 `verificationPolicy=deferred`；
- Deferred 状态不能满足 Completion Evidence。

### PR-T7：Process/Shell 2.0

**目标**：将通用 Shell 降级为高风险后备，将大部分执行迁移到参数化 Process Tool。

**新工具**：`run_process`、`run_shell_script`

**run_process**

```json
{
  "executable": "string",
  "args": ["string"],
  "cwd?": "string",
  "env?": {"k": "v"},
  "timeoutMs?": "number",
  "stdinArtifactId?": "string"
}
```

规则：

- `shell: false`；
- 不拼接命令字符串；
- 支持 AbortSignal；
- 创建进程组；
- 超时杀进程树；
- stdout/stderr 写 Artifact；
- 结构化 exitCode/signal；
- 限制输出和环境变量。

**run_shell_script**

仅在需要管道、重定向、复合命令时使用。

- 风险更高；
- 显式 shell 类型；
- 脚本写 Artifact；
- 必须审批；
- 使用 Sandbox；
- 执行前生成 SideEffect Plan。

**重构要求**

- 普通和流式执行共用同一核心执行器；
- 删除重复安全逻辑；
- 禁止模块级 Sandbox；
- 保留 Legacy shell 作为 Adapter，逐步废弃。

**验收**

- 80% 常见工程命令可通过 run_process；
- 所有进程可取消；
- 无孤儿子进程；
- 输出完整保存在 Artifact。

### PR-T8：Git 2.0

**目标**：将 Git 从文本命令封装升级为结构化版本控制能力。

**只读工具**：`git_status`、`git_diff`、`git_log`、`git_blame`、`git_show`、`git_changed_files`

实施要求：

- 使用 `spawn("git", args, { shell: false })`；
- `git status --porcelain=v2 -z`；
- 解析 staged/unstaged/untracked/conflict；
- `git diff --numstat` + Patch Artifact；
- 路径单独传参；
- 大 Patch 写 Artifact。

**有副作用工具后置**：`git_stage`、`git_commit`、`git_restore`、`git_create_worktree`、`git_remove_worktree`

- 必须单独风险级别，不与只读工具混用。

**验收**：Git 结果可由代码消费，不需要模型解析终端文本。

### PR-T9：Code Intelligence 2.0 与 Repo Map

**目标**：从文本搜索优先升级为语义优先。

**优先链**

```text
Compiler API / LSP
→ Tree-sitter / AST
→ ripgrep
→ Node fallback
```

**新能力**：`resolve_symbol`、`find_semantic_references`、`find_callers`、`find_implementations`、`find_related_tests`、`build_repo_map`、`query_repo_map`、`build_context_slice`

**结构化结果**：每个引用包含：

```json
{
  "location": {},
  "kind": "call | import | type | inheritance | text",
  "authority": "compiler | lsp | ast | text",
  "confidence": "number"
}
```

**Repo Map**

输入：goal；entry file；token budget；language；include tests。

输出：entrypoints；ranked files；ranked symbols；dependency edges；related tests；token estimate；provenance。

**验收**

- TypeScript 项目优先语义结果；
- 文本 fallback 明确标记 authority；
- Repo Map 可直接供 Context Pipeline 使用；
- 不会把全仓库原文返回模型。

### PR-T10：Verification Toolchain 2.0

**目标**：让验证由确定性系统规划和执行，而不是模型每次猜命令。

**新工具**：`discover_verification`、`run_typecheck`、`run_tests`、`run_lint`、`run_build`、`run_targeted_verification`、`classify_command_failure`、`verify_claim`

**discover_verification**

解析：package.json scripts；workspace；tsconfig；test framework；CI；monorepo package；related tests。

输出：

```json
{
  "commands": [],
  "packages": [],
  "confidence": "number",
  "sourceRefs": []
}
```

**run_targeted_verification**：输入 modifiedFiles，计算最小验证集。

**classify_command_failure**：处理 ANSI；测试用例；错误码；Stack Frame；重复根因；Failure Signature；相关文件。

**verify_claim**：检查声明（tests passed / typecheck passed / build passed / all callers updated / no unrelated files changed），查询 Artifact、Evidence、Transaction、Workspace Hash。

**验收**

- Typecheck 失败返回 domain_failed；
- 大日志只返回失败组；
- 旧 Evidence 在新 Patch 后自动 stale；
- Completion 可直接消费 verify_claim。

### PR-T11：Web、Service 与 MCP 安全硬化

#### 11.1 Web Search

返回结构化 Source：

```json
{
  "query": "string",
  "provider": "string",
  "retrievedAt": "string",
  "sources": [
    {
      "title": "string",
      "url": "string",
      "domain": "string",
      "publishedAt?": "string",
      "updatedAt?": "string",
      "snippet": "string",
      "sourceType": "official | paper | news | community | unknown"
    }
  ]
}
```

支持：domain filter；recency；language；dedup；primary source preference。

#### 11.2 Web Fetch

必须修复：

- Cache Key 包含 summarize/mode/auth scope；
- DNS 解析后的 IP Policy；
- 每次重定向重新检查；
- IPv6 私网/回环/link-local；
- 云 metadata；
- 流式字节上限；
- 内容类型；
- 压缩炸弹；
- 提示注入标记；
- Source Snapshot Artifact。

#### 11.3 Service Supervisor

拆成：`service_start`、`service_status`、`service_logs`、`service_stop`，建立 ServiceLease，绑定 runId 和 cleanupPolicy。

#### 11.4 MCP

每个 Server 定义 Trust Policy：

```json
{
  "trust": "untrusted | restricted | trusted",
  "allowedToolPatterns": [],
  "deniedToolPatterns": [],
  "defaultRiskLevel": "number",
  "allowOpenWorld": "boolean"
}
```

规则：

- 未知 MCP Tool 默认非只读、高风险；
- annotations 只能作为提示；
- 本地 Policy 决定最终风险；
- 首次执行需要审批；
- 支持 outputSchema/structuredContent；
- 服务级超时、取消、熔断；
- 限制结果大小；
- 不得所有 MCP Tool 默认 safe。

**验收**：Web、Service、MCP 不再绕过统一 Policy 和 Run 生命周期。

### PR-T12：Capability Router 与动态工具披露

**目标**：减少每轮 Tool Schema Token，并提高工具选择准确率。

**分层**

- Stable Core：read_file、inspect_file、run_process、apply_patch、git_status、verify_claim
- Task-selected Specialist：LSP、Repo Map、Web、Service、MCP、language-specific verification

**Router 输入**：task type；mode；risk；language；active node；context budget；permissions。

**Router 输出**：capability IDs；reason；token estimate；fallback set。

**规则**

- Tool 顺序稳定；
- Stable Prefix 字节稳定；
- 简单任务不加载高阶工具；
- 网络工具按需披露；
- MCP Tool 延迟加载；
- 同义重叠 Tool 只披露一个主工具。

**验收**

- 常见任务每轮 Tool Schema Token 显著下降；
- 工具选错率不升高；
- Cache Hit 不下降。

### PR-T13：Production Tool Eval

**目标**：建立 Tool 级别的生产门禁。

**每个 Tool 必测**：正常输入；非法输入；边界输入；输出 Schema；取消；超时；重复调用；幂等性；并发；权限；路径逃逸；大输出；Artifact；Evidence；Trace；跨平台；恢复；Secret Redaction。

**必备场景**

- TL-001 两个 Run 的 Shell Sandbox 不串扰
- TL-002 取消 Shell 后无孤儿进程
- TL-003 apply_patch 路径逃逸被拒绝
- TL-004 stale baseHash 阻止提交
- TL-005 multi-file 部分失败全部回滚
- TL-006 verification 失败不提交
- TL-007 Artifact 保存完整截断输出
- TL-008 git 特殊字符路径安全
- TL-009 rg 特殊 pattern 不产生命令注入
- TL-010 Web redirect 到私网被拒绝
- TL-011 Web cache 不混淆 summarize 模式
- TL-012 MCP 未知 Tool 默认高风险
- TL-013 MCP Tool 输出 Schema 失败被拒绝
- TL-014 Service Run 结束自动停止
- TL-015 LSP 旧诊断标记 stale
- TL-016 verify_claim 拒绝旧 Evidence
- TL-017 Capability Router 简单任务不加载 Web/MCP
- TL-018 Tool Trace 开始和结束事件成对
- TL-019 所有写工具经过 WritableRootPolicy
- TL-020 所有大输出生成 Artifact

## 6. PR 依赖顺序

```text
T0 Baseline
  ↓
T1 Contract
  ↓
T2 Legacy Adapter
  ↓
T3 Run Context
  ↓
T4 Result / Artifact
  ↓
T5 Unified Policy
  ↓
T6 File/Edit 2.0
  ├────────→ T9 Code Intelligence
  └────────→ T10 Verification
  ↓
T7 Process/Shell 2.0
  ↓
T8 Git 2.0
  ↓
T11 Web/Service/MCP
  ↓
T12 Capability Router
  ↓
T13 Production Eval
```

可有限并行：

- T8 Git 2.0 与 T9 Code Intelligence；
- T10 Verification Schema 与 T11 Web Source Schema；
- T13 测试骨架可从 T1 开始逐步添加。

禁止并行：

- T3 Run Context 与 Loop 全局状态重构冲突时；
- T5 Policy 与 File/Edit 写入路径同时大改；
- T6 File/Edit 和 T7 Shell 同时替换生产入口。

## 7. 测试命令

每个 PR 至少运行：

```bash
bun run typecheck
bun run test:core
bun run test:replay
bun run build
```

涉及 Loop、Runtime、Tool 执行时增加：

```bash
bun test tests/agent_loop.test.ts
bun run test:integration
```

涉及全量 Tool 迁移和发布候选时：

```bash
bun run test
bun run test:all
```

如果本地 package.json 命令已经变化，以本地脚本为准，并把替代命令写入 PR 报告。

## 8. Feature Flag 与迁移策略

建议配置：

```json
{
  "capabilities": {
    "mode": "legacy",
    "structuredResults": false,
    "artifactOutputs": false,
    "runScopedContext": false,
    "unifiedPolicy": false,
    "dynamicDisclosure": false
  }
}
```

迁移顺序：

```text
legacy
→ shadow
→ enabled for tests
→ enabled for CLI opt-in
→ enabled by default
→ remove legacy after two stable releases
```

Shadow 模式比较：

- 旧 Result 与新 Result；
- 旧 Policy 与新 Policy；
- 旧副作用判断与新判断；
- 旧输出大小与 Artifact；
- 旧 Tool 集合与 Router 选择。

差异记录：`capability.shadow_mismatch`。

不得影响用户当前任务。

## 9. 每个 PR 的统一交付格式

执行 Agent 每完成一个 PR，必须输出：

```text
PR 名称：
目标：
基线 Commit：
变更文件：
新增文件：
删除文件：
行为变化：
兼容策略：
测试命令：
测试结果：
未解决风险：
回滚步骤：
下一 PR 前置条件：
```

代码注释必须解释"为什么"，不重复代码本身。

## 10. 禁止事项

执行期间禁止：

- 一次性删除 `src/tools/**`；
- 新旧 Registry 双写且无权威来源；
- 把 Capability Contract 写进 loop.ts；
- 在 Tool 内部直接调用大模型做确定性任务；
- 通过 `metadata: Record<string, unknown>` 永久逃避 Output Schema；
- 把所有 MCP Tool 默认标为只读安全；
- 非交互模式自动批准高风险操作；
- 为了方便继续使用模块级 Sandbox Setter；
- Shell、Patch、MCP 分别实现不同写入边界；
- 将原始大日志持续塞回模型；
- 用 Tool 数量作为完成指标；
- 在 Tool Runtime 未稳定前实现多 Agent 或 Graph Scheduler。

## 11. 生产级 Definition of Done

Tool Runtime 2.0 完成必须同时满足：

**契约**

- 所有生产工具有 Input Schema；
- 所有生产工具有 Output Schema；
- 所有工具有版本；
- 所有工具有明确副作用和风险；
- 所有错误有标准错误码。

**隔离**

- 无模块级运行状态；
- 两个 Run 并发不串扰；
- 工具使用显式 projectRoot；
- 所有 Tool 支持统一取消。

**安全**

- 所有写入经过 WritableRootPolicy；
- 所有外部访问经过 NetworkPolicy；
- 所有高风险工具经过 ApprovalPolicy；
- Shell 默认 `shell:false`；
- MCP 未知 Tool 默认高风险。

**文件**

- Patch 有 baseHash；
- 多文件写入原子；
- 验证失败不提交；
- 失败自动回滚；
- 事务可追踪和恢复。

**结果**

- 大输出进入 Artifact；
- 模型只接收摘要；
- Verification 生成 Evidence；
- Evidence 绑定 Workspace Hash；
- 过期 Evidence 自动 stale。

**代码智能**

- TypeScript 语义定位优先；
- 文本搜索仅 fallback；
- Repo Map 能按 Token 预算生成 Context Slice。

**验证**

- 能发现项目验证命令；
- 能做定向验证；
- 能分类失败根因；
- 能验证最终声明。

**评测**

- 至少 20 个 Tool Runtime 场景；
- 全量测试通过；
- 无 P0 安全回归；
- Shadow 模式无未解释差异；
- Live Eval 显示 Token 和轮次没有明显回归。

## 12. 成本与能力验收

完成 T12 后，执行同任务对照：

```text
Legacy Tool Runtime  vs  Tool Runtime 2.0
```

最少 30 个真实任务：

- 5 个仓库定位；
- 5 个单文件修改；
- 5 个跨文件修改；
- 5 个测试失败修复；
- 5 个重构；
- 5 个长上下文任务。

记录：Pass Rate；输入 Token；输出 Token；Cache Hit；模型调用数；Tool 调用数；重复读取数；重复失败数；总耗时；无关文件修改；虚假完成；人工介入次数。

建议通过门：

- Pass Rate 不下降
- P0 安全事件 = 0
- 输入 Token 中位数下降 ≥ 25%
- 重复 Tool 调用下降 ≥ 30%
- 无进展轮次下降 ≥ 20%
- 中大型任务总成本下降 ≥ 20%

达不到时不得宣称"显著降本"；必须根据 Trace 找出：Tool Schema 过大；Artifact 读取过多；Router 选错工具；结构化结果导致额外轮次；小任务走了重 Pipeline；验证过度。

## 13. 建议实施里程碑

**Milestone A：Capability Foundation（T0–T5）**

结果：正式契约；兼容 Adapter；Run 隔离；结构化结果；Artifact；统一安全策略。

**Milestone B：Core Engineering Tools（T6–T10）**

结果：事务化 Patch；安全 Process；结构化 Git；Repo Map；Verification Planner；Failure Classifier；Claim Verification。

**Milestone C：External Capabilities（T11）**

结果：安全 Web；受托管 Service；可信 MCP 边界。

**Milestone D：Cost Optimization and Gate（T12–T13）**

结果：动态 Tool Disclosure；生产级 Tool Eval；真实成本和能力对照。

完成 Milestone D 后，才允许进入 Unified Node Runtime 和 Execution Graph 的生产接线。

## 14. 第一条执行命令

执行 Agent 收到本文件后，第一轮只做以下工作：

1. 读取 package.json、ARCHITECTURE、docs/status 和所有 Tool 入口。
2. 生成 `docs/tool-runtime/tool-inventory.md`。
3. 生成 `docs/tool-runtime/gap-analysis.md`。
4. 生成 `docs/tool-runtime/pr-map.md`，把本计划映射到本地真实文件。
5. 运行现有 typecheck、core、replay、build 测试并记录基线。
6. 不修改生产代码。
7. 输出 T0 审计报告，等待进入 PR-T1。

**T0 未通过前，禁止开始 PR-T1。**
