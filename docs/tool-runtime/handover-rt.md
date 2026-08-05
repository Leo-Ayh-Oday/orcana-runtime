# Tool Runtime 2.0 交接文档（2026-08-05，RT-1..10 完成）

执行线：`docs/tool-runtime/execution-plan.md` v1.1（本地现状对齐版）。规则：一个 RT 一个 patch 版本，五门禁 → commit → push → gh release → npm publish。

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
| RT-11 | v0.5.20 | Web/Service/MCP 硬化 | ❌ 待做 |
| RT-12 | v0.5.21 | Capability Router 动态披露 | ❌ 待做 |
| RT-13 | v0.5.22 | Tool Production Eval（TL-001..020）| ❌ 待做 |
| 收尾 | — | **README.md + README.zh.md 更新**（用户明确要求，Tool Runtime 2.0 相关内容）| ❌ 待做 |

## 2. 发布阻塞：用户 TUI 工作区（重要）

**v0.5.16–0.5.19 已 commit 但未 push/release/publish。原因：用户在本会话期间自行重构 TUI（未完成状态），`bun run build` 因 `src/tui/` 引用不存在的模块失败：**

- `src/tui/clock.ts` 被删除，但 `main.tsx` / `components/AppShell.tsx` 仍 import `./clock`
- 新增 `src/tui/app/`（useOverlayController.ts 等）引用不存在的 `./state/tui-store`、`./state/adapter-helpers`、`./overlays`
- 新增未完成文件：`src/tui/motion.ts`、`src/tui/overlays.ts`、`src/tui/render-metrics.ts`、`src/tui/state/`（新建目录）

**处理规则：绝不修改/提交 `src/tui/**`（用户工作区，与 demo/、docs/gui-*.html 同级的用户文件）。** 发布流程中 npm publish 会跑 prepack build → 失败。等用户 TUI 修复后：
1. `bun run build` 通过 → 逐个发布 v0.5.16 → v0.5.19（每次：feature 已 commit，只需 `chore: release` bump → push → gh release → npm publish）
2. 版本 bump 和 CHANGELOG 条目**尚未写入**（package.json 仍 0.5.15，CHANGELOG 只有到 v0.5.15）

**受限门禁**（TUI 破损期间）：`bun test tests/tools/ tests/capabilities/ tests/harness-replay/ tests/tool_contract.test.ts tests/tool_policy.test.ts tests/tool_risk.test.ts`（166 tests 全绿）；typecheck 忽略 `src/tui/` 错误（约 20 个，全部在 tui 内，非本项目错误）。

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

## 4. 待办（上下文恢复后按序执行）

1. **发布积压 4 版**：v0.5.16→v0.5.19（bump package.json + CHANGELOG 条目 + push + gh release + npm publish；gh.exe 在 `/mnt/c/Users/ZhuanZ（无密码）/AppData/Local/Programs/gh/bin/gh.exe`；npm token `--userconfig "/mnt/c/Users/ZhuanZ（无密码）/.npmrc"`）。前提：TUI build 修复。
2. **RT-11（v0.5.20）Web/Service/MCP 硬化**：
   - `src/tools/webfetch.ts`：SSRF/IP policy（DNS 解析后检查私网/回环/link-local/IPv6/云 metadata）、重定向逐跳复查、压缩炸弹、流式字节上限、缓存 key 含 summarize/mode、提示注入标记
   - `src/tools/service.ts`：ServiceLease（runId 绑定 + cleanupPolicy）
   - `src/mcp/`：TrustPolicy（trust/allowedPatterns/deniedPatterns/defaultRiskLevel/allowOpenWorld；未知工具默认非只读高风险 + 首次执行审批）
3. **RT-12（v0.5.21）Capability Router**：Stable Core（read_file/inspect_file/run_process/apply_patch/git_status/verify_claim）+ Specialist 分层披露；token 预算；MCP 延迟加载。注意：`verify_claim` 与 `inspect_file` 是计划名——inspect_file 尚未创建（可用 read_file selector 或新建）。
4. **RT-13（v0.5.22）Tool Production Eval**：TL-001..020 场景（`tests/tools/` 或 `evals/harness` 复用 trace-assertions），至少 20 个场景 + 无 P0 安全回归。
5. **README.md/README.zh.md 更新**（用户明确要求）：Tool Runtime 2.0 能力（新工具、错误码、mode flag、policy 模块）写进首页文档。
6. **计划文档**：RT 全部完成后在 execution-plan.md 追加实施记录。

## 5. 重要约定（勿忘）

- **显式 git add，绝不 `git add -A`**（src/tui/、demo/、docs/gui-*.html 是用户文件）
- commit 前缀 `feat:/fix:/docs:` + `(RT-N, v0.5.x)`；版本 commit `chore: release v0.5.x (Tool Runtime RT-N)`
- 每版五门禁：typecheck / test / build / `npm pack --dry-run` / `git diff --check`
- evals 门禁：`bun run eval:replay`（12 HR 场景）——TUI 修复后也要跑
- 指纹快照：新增工具必须更新 `tests/tool_contract.test.ts` 的 stable fingerprints 数组（按 BUILTIN_TOOL_DEFS 顺序）
- 用户偏好：发布前不询问；每阶段直接提交；版本号最后一位叠加
