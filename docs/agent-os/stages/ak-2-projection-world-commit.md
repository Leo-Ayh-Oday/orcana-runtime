# AK-2 Projection + World Commit

**Task ID:** `AK2-PROJECTION-001`
**状态:** `READY_FOR_INDEPENDENT_AUDIT`（AK2-R5 Correction Gate 候选提交链 `b7d15db..HEAD`；等待独立复审；不等于 PASS/CLOSED，不得进入 AK-3）
**基线 / 回滚点:** `e224ad6bb8aed5cca2d1b8b63f048333cfb88003`
**专用分支:** `feat/agent-os`（R5 专用：`feat/agent-os-r5` @ `/home/fuqiang/worktrees/orcana-agent-os-r5`）

## 目标

实现第一条最小完整 Projection 链：固定 World Snapshot 物化为临时 native projection，Linux Execution Fabric 只在 projection 内执行，Delta Scanner 产生 content-addressed delta，Commit Validator 在 World mutation 前验证 revision、写入范围与预期输出，最后通过现有 `compareAndCommit()` 生成 WorldCommitReceipt。

AK-2 不实现 Capability Handle、Effect Kernel、Graph Completion、自动 merge、live WorldFS、remote worker 或 World branch merge。Linux execution 成功只允许进入 `DELTA_READY/COMMIT_PENDING`，不能直接完成 Graph。

## 文件白名单

- `docs/agent-os/stages/ak-2-projection-world-commit.md`
- `src/kernel/projection/**`
- `src/kernel/world/contracts.ts`
- `src/kernel/world/cas.ts`
- `src/kernel/world/store.ts`
- `tests/kernel/projection/**`
- `tests/kernel/world/store.test.ts`
- `tests/kernel/world/snapshot-recovery.test.ts`

如发现必须修改 `src/runtime/linux/**`，先停止实现并以 `PROPOSAL` 记录精确原因、文件和不变量；未经重新核定白名单不得写入。`src/workflow/**`、`src/harness/**`、`src/execd/**` 不在本阶段写入范围。

## 最小实现范围

1. 定义冻结且 runtime-validated 的 `WorldProjectionPlan`、Projection/Execution/World/Effect/Evidence 正交状态和 receipt。
2. 只实现 `mode=native`；`direct/live` 保留为 ABI 枚举并明确 fail-closed，不伪装已实现。
3. 从 plan 指定的 immutable snapshot 物化 regular file/directory base；路径必须为规范化相对路径，拒绝绝对路径、父目录、NUL、反斜杠、symlink/device/FIFO 与重复 path。
4. native backend 优先 OverlayFS，允许在无 mount authority 的权威 Ubuntu/WSL 环境使用已安装的 `fuse-overlayfs`；backend 只决定执行位置，不改变 plan 写权限。
5. Delta Scanner 基于 immutable base 与 merged view 产生 deterministic create/write/delete/rename；所有内容在 World commit 前进入 CAS。
6. Commit Validator 验证 snapshot/world/branch/base revision、writable roots、readonly roots、expected outputs、unexpected writes 和 execution receipt outcome。
7. Delta 转换为 World mutations，保留已有 object identity/metadata；stale head 返回 `WORLD_HEAD_MOVED`，第一版不自动 merge。
8. World commit 的 `deltaDigest` 必须对应 CAS 中 canonical mutation bytes，并在同一 WorldDB transaction 建立 authoritative CAS link。
9. 提供 Linux Broker adapter；其 receipt 只证明 Execution，不提供 Graph/Evidence completion authority。
10. 第一条纵向测试：revision 0 的 TypeScript 文件 → native projection → Linux execution 修改 → Delta → World commit revision 1 → snapshot/receipt/integrity 验证。

## 验收门

```text
CELL_DIRECT_WORLD_MUTATION       = 0
UNAUTHORIZED_WORLD_WRITE         = 0
STALE_PROJECTION_COMMIT          = 0
DELTA_WITHOUT_CAS                = 0
WORLD_COMMIT_WITHOUT_RECEIPT     = 0
EXECUTION_SUCCESS_AUTO_COMPLETE  = 0
```

同时要求：

1. projection base immutable，执行环境无 WorldDB/CAS authority path；
2. projection cleanup 在成功、失败、取消、validation reject 和 conflict 路径均执行；
3. Delta/receipt/commit digest deterministic，rename 推断只在唯一同 digest pair 时发生；
4. expected output 缺失、readonly write、path escape、symlink output、stale snapshot/head 全部 fail-closed；
5. execution `exitCode=0` 后、World commit 前的状态可观测为未完成；
6. 最相关 projection/world/Linux tests、`bun run typecheck`、`bun run build`、`git diff --check` 通过；
7. 独立只读 Agent 审核通过，最终 worktree 干净。

## 停止条件

- 需要新增生产依赖；
- 需要改变 WorldDB schema 或选择不兼容 migration；
- 需要把 Capability/Effect/Evidence/Graph 权威提前塞入 Projection；
- 需要 root mount、重启 WSL、清理非本任务进程或修改宿主安全配置；
- 现有 Linux Broker 无法在不放宽 authority 的前提下执行 projection；
- 无法在 commit transaction 内绑定 delta CAS 与 World receipt。

## 回滚

AK-2 的阶段提交可整体回退到 `e224ad6bb8aed5cca2d1b8b63f048333cfb88003`。Projection 目录为临时计算投影；测试与失败路径必须卸载并清理。没有外部 effect、生产数据迁移、main merge、push 或发布。

## 阶段记录

### FACT

- AK-1 closure commit `e224ad6bb8aed5cca2d1b8b63f048333cfb88003` 已获独立 `FINAL PASS`，专用 worktree 起点干净。
- 当前 Ubuntu/WSL 环境存在 `/usr/bin/fuse-overlayfs`；native kernel mount authority 未作假设。
- 现有 Linux Execution Fabric 已有 TrustedExecutionAuthority、WorkspaceAuthorityRegistry、Broker receipt 和跨进程 workspace lease；AK-2 只通过其公开执行边界消费，不把 backend 当授权系统。
- SocratiCode 当前无可调用入口，代码导航回退为限定范围的 `rg` 与精确读取。

