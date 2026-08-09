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

### FACT — 第二轮独立复审

- 独立 Agent 对 `b8660343070e7490b347b8ef19c1f13d606c578e` 给出 `CHANGES_REQUIRED`，并确认首轮 8 个阻塞项全部关闭。
- 新阻塞发现：1 Critical、2 High。
  1. manifest 引用验证信任可变的 `cas_objects.media_type`，篡改媒体类型并删除 manifest edge 后可能错误 GC 真实 chunk；
  2. schema 打开逻辑只校验版本行，不校验既有库的完整结构，空版本或伪造当前版本可能被接受；
  3. 首个 digest prefix 目录创建后未 fsync 父目录，断电窗口可能丢失已提交 CAS 路径。
- 残余发现：旧 `contentRef` 路径只用 `has()`、canonical metadata 域不是严格可逆 JSON、缺少真实双进程 link-vs-GC 屏障测试。
- 审计 Agent 保持只读，未修改文件、提交或启动服务。

### FACT — 第二轮修复

- 修复提交为 `4b7ddbe4374d0ba2f6459252c6e7bf2cf5a466d1`，parent 为 `b8660343070e7490b347b8ef19c1f13d606c578e`。
- manifest 类型现在从 immutable content 的 `schemaVersion/type` 识别，不再依赖数据库媒体类型；CAS metadata/link 更新由数据库 trigger 拒绝。
- 新库的 schema DDL、版本写入与 fingerprint 校验在同一 `BEGIN IMMEDIATE` 中完成；既有库必须同时匹配唯一版本和完整 table/index/trigger fingerprint，禁止自愈未知结构。
- CAS 目录创建逐级 fsync 新目录及父目录；rename 后同时 fsync destination parent 和 staging source directory。
- object/artifact/service 的所有 `contentRef` 在 commit 前执行完整 bytes/hash 校验，包括 digest 未变化的 metadata-only update。
- canonical JSON 拒绝 `undefined`、稀疏数组、bigint、非 plain object、symbol key、accessor、non-enumerable property 与 cycle；内部可选状态用显式 `null` 或省略字段表示。
- 新增真实双 Bun 子进程竞争测试：link transaction 在验证与 insert 间持有写锁，recovery/GC 在其提交前不能越过，提交后内容和 authoritative link 保留。

### FACT — 第二轮修复后主代理验证

- `bun test tests/kernel/world`：`31 pass / 0 fail / 160 expect`。
- `bun test tests/execd/state-store.test.ts tests/runtime/linux/cache/cas.test.ts`：`17 pass / 0 fail / 47 expect`。
- `bun run typecheck`：通过。
- `bun run build`：通过。
- `git diff --check`：通过。
- hosted CI 仍因既有账号 billing lock 未执行；live/provider 测试未执行且不计为通过。

### INFERENCE — 第二轮修复候选门评估

第二轮 3 个阻塞项和 3 个残余项均有实现闭锁与直接反例测试；AK-1 状态保持 `FIXED_REAUDIT_PENDING`，必须由独立 Agent 对包含本记录的最终候选 HEAD 再次只读复审后才能关闭阶段。

### FACT — 第三轮独立复审

- 独立 Agent 对 `aac73c64f93e948c12ccbfba6a2f2b527707069e` 给出 `CHANGES_REQUIRED`，确认第二轮 schema shape、正常目录 fsync、旧 contentRef 校验与真实双进程 link-vs-GC 已关闭。
- 新阻塞发现：3 High。
  1. 对所有 JSON 按内容识别 manifest 会把合法 `application/json` lookalike 误报为全局 CAS divergence，并可能 quarantine 所有 World；
  2. canonical array 分支直接读取索引，array accessor 可在多次 digest/materialization/ledger 计算之间返回不同值；
  3. CAS 对既存 symlink 使用 follow 语义，put/recovery 可能越出 World 根写入或删除。
- 残余发现：并发首次 schema bootstrap 的一次性失败、持久格式变更仍沿用 v2、`-0` 不能字面可逆。
- 审计 Agent 保持只读，未修改文件、运行测试/构建或启动服务。

### FACT — 第三轮修复

