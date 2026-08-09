# AK-1 Durable Agent World

**Task ID:** `AK1-WORLD-001`
**状态:** `FIXED_REAUDIT_PENDING`
**基线 / 回滚点:** `60bff0515214197b297993faebb53bb4858938c3`
**专用分支:** `feat/agent-os`

## 目标

实现本机强权威的 WorldDB、同事务 WorldLedger、content-addressed store、File/Directory/World manifests、deterministic snapshot 与崩溃恢复测试。AK-1 只建立 Durable Agent World，不实现 Projection、Capability Handle、Effect Kernel、Semantic MMU 或分布式 World authority。

## 文件白名单

- `docs/agent-os/stages/ak-1-durable-world.md`
- `src/kernel/world/**`
- `tests/kernel/world/**`

白名单之外的修改一律停止并重新评估。

## 验收门

```text
WORLD_REVISION_SPLIT_BRAIN     = 0
LEDGER_DB_DIVERGENCE           = 0
CAS_MISSING_REFERENCED_OBJECT  = 0
UNREACHABLE_OBJECT_LEAK        = 0
NONDETERMINISTIC_SNAPSHOT      = 0
CRASH_LOSES_COMMITTED_WORLD    = 0
```

同时要求：

1. 所有 materialized World mutation 与对应 ledger event 在同一个 SQLite transaction；
2. stale `baseRevision` fail-closed，不自动 merge；
3. ledger 由数据库 trigger 强制 append-only；
4. CAS 引用完整、refCount 可重建、unreachable object 可回收；
5. 同一 World revision 的 snapshot digest 和 snapshot ID 稳定；
6. crash injection 覆盖 commit 前、DB commit 后 response 前、CAS/manifest 窗口；
7. 相关测试、`bun run typecheck`、`bun run build`、`git diff --check` 通过；
8. 候选提交后由与实现隔离的 Agent 只读审计，主 Agent 复核关闭发现；
9. 最终 worktree 干净。

## 停止条件

- 需要新增生产依赖；
- 需要修改现有 `src/workflow/`、`src/runtime/linux/` 或 Evidence 权威；
- SQLite 无法保证 ledger 与 materialized state 的单事务原子性；
- 持久格式或迁移策略出现需要 Owner 决定的不兼容选择；
- 实现需要提前进入 AK-2 或更后阶段。

## 回滚

AK-1 仅新增 `src/kernel/world/**`、`tests/kernel/world/**` 与本阶段记录。阶段提交可整体回退到 AK-0 关闭提交；没有生产数据迁移或外部副作用。

## 阶段记录

### FACT

- AK-0 已由独立只读复审明确 `PASS`，关闭提交为 `60bff0515214197b297993faebb53bb4858938c3`。
- 共享稳定化 checkout 已恢复干净；AK-1 只在 `/home/fuqiang/worktrees/orcana-agent-os` 实施。
- 仓库已有 Bun 内建 `bun:sqlite` 权威 store 与 CAS/atomic-write 实现先例，无需新增依赖。
- SocratiCode 的外部 Qdrant 仍不可达；继续使用限定范围的精确文件读取。

### INFERENCE

- AK-1 的 authoritative WorldLedger 应使用 `world_events` append-only SQLite 表，以便和 materialized state 共享事务；外部 `ledger/events.log` 在本阶段不作为第二权威。
- CAS 采用 file-first + SQLite metadata：DB 一旦引用对象，文件已原子发布；file-only crash residue 由 recovery/GC 清理。

### PROPOSAL

- WorldDB 初期使用 `PRAGMA journal_mode=WAL`、`synchronous=FULL`、`BEGIN IMMEDIATE` compare-and-commit。
- Revision 以 SQLite TEXT 保存十进制 bigint，避免 JavaScript safe-integer 上限和隐式精度损失。

### OWNER-DECISION-REQUIRED

- 无。

## 验证与审计证据

### FACT — 候选实现

- 新增 WorldDB schema、BigInt revision compare-and-commit、同事务 materialization/ledger、不可变 commit/snapshot 数据库边界。
- 新增 file-first CAS、引用图/refCount 重建、unreachable GC、File/Directory/World manifest 与 deterministic snapshot。
- recovery 覆盖 DB commit 前回滚、DB commit 后 response 丢失、file-only CAS residue 与 referenced CAS bytes 缺失。
- 完整性检查覆盖 World/meta HEAD 一致性、全 revision commit chain、每个 commit 的 ledger 事件数量/归属/revision/payload digest/receipt 对齐，以及 CAS content/reference。