### INFERENCE

- World object 的 `contentRef` 可直接物化 regular-file bytes；Projection 不把 Git branch 当 World authority。
- `world_commits.delta_digest` 已可承载 canonical mutation bytes 的 CAS digest，无需修改 WorldDB schema；必须补 authoritative CAS root/link 与完整性验证。

### PROPOSAL

- Projection Coordinator 持有状态机与 cleanup；Linux Broker adapter 只返回 SandboxReceipt，不得调用 WorldStore。
- native projection backend 以注入接口隔离实现/测试；生产实现选择 OverlayFS/fuse-overlayfs，测试可用受同一 path/delta invariants 约束的确定性 backend fixture。

### OWNER-DECISION-REQUIRED

- **R3-01.6：Execution Receipt 真实性**。当前 authority 基于「公开 SHA-256
  digest + 文件系统权限」—— 同 UID 攻击者可修改 receipt JSON 并重算公开
  digest（R3-00-3 证据测试证明伪造被接受）。R3 已关闭大部分篡改面
  （receipt 与 coordinator outcome 的 exitCode/timedOut/cancelled/violations
  对账；intent binding 打破跨 World/session 重放），但 **cleanup truth 字段
  的篡改**（mountsReleased/cleanupVerified 等）仍无法在无密钥方案下区分
  真伪。可靠修复需要独立 UID / 受保护 daemon / MAC key / 可信 IPC ——
  该子项标记 **OWNER-DECISION-REQUIRED**；production 路径保持 fail-closed
  （cleanup proof 不可得 → World commit 拒绝），不得用权限位或公开 hash
  冒充真实性。

## AK2-R3 Correction Gate 记录（候选提交链，等待独立复审）

### R3-00 反例冻结（17 红 → 17 绿 + 2 证据测试）

| 反例 | 内容 | RED→GREEN |
|---|---|---|
| R3-00-1 | production backend + token + receiptless 拒绝（token 不越过 backend.kind 门） | ✓ |
| R3-00-2 | final receipt exitCode/timedOut/cancelled/violations 与 outcome 冲突拒绝 | ✓ |
| R3-00-3 | 同 UID 篡改+重算公开 digest 被接受 —— **OWNER-DECISION-REQUIRED 证据** | 证据 |
| R3-00-4/5 | execute 后 / scan 前 ownership 丢失 → 终态 + cleanup + receipt | ✓ |
| R3-00-6/6b/6c | scan/commit/cancel 中 cleanup() 抛异常 → 确定终态 + receipt | ✓ |
| R3-00-7 | start→cancel→execute/scan/commit 全拒绝复用（CLEANED_SESSION_REUSED） | ✓ |
| R3-00-8 | foreign mount 替换 → cleanup 拒绝卸载/删除 foreign（真实 FUSE） | ✓ |
| R3-00-9 | commit 后 runtime receipt 删除 + verifyIntegrity/gc → CAS receipt 保留 | ✓ |
| R3-00-10/10b | stale/idempotency conflict 无虚假 world_commit link | ✓ |
| R3-00-11 | namespace：../x、a//b、跨 commit file-parent、祖先缺失全拒绝 | ✓ |
| R3-00-12/12b | onFileReadAfter 期间改/增 sibling → terminal barrier 拒绝 | ✓ |
| R3-00-13 | root 内 symlink swap → 外部 sentinel 不被 chmod/delete（fd 锚定删除） | ✓ |
| R3-00-14 | scanner race 测试提前 return 修复（独立场景 + 精确错误码） | ✓ |
| R3-00-15 | B lane：未知 commit error 必须失败，只有 cleanup-proof 类归类 ENV_BLOCKED | ✓ |

### R3-01 Execution Receipt 信任边界

- 移除公开 `allowFixtureExecution` 绕过（保留为内部兼容字段）：fixture
  执行必须 `FIXTURE_EXECUTION_TOKEN`（test-only 导出）+ `backend.kind ===
  "fixture"` 双重门；production backend 永不满足。
- coordinator 独立派生 expected binding（worldId/branchId/snapshotId/
  projectionId/sessionNonce/mergedRootIdentity/command/scopeDigest ——
  intent 真源）；adapter 测试证明 spec 编译与 intent.command/scope 完全一致。
- final receipt 与 outcome 对账（exitCode/timedOut/cancelled/violations/
  unexpectedWrites）—— 冲突拒绝（EXECUTION_RECEIPT_BINDING_MISMATCH）。
- 真实性缺口（cleanup truth 篡改）→ OWNER-DECISION-REQUIRED（见上）。

### R3-02 统一 lifecycle terminalizer

- `terminalize()`：唯一终态化路径（永不抛）—— execute throw/failure/
  cancel、ownership 丢失（execute 后/scan 前）、scan 失败、validation
  失败、WORLD_HEAD_MOVED、compareAndCommit 失败、explicit cancel、
  cleanup 抛异常 —— 全部产生确定终态 + cleanupState（结构化错误）+
  terminal receipt。
- post-commit reconciliation 比较**完整 canonical commit request**
  （store.computeCommitRequestDigest 对账），不只凭 commitId 存在。

### R3-03 mount / projection root ownership

- foreign mount / mount identity mismatch → cleanup 立即 return failure，
  禁止 unmount、禁止 rm/chmod upper/work/merged（真实 FUSE 验证）。
- 删除前复核 mount 已消失（fusermount exit 0 ≠ 已卸载）。
- projection root 删除改为 fd 锚定（open O_NOFOLLOW|O_DIRECTORY → 递归
  fd 相对 unlink/rmdir + fchmod）—— lstat 后 pathname 递归删除禁止；
  symlink 子项不跟随（外部 sentinel 不被 chmod/delete）。

### R3-04 receipt CAS durability

- execution_receipt_ids 进入 authoritativeReferences/reachability（gc 保护）。
- owner link 只在 compareAndCommit 事务成功路径建立（stale/idempotency
  失败无虚假 link）；事务前只做存在性 fail-fast。
