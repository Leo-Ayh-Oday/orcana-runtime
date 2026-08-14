# AK2-R6 Correction Gate — 独立审核证据包

**候选链（固定审核范围）：** `3be4b86..HEAD`（`3be4b86aaa9a8dab653feefc51d0df6b466efdce` 起）
**分支 / worktree：** `feat/agent-os-r6` @ `/home/fuqiang/worktrees/orcana-agent-os-r6`
**最终状态：** `READY_FOR_INDEPENDENT_AUDIT`（不写 PASS / CLOSED / AK-2 COMPLETE / READY FOR AK-3）

## 1. 提交链（父 → 子）

| Commit | 内容 | 父 |
|---|---|---|
| `43edb4a` | test(agent-os): freeze AK2-R6 counterexamples（R6-00-1..14；隔离，未 amend） | 3be4b86 |
| `2e6a1e4` | fix(agent-os): apply AK2-R6 correction fixes (R6-01..R6-07) | 43edb4a |
| `0ab6baa` | test(agent-os): reconcile AK2-R6 fixtures — structural fidelity, brands, derived digests | 2e6a1e4 |
| （下一提交） | docs(agent-os): record AK2-R6 candidate evidence | 0ab6baa |

RED commit 未 amend；修复未与 RED 混在同一提交。

## 2. 文件白名单（实际改动）

- `docs/agent-os/stages/ak-2-projection-world-commit.md`（本阶段文档）
- `docs/agent-os/evidence/ak2-r6/**`（本证据包）
- `src/kernel/projection/{contracts,coordinator,backend,broker-adapter,
  receipt-authority,plan,scanner,intent-reservation,spec-binding}.ts`
- `src/kernel/world/{contracts,schema,store,manifests,snapshot}.ts`
- `src/runtime/linux/{contracts,receipt}.ts`（仅 cellId? 与
  cellSpecDigestNormalized() 两处最小 spec-binding 必要改动；broker.ts 未改）
- `tests/kernel/projection/**`、`tests/kernel/world/**`

未触碰：`src/workflow/**`、`src/harness/**`、`src/execd/**`、
`src/kernel/effects/**`、`src/kernel/capabilities/**`、package.json/lockfile、
CI/secrets/billing、远程配置、WSL 环境。

## 3. 修复目标（R5 独立审计十项阻断）+ BASE 归因

| 阻断项 | 修复提交 | 反例/回归证据 |
|---|---|---|
| 伪造 trustLevel 获得授权 | 2e6a1e4（R6-01） | R6-00-1/2/3/6/10 GREEN |
| 结构性 fixture 冒充 production | 2e6a1e4（R6-01/R6-03） | R6-00-3/7/8/9 GREEN |
| per-coordinator registry 可重建绕过 | 2e6a1e4（R6-02） | R6-00-4/5 GREEN；R5-00-8（durable 重写）GREEN |
| 不完整 spec binding（adapter 自报） | 2e6a1e4（R6-03） | R6-00-7/8/9 GREEN；R4-00-3a/b/c GREEN |
| FUSE mount-gone-leak | 2e6a1e4（R6-05） | R4-00-6 / R3-00-4/5 GREEN |
| parent/child fd 关闭（替换目录 chmod/删除） | 2e6a1e4（R6-04） | R3-00-13 / P2-1 GREEN |
| sync executor throw 裸传播 | 2e6a1e4（R6-04） | R3-00-6/6b（cleanup 抛）GREEN |
| isManifest 派生 representation | 2e6a1e4（R6-06） | R6-00-11 GREEN；R5-00-10 GREEN |
| snapshot 先写 CAS 再查 existing | 2e6a1e4（R6-07） | R6-00-12 GREEN |
| contentRef 缺失在 delta CAS 写后才发现 | 2e6a1e4（R6-07） | R6-00-13 GREEN |
| R5-00-9 攻击未真实成功 | 43edb4a（R6-00-14 修正） | KNOWN RED：攻击真实落地 + scan fail-open 证据 |

### BASE 归因（/tmp/ak2-r6-base-check，3be4b86 检出 + frozen-lockfile）

- `coordinator.test.ts`（41 tests）：BASE 41/41 全绿 → R6 曾引入的 12 项
  失败（P0-2 ×7、R2-00-3、R2-08、R2-02、R2-01-8、cleanup 失败、R03
  unmount）全部为 R6 改动所致 → 0ab6baa 修复后 41/41 全绿。
