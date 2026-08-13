# AK2-R5 Correction Gate — 独立审核证据包

**候选链（固定审核范围）：** `b7d15db..HEAD`（`b7d15db4dfb70365cc94dcb38b78049e81ddcb11` 起）
**分支 / worktree：** `feat/agent-os-r5` @ `/home/fuqiang/worktrees/orcana-agent-os-r5`
**最终状态：** `READY_FOR_INDEPENDENT_AUDIT`（不写 PASS / CLOSED / AK-2 COMPLETE / READY FOR AK-3）

## 1. 提交链（父 → 子）

| Commit | 内容 | 父 |
|---|---|---|
| `d15cf90` | test(ak2): freeze R5 authority, base-root, lifecycle and CAS counterexamples | b7d15db |
| `d2fe516` | fix(ak2): remove receiptless production authority (R5-01) | d15cf90 |
| `10fb174` | fix(ak2): anchor projection root and terminalize lifecycle (R5-02/R5-03) | d2fe516 |
| `b02882d` | fix(ak2): fence FUSE ownership and intent cardinality (R5-04/R5-05) | 10fb174 |
| `38442ae` | fix(ak2): bind immutable content representation (R5-07) | b02882d |
| `3274fd5` | test(ak2): complete R5 regression and cleanup assertions (R5-08) | 38442ae |
| （下一提交） | docs(agent-os): record AK2-R5 candidate evidence | 3274fd5 |

RED commit 未 amend；修复未与 RED 混在同一提交。

## 2. 文件白名单（实际改动）

- `docs/agent-os/stages/ak-2-projection-world-commit.md`（本阶段文档）
- `docs/agent-os/evidence/ak2-r5/**`（本证据包）
- `src/kernel/projection/{contracts,coordinator,backend,broker-adapter,receipt-authority,materializer}.ts`
- `src/kernel/world/{manifests,snapshot,cas,store}.ts`
- `tests/kernel/projection/**`、`tests/kernel/world/**`、`tests/kernel/authority-graph.test.ts`

未触碰：`src/workflow/**`、`src/harness/**`、`src/execd/**`、`src/runtime/linux/**`
（本轮零改动）、package.json/lockfile、CI/secrets/远程配置。

## 3. R5-00 反例冻结（17 反例 + 1 静态门）

RED 证据（提交 `d15cf90`，基线 b7d15db）：`bun test tests/kernel/projection/
r5-counterexamples.test.ts tests/kernel/world/r5-cas-representation.test.ts`
→ **16 fail / 1 pass**（R5-01 导出面 inventory 静态门为不变式，基线即通过）。
全部失败由目标缺陷驱动（见下），无 setup/timeout/无关异常。

| 反例 | 内容 | RED → GREEN |
|---|---|---|
| R5-00-1 | 任意调用方实现 kind:"fixture" + allowTestBackends=true 不得获得 receiptless World commit | ✓ d2fe516 |
| R5-00-2 | baseProjectionRoot 是 symlink → start 在创建任何 child/物化/CAS 副作用前拒绝 | ✓ 10fb174 |
| R5-00-3 | base root 在验证与 child 创建之间被替换 → 拒绝；外部 sentinel 不变 | ✓ 10fb174 |
| R5-00-4 | assertReady() 抛异常 → 先 instance.cleanup()；未证明卸载不得遍历/删除 root；residue/error 保留 | ✓ 10fb174 |
| R5-00-5 | create 完成 FUSE mount 后被替换为 foreign FUSE → 不得卸载 foreign、不得 rm/chmod upper/work/merged（REAL） | ✓ b02882d |
| R5-00-6 | execute RUNNING 时并发 cancel → 先取消、等待 executor、恰好一个终态、cleanup 后无 writer | ✓ 10fb174 |
| R5-00-7a-e | seam 抛异常必须 terminalize：merged lstat / getFinalReceipt / isCleanupFinalized / sealForScan / commit preflight | ✓ 10fb174 |
| R5-00-8 | 同一 intent 被两个 adapter 实例 / 重建 adapter 使用 → 只允许一个 execution cell | ✓ b02882d |
| R5-00-9 | sealed 后同 UID 直写 writeLayerPath/upper → 不得返回成功 delta、不得 commit | **KNOWN RED**（见 §6） |
| R5-00-10 | raw bytes 恰为合法 FileManifest JSON → promotion/GC/recovery 后物化逐字节一致 | ✓ 38442ae |
| R5-00-11 | invalid final namespace 拒绝后无 CAS/file/staging residue | ✓ 3274fd5 |
| R5-00-12 | maxFileChunks 超限在第二份数组分配/逐项 normalize/打开目标文件前拒绝 | ✓ 3274fd5 |
| R5-01 | 生产导出面不导出任何 fixture/test authority 能力（STATIC 门） | ✓（不变式） |
| R5-03 | post-commit divergence → 显式 RECONCILING（不得谎报 REJECTED） | ✓ 3274fd5（回归） |

