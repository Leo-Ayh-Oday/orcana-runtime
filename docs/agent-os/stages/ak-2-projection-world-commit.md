# AK-2 Projection + World Commit

**Task ID:** `AK2-PROJECTION-001`
**状态:** `IN_PROGRESS`
**基线 / 回滚点:** `e224ad6bb8aed5cca2d1b8b63f048333cfb88003`
**专用分支:** `feat/agent-os`

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

- 无。