- `r3/r4/r5-counterexamples`：BASE 53 pass / 1 fail（仅 R5-00-9 KNOWN
  RED）→ R6 引入的 9 项失败（docs-root 缺失 + gate 阻断）已修复；当前
  全绿（R6-00-14 KNOWN RED 除外）。
- `store.test.ts` AK-1「unchanged contentRef revalidated」：BASE 通过 →
  R6-07 preflight 曾把 corrupt 报成 not-in-CAS → 2e6a1e4 已区分两种
  语义，测试全绿。
- 单独 `-t` 过滤运行会因模块级 `activeAuthority` 状态产生假失败 —— 判
  定一律以整文件/整目录运行为准（test-truth 规则）。

## 4. R6-00 反例冻结（14 反例）

RED 证据（提交 `43edb4a`，基线 3be4b86）：`bun test tests/kernel/projection/
r6-counterexamples.test.ts tests/kernel/world/r6-cas-snapshot.test.ts` →
**10/10 + 3/3 全 fail**；`r5-counterexamples` 的 R6-00-14 以「攻击真实
成功 + scan 返回成功 delta」fail（非 EACCES/setup 冒充）。

| 反例 | 内容 | RED → GREEN |
|---|---|---|
| R6-00-1 | 普通对象自报 trustLevel='kernel-authenticated' → 不得获得 production commit | ✓ 2e6a1e4 |
| R6-00-2 | trustLevel undefined/unknown/错误大小写 → 构造即 fail-closed | ✓ 2e6a1e4 |
| R6-00-3 | 普通 kind:'fixture' + 普通 trustLevel:'test-harness' → 不得通过 gate | ✓ 2e6a1e4 |
| R6-00-4/5 | 独立/重建 registry 同一 intent → 只允许一个 cell | ✓ 2e6a1e4 |
| R6-00-6 | 结构化 authority 无法伪造 brand → PRODUCTION_WORLD_COMMIT_BLOCKED | ✓ 2e6a1e4 |
| R6-00-7/8 | kernel 期望 spec digest ≠ adapter 实际编译（mount/workspace）→ spawn 前拒绝 | ✓ 2e6a1e4 |
| R6-00-9 | commit 时 receipt.cellSpecDigest 必须等于 kernel 用真实 cellId 重编译 | ✓ 2e6a1e4 |
| R6-00-10 | same-uid-untrusted authority → commit fail-closed（不写 CLOSED） | ✓ 2e6a1e4 |
| R6-00-11 | 同一 raw FileManifest —— 两种顺序物化一致（representation 持久化） | ✓ 2e6a1e4 |
| R6-00-12 | existing snapshot 幂等重入零物理 CAS residue | ✓ 2e6a1e4 |
| R6-00-13 | 不存在 contentRef → commit 拒绝且零残留 | ✓ 2e6a1e4 |
| R6-00-14 | 修正 R5-00-9：攻击真实成功后 scan fail-open | **KNOWN RED**（OWNER-DECISION-REQUIRED） |

## 5. 修复记录摘要

- **R6-01** fail-close authority：WeakSet brand（test-harness authority +
  test-fixture backend）配对是唯一测试授权通道；authenticated brand 无
  mark 导出（恒 false）→ production 正向 commit 结构性被阻止。
- **R6-02** SQLite durable reservation（unique-key；跨实例/进程/重启）。
- **R6-03** kernel-owned spec compiler（spec-binding.ts）—— 期望 digest
  派生、adapter pre-spawn 规范化比对、commit 真实 cellId 重编译。
- **R6-04** retained child+parent fd；dispose fail-closed；sync executor
  throw 入状态机。
- **R6-05** wasMounted + fullOwnershipCheck（mount id/fsType/source/upper/
  daemon cmdline）；seal 重证明。
- **R6-06** representation 持久化（schema v5 + DB CHECK）；snapshot 只复
  制持久值。
- **R6-07** 快照 existing 先证明后写入；compareAndCommit 统一引用
  preflight（missing vs corrupt 区分）。
- **0ab6baa** 回归调和：docs-root 结构性保真、branded 测试配对、派生
  cellSpecDigest claim、R3-01.4 profile/expectedCellSpecDigest、AK-1
  corrupt-vs-missing 语义。

## 6. 门禁结果

- `bun test tests/kernel/projection/ tests/kernel/world/`：**305 PASS /
  1 KNOWN RED（R6-00-14）**（多轮一致）。