## 4. 修复记录

### R5-01 彻底删除 production receiptless authority
- `allowTestBackends` 选项整体删除；构造时结构性要求 receiptAuthority
  （所有 backend 含 kind:"fixture" 的任意结构化实现 / cast）。
- commit 不存在 receiptless 分支；scan 的 receipt/cleanup-proof 门对所有
  backend 无条件生效。
- `ProjectionReceiptAuthority.trustLevel`：`same-uid-untrusted`（
  RuntimeStateReceiptAuthority 声明）／`test-harness`（tests/ 内）／
  `kernel-authenticated`（未来）。commit 门：same-uid-untrusted →
  `PRODUCTION_WORLD_COMMIT_BLOCKED`；test-harness 只可配对 test-only
  fixture backend。
- 导出面 inventory 测试：`PUBLIC_FIXTURE_AUTHORITY = 0`、
  `WORLD_COMMIT_WITHOUT_RECEIPT = 0`。

### R5-02 可信 projection base root
- `ProjectionBaseRootAuthority`：0700 创建、O_DIRECTORY|O_NOFOLLOW 打开、
  owner === 当前 principal、mode === 0700、dev/ino 身份、session 生命周期
  保留 dirfd；child 创建/打开/删除相对 retained base fd
  （/proc/self/fd/N/<child>）；每次操作前 path 身份复核。
- `PROJECTION_BASE_PATH_AUTHORITY = 0`、`PROJECTION_ROOT_ESCAPE = 0`。

### R5-03 统一 lifecycle terminalizer
- `session.terminalized` 幂等 guard（最多一个终态 / 一个 terminal receipt）。
- execute intent 构建 guard（EXECUTION_INTENT_BUILD_FAILED）；abort 信号；
  runningExecute 注册。
- cancel 改 async：abort → await executor → 唯一终态化（cleanup 后无
  writer）；幂等返回同一 cleanupState。
- cleanupState 记录 phase / residue / mount truth。
- RECONCILING 终态（post-commit divergence 不谎报 REJECTED）。
- `NONTERMINAL_FAILURE_PATH = 0`、`CLEANUP_RESIDUE_SILENT_SUCCESS = 0`、
  `CANCELLED_WRITER_SURVIVES = 0`、`DUPLICATE_TERMINAL_RECEIPT = 0`。

### R5-04 FUSE mount ownership
- **实证**：mount id 在卸载后会被内核复用（同路径重挂载拿到相同 id）——
  id + upper dev/ino 不足；新增判别依据：fuse-overlayfs daemon 命令行
  （/proc/<pid>/cmdline 含 upperdir=<ours> 与挂载点；daemon 选项不进
  mountinfo）。
- create 错误路径 / assertMountOwned / cleanup / seal 全部绑定
  mountId + fsType/source + mountpoint 身份 + upper dev/ino + daemon
  命令行；foreign/unknown/replaced → 不卸载、不 rm/chmod、保留 residue。
- seal RO remount attestation 失败 → 记录 lenient mount id（清理依据不遗失）。
- `FOREIGN_MOUNT_UNMOUNT = 0`、`MOUNTED_TREE_RECURSIVE_DELETE = 0`、
  `OWNED_MOUNT_SILENT_LEAK = 0`。

### R5-05 intent 一次性 reservation
- `ProjectionIntentRegistry`（kernel-owned；coordinator 持有）；
  adapter 必填该 registry，删除实例内 Set —— 同一 intent 第二次 execute
  （任意 adapter 实例 / 重建 / 并发）拒绝；保留失败也消耗 intent。
- coordinator 不预占（adapter 是唯一 reservation 点；fixture 路径由
  session 状态机保证 one-cell-per-session）。
- `MULTI_CELL_INTENT_REUSE = 0`、`EXECUTION_SPEC_SELF_ATTESTATION = 0`。

### R5-06 sealed scan trust boundary —— 选 B（fail-closed）
- 当前 same-UID backend 不具备生产 seal authority（sealed 视图 = RO
  remount / mode-based，同 UID 可直写 upper）→ **production World commit
  被禁止**（PRODUCTION_WORLD_COMMIT_BLOCKED；同 R5-01 trust level 门）。
- 未写 `SEALED_VIEW_MUTABLE = 0`（无真实隔离不写 0）。
- 独立 UID / privileged daemon / MAC key / 新 IPC 属架构决策 →
  OWNER-DECISION-REQUIRED（不自行实现超范围系统服务）。

### R5-07 CAS typed content representation
- SectionManifestEntry 增加不可变 `representation`（raw | file-manifest），
  snapshot 创建时绑定（一次快照）；materializer 只服从该判别子，不读
  CAS 全局可变 isManifest；旧格式 fail-closed 拒绝（无静默 reinterpretation）。