- verifyIntegrity 检查 commit row / CAS object / world_commit link 三者一致。

### R3-05 World 最终 namespace 校验

- 事务内、写库前：current world_objects → 内存应用全部 mutations（先
  delete 后 put，顺序无关）→ 最终状态校验：canonical relative path（拒绝
  ../、a//b、尾斜杠、反斜杠、CR/LF/NUL）、path 全局唯一、类型稳定、
  file 祖先必须存在且为 directory。
- 既有测试 fixture 修正（file 无祖先的 commit 数据补 dir）。

### R3-06 scanner terminal barrier 与资源上限

- 最终 barrier：全部 digest 后每目录 dev/ino 复核 + 完整成员集合复核 +
  每文件 identity/size/nlink/mtime/ctime 复核 + 内容重读对比（sibling
  改写/新增/删除 fail-closed；bun stat 缓存盲窗由内容级对比封闭）。
- maxManifestBytes / maxMetadataBytes 新限额（读取/JSON parse 前检查）。
- 累计 tree budget 在下一文件读取/写入前预留（不先分配再检查）。
- bun 环境限制（如实记录）：fstat 仅 ms 截断 + writeFileSync 偶发不更新
  mtime → 同 ms / inode 复用窗口的 swap-back 检测依赖内容/identity；
  测试用占位+utimes 保证确定性。

### 门禁

- projection+world+authority-graph **259/259**（3 连全绿）；typecheck 0
  error；build ✓；git diff --check ✓；worktree clean（tracked）。
- B lane：真实 fuse-overlayfs + 真实 bwrap broker 执行成功；cleanup proof
  不可得（本机 bwrap 无 cgroup 委托）→ `ENV_BLOCKED: EXECUTION_RECEIPT_
  NOT_PERSISTED/NOT_FINALIZED`（fail-closed 拒绝，未伪装正向通过）。
- aggregate 全量 `bun run test` 白名单外负载类失败与本 diff 无关（同窗口
  BASE 对照）；不做 timeout 扩大的隐藏（12 步全链 5s 墙钟为负载放大，
  低负载窗口通过）。
- 未 push、未 merge、未建 PR。

## AK2-R2 修复记录（候选提交 `ddaed17`，等待独立复审）

### FACT

- R2-00：7 个反例测试先红后绿（UNPROJECTED commit 误接受、cleanup 未证明仍
  finalized、跨 World receipt 重放、cleaned session reuse、walk 后新增遗漏、
  cleanup 抛异常无终态、durable commit 后被标 REJECTED）。
- 本机 bwrap 无 cgroup 委托（`cleanupVerified=false`）→ 真实 strict lane 无
  cleanup proof → 无 receiptId → fail-closed 验证；真实执行测试如实标注
  `ENV_BLOCKED`（非缺陷）。
- bun `statSync` 存在进程内偶发缓存（写入后立即 fstat 可能返回旧 mtime/ctime）
  —— 已用读后 reopen 二次内容对比补盲窗（内容级权威，不依赖时间戳缓存）。

### R2-01 Execution Intent

- `ProjectionExecutionIntent` 由 coordinator 生成；broker 从 spec 环境变量
  `ORCANA_PROJECTION_INTENT` 注入 final receipt 的 `projectionIntentDigest`。
- commit 时 intent 驱动校验：run/node/cell/spec/fs-policy/workspace-root 绑定 +
  intent 匹配，跨 World/session/命令重放 → `EXECUTION_RECEIPT_REPLAY`；
  cleaned session 复用 → `CLEANED_SESSION_REUSED`。

### R2-02 Receipt Digest 自洽与 CAS 权威

- `computeReceiptDigest` 剥离被 pre-final spread 继承的旧 `receiptDigest` 字段
  （canonical 摘要绝不包含被覆盖的自摘要）。
- `getFinalReceipt` anchored no-follow 读取（openRootAnchored + fstat 验证
  regular file）+ 重算 digest（tampered → 拒绝）。
- commit 前 canonical final receipt put 进 `store.cas`；`sha256:` 前缀的
  executionReceiptId 强制 CAS 存在性 + `world_commit` link；runtime receipt
  删除后 CAS 仍可恢复 provenance（测试覆盖）。

### R2-03 cleanup truth 严格化

- `isCleanupFinalized`：cleanupVerified===true、processesRemaining===0、
  mountsReleased/cgroupRemoved===true、cleanupActions 无失败、无 degradation；
  矩阵测试逐字段拒绝。`processesRemaining=-1` 是"无法测量"如实声明，不充当
  finalized（cgroup 委托不可用是环境事实）。

### R2-04 状态机唯一真源

- `applyProjectionStateTransition` 显式白名单表；FAILED/CANCELLED/throw →
  World REJECTED + 异常规范化 cleanup + terminal receipt；post-commit 异常按
  commitId 查 `getCommit`，World 已 durable → COMMITTED。全状态 × 全事件矩阵
  测试（未列出的边一律 INVALID_STATE）。

### R2-05 scanner 稳定性

- 阶段 2 每目录重新枚举成员集合 + dev/ino 复核 + 文件读后 reopen 二次内容
  对比 + mtime/ctime 复核（same-size in-place 确定性检测，测试注入窗口
  `onFileReadAfter`）；真并发子进程 race 与 6 场景 harness 全覆盖。

### R2-06 mount ownership

- mount identity = mountId + upper 目录 dev/ino（mount id 卸载后会被内核复用，
  upper 身份是更强绑定）；foreign 重挂载 → `assertMountOwned` false、cleanup
  拒绝卸载 foreign（真实 fuse-overlayfs 测试）。

### R2-07 store 完整性

- file 缺 contentRef 拒绝、同 commit 内不同 objectId 同 path 冲突拒绝、
  file-parent collision 拒绝（delete+put 替换允许）；exact duplicate mutation
  真正 canonical dedupe（单条 ledger event）；materializer 有界流式写入（逐
  chunk 写 fd，无 parts[]+Buffer.concat 双倍峰值；chunk CAS record size 预检）。

