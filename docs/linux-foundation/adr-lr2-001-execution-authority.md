# ADR-LR2-001 Execution Authority

**状态：** 提案（LR2-0 Batch A 冻结）
**计划：** [Linux Runtime 2.0 可执行总计划](linux-runtime-2.0-plan.md)
**关联：** [ADR-L1](architecture-decisions.md)（Linux 子进程单一入口）、[ADR-LR2-002](adr-lr2-002-cell-state-machine.md)、[ADR-LR2-003](adr-lr2-003-receipt-evidence-boundary.md)

## 背景

LNXF-1.0 修复线（R0~R2 + PR-9/10/11）已收敛大部分执行原语，但执行权威仍分裂：

- `getLinuxBroker()` 默认创建 `shadow` 模式 Broker，产品级进程未全部进入统一执行链；
- Broker 的取消/清理虽已真实现，但 `ExecutionGateway` 层尚不存在——`run_process`/`run_shell_script` 等工具仍通过 `process-executor` 直接调用 broker，而 Git/TypeScript/MCP/LSP/Service 等模块存在直接 `node:child_process` 导入；
- 没有明确的权威边界声明，"谁批准、谁完成"的关系未被固化。

## 决策

固定以下权威关系（只读、不可被模型/工具参数反向影响）：

```text
Graph              = 任务依赖与完成权威
Harness            = 权限与副作用批准权威
ExecutionGateway   = 所有运行请求的唯一入口
orcana-execd       = Linux 进程、cgroup、容器、缓存和运行状态权威
Receipt            = 已发生执行事实
Evidence           = Receipt 对任务结论的解释与绑定
```

1. **ExecutionGateway 是唯一执行入口**：任何产品级进程执行请求（tool、Git、TypeScript、验证、CodeGraph、Worktree、Service、MCP、LSP）必须经 `ExecutionGateway.execute(intent, context)`，最终到达 Broker / execd。
2. **Agent Domain、Execution Cell、Service Cell 只是 Graph Assignment 的执行投影**，不能反向成为任务完成权威。
3. **ExecutionContext 只能由 Harness 与 Graph Runtime 构造**：模型或 Tool 参数不得直接提供宿主 mount source、cgroup 路径、Backend argv、seccomp 文件路径、真实秘密值、缓存宿主路径、任意网络 namespace、`allowDegradation=true`。这些必须由 Policy Compiler 从受信输入生成。
4. **迁移开关**：`shadow`（双编译比较）→ `enabled`（默认 Broker，基础设施故障可回退但必须生成 Degradation Evidence）→ `enforced`（禁止旧路径，Broker 不可用即失败）。
5. **完成链**：`ToolResult + Final Receipt + Verification Evidence + Ownership Evidence → Node Completion Gate`。写节点完成条件：`exitCode 满足要求 AND Receipt 完整 AND 无未批准写入 AND Cleanup 满足策略 AND Verification 通过`。服务节点进入 `SERVICE_READY`，不使用短任务完成语义。

## 影响

- 新增 `src/runtime/execution/`（execution-gateway / intent / context / result / errors）；
- 迁移顺序：`process.ts` + `shell.ts` → Git → TypeScript/test → Verification → CodeGraph/ast-grep → Worktree → MCP/LSP/Service；
- 现有 `LinuxExecutionBroker` 保留为 Gateway 的 Linux 后端，不删除旧路径（shadow 期间并存）；
- Gate：`DIRECT_PRODUCT_PROCESS_BYPASS = 0` / `UNCLASSIFIED_CHILD_PROCESS_IMPORT = 0`。

## 不变量

- 模型/Tool 参数不携带宿主路径、cgroup 路径、Backend argv、seccomp 路径、秘密值；
- 每次执行可回答：谁批准、属于哪个 Run/Node/Agent/Attempt、预留了什么资源、进入哪个 cgroup、看到哪些文件、网络权限、工具链与缓存、产生哪些写入、为何退出、是否真正清理。
