# Tool Runtime 2.0 交接文档（2026-08-05，RT-1..13 全部完成，v0.5.10–v0.5.22）

执行线：`docs/tool-runtime/execution-plan.md` v1.2（RT-1..13 实施记录已追加）。规则：一个 RT 一个 patch 版本，五门禁 → commit → push → gh release → npm publish。

## 1. 当前状态总览

| RT | 版本 | 内容 | 状态 |
|---|---|---|---|
| RT-1 | v0.5.10 | 契约补强：26 错误码 / ToolExecutionResult 6 状态 / retry / ToolExecutionContext / schema-validator 共享 | ✅ 已发布 |
| RT-2 | v0.5.11 | 能力模式 flag（legacy/shadow/enabled）+ shadow 差异事件 | ✅ 已发布 |
| RT-3 | v0.5.12 | kernel projectRoot 显式化 + context 直达 handler + 并发隔离测试 | ✅ 已发布 |
| RT-4 | v0.5.13 | output-limiter（大输出→artifact）+ 首批 output schema | ✅ 已发布 |
| RT-5 | v0.5.14 | policy 模块化（writable-root/network/risk/approval/concurrency）| ✅ 已发布 |
| RT-6 | v0.5.15 | apply_patch / apply_patch_transaction / edit_symbol / read_file selectors | ✅ 已发布 |
| RT-7 | v0.5.16 | run_process / run_shell_script（shell:false 参数化）| ⚠️ **已 commit 未发布** |
| RT-8 | v0.5.17 | git porcelain=v2 结构化 + numstat + 写工具风险分离 | ⚠️ **已 commit 未发布** |
| RT-9 | v0.5.18 | repo map（build/query/context-slice，compiler-AST）| ⚠️ **已 commit 未发布** |
| RT-10 | v0.5.19 | verification 工具链（discover/targeted/classify/verify_claim）| ⚠️ **已 commit 未发布** |
| RT-11 | v0.5.20 | Web/Service/MCP 硬化（SSRF DNS/IP 逐跳复查、流式上限+压缩炸弹、缓存模式分离、提示注入标记；ServiceLease runId+cleanupPolicy+run 结束回收；MCP TrustPolicy 未知工具默认非只读高风险）| ✅ 已 commit 未发布 |
| RT-12 | v0.5.21 | Capability Router 动态披露（Stable Core + Specialist 分层、token 估算、bootstrap toolDisclosure）| ✅ 已 commit 未发布 |
| RT-13 | v0.5.22 | Tool Production Eval（TL-001..020）+ executor trace 成对修复 | ✅ 已 commit 未发布 |
| 收尾 | — | **README.md + README.zh.md 更新**（Tool Runtime 2.0 章节 + 状态表）| ✅ 已完成（ec31640） |

## 2. 发布阻塞：用户 TUI 工作区（重要）

**v0.5.16–0.5.22 已 commit 但未 push/release/publish（共 7 版积压）。原因：用户在本会话期间自行重构 TUI（未完成状态），`bun run build` 因 `src/tui/` 引用不存在的模块失败。**

**处理规则：绝不修改/提交 `src/tui/**`（用户工作区，与 demo/、docs/gui-*.html 同级的用户文件）。** 发布流程中 npm publish 会跑 prepack build → 失败。等用户 TUI 修复后：
1. `bun run build` 通过 → 逐个发布 v0.5.16 → v0.5.22（每次：feature 已 commit，版本 bump + CHANGELOG 条目**已写入**，只需 push → gh release → npm publish）
2. package.json 当前 0.5.22，CHANGELOG 已覆盖到 v0.5.22（含 RT-8/9/10 补写条目）

**受限门禁**（TUI 破损期间）：`bun test tests/tools/ tests/capabilities/ tests/harness-replay/ tests/tool_contract.test.ts tests/tool_policy.test.ts tests/tool_risk.test.ts`（341 tests 全绿）；typecheck 非 tui 错误 0（`src/tui/`、`tests/tui/` 内错误属用户工作区，忽略）。