- 修复提交为 `bd42d74358757bc77effc5c5711ed22b34fb3cc9`，parent 为 `aac73c64f93e948c12ccbfba6a2f2b527707069e`。
- manifest 检查重新要求 immutable `application/vnd.orcana.manifest+json`；`gc()`/`recover()` 在同一 `BEGIN IMMEDIATE` 删除事务内先复核 schema version/fingerprint，schema 被篡改时在 refCount、文件删除或 World quarantine 前 fail closed。
- 普通 JSON manifest-lookalike 已在两个 World 的回归中证明不会产生 divergence 或跨 World quarantine。
- canonical array 只接受完整 `0..length-1` data descriptors，拒绝 accessor、稀疏索引、额外 string/symbol property、non-enumerable element；commit 输入只 canonicalize 一次并解析为内部 plain JSON，后续 delta/materialization/ledger 复用同一规范值。数组 accessor 回归证明 getter 调用数为 0。
- canonical number 明确拒绝 `-0`，避免 stringification 丢失数值身份。
- World/CAS root、objects/staging、digest prefix 和 staging entry 使用 `lstat`、`O_NOFOLLOW` 与 `/proc/self/fd/<dirfd>` 相对操作；恢复先验证完整布局再删除，symlink 指向的外部 sentinel 均保持不变。
- schema bootstrap 的空库判定移入 `BEGIN IMMEDIATE`，WAL 初始化对 `SQLITE_BUSY` 做 5 秒有界重试；4 个独立 Bun 进程并发首次打开连续 5 轮通过。
- 持久格式版本从 v2 明确提升为 v3；AK-1 尚未发布，不对中间候选数据库提供隐式迁移或自愈。

### FACT — 第三轮修复后主代理验证

- `bun test tests/kernel/world`：`37 pass / 0 fail / 186 expect`。
- schema bootstrap 4 进程竞争测试额外连续运行 5 轮，全部通过。
- `bun test tests/execd/state-store.test.ts tests/runtime/linux/cache/cas.test.ts`：`17 pass / 0 fail / 47 expect`。
- `bun run typecheck`：通过。
- `bun run build`：通过。
- `git diff --check`：通过。
- hosted CI 仍因既有账号 billing lock 未执行；live/provider 测试未执行且不计为通过。

### INFERENCE — 第三轮修复候选门评估

第三轮 3 个 High 与 3 个 residual 均已由 fail-closed 实现和直接反例覆盖；AK-1 仍等待独立 Agent 对最新候选 HEAD 做最终只读复审。

### FACT — 第四轮独立复审

- 独立 Agent 对 `c8878bf8476ceaa65a09d8dd9065ffec25d51a3b` 给出 `CHANGES_REQUIRED`，确认第三轮 ordinary JSON、canonical array、CAS symlink、schema bootstrap 与 v3 持久格式问题均已关闭。
- 新阻塞发现：4 High。
  1. GC 先删除并 fsync CAS 文件、再提交 metadata；进程在二者之间崩溃会留下已注册但缺失 bytes 的 unreachable object，原 recovery 无法收敛；
  2. `cas.recover()` 的 schema guard 与后续 World quarantine mutation 不在同一事务，DDL 可在二者之间改变 schema；
  3. `world.db` symlink 与 Store 打开后的根路径替换未受目录句柄约束，可能造成 SQLite 与 CAS 使用不同的物理根；
  4. Store 首次创建 World root 后未 fsync 父目录，断电可能丢失已经返回成功的根目录项。
- 残余发现：同 digest 的媒体类型采用 first-writer-wins、recovery 打开第二个目录失败时可能泄漏首个 fd、无法归属具体 World 的嵌套 CAS 图损坏会触发全 Store fail-closed quarantine。
- 审计 Agent 保持只读，未修改文件、运行测试/构建或启动服务。

### FACT — 第四轮修复