### FACT — 主代理验证

- 初始候选 `93bb7c553bb353c13baf9c0e004eb453fed2169c`：`bun test tests/kernel/world` 为 `16 pass / 0 fail / 67 expect`。
- `bun run typecheck`：通过。
- `bun test tests/execd/state-store.test.ts tests/runtime/linux/cache/cas.test.ts`：`17 pass / 0 fail / 47 expect`。
- `bun run build`：通过。
- `git diff --check`：通过。
- 未运行 hosted CI（账号 billing lock，workflow 为 `0 steps`）；未运行 live/provider 测试，本阶段不声称这些门已通过。

### INFERENCE — 候选门评估

```text
WORLD_REVISION_SPLIT_BRAIN     = 0
LEDGER_DB_DIVERGENCE           = 0
CAS_MISSING_REFERENCED_OBJECT  = 0
UNREACHABLE_OBJECT_LEAK        = 0
NONDETERMINISTIC_SNAPSHOT      = 0
CRASH_LOSES_COMMITTED_WORLD    = 0
```

这是进入独立只读审计前的候选结论，不是阶段最终验收。实现提交、独立审计发现、主代理修复与复验将在后续提交中追加。

### FACT — 独立审计

- 独立 Agent 对 `93bb7c553bb353c13baf9c0e004eb453fed2169c` 给出 `CHANGES_REQUIRED`。
- Git 身份、parent、16 文件白名单、clean worktree、`git diff --check` 均通过。
- 阻塞发现：2 Critical、6 High；残余发现：3 Medium。审计按约束未运行测试、构建或服务。

阻塞项及主代理复核结果：

1. CAS owner 冒号拼接可碰撞：确认，改为 canonical tuple encoding，并加入双 World/branch 反例。
2. `linkMany()`/`gc()` TOCTOU：确认，CAS put/link/unlink/GC/recovery 全部纳入同一 SQLite `BEGIN IMMEDIATE` 串行化边界。
3. 完整性检查未枚举 materialized/snapshot roots：确认，改为从 WorldDB 权威行构造 roots，逐一验证 link/registration/file/hash。
4. refCount GC 无法清除环：确认，改为 root-based mark-and-sweep，并覆盖 self/双节点 cycle 与 ghost root。
5. ledger 未绑定 materialized state、NULL-commit 伪事件可绕过：确认，每 revision receipt 保存 materialized-state digest；完整性检查确定性 replay 全部 mutation、校验当前 materialized image，并约束 genesis/snapshot/quarantine 事件。
6. 同 revision 可有多个 snapshot 且排序依赖 ICU：确认，数据库唯一键改为 `(world_id, branch_id, revision)`，排序改为明确 UTF-16 code-unit order，并加入 Unicode 用例。
7. metadata 可覆盖 service/artifact 权威字段：确认，保留键在 commit 时拒绝，snapshot 中权威字段最后写入。
8. crash 测试只是同进程 throw：确认，新增 Bun 子进程硬退出 harness，覆盖 materialization/ledger/DB-commit-response、CAS temp/rename/metadata、snapshot manifest/insert 窗口。

残余项关闭：

- metadata bigint 改为 fail-closed，要求调用方显式编码为 string；不再静默改变类型。
- schema version 提升为 2，打开未知版本时关闭连接并报 `WORLD_SCHEMA_INCOMPATIBLE`。
- recovery 对非 CAS 的 ledger/revision 问题也将受影响 World quarantine 为 `corrupted`，不能继续 commit。

### FACT — 修复后主代理验证

- `bun run typecheck`：通过。
- `bun test tests/kernel/world`：`27 pass / 0 fail / 134 expect`，包含真实子进程 crash/reopen/recover。
- `bun test tests/execd/state-store.test.ts tests/runtime/linux/cache/cas.test.ts`：`17 pass / 0 fail / 47 expect`。
- `bun run build`：通过。
- `git diff --check`：通过。
- hosted CI 因既有账号 billing lock 未执行；live/provider 测试未执行且不计为通过。

### INFERENCE — 修复候选门评估

六项 AK-1 gate 在本地实现与反例测试中为 0；该结论仍需独立 Agent 对修复提交只读复审后才能转为阶段最终验收。