### 门禁

- projection+world+authority-graph **239/239**（7 连绿）；typecheck 0 error、
  build ✓、git diff --check ✓；19 文件 +1319/−260；worktree 干净（tracked）。
- `src/runtime/linux/{contracts,broker,receipt}.ts` 最小改动（intent 字段 +
  digest 剥离），无 authority 放宽。
- 未 push、未 merge、未建 PR；等待独立复审员对 `ddaed17` 复核。

## AK2-R4 Correction Gate 记录（候选提交链，等待独立复审）

**R4 专用分支 / worktree:** `feat/agent-os-r4` @ `/home/fuqiang/worktrees/orcana-agent-os-r4`
**R4 起点:** `7316325`（AK2-R3 候选；parent 链 `477fe5f → cf4e57d → 589dfc2 → 7316325`）
**R4 文件白名单:** `src/kernel/projection/**`、`src/kernel/world/{cas,store}.ts`、
`src/runtime/linux/backends/bubblewrap.ts`、`src/runtime/linux/contracts.ts`（仅
receipt/outcome 最小字段）、`src/runtime/linux/receipt.ts`（仅 receipt canonical
binding）、`tests/kernel/projection/**`、`tests/kernel/world/**`、本阶段文档。
未触碰：`src/workflow/**`、`src/harness/**`、`src/execd/**`、依赖锁、CI/secrets/billing。

### R4-00 反例冻结（25 反例：先红后绿 + 1 正对照）

| 反例 | 内容 | RED→GREEN |
|---|---|---|
| R4-00-1 | production backend + `allowFixtureExecution:true` + receiptless 仍可 commit（boolean bypass） | ✓ |
| R4-00-2a | 整个 merged root RW bind 到 `/workspace`（unscoped 可读可写） | ✓ |
| R4-00-2b | 覆盖 readonly root 的更宽 RW ancestor mount | ✓ |
| R4-00-2c | unscoped workspace 路径被 mount target 覆盖 | ✓ |
| R4-00-2d | unscoped cwd/executable 仍可编译（受控视图外解析） | ✓ |
| R4-00-3a/b/c | adapter 未绑定 intent command / scope roots / workspace identity（spawn 前必须逐字段拒绝） | ✓ |
| R4-00-5 | receipt 存在 signal/oomKilled/pidLimitHit/outputLimitHit/tempLimitHit 仍作为成功提交 | ✓ |
| R4-00-6 | execute 前 mount ownership 丢失 → 裸 throw，未 terminalize | ✓ |
| R4-00-7 | production scan 缺少 finalized receipt/cleanup proof 仍继续（不能跳过） | ✓ |
| R4-00-8 | projection root 在 lstat 后、fd open 前被替换 → cleanup 删除替换目录内容 | ✓ |
| R4-00-9 | backend mount 成功后 create 失败 → 递归删除仍挂载的 merged（unmount 报告成功 ≠ 已卸载；fake fusermount 经子进程注入） | ✓ |
| R4-00-10a | dir 从 a 移到 b 后留下 a/x orphan（directory 孤儿不检查） | ✓ |
| R4-00-10b | directory a/b + file a 的反序 mutation（file 祖先不检查） | ✓ |
| R4-00-10c | pathless file（无 path 对象不检查） | ✓ |
| R4-00-10d | pathful workspace（workspace 允许 path —— materializer 契约违反） | ✓ |
| R4-00-10e | object move 后由其他 object 复用旧 path（孤儿悬挂在 file 下） | ✓ |
| R4-00-11a/b/c | final verification 期间新增 sibling / 修改已验证文件 / 删除目录 → 未拒绝未检测 | ✓ |
| R4-00-11d | 真实 FUSE sealed 视图（内核 EROFS）—— seal 后写入被内核拒绝 | ✓ |
| R4-00-12 | FileManifest JSON 很小但 logical file 很大 → tree budget 在文件创建后才拒绝 | ✓ |
| R4-00-13 | 阶段文档第 144 行 trailing whitespace（`git diff --check` 基线） | ✓ |
| R4-01 | `FIXTURE_EXECUTION_TOKEN` 仍从生产模块公开导出（PUBLIC_FIXTURE_AUTHORITY ≠ 0） | ✓ |

RED 证据（提交 `98dfdd6`）：`bun test tests/kernel/projection/r4-counterexamples.test.ts
tests/kernel/world/r4-namespace.test.ts` → 24 fail / 1 pass（正对照），全部因目标
缺陷失败（bypass 生效 / mount 布局错误 / 无绑定验证 / 无终态化 / 无 sealed 视图 /
budget 事后拒绝 / namespace 漏检 / 导出面残留），无 setup/timeout/无关异常。
RED 提交含两个 inert test-only 注入窗口（生产不传、零行为变化）：
`coordinator.onBeforeProjectionRootOpen`（R4-00-8 确定性替换窗口）、
`scanner.onFinalVerifyAfter`（R4-00-11 确定性 final-verify race 窗口）。

### R4-01 删除 fixture authority 旁路

- 完全删除 `allowFixtureExecution` option/property/commit bypass 与
  `FIXTURE_EXECUTION_TOKEN`（生产模块不再导出任何 fixture 执行能力）。
- 结构门：receiptless commit 只允许 `backend.kind === "fixture"`（test-only
  factory `tests/kernel/projection/test-fixtures.ts`）&& 显式 `allowTestBackends`；
  production backend 无 receipt 永远拒绝（`WORLD_COMMIT_WITHOUT_RECEIPT = 0`）。
- production coordinator 构造时结构性要求 `receiptAuthority`（缺省拒绝构造）。
- fixture backend（`CopyProjectionFixtureBackend`）移出 `src/kernel/projection/
  backend.ts`（生产导出面 `PUBLIC_FIXTURE_AUTHORITY = 0`）。

### R4-02 Bubblewrap 有效权限

- 受控视图（存在 `/workspace` 声明挂载）：`/workspace` 为空目录（`--dir`），
  只把 plan 声明的 roots 挂到 `/workspace/<root>`（adapter target 从 `/<root>`
  改为 `/workspace/<root>`）；writable → rw、readonly → ro；unscoped 不可读、
  不可写；无覆盖 readonly root 的更宽 RW ancestor。
