# AK-0 Kernel Constitution / Foundation

**Task ID:** `AK0-FND-001`
**状态:** `ACCEPTED`
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

并要求 canonical conformance report：

```text
authorityAssignmentViolations = []
unexpectedEdges               = []
missingRequiredEdges          = []
forbiddenRelations            = []
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

- 候选提交：`cf36ee6461a3552b2b3ba95c6b4238f0c34791e9`；父提交：`76a90ef143d97b0b0466cc118d511a3ea1f78323`。
- 独立只读审计结论：`CHANGES_REQUIRED`。
- High：`SECOND_TASK_AUTHORITY` 未覆盖 Task definition/dependency；确认成立。
- High：`SECOND_WORLD_AUTHORITY` 未覆盖 Execution Fabric 等非 Kernel World mutation edge；确认成立。
- High：`TOOL_AS_AUTHORITY` 使用不完整 privileged-operation denylist；确认成立。
- Medium：反例测试未覆盖可表达的绕过路径；确认成立。
- Low：`Task State` 在 World 中的文字可能被误解为权威状态；确认成立。
- 修复策略：Task 三域与 task edge fail-closed；World mutation 与 Tool edge 使用精确 allowlist；建模 `remote_worker`；增加表驱动 owner/edge mutation tests；明确 Task projection 为 non-authoritative。
- 审计 Agent 未修改文件、未运行测试或启动服务；主 Agent 负责修复与复验。
- 第二名独立只读代码审计结论：`FAIL`；独立复现上述 3 个 High，并新增 Medium：任何 Execution Fabric→Graph edge 都应 fail-closed、canonical authority 常量需要运行时冻结、全 authority domain 需要结构自检。
- 第一轮审计修复后 Bun 运行测试为 10 pass / 0 fail，但 typecheck 因 readonly tuple 断言失败；该轮不计为通过，继续修复。
- 第二轮修复增加全域 `authorityAssignmentViolations`、unexpected/missing edge 报告、Execution Fabric→Graph 全边拒绝与 canonical data runtime freeze。
- 最终主代理复验：`bun test tests/kernel/authority-graph.test.ts tests/gate04_authority.test.ts` 为 13 pass / 0 fail；`bun run typecheck` 通过；`bun run build` 通过；`git diff --check` 通过。
- `architecture.md` 仅对三处 Task State 增加 non-authoritative Graph projection/reference 限定；修复后 SHA-256 为 `ad8fbd2ac32605792ecfc0309301246648c1628c9d7e8da442dca17c67a4a84e`。
- 审计修复提交：`a939b26ea16694e8d8a61a259615b2c433501440`；父提交：`cf36ee6461a3552b2b3ba95c6b4238f0c34791e9`。
- 独立只读复审结论：`PASS`，无未关闭 findings；复审逐项验证两轮审计发现、最终白名单、提交链和 clean worktree。
- 残余风险：`evaluateAuthorityConformance` 在 AK-0 仅由 conformance tests 使用，尚未接入生产 gate；外部 JSON 的运行时 schema 验证属于后续接入范围。
- 分层状态：本地定向/回归测试、typecheck、build 已通过；hosted CI 因外部 billing lock 未执行；live/provider 未执行；未 merge main、未 push、未发布。
