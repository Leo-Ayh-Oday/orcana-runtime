# AK-0 Kernel Constitution / Foundation

**Task ID:** `AK0-FND-001`
**状态:** `CANDIDATE_READY_FOR_AUDIT`
**基线 / 回滚点:** `76a90ef143d97b0b0466cc118d511a3ea1f78323`
**专用分支:** `feat/agent-os`

## 目标

固定 Agent OS 的权威边界，保存总架构，形成七份架构决策，并把 authority graph 写成可自动验证的数据结构。AK-0 不实现 WorldDB、Capability Handle、Effect runtime、Semantic MMU 或分布式能力。

## 文件白名单

- `docs/agent-os/**`
- `src/kernel/authority/**`
- `tests/kernel/authority-graph.test.ts`

白名单之外的修改一律停止并重新评估。

## 验收门

```text
SECOND_TASK_AUTHORITY             = 0
SECOND_WORLD_AUTHORITY            = 0
TOOL_AS_AUTHORITY                 = 0
EXECUTION_COMPLETES_GRAPH_DIRECT  = 0
```

同时要求：

1. `bun test tests/kernel/authority-graph.test.ts` 通过；
2. `bun run typecheck` 通过；
3. `bun run build` 通过；
4. `git diff --check` 通过；
5. 候选提交后由与实现隔离的 Agent 只读审计，主 Agent 逐项复核；
6. 最终 worktree 干净。

## 停止条件

- 发现现有 Graph、Evidence 或 Linux Execution Fabric 与宪法存在不可兼容权威冲突；
- 需要修改文件白名单之外的生产代码；
- 需要提前实现 AK-1 或更后阶段的运行时能力；
- 出现需要 Owner 决定的 API、数据迁移或外部副作用。

## 回滚

AK-0 全部新增文件均可通过回退阶段提交恢复到基线；不迁移现有数据，不修改外部系统。

## 阶段记录

### FACT

- Linux 权威 checkout 交接 HEAD 为 `76a90ef143d97b0b0466cc118d511a3ea1f78323`，父提交为 `a007b7ec648b6dd8ce230634cf40d957fc619930`。
- 专用 worktree `/home/fuqiang/worktrees/orcana-agent-os` 从该 HEAD 创建。
- `architecture.md` 从共享 checkout 复制后双端 SHA-256 均为 `fe13c8c03d96d6083ce361322e9b740b9e714343b5082f7a50dc6217814d5f73`。
- SocratiCode 因 `localhost:6333` 的外部 Qdrant 不可达而无法索引；本阶段回退到限定范围的精确文件读取。
- `bun test tests/kernel/authority-graph.test.ts`：4 pass / 0 fail。
- `bun run typecheck`：通过。首次检查发现 `as const` 异构数组的 `includes()` 参数被收窄为 `never`；已在白名单内修复并重新通过。
- `bun run build`：通过。
- GitHub hosted Actions 未运行；已知账号 billing lock 仍会在 0 steps 阶段阻塞远程 CI。
- Live/provider 测试未运行，本阶段不声称其通过。

### INFERENCE

- 现有 Graph、Evidence 与 Linux Execution Fabric 已有明确权威边界，AK-0 应固化这些边界而不是建立第二套完成或执行权威。

### PROPOSAL

- AK-1 只在 AK-0 审计关闭后开始，并保持 `src/workflow/` 与 `src/runtime/linux/` 的既有职责不变。

### OWNER-DECISION-REQUIRED

- 无。

## 验证与审计证据

阶段候选提交、审计发现、修复与残余风险在审计关闭提交中补录。
