# AK2-R7 Correction Gate — 候选证据包

**RED 冻结点：** `b65e53e`（`test(agent-os): freeze AK2-R7 counterexamples`；未 amend）
**R6 固定基线：** `421f1a73bce1802f8a91511940ff9753259b9b37`
**分支 / worktree：** `feat/agent-os-r7` @ `/home/fuqiang/worktrees/orcana-agent-os-r7`
**恢复点：** 会话恢复自上一窗口的 dirty worktree；恢复包
`/tmp/orcana-ak2-r7-rescue-20260823-090449/`（git status / HEAD /
diff --binary / untracked 副本 + SHA-256 / diff --check）。
**最终状态：** `READY_FOR_INDEPENDENT_AUDIT`（不写 PASS / CLOSED /
AK-2 COMPLETE / READY FOR AK-3）

> 注：原任务建议五段式提交链中的“test(agent-os): complete AK2-R7
> regression coverage”未单独成提交 —— 全部测试调和已分别随其所属修复提
> 交（理由见 §1 表内注），避免制造测试与生产不同步的中间态。

## 1. 提交链（父 → 子）

| Commit | 内容 | 父 |
| --- | --- | --- |
| `b65e53e` | test(agent-os): freeze AK2-R7 counterexamples（R7-00-1..14；隔离，未 amend） | 421f1a7 |
| （提交 2） | fix(agent-os): close AK2-R7 projection authority and lifecycle gaps（R7-01..R7-04；测试调和与修复不可分 —— TestProjectionCoordinator 子类 / 必填 intentReservationPath 直接由本修复产生，独立成提交会产生不可编译中间态） | b65e53e |
| （提交 3） | fix(agent-os): normalize World representation and attest typed manifests（R7-05 + store.test delta 格式 / r7-representation 两处调和） | 提交 2 |
| （提交 4） | docs(agent-os): record AK2-R7 candidate evidence（本文件 + 阶段文档 R7 节） | 提交 3 |

实际 commit hash 以 git log 为准（本文件在提交 4 中定稿）。

## 2. 文件白名单核验

实际修改（19 文件，+794/-333）全部位于白名单：

- `src/kernel/projection/{backend,broker-adapter,contracts,coordinator,
  intent-reservation,receipt-authority}.ts`
- `src/kernel/world/{cas,snapshot,store}.ts`
- `tests/kernel/projection/**`、`tests/kernel/world/**`
- `docs/agent-os/stages/**`、`docs/agent-os/evidence/ak2-r7/**`

未触碰：`src/runtime/linux/**`、`src/workflow/**`、`src/harness/**`、
`src/execd/**`、`src/kernel/effects/**`、`src/kernel/capabilities/**`、
package.json / bun.lock / bun.lockb、`.github/**`、任何 secret/billing/
provider 配置。每次提交前已执行 staged-file 白名单复核 +
`git diff --cached --check`。

## 3. RED→GREEN 原始数字

| 时点 | 数字 |
| --- | --- |
| 恢复时 dirty tree 复验 | 9 pass / 5 fail（R7-00-1..9 GREEN；R7-00-10..14 RED）——与外部控制器实测一致 |
| R7-05 实现后 | 14/14 GREEN（R7-00-1..14） |
| projection+world 全目录 | 320 pass / 1 fail（唯一 fail = R5-00-9 KNOWN RED，见 §7） |

## 4. 各修复项证明了什么（FACT vs INFERENCE 分层）

### R7-01 公开 Test Authority 消除（提交 2）