- 修复提交为 `ba66b59f6292636103bc4822f49abb6d1103cc11`，parent 为 `c8878bf8476ceaa65a09d8dd9065ffec25d51a3b`。
- 新增 GC 文件 fsync 后、metadata commit 前的真实子进程硬退出故障点；文件删除现在对已缺失对象幂等，重启 recovery 可删除回滚后遗留 metadata 并恢复完整性。
- `markCorruptedFromRecovery()` 与 `quarantineWorldFromRecovery()` 在各自 `BEGIN IMMEDIATE` 内重新执行 schema version/fingerprint 校验，关闭 recovery guard 与隔离写入之间的 DDL 窗口。
- World root、WorldDB 与 CAS 绑定已打开的目录 fd；WorldDB 使用 `O_NOFOLLOW` 预打开并校验 inode，SQLite 与 CAS 在根路径被 rename/replace 后仍写入同一个物理 World。
- 新建 World root 的每级目录和父目录均执行 fsync；已有递归创建语义保留，路径组件按目录句柄逐级创建并拒绝 final symlink。
- recovery 在第二个受信目录打开失败时显式关闭第一个 fd，消除审计指出的描述符泄漏。
- 同 digest 的 `mediaType` 是 CAS immutable metadata 的 first-writer-wins 属性；不同媒体类型复用同 bytes 必须接受既有记录或使用外层 manifest 描述，不允许改写已注册对象。
- 无法可靠归属单一 World 的嵌套 CAS 图损坏在 AK-1 明确采用 Store 级 fail-closed quarantine。更细的 transitive ownership containment 不在本阶段引入，避免错误地让共享损坏对象继续服务任一 World。

### FACT — 第四轮修复后主代理验证

- `bun test tests/kernel/world`：`41 pass / 0 fail / 211 expect`。
- `bun test tests/kernel`：`51 pass / 0 fail / 292 expect`，同时复验 AK-0 authority graph。
- `bun run typecheck`：通过。
- `bun run build`：通过。
- `git diff --check`：通过。
- hosted CI 仍因既有账号 billing lock 未执行；live/provider 测试未执行且不计为通过。

### INFERENCE — 第四轮修复候选门评估

第四轮 4 个 High 已分别由硬退出恢复、事务内 schema guard、WorldDB/CAS 根句柄绑定和父目录持久化闭锁；3 个 residual 已实现关闭或明确为 fail-closed AK-1 策略。阶段仍保持 `FIXED_REAUDIT_PENDING`，等待独立 Agent 对包含本记录的固定候选 HEAD 最终只读复审。

### FACT — 第五轮独立复审

- 独立 Agent 对 `62ca71d8a2a79ebcb943c523e1a465b47c1d5381` 给出 `CHANGES_REQUIRED`，确认第四轮 GC crash、recovery schema guard、root fd、父目录 fsync 与 recovery fd leak 均已关闭。
- 新阻塞发现：2 High。
  1. 单一 `media_type` 的 first-writer 策略会让同 bytes 先以普通 MIME 写入后，File chunk、Directory/World manifest 与 Snapshot 的合法构造稳定失败；
  2. SQLite 仍会按 pathname 重开 main DB，并按 pathname 打开 `world.db-wal/-shm/-journal`，只保护 main 文件不足以阻止 sidecar symlink 越界与打开窗口内的入口替换。
- 残余发现：root replacement 后公开 pathname locator 可能指向替换目录；World root/CAS 新目录 fsync 异常路径各有一个 fd leak。
- 审计 Agent 保持只读，未修改文件、运行测试/构建或启动服务；固定 HEAD、parent、白名单与 clean status 均通过。

### FACT — 第五轮修复

- 修复提交为 `d3119bc77520bdc2dad3fcd98534ed4cc6bb73ed`，parent 为 `62ca71d8a2a79ebcb943c523e1a465b47c1d5381`。
- CAS schema 升级为未发布的 v4：`cas_media_roles` 对每个 digest 追加多个 MIME role；`cas_objects.is_manifest` 是从 `0` 到 `1` 的单向、数据库 trigger 约束的 manifest attestation。首个 `media_type` 保持不可变兼容字段，但不再拒绝同 bytes 的新增合法 role。
- `putManifest()` 在一个 `BEGIN IMMEDIATE` 中验证/复用 bytes、追加 manifest role、单向 attestation 并绑定 child links；普通 JSON lookalike 只有经 manifest 构造路径 attestation 后才获得 manifest 语义。
- 直接反例覆盖：File chunk 先以 `text/plain` 写入、Directory/World manifest canonical bytes 先以 `application/json` 写入、Snapshot 的六个 section bytes 先以普通 JSON 写入，随后构造均成功且完整性为 0。
- WorldDB main、WAL、SHM 与 rollback journal 均先以 `O_NOFOLLOW` 打开，要求 single-link regular file，fsync 后锁定 World root 为 `0500`，再次核验 inode 后才交给 SQLite；Store 正常关闭或构造失败时恢复 `0700`。
- 首次空库在受限的 bootstrap 窗口完成 WAL/schema transaction，再重新固定全部 SQLite entries 后进入正式 Store 生命周期；已有 authority DB 不经过 bootstrap 写窗口。
- `databasePath`、`objectsRoot`、`stagingRoot` 与 `resolveObjectPath()` 改为 pinned `/proc/self/fd/...` locator，root rename/replace 后不会指向替换 World；两个 fsync 异常路径均显式关闭新 fd。
- 双进程 CAS link-vs-GC 测试的协作文件移入受权 `recovery/` 子目录，不再依赖锁定后的 World root 顶层可写。