**本环境限制**：WSL 镜像网络把 127.0.0.1 路由到 Windows 主机，localhost TCP 集成测试不可行——`safeHttpGet`（`connect` hook）与 service readiness（`waitForHttp` deps）有仅测试用注入点；生产路径 fail-closed 不受影响。

## 3. 已完成阶段的关键文件

| RT | 文件 |
|---|---|
| RT-1 | `src/harness/capabilities/{errors,result,retry,execution-context,schema-validator}.ts` + `contracts/capability.ts` |
| RT-2 | `src/harness/capabilities/flags.ts` + `contracts/events.ts`（capability.shadow_mismatch）|
| RT-3 | `src/agent/loop-types.ts`（AgentOptions.projectRoot）+ `kernel/context.ts` + `capabilities/executor.ts`（context 字段）+ `nodes/tool-node.ts` |
| RT-4 | `src/harness/capabilities/{output-limiter,output-schemas}.ts` + executor Step 6.5 |
| RT-5 | `src/harness/capabilities/policy/{writable-root,network,risk,approval,concurrency}-policy.ts` + `agent/tool-execution/policy.ts` 编排 |
| RT-6 | `src/tools/{apply-patch,file(edit_symbol/read_file 增强)}.ts` |
| RT-7 | `src/tools/process.ts` + `service.ts`（shell:false）+ `registry.ts`（Result.failWithMetadata）|
| RT-8 | `src/tools/git.ts`（parsePorcelainV2 + numstat + requiresConfirmation）|
| RT-9 | `src/tools/repo-map.ts` |
| RT-10 | `src/tools/verification.ts` |
| RT-11 | `src/tools/{web-safe,webfetch,service}.ts` + `src/mcp/{trust-policy,config,bridge}.ts` + `src/harness/runtime/run-registry.ts`（run-end 回收）|
| RT-12 | `src/harness/capabilities/router.ts` + `src/runtime/bootstrap.ts`（toolDisclosure）|
| RT-13 | `tests/capabilities/tool_production_eval.test.ts` + `src/harness/capabilities/executor.ts`（trace 成对修复）|

## 4. 待办（上下文恢复后按序执行）

1. **发布积压 7 版**：v0.5.16→v0.5.22（bump + CHANGELOG 已写入，只差 push + gh release + npm publish；gh.exe 在 `/mnt/c/Users/ZhuanZ（无密码）/AppData/Local/Programs/gh/bin/gh.exe`；npm token `--userconfig "/mnt/c/Users/ZhuanZ（无密码）/.npmrc`）。前提：TUI build 修复。
2. **TUI 修复后补跑**：`bun run build`、`npm pack --dry-run`、`bun run eval:replay`（12 HR 场景）、全量 `bun run test` + typecheck（含 tui 错误清零）。
3. **后续计划线**：Tool Runtime 2.0 已全部完成（RT-1..13）。下一步为 Harness 计划线 H10 Context Pipeline（见 docs/harness-2.0-plan.md），或按用户点名推进。

## 5. 重要约定（勿忘）

- **显式 git add，绝不 `git add -A`**（src/tui/、tests/tui/、demo/、docs/gui-*.html、a.txt、new1.txt、src/a.ts 是用户文件）
- commit 前缀 `feat:/fix:/docs:` + `(RT-N, v0.5.x)`；版本 commit `chore: release v0.5.x (Tool Runtime RT-N)`
- 每版五门禁：typecheck / test / build / `npm pack --dry-run` / `git diff --check`
- evals 门禁：`bun run eval:replay`（12 HR 场景）——TUI 修复后也要跑
- 指纹快照：新增工具必须更新 `tests/tool_contract.test.ts` 的 stable fingerprints 数组（按 BUILTIN_TOOL_DEFS 顺序）
- 用户偏好：发布前不询问；每阶段直接提交；版本号最后一位叠加
- WSL 环境：127.0.0.1 被路由到 Windows 主机，本机 localhost 网络集成测试不可行（用注入点测试）