- 通用模式（无 `/workspace` 声明挂载 —— 通用 broker 工作区模型，整个 workspace
  即授权范围）保持整树绑定语义；两模式都做最终 argv mount dominance 检查
  （RW 不得覆盖 RO target、受控视图下 `/workspace` 不得 RW bind、无重复 target）。
- cwd/executable 必须在受控视图内解析（unscoped → compile 期 `WORKSPACE_PATH_ESCAPE`，
  非 spawn 期 ENOENT）。验收：`UNSCOPED_PATH_VISIBLE = 0`、
  `READONLY_ROOT_WRITABLE_ALIAS = 0`、`BROADER_RW_ANCESTOR = 0`（argv 断言测试）。

### R4-03 独立绑定 Intent / Spec / Scope / Outcome

- intent 增加 kernel-owned 字段：`filesystemScope`（plan roots）、
  `workspaceIdentity`（canonical path + dev/ino）、`filesystemPolicyDigest`
  （coordinator 从 plan roots + merged hostRoot 按 runtime `spec.filesystem`
  canonical 结构独立派生 —— 不依赖 receipt/claim 自报值）。
- adapter spawn 前逐字段验证：executable/args/timeoutMs、canonical
  writable/readonly roots、workspace identity（path + dev/ino）、intent ids、
  `ownerFiles === writableRoots`（pathguard 契约）、`emptyHome === true`（投影
  契约）；编译后 digest 复核（belt）。任何不一致 → `EXECUTION_RECEIPT_BINDING_MISMATCH`
  （command 从未 spawn）。一个 intent 只能对应一个授权 cell（usedIntents 集合）。
- coordinator commit：receipt `filesystemPolicyDigest` 必须等于 kernel 派生期望值；
  执行结论优先从 verified final receipt 派生 —— 成功要求 exitCode===0 且无
  signal/oomKilled/pidLimitHit/outputLimitHit/tempLimitHit/timedOut/cancelled/
  violations/unexpectedWrites；与本地 outcome 冲突 → 拒绝。
- `scopeDigest` 真正参与验证（经 filesystemPolicyDigest 派生链）；死参数已删除。

### R4-04 Execution Receipt 真实性 —— OWNER-DECISION-REQUIRED（不写 CLOSED）

已确认事实（R3-00-3 证据测试，R4 保留并强化）：同 UID 进程可以修改普通 JSON
receipt、重算公开 SHA-256，并被当前 `RuntimeStateReceiptAuthority` 接受。
当前 authority 不是 authenticated authority —— 本记录不再声称其为真实性证明。

**Decision Packet（等待 Owner 决策；本轮未自行发明任何密钥/daemon/IPC 方案）：**

| 方案 | 机制 | 优点 | 代价 / 风险 |
|---|---|---|---|
| A：独立 UID + 受保护 daemon | receipt 由低权限 UID 进程写、高权限 daemon 读（受限 IPC） | 同 UID 攻击面缩小；无密钥管理 | 需要新 daemon/UID/IPC 协议；进程生命周期管理；部署复杂度 |
| B：kernel-owned MAC/signature key + sealed IPC | coordinator 持有 MAC key，receipt 带 keyed digest；写入经 sealed channel | 可检测任意篡改（含 cleanup truth 字段） | 密钥管理/轮换；密钥泄漏即全失效；需可信信道分发 |
| C：明确排除 same-UID adversary + 记录安全降级 | 信任边界声明为「同 UID 进程不在对抗模型内」 | 零新基础设施 | 安全模型降级必须显式记录并被 Owner 接受 |

**推荐：** B（kernel-owned MAC key + sealed IPC）为长期方案；短期可接受 C 的
显式降级声明，但 production 正向承诺（authenticated receipt）必须保持 fail-closed。
**影响文件（若实施）：** `src/runtime/linux/recovery/state-store.ts`、
`src/kernel/projection/receipt-authority.ts`、新 daemon/密钥模块（均不在本轮
白名单 —— 未经 Owner 决策不写入）。**迁移成本：** 高（新 IPC + 密钥分发 +
轮换）。**恢复语义：** 旧无密钥 receipt 停止被接受（fail-closed 升级）。**密钥
轮换要求：** 支持 key version + 多 key 验证窗口；轮换时旧 key 只验证不签发。

**本子项状态：** `OWNER-DECISION-REQUIRED`（不得写 CLOSED）。阻塞期间其余 R4
任务继续；**AK-2 不得 PASS**。production 正向 World Commit 依赖该未认证 authority
时保持 fail-closed / `ENV_BLOCKED`（本机 B lane 即此状态）。

### R4-05 生命周期、可信 root 与 cleanup

- 单一不抛异常 terminalize 覆盖：start/create/assertReady 失败、execute 前/后
  ownership 丢失、missing/unfinalized receipt、scan/validation 失败、stale head、
  compareAndCommit 失败、cancel、unmount 失败、root 删除失败 —— 全部产生
  deterministic terminal state + `cleanupState` + terminal receipt + residue 信息。
- production scan 必须有 finalized cleanup proof（`EXECUTION_RECEIPT_REQUIRED /
  NOT_FINALIZED`，缺失拒绝，不跳过）。
- projection base：0700、owner 验证、`O_NOFOLLOW`、retained dirfd、dev/ino
  fencing（子 root 创建/打开/删除相对 base dirfd；打开的 root fd 再次与
  `session.rootIdentity` 比较 —— R4-00-8：lstat→open 窗口替换目录不被修改）。
- foreign/unknown mount：不卸载、不 chmod、不递归删除、保留 residue。
- unmount 成功后重新确认 mount 已消失；merged mountpoint 只在确认空且非 mount
  后用 rmdir 删除（禁止递归穿越仍挂载目录 —— R4-00-9 真实 FUSE 反例）。

### R4-06 Sealed Scan View