### FACT — 第五轮修复后主代理验证

- `bun test tests/kernel/world`：`45 pass / 0 fail / 237 expect`。
- `bun test tests/kernel`：`55 pass / 0 fail / 318 expect`，同时复验 AK-0 authority graph。
- schema bootstrap 4 进程竞争测试额外连续运行 5 轮，全部通过。
- `bun test tests/execd/state-store.test.ts tests/runtime/linux/cache/cas.test.ts`：`17 pass / 0 fail / 47 expect`。
- `bun run typecheck`：通过。
- `bun run build`：通过。
- `git diff --check`：通过。
- hosted CI 仍因既有账号 billing lock 未执行；live/provider 测试未执行且不计为通过。

### INFERENCE — 第五轮修复候选门评估

第五轮 2 个 High 已由 append-only media roles/manifest attestation，以及 SQLite 全入口 no-follow + parent write lock 闭锁；2 个 residual 同步关闭。AK-1 继续保持 `FIXED_REAUDIT_PENDING`，必须由独立 Agent 对包含本记录的固定候选 HEAD 再次只读复审后才能完成。

### FACT — 第六轮独立复审

- 独立 Agent 对 `a0b9afa8275c7ac75ab703e9648529e76838a3d9` 给出 `CHANGES_REQUIRED`，确认第五轮 MIME collision、pinned DB/CAS locator 与稳态 sidecar symlink 问题已关闭。
- 新阻塞发现：3 High。
  1. `putManifest()` 信任公开 `referencedDigests`，可在同一事务内提升缺字段 manifest 或提交与 bytes 不一致的 child links；
  2. 首次 bootstrap 关闭验证 fd 后在可写 root 下交给 SQLite pathname，存在 main/sidecar 替换窗口；
  3. 每个 Store open/close 都切换共享 root 权限，一个并发 Store 关闭会解锁仍活跃 Store 的 authority 目录。
- 残余发现：公开 `WorldStore.root` 仍是可被替换的 configured pathname；CAS digest prefix 新目录 fsync 异常会泄漏 `prefixFd`。
- 审计 Agent 保持只读，未修改文件、运行测试/构建或启动服务；HEAD、parent、白名单、diff-check 与 clean status 证据一致。

### FACT — 第六轮修复

- 修复提交为 `c624645b68aa2401ac8c3f3c9a3b7a1d278e7609`，parent 为 `a0b9afa8275c7ac75ab703e9648529e76838a3d9`。
- manifest attestation 在同一 `BEGIN IMMEDIATE` 内解析 canonical bytes，对 File/Directory/WorldSection/World 执行完整 envelope、字段、排序、digest 与布局校验；child refs 从 bytes 推导并与调用方及已持久链接精确比对。
- malformed、noncanonical、missing-ref 与 extra-ref 在 `is_manifest` 提升前 fail-closed；同一 parser 复用于后续 integrity verification，避免 attestation 和完整性语义分叉。
- WorldDB 首次镜像在内存中构造并预置 SQLite WAL header，通过已验证 main fd 写入；进程间 hard-link lock 与 schema-fingerprint completion marker 区分完成、未完成与无法证明的 DB。
- root 在任何 bootstrap 或 SQLite pathname open 之前设为 `0500`，所有 main/WAL/SHM/journal fd 保持到 inode 复验完成；Store close 不再恢复顶层写权限，因此并发 Store 无法互相解锁。
- 崩溃遗留 bootstrap lock 只允许重建未完成的首次镜像；非空 DB 缺失 completion marker 时拒绝自动覆盖并报 `WORLD_DB_BOOTSTRAP_MARKER_MISSING`。
- `WorldStore.root` 改为 pinned `/proc/self/fd/<rootFd>` locator，原输入仅作为 `configuredRoot`；CAS prefix fsync 异常路径显式关闭 `prefixFd`。
- 新增反例覆盖 manifest 提升回滚、精确 refs、崩溃 bootstrap 恢复、无证明 DB fail-closed 与并发 Store close 不解锁。

