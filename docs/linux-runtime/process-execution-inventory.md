# 进程执行点 Inventory（LR2-0C）

**计划：** [Linux Runtime 2.0 可执行总计划](../linux-foundation/linux-runtime-2.0-plan.md) LR2-0C
**Gate：** `DIRECT_PRODUCT_PROCESS_BYPASS = 0` / `UNCLASSIFIED_CHILD_PROCESS_IMPORT = 0`
**检查脚本：** `bun scripts/check-process-bypass.ts`（CI 违例 exit 1）
**允许清单：** `config/runtime-process-bypass-allowlist.json`（单一事实源）

## 现状（扫描于 2026-08-08，`bun scripts/check-process-bypass.ts --list`）

LNXF R1 统一入口迁移后，`src/` 下直接进程执行点已收敛为 **8 文件 19 点**，全部位于统一执行链内：

| 文件 | 执行点 | 分类 |
|---|---|---|
| `src/runtime/linux/process/supervisor.ts` | spawn@67 | C — Broker 内部（唯一真实 spawn 后端） |
| `src/runtime/linux/process/termination.ts` | spawnSync@64（ps fallback） | C — Broker 内部 |
| `src/runtime/linux/broker.ts` | spawnSync@330/338/340（podman/bwrap 探测） | C — Broker 内部 |
| `src/runtime/linux/capability-probe.ts` | spawnSync@106~184（7 点，系统能力探测） | C — Broker 内部（固定只读命令） |
| `src/runtime/linux/service-cell.ts` | spawn@98 | C — Broker 内部（Service Cell，LR2-5 迁移为 Durable Service Cell） |
| `src/runtime/process-executor.ts` | spawn@113/178（Windows legacy + taskkill） | A — 统一入口（Linux 经 Broker；Windows 保留 legacy） |
| `src/runtime/legacy-process.ts` | nodeSpawnSync@30 / nodeSpawn@39 / nodeExecSync@44 | A — 暂存区（sync/长期进程，显式标注，待迁移） |
| `src/tools/process.ts` | spawn@56（Windows taskkill 辅助） | A — run_process 工具入口（Linux 经 Broker） |

## 四类分类（对照计划 LR2-0C）

### A. 必须进入 Broker（已迁移，R1）

- `run_process` / `run_shell_script`：经 `process-executor.ts` → `LinuxExecutionBroker`（enabled 模式）→ Backend → Receipt；
- Git / TypeScript / 测试 / CodeGraph / Verification / Worktree / 开发服务：经统一入口，**不再直接 import `node:child_process`**（AST 门禁保证）；
- 遗留：`legacy-process.ts` 暂存区（R1.2 标注，待全部迁移后移除）。

### B. 应升级为 Durable Service Cell（LR2-5 目标）

- MCP Server、LSP Server、开发服务器、长期监听器、本地数据库 —— 现经 Service Cell / 工具层执行，LR2-5 建立独立 Service 状态机与 Lease 合同后迁移。

### C. Broker 内部允许执行（allowlist）

- Bubblewrap / Podman 后端、`orcana-cell-init`（LR2-4）、网络代理、系统能力探测中的固定只读命令；
- 文件范围：`src/runtime/linux/**`（supervisor/termination/broker/capability-probe/service-cell/backends）。

### D. 非产品 Runtime

- 发布脚本、代码生成脚本、测试夹具、本地开发工具 —— `scripts/`、`bin/`、`evals/` 不在扫描范围（CI 仅强制 `src/`）。

## Gate 语义

```text
任何 src/ 下新增 node:child_process / Bun.spawn / Deno.Command / shell:true import
→ 默认失败（exit 1）

只有 allowlist 中的 Broker 内部文件
→ 可以通过

allowlist 条目无真实执行点（入口被删）
→ 失败（防"删掉入口"式假绿）
```

## 变更流程

1. 新增产品进程执行需求 → 经 `ExecutionGateway`（LR2-0D）→ Broker，禁止直接 import；
2. 确实属于 Broker 内部的固定只读命令 → 先提交 inventory 变更 + allowlist 条目，再合并代码；
3. 运行 `bun scripts/check-process-bypass.ts` 验证 Gate 归零。