- `bun run typecheck`：0 error。`git diff --check`：✓。
- 全量 `bun test tests/`（4437 tests / 383 files）：11 fail + 2 errors 归因
  （BASE/HEAD 对照）：5 eval（DEEPSEEK_API_KEY 未设）、LF-2 static gate
  （R5-04/R5-05 引入的 backend.ts execFileSync —— BASE 即失败，基线外）、
  LF-1 capability probe 超时（环境）、divide 零除数（预存）、R6-00-14
  KNOWN RED；2 errors 为 workflow checkpoint 并行干扰（单独运行全绿）。
- 环境：0 mount residue、0 残留进程；worktree clean；未 push / merge / PR。

## 7. OWNER-DECISION-REQUIRED（不写 CLOSED）

1. **Execution Receipt 真实性**（same-UID authenticated receipt）：同 UID
   可改 receipt JSON + 重算公开 digest（R3-00-3 证据测试）→
   `PRODUCTION_WORLD_COMMIT_BLOCKED` 保持；authenticated verifier 需
   Owner 决策（MAC key / sealed IPC / 独立 UID）。
2. **R6-00-14 / R5-00-9 same-UID sealed upper 直写**：KNOWN RED，攻击真实
   落地后 scan fail-open —— 生产 seal authority 缺失；禁止伪造 GREEN。
3. **production 正向 B lane**：无 cgroup 委托 → `ENV_BLOCKED`。

## 7b. 独立只读审计结果（8 轮复核项全绿）

独立只读 Agent 审计（无写操作）结论：`READY_FOR_INDEPENDENT_AUDIT`。
11 项检查全部通过：链完整性（4 提交、RED 隔离、无 amend）、白名单（29
 路径全部在桶内、零越界）、门禁（305/1 KNOWN RED、typecheck 0、diff
--check 干净）、gate 语义（brand 配对、无导出面泄漏、R6-00-1/3/6/10
保持阻断）、spec binding / durable reservation / representation /
snapshot ordering / FUSE ownership 结构确认、OWNER-DECISION-REQUIRED
纪律（same-UID receipt + upper seal 不写 CLOSED）、环境（0 mount、0
进程、worktree clean）。

### 审计发现 + 反驳（逐条）

| # | 发现（严重度） | 反驳 / 处置 |
|---|---|---|
| A | cellSpecDigestNormalized 仅规范化 cellId —— 未来 authenticated verifier 的 identity/workspace envelope 若与 buildProjectionAuthority 不一致会误拒（MEDIUM，fail-closed） | 接受为潜在风险并记录：当前所有路径 envelope 同源（adapter 身份由 intent 覆盖 broker-adapter.ts:178-187；spec 只取 hostRoot/ownerFiles，与 kernel 同源），一致性由 R4-00-3a/b/c、R6-00-7/8、R3-01.4、B lane 实证；误拒方向正确（无接受路径）；修复（规范化 runId/attempt）将削弱 digest 的 runId 绑定 —— 不修复，留待 authenticated-verifier 设计 |
| B | adapter timeoutMs 回退（options.timeoutMs 兜底）与 kernel 期望可能发散（LOW，fail-closed） | 接受为潜在风险并记录：当前 wiring 不设置 options.timeoutMs；intent.command.timeoutMs 与 command.timeoutMs 恒同源（coordinator.ts:774-778），assertIntentBinding 拒绝双定义不一致；发散只会发生在未来 wiring 且方向为误拒 —— 不修复，留待 authenticated-verifier 设计 |

两项均不产生任何接受路径（只可能拒绝）；不涉及 R5 审计 Critical/High
范围；已在 stage 文档 RESIDUAL RISK 记录，不静默。

## 8. 复核指引（独立只读）

- 复现：`cd /home/fuqiang/worktrees/orcana-agent-os-r6 && bun test
  tests/kernel/projection/ tests/kernel/world/`（预期 305/1）。
- 归因对照：`/tmp/ak2-r6-base-check`（3be4b86 + node_modules）跑同一组
  测试对比。
- RED 隔离：`git show 43edb4a --stat`（仅反例 + 使反例可达的最小骨架）。
- gate 语义：R6-00-1/3/6/10 必须保持 PRODUCTION_WORLD_COMMIT_BLOCKED；
  任何把 same-UID 认证/upper seal 写成 CLOSED 的改动即为违规。