### FACT — 第六轮修复后主代理验证

- `bun test tests/kernel/world`：`50 pass / 0 fail / 258 expect`。
- 新增专项组（manifest + bootstrap + confinement）：`21 pass / 0 fail / 90 expect`。
- `bun run typecheck`：通过。
- `bun run build`：通过。
- `git diff --check`：通过。
- hosted CI 仍因既有账号 billing lock 未执行；live/provider 测试未执行且不计为通过。

### INFERENCE — 第六轮修复候选门评估

第六轮 3 个 High 和 2 个 residual 已由同事务 manifest parser/reference derivation、进程间 bootstrap 证明协议、永不恢复的顶层 root write lock 与 pinned locator 闭锁。AK-1 仍保持 `FIXED_REAUDIT_PENDING`，必须对包含本记录的固定候选 HEAD 进行独立只读复审。

### FACT — 第七轮独立复审

- 独立 Agent 对 `36e62a6dbff11acec006f3df4ad1d0b702c35bb7` 给出 `CHANGES_REQUIRED`，确认第六轮 manifest full-schema/reference derivation、root lifetime lock、pinned locator 与 CAS prefix fd 关闭已成立。
- 新阻塞发现：4 High。
  1. 任意 dead-PID lock 文件会授权覆盖无 marker 的非空 WorldDB，可直接丢失已提交 World；
  2. stale lock 的 check/unlink pathname 存在 ABA/TOCTOU，两个恢复者可互删新 live lock 并发写 DB；
  3. hard-link completion marker 在 directory fsync 前已可见，第二进程可把未 durable marker 当作完成；
  4. World mutation 允许空 `objectId`/`path`，但 snapshot manifest parser 拒绝，导致已提交 World 无法 snapshot。
- 新残余发现：2 Medium。manifest parser 使用非 fatal UTF-8 decode；bootstrap metadata 与 CAS object FIFO 在 `fstat` 前可阻塞同步 open。
- 审计 Agent 保持只读，未修改文件、运行测试/构建或启动服务；HEAD、parent、白名单、diff-check 与 clean status 均通过。

### FACT — 第七轮修复

- 修复提交为 `0192aa5532d5fc2776f72c9c4e10ac9f6a40ad26`，parent 为 `36e62a6dbff11acec006f3df4ad1d0b702c35bb7`。
- 移除 PID file takeover 与 hard-link completion marker；新增 Linux `flock(2)` 独占锁，锁所有权由 kernel 绑定 fd 并在进程退出时自动释放，不再存在 stale pathname unlink。
- bootstrap provenance 改为固定 single-link state inode 上的 append-only `writing -> complete` log；每条记录绑定 initial image digest、installed time、schema version/fingerprint 并单独 fsync。
- 恢复只在 durable `writing` 存在、重建镜像 digest 一致且当前 DB bytes 是该初始镜像的完整前缀时进行；任意 lock 内容不作 provenance，非空无 state 或 state/DB 分叉始终 fail-closed。
- `complete` 只在 initial DB image fsync 后追加并 fsync，其后才释放 flock；部分 state record 依据最后完整 newline 截断后恢复，不存在可见但未 durable 的 completion 名称。
- `recovery/` 在预建 CAS staging、lock 与 state 后永久设为 `0500`；固定 entry 使用 `O_NOFOLLOW | O_NONBLOCK`、single-link regular-file 验证。CAS object read/existing-object probe 同样加入 `O_NONBLOCK`。
- manifest bytes 使用 fatal UTF-8 decoder 并要求 UTF-8 roundtrip bytes 一致。
- `createWorld()` 拒绝空 root object；`compareAndCommit()` 在任何 transaction/materialization 前拒绝空 World/branch/actor/commit/receipt ID，以及所有无法被 snapshot manifest 表达的空 mutation identifier/path/mediaType/status。
- 新增真实子进程在 bootstrap intent fsync 后与 image fsync 后硬退出，每个崩溃根由 4 个并发恢复进程收敛；同时覆盖 stale PID text 无权、无 provenance 非空 DB、非法 UTF-8、FIFO 和 mutation/snapshot contract。