- `NONDETERMINISTIC_SNAPSHOT = 0`、`MUTABLE_CONTENT_INTERPRETATION = 0`。

### R5-08 事务与资源上限
- validateFinalNamespace 移到 delta CAS 物理写入前（invalid commit 零
  CAS/file/staging residue）。
- parseFileManifest：chunk count 与 logical size 在第二份数组分配与逐项
  normalize 前检查（超限输入不触发 normalize/chunk read/write/CAS put）。

## 5. same-UID receipt authenticity —— OWNER-DECISION-REQUIRED（不写 CLOSED）

- 普通 JSON + 公开 SHA-256 不是 authenticated authority（同 UID 进程可
  改写 receipt 并重算公开 digest —— R3-00-3 证据测试保留）。
- RuntimeStateReceiptAuthority 显式声明 `same-uid-untrusted`；production
  acceptance 遇到 untrusted authority fail-closed
  （`PRODUCTION_WORLD_COMMIT_BLOCKED`）。
- Decision Packet（等待 Owner 决策；未替 Owner 决策、未实现超范围服务）：
  - A：独立 UID + 受保护 daemon（新 daemon/UID/IPC，部署复杂度高）
  - B：kernel-owned MAC/signature key + sealed IPC（可检测任意篡改；
    密钥管理/轮换；长期推荐）
  - C：显式 threat-model downgrade（零基础设施；安全模型降级必须被
    Owner 接受）
- 影响文件（若实施）：`src/runtime/linux/recovery/state-store.ts`、
  `src/kernel/projection/receipt-authority.ts`、新 daemon/密钥模块（不在
  本轮白名单；未经 Owner 决策不写入）。

## 6. KNOWN RED —— R5-00-9（OWNER-DECISION-REQUIRED；禁止伪造 GREEN）

- sealed 后同 UID 直写 writeLayerPath/upper 无法被阻止（无 kernel-owned
  immutable snapshot / 独立 UID / MAC 授权）→ 测试保持 RED，未跳过、未
  放宽 verifier、未 mock、未 conditional return。
- 有限次数 readdir/re-hash 不构成 TOCTOU 闭合（任务明确禁止以此宣称
  关闭）；仅检查 upper dev/ino 不构成证明。
- 该项与 R5-06（生产 seal authority 缺失）同源 —— 都等待 Owner 对
  authenticated execution authority 的决策。

## 7. 门禁

| 门 | 结果 |
|---|---|
| `bun test tests/kernel/projection/ tests/kernel/world/ tests/kernel/authority-graph.test.ts` | **303 tests：302 PASS + 1 KNOWN RED（R5-00-9）**（3 连，每次 ~29-40s） |
| `bun run typecheck` | 0 error |
| `bun run build` | ✓ |
| `git diff --check` | ✓ |
| 真实 fuse-overlayfs lane（R5-00-5 foreign swap / R4-00-11d EROFS / R3-00-8 / B lane） | PASS / ENV_BLOCKED 如实标注 |
| live/provider | NOT_RUN（QUARANTINED 清单未变） |
| aggregate `bun run test` | 基线外失败逐文件归因（BASE/HEAD 同窗口对照） |

- 基线外 aggregate 失败（linux-foundation 能力探测 / process-core LF-2 静态门 /
  service-cell cleanupRun / plan-cache-wiring wall-clock / harness 负载类）
  在 b7d15db 同窗口全部存在 —— 与本 diff 无关（A/B 对照记录）。
- 测试后环境：0 mount residue、0 残留进程、0 残留 /tmp 目录、worktree
  tracked+untracked clean。

## 8. INFERENCE

- trustLevel 门把「认证性」从实现中剥离：生产部署显式配置
  RuntimeStateReceiptAuthority（same-uid-untrusted）→ 结构性无法正向提交
  —— fail-closed 由配置承载，不依赖运行时巧合。
- daemon 命令行判别使 foreign 重挂载（含 mount id 复用）可被确定识别 ——
  mount ownership 不再依赖可复用/可伪造的单点证据。
- representation 判别子把「内容语义」绑定到内容寻址的 snapshot —— 全局
  可变标志无法再改变历史语义。

## 9. RESIDUAL RISK（不掩盖可构造反例）

- R5-00-9：same-UID 直写 sealed upper 仍可构造 → KNOWN RED +
  OWNER-DECISION-REQUIRED（不是 residual 降级，是已确认的未闭合反例）。
- production 正向 World commit 全部被 PRODUCTION_WORLD_COMMIT_BLOCKED
  拒绝（结构性）—— 无伪造正向通过；B lane 本机另受 cleanup proof
  不可得（无 cgroup 委托）限制（ENV_BLOCKED）。
- daemon 命令行判别依赖 /proc 可见性（同 UID 命名空间）；跨命名空间 /
  特权场景未覆盖（文档如实记录；超出本机验证范围）。