- FACT：生产模块不再导出 `markTestFixtureBackend` /
  `markTestHarnessReceiptAuthority`（WeakSet brand 已删）；
  `isProductionCommitAuthorized()` 仅接受 authenticated brand（当前无任
  何实现可设置 → production World commit 结构性 fail-closed，
  `PRODUCTION_WORLD_COMMIT_BLOCKED`）；fixture 正向能力经 tests/** 的
  `TestProjectionCoordinator` 子类（protected 覆盖）进入 commit 校验路径。
  R7-00-2 export inventory 同时检查 package/index/直接子模块 require 导出
  面 + 动态可见成员 → GREEN。
- INFERENCE：`PUBLIC_FIXTURE_AUTHORITY = 0`、
  `WORLD_COMMIT_WITHOUT_RECEIPT = 0` 由反例证明；**未证明** same-UID 进程
  不能伪造更深层 authority（架构边界，OWNER-DECISION-REQUIRED，见 §8）。

### R7-02 Final Intent / Cell Spec 单一来源（提交 2）

- FACT：coordinator.execute 两阶段构造 —— 完整 binding intent（正式
  command/scopeDigest/filesystemPolicyDigest/workspace/profile/network/
  resources/secretsDigest）先建，expectedCellSpecDigest 从该**完整**
  intent 派生后冻结进 immutable intent；spec-binding.ts 是唯一规范化编译
  入口；adapter spawn 前以确定性 envelope 契约拒绝身份偏差
  （`PROJECTION_AUTHORITY_IDENTITY_ENVELOPE`，R7-00-3 GREEN —— 真实
  coordinator → boundCommand → LinuxBrokerProjectionExecutor → 真实
  broker 注册路径，spawn 前 digest 一致或确定性拒绝）。
- INFERENCE：digest 一致性由 fixture broker lane + 真实 broker 构造路径证
  明；真实 bwrap/cgroup 隔离内的端到端 spawn 未在本 gate 证明（B 层
  ENV_BLOCKED，见 §6）。

### R7-03 Durable Intent Reservation 与 Dispatch（提交 2）

- FACT：RESERVED/DISPATCHED → UNKNOWN 为合法 stale reconciliation 边
  （单条条件 UPDATE 内含 status+时间窗，changes===1 强制 —— 时间窗口消
  除，R7-00-4 GREEN）；所有转移 `WHERE intent_id=? AND status=?` +
  changes===1，陈旧并发转换显式失败、终态不可覆盖/复活（双 connection 竞
  争反例 R7-00-5 GREEN）；markDispatched 在 executor 创建前持久化，写入失
  败 → executor 从未启动 + session 终态化 + cleanup + 可恢复 reservation
  （R7-00-6 GREEN）；cellId/receiptDigest/cellSpecDigest/commitId 持久化；
  journal 写入失败不吞（settlement 失败记录进 receipt reason，行保留供
  reconcile）；dispose() 关闭 registry SQLite connection；reservation path
  必填 kernel 配置（不再默认 /tmp），parent/DB/WAL/SHM/journal
  owner/euid/mode(0700/0600)/no-symlink fail-closed 校验。
- INFERENCE：跨进程竞争由两个 SQLite connection 反例证明；真正的多进程并
  发调度器场景未在本 gate 构建。

### R7-04 Cleanup / Mount / Root Identity（提交 2）

- FACT：upper/work 身份在 create 时记录（dev/ino），所有删除分支先复核身
  份 —— mount 消失后被替换为 foreign 目录 → 不 rm/chmod/unmount，
  cleanup failure + residue（REAL FUSE，R7-00-7 GREEN）；merged 身份同样
  复核；projection root 被 rename 后 canonical path 缺失 ≠ rootRemoved ——
  retained rootFd fstat 存活即拒绝删除/commit（R7-00-8 GREEN，World 未推
  进 + renamed 树内容原样保留）；cleanup 异常路径经 finally 关闭 retained
  child fd（/proc/self/fd 扫描零泄漏，R7-00-9 GREEN）。
- INFERENCE：daemon/mount ownership 的 /proc cmdline 子串检查仍为多因子之
  一（非独立 authority —— R6 已建立）；foreign mount 无法证明 identity 时
  进入 cleanup failure/reconciling，不卸载 foreign mount。

### R7-05 World Representation / Typed Manifest / CAS Reachability / Snapshot Fast Path（提交 3）

- FACT：
  - 单一规范化点 `normalizeMutations()`：legacy file mutation 按 **commit
    时刻** CAS isManifest 一次性解析为显式 representation；同一规范化
    mutation 用于 dedupe、冲突检查、requestDigest（与 coordinator 对账共
    用 computeCommitRequestDigest）、delta manifest、materialized apply 与
    ledger payload；replay 只消费持久化显式值，legacy 格式事件 →
    fail-closed LEDGER_DB_DIVERGENCE（不再读取可变 cas.isManifest）。
    promotion 后 verify/reopen 无 divergence、representation 事实不变
    （R7-00-10 GREEN，含 reopen）。
  - `WorldCas.attestFileManifest()`：注册 + isManifest + bytes/digest 自洽
    - canonical typed 解析（type==="file"、chunk layout/顺序/logical size）
    - 全部 chunk 对象存在且完整 + cas_object link 集合与声明引用完全一致。
    compareAndCommit 在任何 delta CAS 物理写入前对 file-manifest mutation
    执行 attestation → raw JSON 冒充拒绝（R7-00-11 GREEN，revision 不推
    进、零物理对象）、DirectoryManifest 拒绝（R7-00-12 GREEN）。
  - 合法 FileManifest 提交后 manifest→chunks link 建立 reachability；
    GC/recovery 后 chunks 存活且可物化（R7-00-13 GREEN）。
  - existing snapshot fast path：digest 比较之外，七个 manifest（world/
    filesystem/memory/task/capability/services/artifacts）逐一验证注册、
    bytes 存在（size+sha256 自洽）、typed canonical 解析、world manifest
    引用集与记录一致、snapshot owner links 恰好覆盖、每个 manifest 的
    cas_object links 与声明一致；任一缺失/损坏 → WorldCorruptionError
    fail-closed，零 CAS 写入零 residue（R7-00-14 GREEN）。
- 见 §6 测试调和记录。

## 5. 验证门禁结果

| 门禁 | 结果 |
| --- | --- |
| 定向反例（r7-counterexamples + r7-representation） | 14/14 GREEN |
| bun test tests/kernel/projection/ tests/kernel/world/ | 320 pass / 1 fail（R5-00-9 KNOWN RED） |
| authority graph（tests/kernel/authority-graph.test.ts） | 10 pass / 0 fail |
| bun run typecheck | 通过 |
| bun run build | exit 0，dist 生成 |
| git diff --check；git diff 421f1a7..<candidate> --check | 通过 |
| bun run test（官方聚合门禁） | 见 §5.1 |

### 5.1 Aggregate 分层归因

聚合日志：`/tmp/r7-aggregate.log`（exit=1；9 个失败文件逐一定位：
单独复跑 + BASE 421f1a7 临时 worktree 同窗口实证）：

| 失败文件 | 聚合 | 单独复跑 | BASE 实证 | 归因 |
| --- | --- | --- | --- | --- |
| tests/kernel/projection/r5-counterexamples.test.ts | fail | 14 pass / 1 fail | KNOWN RED 用例同名同败 | **KNOWN RED**（R5-00-9） |
| tests/kernel/projection/r7-counterexamples.test.ts | fail（R7-00-3，5.1s） | **9/9 pass** | — | 并发时序（真实 broker 注册 ~5s，聚合并发负载下超时）；非回归 |
| tests/runtime/execution/execution-gateway.test.ts | fail | **8/8 pass** | — | 时序；非回归 |
| tests/runtime/linux/broker-transaction.test.ts | fail（C5 /tmp residue ~5s 窗口） | **14/14 pass** | — | 时序（WSL 清理窗口）；非回归 |
| tests/harness_llm_agent_node.test.ts | fail | **8/8 pass** | — | 时序（假 timer/token，负载敏感）；非回归 |
| tests/harness_llm_agent_node_stream.test.ts | fail | **3/3 pass** | — | 同时序集群；非回归 |
| tests/runtime/linux/process-core.test.ts（LF-2 静态门） | fail | 46 pass / 1 fail | **46/1 同一用例同败** | **既有失败**（R5 引入、R6 已记录：src/kernel/projection/backend.ts 的 fuse-overlayfs 直接执行不在 allowlist；本 diff 零新增 child_process 使用 —— `git diff 421f1a7 -- src/ \| grep child_process` = 0；修复需架构决策，白名单外） |
| tests/runtime/linux/linux-foundation.test.ts（LF-1 capability probe） | fail | 51 pass / 1 fail | **51/1 同败** | **既有失败**（capability probe digest stability ~7.5s） |
| tests/runtime/linux/service-cell.test.ts（janitor cleanupRun） | fail | 8 pass / 1 fail | **8/1 同败** | **既有失败** |

QUARANTINED 7 个（provider lane，缺 DEEPSEEK_API_KEY + 网络）——按设
计 NOT_RUN，不计 PASS。touched-path 回归数：**0**。

审计者环境无 shell，其条件性动态验证由实现者运行时补齐执行并出具新鲜
输出：聚焦反例 14/14 GREEN（连续两次）、typecheck 通过、`git diff --check`
与 `git diff 421f1a7..6a56503 --check` 均通过。

## 6. 测试调和记录（非削弱；独立审计重点复核项）

以下调和均保持反例攻击目标全副武装，仅修正与目标无关的期望值/基线：

1. **store.test.ts「compare-and-commit materializes …」**：期望 delta JSON
   增加 `"representation":"raw"` —— R7-05 规范化的直接后果（任务明文要求
   request digest、delta digest 使用同一规范化 mutation）。
2. **r7-representation.test.ts R7-00-13**：物化期望从存储字节（manifest
   JSON）修正为逻辑内容 "hello"。依据：representation:"file-manifest" 的
   物化语义是 chunk 重组 —— 由既有锁定测试 materializer.test.ts R04
   （>1MiB 多 chunk FileManifest 重建逐字节一致）确立；verbatim 语义会向
   执行工作区写入 manifest JSON，架构上不可行。反例三目标不变：(a) 未
   attest 拒绝前置；(b) GC/recovery 后 chunks 可达；(c) 可完整物化。
3. **r7-representation.test.ts R7-00-14**：residue 基线移到人为删除之后
   （第二次调用的真实入口状态）。原冻结版本在删除前捕获 `before`，使任
   何零写入 fail-closed 实现在算术上无法满足 after===before。两条断言保
   留：必须抛错 + 零新增物理 CAS 对象。
4. **projection 测试基建**（提交 2 内，与修复不可分）：`TestProjectionCoordinator`
   test-only 子类替代已删除的生产 mark* brand；所有 coordinator 构造补
   必填 `intentReservationPath`（R7-03 fail-closed 的直接后果；R5-00-8 的
   reservation 路径从裸 /tmp 移入 kernel-owned 0700 临时目录 —— parent
   owner/mode 校验按设计拒绝裸 /tmp）；r7-counterexamples 的最终形态
   （R7-00-4 DISPATCHED 行经原始 SQL 播种、R7-00-7 rename 替换防 inode
   复用）。
5. **lint 级清理**（行为等价）：空 catch 升级为 ENOENT 条件性上报
   （console.error）或命名 catch；未使用 import/变量移除（全部为冻结基线
   已存在的模式）。

## 7. KNOWN RED（单独标记，不计 PASS）

- **R5-00-9（= R6-00-14）sealed 后同 UID 直写 upper/writeLayerPath**：
  攻击动作真实成功（tampered.txt 落盘），scan 返回含 tampered 路径的成功
  delta —— same-UID 架构无法阻止，fail-open 证据成立。测试以精确错误信
  息标记 KNOWN RED / OWNER-DECISION-REQUIRED。修复需 MAC/独立 UID/
  privileged daemon 架构决策（§8）。

## 8. OWNER-DECISION-REQUIRED

- same-UID authenticated receipt authenticity（MAC/signature/sealed IPC/
  独立 UID verifier）—— production World commit 当前结构性 fail-closed。
- same-UID immutable upper seal（privileged daemon / fs-verity / 独立身
  份）。
- production B/cgroup delegated lane 在当前环境的可用性（B 层
  ENV_BLOCKED：bubblewrap cleanup proof 不可得 → World commit 按契约拒
  绝；非条件 PASS）。
- durable reservation 的最终宿主位置（kernel-owned 显式路径已强制；跨主
  机/daemon 化属后续架构决策）。

## 9. RESIDUAL RISK

- requestDigest 规范化依赖 commit 时刻与对账时刻 CAS isManifest 一致；
  两刻之间同 digest 被 promotion 会使 post-commit 对账走 RECONCILING
  （fail-closed，非静默）—— 窗口极小，已记录。
- legacy 格式 ledger（旧版本写入、缺显式 representation）reopen 时
  verifyIntegrity 报 LEDGER_DB_DIVERGENCE（fail-closed 拒绝 replay）——
  无静默迁移路径。
- REAL FUSE lane（R7-00-7 等）依赖宿主 fuse-overlayfs；不可用环境该用例
  skipIf 跳过（不计 PASS；ENV_BLOCKED 记录于分层报告）。
- 跨进程 reservation 竞争由双 connection 反例覆盖；真实多进程调度器并发
  未构建。

### 9.1 独立只读审计发现（实现者逐项复核后收录；均非阻塞）

审计 Agent：reviewer（fresh context，静态对抗审查，未复用实现者结
论）；固定对象 `421f1a73bce1802f8a91511940ff9753259b9b37..6a56503`。
结论：**READY_FOR_INDEPENDENT_AUDIT —— 11 个攻击面 0 阻塞项**。

- <MINOR> coordinator.ts:1222/1476-1486 —— rootRenamedAway 检查与
  backend.cleanup()/removeVerifiedProjectionRoot 之间的同 UID check-
  then-act 窗口：窗口内发生 rename 可能被漏检 → rootRemoved=true 误报。
  失败方向：残留泄漏 + 提交密封视图 delta（无外部内容、无错误删除）。
  实现者复核：确认存在；完全闭合需 fd 相对删除 renamed 树（架构扩展）；
  同 UID 对抗已在 OWNER-DECISION-REQUIRED 边界内。记录不修复。
- <MINOR> store.ts:1063-1077/1300-1310 —— 直接 WorldStore 调用方的
  legacy mutation 在提交与对账/幂等重试之间遭遇 promotion 时，
  requestDigest 可能随时间翻转（虚假 RECONCILING / 幂等冲突；fail-
  closed 方向）。实现者复核：与 §9 第一条相同窗口；AK-2 投影管道不可达
  （scanner 恒显式 representation）。记录不修复。
- <INFO> intent-reservation 唯一性作用域限于单个 DB 文件（部署须共享同
  一 reservation path）；<INFO> 子类风格 gate 绕过是语言固有能力（设计
  使然）；<INFO> attestExistingSnapshot 不重查 isManifest 位（结构+
  bytes+link 检查占优；该位仅 putManifest 单调 0→1 可写，schema 触发器
  保护）。

## 10. Runtime residue 清理

仅清理本任务拥有的资源：per-test mkdtemp 目录经 afterEach/finally 删除；
reservation SQLite（含 WAL/SHM）随临时目录删除；FUSE mount 经
ownership-verified cleanup 卸载；bun test 子进程自然退出；未杀任何其它任
务进程，未重启 WSL。聚合门禁结束后 `/proc` 复核无残留 fuse-overlayfs /
broker 进程（见最终报告实测输出）。