### FACT — 第七轮修复后主代理验证

- `bun test tests/kernel/world`：`55 pass / 0 fail / 288 expect`。
- `bun test tests/kernel`：`65 pass / 0 fail / 371 expect`。
- `bun test tests/execd/state-store.test.ts tests/runtime/linux/cache/cas.test.ts`：`17 pass / 0 fail / 47 expect`。
- `bun run typecheck`：通过。
- `bun run build`：通过。
- `git diff --check`：通过。
- hosted CI 仍因既有账号 billing lock 未执行；live/provider 测试未执行且不计为通过。

### INFERENCE — 第七轮修复候选门评估

第七轮 4 个 High 与 2 个 Medium 已分别由 kernel-released flock、durable append-only bootstrap provenance、snapshot-compatible mutation validation、fatal UTF-8 与 nonblocking regular-file probes 闭锁。AK-1 仍保持 `FIXED_REAUDIT_PENDING`，等待独立 Agent 对包含本记录的固定候选 HEAD 只读复审。

### FACT — 第七轮复审隔离失效与新增发现

- 第七轮复审固定对象为 `5606f900fe06ca5e957b9992358e3275e06a88ad`，parent 为 `0192aa5532d5fc2776f72c9c4e10ac9f6a40ad26`。
- 审计开始后，主代理为重复测试短暂创建并删除未跟踪的 `node_modules` symlink；tracked tree、index 与 HEAD 未变化，但审计起止状态不一致。该轮即使没有代码发现也不得作为最终独立验收，必须在干净且全程不变的 worktree 上重做。
- 独立 Agent 最终给出 `CHANGES_REQUIRED`，确认 2 个阻断 High：
  1. bootstrap provenance 只证明 `world.db`，未拒绝无 `complete` state 时预置的非空 WAL/SHM/journal；
  2. transaction 前 validator 未检查运行时 `objectType` 与 metadata shape，可提交随后无法 snapshot 的 World。
- 审计另记录 2 个残余风险：目录 `fchmod(0500)` 后未再次 fsync；`flock()` 把非 contention errno 当 busy 且使用可回拨 wall clock。
- 审计期间的未跟踪 symlink 由主代理测试流程产生并移除，不是审计 Agent 写入；该过程违反本阶段 clean-start/clean-end 隔离要求，已作为治理事实保留。

### FACT — 第八轮修复

- 修复提交为 `3ae1d126a088f0e674a7c27f743876a4137695eb`，parent 为 `5606f900fe06ca5e957b9992358e3275e06a88ad`；只修改 `src/kernel/world/**` 与 `tests/kernel/world/**` 白名单内 6 个文件。
- bootstrap 现在在 durable `complete` 缺失时要求 `world.db-wal`、`world.db-shm`、`world.db-journal` 全部为空；检查基于已通过 no-follow/single-link/regular-file 验证并固定的 FD，在写 initial image 或发布 `complete` 前 fail-closed。
- 回归使用另一个相同 `installedAt` WorldStore 产生的真实有效 WAL 注入空目标 root，并验证构造拒绝、main DB 保持空、WAL bytes 保持不变；SHM 与 rollback journal 也逐项覆盖非空拒绝。
- `WORLD_OBJECT_TYPES` 成为冻结的运行时/类型共同真源；commit validator 在 transaction 前验证 exact object type，并要求 object/artifact/service metadata 为 plain non-array record。
- 回归逐项拒绝空 object type 和三类数组 metadata，确认 revision 保持 0；随后提交全部受支持 object types 并成功生成 revision 1 snapshot，闭合 commit-to-snapshot contract。
- `recovery/` 与 World root 在 `fchmod(0500)` 后立即 fsync 对应 directory FD。
- `flock` wrapper 读取 Linux errno：仅 `EAGAIN` 视为 contention，`EINTR` 在同一 monotonic deadline 内重试，其余错误立即 fail-closed；新增 invalid-FD 与双 FD contention/timeout 回归。

### FACT — 第八轮修复后主代理验证