- 不再用「增加一次 final pass」宣称消除 TOCTOU —— backend-level `sealForScan()`：
  执行 writer 已终止（cleanup proof）后，merged 视图转为不可写、不可替换的
  scan 输入；scanner 只读 sealed 视图；seal 失败 → 不生成 delta、不写 CAS
  delta content、不 commit World。
- 生产实现：fuse-overlayfs 卸载 RW mount（确认已消失）→ 同一 lower/upper/work
  以 `ro` 重挂载 —— 内核 `MS_RDONLY`（写返回 EROFS，已用 R4-00-11d 真实 FUSE
  验证）。这是 kernel-enforced 的 sealed view 证明（非有限扫描冒充闭合）。
- fixture（test-only）seal 为 mode-based（0555/0444）—— 同 UID 可还原，只作
  逻辑近似，不冒充不可变证明（如实记录）。
- 残余风险（如实记录）：seal 保护 guest 视图与扫描输入；同 UID 进程直接写
  upper 目录不在本方案对抗模型内（→ R4-04 OWNER-DECISION-REQUIRED）。

### R4-07 World 最终 namespace

- validator 重写为真正 final-state 模型：按 objectId 加载 current state →
  应用 delete/put（put 同一 objectId 先移除旧 state/path）→ 从最终 byId 重建
  byPath → 全局验证：canonical relative path、path 唯一、objectId 唯一身份、
  file/directory 必须有 path、workspace 必须无 path（materializer 契约）、
  file 必须有 contentRef、每个对象的所有显式祖先必须是 directory、file 不得
  成为任意对象的祖先。顺序无关（byId 覆盖消除 delete/put 顺序缺陷）。
- 每个成功 commit 测试继续执行 createSnapshot → materialize（正对照）。
- 任一失败：revision 不推进、ledger 不追加、CAS owner links 不残留（断言覆盖）。
- AK-1 既有测试的 pathless file/directory 对象按新契约补 path（filesystem
  对象必须可寻址；非 filesystem 类型保持 pathless 合法）。

### R4-08 Resource Budget 与文档真实性

- FileManifest 使用 logical `manifest.size` 做累计 tree budget 预留（不再用
  manifest JSON 的 CAS record size —— JSON 可很小而 logical file 很大）；预算
  超限在打开目标文件、读取 chunk、写入任何字节之前拒绝（R4-00-12：文件未被
  创建）；manifest 只解析一次（parse 结果复用，不重复 parse/copy）。
- 如实记录 pre-parse 边界：`maxManifestBytes` 是 CAS-record byte ceiling
  （读取/JSON parse 前检查）；entry 数/单条目 metadata 只能在 JSON parse 后
  限制 —— 本文档不声称 pre-parse 全覆盖，只陈述真实的 aggregate manifest
  byte ceiling。
- 修复全部 trailing whitespace（R4-00-13；`git diff --check` 通过）。

### 门禁（R4 候选链）

- `bun test tests/kernel/projection/ tests/kernel/world/ tests/kernel/authority-graph.test.ts`
  **285/285**（3 连全绿，每次 24~29s）；typecheck 0 error；build ✓；
  `git diff --check 7316325 HEAD` ✓。
- 分层报告（本机 Ubuntu/WSL，bwrap + fuse-overlayfs 可用）：
  - 真实 bwrap broker 执行（vertical slice B lane）：PASS（隔离/隐藏断言全过）；
    World commit 因 cleanup proof 不可得（无 cgroup 委托）→ `ENV_BLOCKED`
    （fail-closed，未伪装正向通过）。
  - 真实 fuse-overlayfs（挂载/所有权/foreign/swap/seal/EROFS）：PASS。
  - live/provider：NOT_RUN（无 live key lane；与 R3 一致，QUARANTINED 清单未变）。
- 未 push、未 merge、未建 PR；worktree 无 mount residue（测试后确认）。

### FACT

- R3 候选 `7316325` 上 25 个 R4 反例全部 RED（24 fail + 1 正对照），缺陷根因
  逐一确认（见 R4-00 表）。
- 本机 `fuse-overlayfs -o ...,ro` 重挂载真实生效（内核 EROFS，R4-00-11d）。
- bun `execFileSync` 使用进程启动时 PATH 解析二进制（运行时改 `process.env.PATH`
  无效）—— R4-00-9 经子进程注入 fake fusermount（unmount 报告成功 ≠ 已卸载）。
- AK-1 既有测试大量使用 pathless file/directory 对象 —— R4-07 契约下已补 path。

### INFERENCE

- intent 携带 coordinator 派生期望值（filesystemScope/workspaceIdentity/
  filesystemPolicyDigest）后，adapter 的 pre-spawn 逐字段验证与 commit 的
  receipt-vs-期望比对构成闭环；executor 无法再同时提供「声明」和「证明」。
- 受控视图（/workspace 声明挂载）与通用模式（无声明挂载）的语义差异由
  ALLOWED_MOUNT_TARGET_PREFIXES 的既有设计自然承载。

### PROPOSAL

- R4-04 Decision Packet 方案 B（kernel-owned MAC key + sealed IPC）为长期方向；
  实施前必须 Owner 决策（影响文件不在本轮白名单）。
- production B lane 的 cleanup proof 依赖宿主 cgroup 委托；无委托环境保持
  ENV_BLOCKED，不改变代码以「伪造成功」。

### OWNER-DECISION-REQUIRED

- **R4-04：Execution Receipt 真实性**（同 UID 可改 JSON + 重算公开 digest 被
  接受；无密钥方案无法区分 cleanup truth 真伪）。状态 `OWNER-DECISION-REQUIRED`
  （不写 CLOSED）；阻塞时 AK-2 不得 PASS。方案 A/B/C 见 Decision Packet。
- **production 正向 B lane**：本机无 cgroup 委托 → 真实执行成功但 World commit
  被 fail-closed 拒绝 —— `ENV_BLOCKED`（不写 PASS/CLOSED）。
- **sealed scan**：kernel-enforced ro remount 已实现并验证（EROFS）；残余
  same-UID 直写 upper 风险归属 R4-04 对抗模型决策，不单独写 CLOSED。

### 最终状态

`READY_FOR_INDEPENDENT_AUDIT`（候选提交链 `7316325..HEAD`；未 push、未 merge、
未建 PR；等待独立只读复审 —— 不复用实现者结论，不写文件、不修复、不提交）。
不得写 PASS / CLOSED / AK-2 COMPLETE / READY FOR AK-3。

## AK2-R5 Correction Gate 记录（候选提交链，等待独立复审）

**R5 专用分支 / worktree:** `feat/agent-os-r5` @ `/home/fuqiang/worktrees/orcana-agent-os-r5`
**R5 起点:** `b7d15db`（AK2-R4 候选）
**R5 文件白名单:** 本阶段文档、`docs/agent-os/evidence/ak2-r5/**`、
`src/kernel/projection/**`、`src/kernel/world/{contracts,cas,manifests,snapshot,store}.ts`、
`tests/kernel/projection/**`、`tests/kernel/world/**`、`tests/kernel/authority-graph.test.ts`。
本轮 `src/runtime/linux/**` 零改动（无需绕不开的公开契约缺口）。
未触碰：`src/workflow/**`、`src/harness/**`、`src/execd/**`、依赖锁、CI/secrets/billing。

### R5-00 反例冻结（17 反例 + 1 静态门；RED 证据见 evidence/ak2-r5/README.md）

| 反例 | 内容 | RED→GREEN |
|---|---|---|
| R5-00-1 | 任意调用方实现 kind:"fixture" + allowTestBackends=true 不得获得 receiptless World commit | ✓ |
| R5-00-2 | baseProjectionRoot 是 symlink → start 在创建任何 child/物化/CAS 副作用前拒绝 | ✓ |
| R5-00-3 | base root 在验证与 child 创建之间被替换 → 拒绝；外部 sentinel 不变 | ✓ |
| R5-00-4 | assertReady() 抛异常 → 先 instance.cleanup()；未证明卸载不得遍历/删除 root；residue/error 保留 | ✓ |
| R5-00-5 | create 完成 FUSE mount 后被替换为 foreign FUSE → 不得卸载 foreign、不得 rm/chmod upper/work/merged（REAL） | ✓ |
| R5-00-6 | execute RUNNING 时并发 cancel → 先取消、等待 executor、恰好一个终态、cleanup 后无 writer | ✓ |
| R5-00-7a-e | seam 抛异常必须 terminalize（merged lstat / getFinalReceipt / isCleanupFinalized / sealForScan / commit preflight） | ✓ |
| R5-00-8 | 同一 intent 被两个 adapter 实例 / 重建 adapter 使用 → 只允许一个 execution cell | ✓ |
| R5-00-9 | sealed 后同 UID 直写 writeLayerPath/upper → 不得返回成功 delta、不得 commit | **KNOWN RED**（OWNER-DECISION-REQUIRED；禁止伪造 GREEN） |
| R5-00-10 | raw bytes 恰为合法 FileManifest JSON → promotion/GC/recovery 后物化逐字节一致 | ✓ |
| R5-00-11 | invalid final namespace 拒绝后无 CAS/file/staging residue | ✓ |
| R5-00-12 | maxFileChunks 超限在第二份数组分配/逐项 normalize/打开目标文件前拒绝 | ✓ |
| R5-01 | 生产导出面不导出任何 fixture/test authority 能力（STATIC 门） | ✓（不变式） |
| R5-03 | post-commit divergence → 显式 RECONCILING（不得谎报 REJECTED） | ✓（回归） |

### R5-01 彻底删除 production receiptless authority

- `allowTestBackends` 选项整体删除；构造时结构性要求 receiptAuthority
  （所有 backend 含 kind:"fixture" 的任意结构化实现 / cast）——
  `WORLD_COMMIT_WITHOUT_RECEIPT = 0`；不存在 receiptless commit 分支。
- `ProjectionReceiptAuthority.trustLevel`（same-uid-untrusted /
  test-harness / kernel-authenticated）：RuntimeStateReceiptAuthority 显式
  声明 same-uid-untrusted；production acceptance 遇到 untrusted authority
  fail-closed（`PRODUCTION_WORLD_COMMIT_BLOCKED`）。
- 导出面 inventory：`PUBLIC_FIXTURE_AUTHORITY = 0`。

### R5-02 可信 projection base root

- `ProjectionBaseRootAuthority`：0700 创建、O_DIRECTORY|O_NOFOLLOW 打开、
  owner === 当前 principal、mode === 0700、dev/ino 身份、retained dirfd；
  child 创建/打开/删除相对 base fd（/proc/self/fd/N/<child>）；每次操作前
  path 身份复核（parent swap fail-closed；外部 sentinel 不变）。
- `PROJECTION_BASE_PATH_AUTHORITY = 0`、`PROJECTION_ROOT_ESCAPE = 0`。

### R5-03 统一 lifecycle terminalizer

- terminalize 幂等 guard（最多一个终态 / 一个 terminal receipt）；
  execute intent 构建 guard（EXECUTION_INTENT_BUILD_FAILED）；abort 信号；
  runningExecute 注册；cancel 改 async（先 abort → await executor →
  唯一终态化；cleanup 后无 writer）；cleanupState 记录 phase/residue/
  mount truth；post-commit divergence → 显式 RECONCILING（不谎报
  REJECTED）。
- `NONTERMINAL_FAILURE_PATH = 0`、`CLEANUP_RESIDUE_SILENT_SUCCESS = 0`、
  `CANCELLED_WRITER_SURVIVES = 0`、`DUPLICATE_TERMINAL_RECEIPT = 0`。

### R5-04 FUSE mount ownership

- 实证：mount id 卸载后会被内核复用 —— id + upper dev/ino 不足；新增
  daemon 命令行判别（/proc/<pid>/cmdline 含 upperdir=<ours>）。
- create 错误路径 / assertMountOwned / cleanup / seal 全部绑定
  mountId + fsType/source + mountpoint 身份 + upper dev/ino + daemon
  命令行；foreign/unknown/replaced → 不卸载、不 rm/chmod、保留 residue。