- 定向 `file-lock + schema-bootstrap + store`：`24 pass / 0 fail / 116 expect`（加入全 object-type snapshot 断言后，单独 store suite 为 `14 pass / 0 fail / 82 expect`）。
- `bun test tests/kernel`：`70 pass / 0 fail / 391 expect`。
- `bun test tests/execd/state-store.test.ts tests/runtime/linux/cache/cas.test.ts`：`17 pass / 0 fail / 47 expect`。
- `bun run typecheck`：通过。
- `bun run build`：通过。
- bootstrap + flock 定向 suite 连续 5 轮：每轮 `10 pass / 0 fail / 35 expect`。
- `git diff --check`：通过；测试依赖 symlink 已删除，代码提交后 worktree 干净。
- 一次 build 前置命令因 PowerShell/WSL PATH 转义错误未启动 build；随后使用固定 Linux PATH 重跑并通过。该命令错误不计为测试或 build 通过证据。
- hosted CI 仍被既有账号 billing lock 阻塞为 0 steps；live/provider 测试未运行且不计为通过。

### INFERENCE — 第八轮修复候选门评估

第七轮复审的 2 个 High 与 2 个残余风险均已由 pinned-sidecar bootstrap validation、snapshot-compatible runtime validation、post-chmod directory fsync 和 errno-aware monotonic flock 闭锁。阶段状态仍为 `FIXED_REAUDIT_PENDING`；必须在全程无任何主代理 mutation 的干净 worktree 上完成新的独立只读复审，才可关闭 AK-1。

### FACT — 第八轮独立复审

- 独立 Agent 对 `398f13544fa02bd500613f3fbb0518d7922bc507` 完成 clean-start/clean-end 全程不变的只读复审，给出 `CHANGES_REQUIRED`。
- 第八轮 sidecar provenance、runtime mutation/snapshot contract、errno-aware flock 与 post-chmod fsync 均被静态确认关闭。
- 新增 1 个阻断 High：`createWorld()` 仅以 truthiness 检查输入，普通 JavaScript 可传入 truthy number；SQLite TEXT affinity 会把 materialized root 转为字符串，而 genesis ledger 保留数字。`verifyIntegrity()` 对 malformed genesis 只跳过 replay、不报 issue，可能错误返回零问题。
- 审计残余风险：bootstrap state torn record、错误 prefix/digest/fingerprint 尚无直接测试注入；`libc.so.6` + `__errno_location` 限定当前实现为 glibc Linux。当前权威 Ubuntu 环境满足该约束，musl 支持不在 AK-1 范围内。

### FACT — 第九轮修复

- 修复提交为 `3bd4bcedeb45e4e5b562e1e730665f60e398e445`，parent 为 `398f13544fa02bd500613f3fbb0518d7922bc507`；只修改 `src/kernel/world/store.ts` 与 `tests/kernel/world/store.test.ts`。
- `createWorld()` 仅把 `undefined` 视为省略值；规范化后的 `worldId`、`branchId`、`rootObjectId`、`owner`、`purpose` 在 transaction 前全部执行 runtime non-empty string validation，并在 WorldDB 与 genesis ledger 间复用同一组值。
- `verifyIntegrity()` 要求 `world.created` payload 具有 exact keys、non-empty root/purpose、合法 materialized digest 与 non-empty actor；任何 malformed genesis 都显式产生 `LEDGER_DB_DIVERGENCE`，不再静默关闭 deterministic replay。
- 新增五类普通 JavaScript number 输入反例，覆盖 world、branch、root、owner、purpose，并证明 WorldDB 未创建任何 World；另篡改 genesis payload 为 numeric root 且同步更新 payload digest，验证完整性检查仍明确失败。

### FACT — 第九轮修复后主代理验证

- 定向 `bun test tests/kernel/world/store.test.ts`：`16 pass / 0 fail / 90 expect`。
- `bun test tests/kernel`：`72 pass / 0 fail / 399 expect`。
- `bun test tests/execd/state-store.test.ts tests/runtime/linux/cache/cas.test.ts`：`17 pass / 0 fail / 47 expect`。
- `bun run typecheck`：通过。
- `bun run build`：通过。
- `git diff --check`：通过；测试依赖 symlink 已删除，代码提交后 worktree 干净。
- hosted CI 仍被既有账号 billing lock 阻塞为 0 steps；live/provider 测试未运行且不计为通过。

### INFERENCE — 第九轮修复候选门评估

第八轮独立复审的唯一 High 已由 pre-transaction normalized string validation 与 explicit malformed-genesis integrity failure 闭锁。AK-1 仍为 `FIXED_REAUDIT_PENDING`；需要新的 clean-start/clean-end 独立只读复审确认后才能关闭。