- `FOREIGN_MOUNT_UNMOUNT = 0`、`MOUNTED_TREE_RECURSIVE_DELETE = 0`、
  `OWNED_MOUNT_SILENT_LEAK = 0`。

### R5-05 intent 一次性 reservation

- `ProjectionIntentRegistry`（kernel-owned；coordinator 持有；adapter 必填）
  —— 一个 intent = 恰好一个 cell（跨 adapter 实例 / 重建 / 并发）；
  不依赖实例内 Set。
- `MULTI_CELL_INTENT_REUSE = 0`、`EXECUTION_SPEC_SELF_ATTESTATION = 0`。

### R5-06 sealed scan trust boundary —— 选 B（fail-closed）

- 当前 same-UID backend 不具备生产 seal authority（sealed 视图 = RO
  remount / mode-based，同 UID 可直写 upper）→ production World commit
  被禁止（PRODUCTION_WORLD_COMMIT_BLOCKED）。未写 SEALED_VIEW_MUTABLE=0。
- 独立 UID / privileged daemon / MAC key / 新 IPC → OWNER-DECISION-REQUIRED
  （不自行实现超范围系统服务）。

### R5-07 CAS typed content representation

- SectionManifestEntry 不可变 `representation`（raw | file-manifest），
  snapshot 创建时绑定；materializer 只服从该判别子（不读全局可变
  isManifest）；旧格式 fail-closed 拒绝（无静默 reinterpretation）。
- `NONDETERMINISTIC_SNAPSHOT = 0`、`MUTABLE_CONTENT_INTERPRETATION = 0`。

### R5-08 事务与资源上限

- validateFinalNamespace 移到 delta CAS 物理写入前（invalid commit 零
  CAS/file/staging residue）；parseFileManifest 的 chunk count 与 logical
  size 在第二份数组分配与逐项 normalize 前检查。

### 门禁（R5 候选链）

- `bun test tests/kernel/projection/ tests/kernel/world/ tests/kernel/authority-graph.test.ts`
  **303 tests：302 PASS + 1 KNOWN RED（R5-00-9）**（3 连）；typecheck 0
  error；build ✓；`git diff --check` ✓。
- 真实 fuse-overlayfs lane（R5-00-5 foreign swap / R4-00-11d EROFS /
  R3-00-8 / B lane）PASS / ENV_BLOCKED 如实标注；live/provider NOT_RUN。
- aggregate 基线外失败逐文件归因（BASE/HEAD 同窗口 A/B 对照；与 R4 相同
  的 4 类环境/负载类失败，非本 diff）。
- 测试后环境：0 mount residue、0 残留进程、0 残留 /tmp 目录、worktree
  tracked+untracked clean；未 push、未 merge、未建 PR。

### FACT

- R4 候选 b7d15db 上 17 个 R5 反例全部 RED（16 fail + 1 静态门），根因
  逐一确认（见 evidence/ak2-r5/README.md 表格）。
- 本机实证：mount id 卸载后被内核复用（同路径 foreign 重挂载拿到相同
  id）—— 这是 R5-04 daemon 命令行判别的直接依据。
- R5-00-10：raw bytes 恰为合法 FileManifest JSON 时，putManifest 同 digest
  翻转全局 isManifest → 修复前物化双重解释（0 字节），修复后逐字节一致。
- R5-00-11：invalid namespace 拒绝后 delta CAS 物理文件残留（cas.put 的
  rename 无法随 SQLite rollback 撤销）→ 校验前移到物理写入前。

### INFERENCE

- trustLevel 门把认证性从实现剥离：生产部署显式配置
  RuntimeStateReceiptAuthority → 结构性无法正向提交（fail-closed 由配置
  承载）。这与 R5-06 option B 同源：same-UID 架构无生产 seal authority。
- representation 判别子把内容语义绑定到内容寻址的 snapshot —— 全局可变
  标志无法再改变历史语义（确定性物化）。
- daemon 命令行判别使 foreign 重挂载（含 mount id 复用）可确定识别。

### PROPOSAL

- Decision Packet（R5-04 真实性）：推荐 B（kernel-owned MAC key + sealed
  IPC）为长期方向；短期可接受 C 的显式降级声明；实施前必须 Owner 决策
  （影响文件不在本轮白名单）。
- production 正向 B lane：本机无 cgroup 委托 → cleanup proof 不可得
  （ENV_BLOCKED）；即使可得，same-uid-untrusted authority 也会被
  PRODUCTION_WORLD_COMMIT_BLOCKED 拒绝（结构性 fail-closed）。

### OWNER-DECISION-REQUIRED

- **R5-04：Execution Receipt 真实性**（same-UID 可改 JSON + 重算公开
  digest；无密钥方案无法区分 cleanup truth 真伪）—— 不写 CLOSED；
  阻塞时 AK-2 不得 PASS。Gate 状态：`OWNER-DECISION-REQUIRED` +
  `PRODUCTION_WORLD_COMMIT_BLOCKED`。
- **R5-00-9 / R5-06：same-UID sealed view 直写 upper 无法阻止**（无
  kernel-owned immutable snapshot / 独立 UID / MAC 授权）—— KNOWN RED，
  禁止伪造 GREEN；生产 seal authority 缺失 → production World commit
  fail-closed。
- **production 正向 B lane**：无 cgroup 委托 → `ENV_BLOCKED`（不写
  PASS/CLOSED）。

### RESIDUAL RISK（不掩盖可构造反例）

- R5-00-9 是已确认未闭合反例（KNOWN RED）—— 不是理论风险。
- daemon 命令行判别依赖 /proc 可见性（同 UID 命名空间）；跨命名空间 /
  特权场景未验证（如实记录）。

### 最终状态

`READY_FOR_INDEPENDENT_AUDIT`（候选提交链 `b7d15db..HEAD`；未 push、未
merge、未建 PR；等待独立只读复审 —— 不复用实现者结论，不写文件、不修复、
不提交）。不得写 PASS / CLOSED / AK-2 COMPLETE / READY FOR AK-3。
