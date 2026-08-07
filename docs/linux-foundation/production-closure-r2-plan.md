# Orcana Linux Execution Authority Closure（LNXF R2.1）— 实现计划

**计划编号：** LNXF-R2.1
**英文名称：** Linux Execution Authority Closure
**审计基线：** 远端 `3bbf44298`（第二轮反向审查）；本机最新 `1c0880c`（OTS-012 后）
**上一版：** LNXF Production Closure R2（远端两轮独立审计产物，本计划为合并修订版）
**定位：** 在 LNXF-1.0（LF-0~LF-8）+ R0~R6 + PR-0~PR-10 修复线之后，进入 **Authority / Lease / Journal / Receipt 四元模型收敛** 的最终实现线。执行旁路归零是前置硬门槛。

> 记录说明：本线产出不进入 0.9 版本线，版本沿 0.8.26.x 推进；push/release 按 LNXF 计划线点名拆分。

---

## 一、缺陷来源与合并裁决

缺陷三源：**A** = 远端独立审计两轮；**B** = 本地全库安全审计（seccomp/journal/legacy 家族）；**C** = 交叉裁决实证（本机 WSL2 真实 cgroupfs + eval 实测）。

### 裁决要点（2026-08-07）

| 项 | 裁决 |
|---|---|
| seccomp BPF arch jt/jf 反转（`seccomp-bpf.ts:77`） | **确认 P0**（A 复核 + B 定位，双方一致；x86_64 命中即 RET_KILL，注释语义完全相反；无测试解码 filter） |
| `.codejournal` 仓库级命令宿主执行（`journal.ts:231`） | **确认 P0**（恶意仓库 → `execSync` 全 env 宿主 RCE，B 定位，A 升级确认） |
| legacy-process 执行旁路家族 | **确认 P0**（AST 门禁只扫 `node:child_process` 直连，`spawnLegacy/SpawnSyncLegacy/execShellLegacy` 隐形；7 调用方 10+ 处宿主执行） |
| cache key 路径穿越（`cache-port.ts:31-35`） | **结构确认 / 严重度降级**：`ProcessRequest` 无 cache 通道，模型当前不可达 → **P1 latent**；未来开放 cache capability 即 P0 host mount escape，必须在开放前修复 |
| cgroup probeWritable 恒假（`delegation.ts:57-67`） | **误判撤回**：本机实测 cgroupfs 含控制文件可 rmdir；`detectDelegatedRoot()` 正常工作（eval LX-002 PASS）。保留真实缺陷：**委托探测不充分 + 过度声称**（未验证 cpu/memory 真实写入、subtree_control、进程迁移） |
| createCell 授权链断口 + enableControllers 吞错 | **本机实测新确认 P1**：eval LX-016~019 真实 fail（`cgroup attribute missing: cell/memory.max`）。根因：`createCell` 独立调用时 agent 层授权 EINVAL 被 catch 静默吞掉（生产 broker 路径先 createRun/createAgent 不受影响） |
| CPU 记账单位错配 | **确认**（A + B 独立发现同一 bug：broker ÷10000 vs ledger ×10000，+Profile 无默认 quota） |
| OCI seccomp `defaultAction=ALLOW`（`seccomp-oci.ts:31`） | **确认 P1**（BPF 面 deny-by-default vs OCI 面 allow-by-default 语义不一致） |
| PDEATHSIG 仅注释无实现（`termination.ts:6`） | **确认 P1**（host-audit 下 setsid 守护进程逃逸 + 伪报干净） |
| network-policy / Landlock 无生产调用方 | **确认 P2**（LF-7 验收基于死代码；需 Production Reachability Gate） |
| 其余 A/B 重合项（digest 64 位、state 0644、非原子写、expiresAt 单次、拒绝集不全、镜像审批、workspace 锁旁路、Reserved Env、dependency 网络矛盾、host-audit 自动降级、Resource Contract、RequestedMount、physical key） | **全部确认**，并入对应 PR |

---

## 二、核心模型收敛

```
                    Trusted Execution Authority
                              │
                              ▼
                    Policy / Resource Compiler
                              │
                              ▼
                      Durable Cell Journal
                              │
                 ┌────────────┴────────────┐
                 ▼                         ▼
           Resource Leases            Backend Lease
      workspace/cgroup/cache        process/container
                 │                         │
                 └────────────┬────────────┘
                              ▼
                       Raw Execution Outcome
                              │
                              ▼
                       Verified Cleanup
                              │
                              ▼
                        Final Receipt
                              │
                    durable persistence
                              │
                              ▼
                         Evidence Ledger
```

**新不变量：**

```text
INV-K: 任何可能在 Runtime crash 后独立存活的资源，
      在获得执行权之前都必须拥有 Durable Recovery Handle。

INV-L: 所有 OS process / shell / container / network side effect
      必须源自单一执行入口（全库旁路归零，含 legacy 包装层）。

INV-R: 资源字段只有三种状态：ENFORCED / REJECTED_AS_UNSUPPORTED /
      NOT_PRESENT_IN_CONTRACT —— 禁止"字段存在、Compiler 接受、Backend 忽略"。

INV-P: 能力宣布完成必须证明生产可达：
      Public entry → production call graph → policy → backend → kernel primitive → Receipt
      （单元测试不能证明 production wiring）
```

---

## 三、PR 实施序列

### R2-0 撤销 Freeze / 缺陷登记（文档提交）

- 更新 `docs/linux-foundation/acceptance-matrix.md`：登记本计划全部缺陷（三源合并），状态统一为 Components IMPLEMENTED / Integration INCOMPLETE / Freeze REVOKED / M8 BLOCKED；修正上一版"本机 4 fail = 无 cgroup 委托"归因（实测为授权链断口 + 探测不充分）。
- 验收门：缺陷登记完整（source + reachability + runtime proof 三证据标注）；门禁全绿。
- 提交：本计划文档 + acceptance-matrix 更新，单 commit。

---

### PR-E1 执行旁路归零（P0 家族，最先实施）

> 顺序理由：`.codejournal`/service/MCP 是仓库级输入可达的宿主 RCE 面，不先归零，后续所有沙盒修复都可被旁路绕过。

**目标**：全库 OS process/shell/container side effect 单一入口 + 门禁可追踪。

| 子项 | 位置 | 方案 |
|---|---|---|
| E1.1 `.codejournal` command 铁律 | `src/agent/journal.ts:231` | 规则命令改走 `executeProcess`（broker，编译层 env 白名单 + timeout + Receipt）；保留 `file_exists`/`directory` 纯 fs 检查；迁移期加显式 allowlist 与日志 |
| E1.2 `service_start` | `src/tools/service.ts:223` | 迁 Service Cell：`executeProcess` + `profile:"service"`（bubblewrap，loopback，禁 env 继承）；迁移前至少禁 `{...process.env}` |
| E1.3 MCP server | `src/tools/mcp.ts:24`、`src/mcp/bridge.ts:111` | server 进程走 Service Cell；配置解析对 command 做 allowlist（绝对路径 + 签名校验可选） |
| E1.4 LSP client | `src/lsp/client.ts:121` | 暂存显式 allowlist（R1.2 待办）：禁 env 继承，`--stdio` 参数白名单；Service Cell 化列入 PR-14 后 |
| E1.5 astgrep `_exec` | `src/ripple/astgrep-provider.ts:191` | 改 `spawn("sg", ["scan","--json","--no-ignore",pattern,root])` 参数数组，删除 shell 拼接 |
| E1.6 worktree git | `src/workflow/agents/worktree.ts:86,97` | 暂存 allowlist（args 数组无注入面）；git worktree 经 broker 的 `git` 工具路径（R1 已 Broker 化）在 PR-13 统一 |
| E1.7 verification collector | `src/verification/collector.ts:81-115` | 死代码：删除或迁 broker（生产无调用方，倾向删除并以 R1 的验证路径替代） |
| E1.8 门禁扩展 | `tests/runtime/linux/process-core.test.ts:414` | AST 门禁同等追踪 `spawnLegacy|spawnSyncLegacy|execShellLegacy`；白名单显式枚举暂存调用方 + 迁移 deadline（0.8.27）；重命名门禁语义为 `DIRECT_NODE_CHILD_PROCESS_IMPORT_BYPASS`，新增 `HOST_PROCESS_BYPASS` 判定 |
| E1.9 旧 sandbox Job Object 死代码 | `src/sandbox/sandbox.ts`、`job-object.ts` | 从能力矩阵撤下"进程树强杀保证 (full)"声明（`.track()` 零调用）；或接线——倾向撤声明 |

**验收门**：`HOST_PROCESS_BYPASS = 0`（门禁追踪扩展后）；`.codejournal` 恶意仓库用例 fail-closed；service/MCP 无宿主 env 泄漏（`HOST_ENV_SECRET_LEAK: 0`）；全量门禁。

---

### PR-9 Execution Authority（Workspace / Mount / Env / Identity）

**目标**：Trusted Execution Authority 全链路收紧，消除 Authority 旁路。

| 子项 | 位置 | 方案 |
|---|---|---|
| 9.1 cwd 父目录 symlink 逃逸 | `policy-compiler.ts:357` `resolveAuthorizedCwd` | candidate 不存在时对**父目录链**逐级 realpath 检查（存在的前缀必须都在 worktree 内）；补测试：`worktree/link/child`（link→/etc）拒绝 |
| 9.2 Physical Workspace Key | `contracts.ts` AuthorizedWorkspace、`isolation-lock.ts` | 新增 `physicalWorkspaceKey = sha256(realpath(hostRoot) + dev + ino)`；锁键改 `workspace-physical:<key>`；workspaceId 保持逻辑身份不变。bind-mount/软链接 alias 不绕过单写者 |
| 9.3 RequestedMount 收紧 | `contracts.ts` UntrustedCapabilityRequest、`policy-compiler.ts` | `RequestedMount` 只允许 `workspace-relative | runtime-grant` 两态，**禁宿主绝对 source**；reserved target policy：禁止 `/`、`/proc`、`/dev`、`/sys`、`/usr`、`/bin`、`/lib*`、`/etc`、`/run`；仅允许 `/workspace/...`、`/cache/...`、`/run/secrets/...` 例外 |
| 9.4 Reserved Env Authority | `environment.ts` | `RUNTIME_RESERVED_ENV_KEYS = {ORCANA_RUN_ID, ORCANA_NODE_RUN_ID, ORCANA_AGENT_ID, ORCANA_CELL_ID, ORCANA_SANDBOX, ORCANA_WORKSPACE_ID}`；构造链末步写入（固定值 → 申请 → Secret → **Runtime identity 最后覆盖**）；requestedValues/secretEnv/白名单均不得覆盖 |
| 9.5 full-approved 批准门落地 | `policy-compiler.ts:202`、`broker.ts` | 注释声称的"运行时 Broker 校验"真实实现：`full-approved` 需 `executeOptions.approvalToken`（人工批准凭证）否则 `NETWORK_APPROVAL_REQUIRED`；Receipt 记录批准 ID |
| 9.6 拒绝集补全 | `environment.ts:19-33` | 增 `*_SECRET`、`*_PASSWORD`、`*_KEY`、`*_CREDENTIALS`、`all_proxy`（`matchesPattern` 通配覆盖） |
| 9.7 导出面收窄 | `index.ts` | 后端工厂（createHostAudit/Bubblewrap/Podman）、`spawnSupervised`、`applyProfileDefaults` 不再导出（内部引用改为 broker 注入）；外部仅 broker/类型/纯校验函数 |
| 9.8 挂载校验缺省收紧 | `policy-compiler.ts:75-84` | `validateMountRule` 无 projectRoot 时不允许跳过逃逸检查（fail-closed） |

**验收门**：`WORKSPACE_PATH_ESCAPE` 新用例（父目录 symlink）；`NETWORK_APPROVAL_REQUIRED` 用例；`ORCANA_RUN_ID` 伪造用例；`ENV_RESERVED_KEY_OVERRIDE: 0`；index.ts 导出面静态断言；全量门禁。

---

### PR-10 Cgroup Delegation Authority + 资源单位统一 + 契约完备

**目标**：委托真实验证、CPU 单位全局统一、资源字段无静默忽略。

| 子项 | 位置 | 方案 |
|---|---|---|
| 10.1 委托真实探针 | `delegation.ts` | `VerifiedCgroupDelegation`：create temp parent → enable cpu/memory/pids → create leaf → 写 memory.max/pids.max/cpu.max → spawn stopped child → migrate → 验证 `/proc/<pid>/cgroup` → kill → populated=0 → rmdir；任一步失败 → `delegation = unavailable`（不再"部分成功继续"）；`capability-probe.ts` 的 `delegated`/`supportsKill` 以探针结果为准（消除仅目录存在/仅 v2 的过度声称） |
| 10.2 CPU 单位统一 | `broker.ts:152`、`resource-ledger.ts:41-43`、`contracts.ts` | Runtime 内统一 `cpuMillis`（1000=1 CPU）；ResourceLedger `usableCPU = cores×1000`；cgroup materialization 转换 `quotaMicros = ceil(cpuMillis×100000/1000)`，period 缺省 100000；`resourceRequestOf` 换算改为 `/1`（直接传 cpuMillis）；Profile 钳制 cpuMillis 上限 |
| 10.3 资源契约完备 | `contracts.ts`、`cgroup/manager.ts` | `RESOURCE_DECLARED_BUT_NOT_ENFORCED = 0`：`readBpsMax/writeBpsMax` 编译期 `REJECTED_AS_UNSUPPORTED`（spec 校验拒绝）而非静默忽略；swap 显式声明（未设 = 不设硬限并记 Receipt 注记）；`maxOpenFiles` 由 rlimit 执行 |
| 10.4 createCell 授权链 | `cgroup/manager.ts:163-213` | `createCell` 独立调用时自建完整授权链（ensure+enable run → agent → cell）或对缺失层 fail loudly；`enableControllers` 失败不再吞错：返回 `{enabled, failed[]}`，调用方按 profile fail-closed；子串匹配改 token 精确匹配（cpuset 误判） |
| 10.5 attach 失败 fail-fast | `broker.ts:491-499` | 严格 Profile（untrusted/evolution/dependency/service）attach 失败 → 树级 kill + `EXECUTION_ABORTED`；非严格记 degradation（现状保留） |

**验收门**：真机断言（WSL2 systemd 场景 `delegation.writable===true` 且 `VerifiedCgroupDelegation.controllers 全真`）；eval LX-016~019 走完整 broker 路径后 PASS（授权链修复）；`CPU_UNIT_MISMATCH: 0` 静态测试；`RESOURCE_DECLARED_BUT_NOT_ENFORCED: 0`（readBps 用例被拒）。

---

### PR-11 Durable Cell Journal + Typed Resource Lease

**目标**：crash 后任意资源可恢复（INV-K）。

| 子项 | 位置 | 方案 |
|---|---|---|
| 11.1 执行日志 | 新增 `src/runtime/linux/recovery/execution-journal.ts` | 结构 `runs/<runId>/{run.json, cells/<cellId>.json, receipts/, cleanup.json}`；`CellExecutionJournal`：schemaVersion/runId/cellId/nodeRunId/agentId/phase（PREPARING→RESERVED→MATERIALIZED→PROCESS_PREPARED→ARMED→RUNNING→EXITED→CLEANING→FINALIZED→FAILED）/backend/workspaceId/reservationIds/lockKeys/cgroupPaths/process{pid,startTicks,pgid}/container{id,cidfile}/materializationRoot/owner{bootId,pid,startTicks}/receiptDigest |
| 11.2 写时序 | `broker.ts` execute | 资源创建 → 写 journal → fsync → 才允许跨下一条 side-effect boundary；**spawn 获取 PID/startTicks → journal → fsync → cgroup attach → journal=ARMED → fsync → 执行 payload** |
| 11.3 Typed Resource Lease | 新增 `src/runtime/linux/scheduler/lease.ts` | `ManagedResourceLease`（HostReservationLease/WorkspaceLockLease/CacheLockLease/CgroupLease/MaterializationLease/ProcessLease/ContainerLease）；`release(): Promise<ReleaseResult>` + `toRecoveryHandle()`；内存事务与 durable journal 共享同一 handle（替代裸 closure compensation stack） |
| 11.4 state-store 加固 | `recovery/state-store.ts` | 全部文件 0600、目录 0700；temp+rename 原子写；损坏文件按"无法判定"跳过清理（不再等同 stale）；修复 `broker.ts:481` cells 字段 `map(r.runId)`→`map(r.cellId)`；receipt 文件名用 receiptDigest/cellId（消除 `Date.now()` 同毫秒覆盖） |
| 11.5 Janitor 消费 journal | `recovery/state-store.ts` startupJanitor | 按 journal phase 恢复：ARMED/RUNNING 的 cell → 按 owner{bootId,pid,startTicks} 验证宿主 → kill PID/cgroup/container/materializationRoot；同 boot 存活不误杀（PR-7 语义保持） |

**验收门**：故障注入（kill -9 于每个 phase 后重启）→ Janitor 归零验证；`WRONG_PROCESS_KILL: 0`；journal 文件 0600 断言；`CELL_JOURNAL_PHASE_SEQUENCE` 状态机测试。

---

### PR-12 Direct Backend Process Gate + seccomp 修复

**目标**：direct backend（host-audit/bubblewrap）attach-before-exec；seccomp 控制复活。

| 子项 | 位置 | 方案 |
|---|---|---|
| 12.1 seccomp BPF jt/jf 反转（**首位**） | `seccomp-bpf.ts:77` | 交换 jt/jf（匹配 → 跳过 KILL）；**先写 BPF 解码+模拟测试**（arch 命中/未命中、deny 命中、allow 命中、兜底四路径），再修实现（TDD，防回归） |
| 12.2 OCI seccomp 统一 | `seccomp-oci.ts:31-32` | `defaultAction` 从 profile 透传（`SCMP_ACT_ERRNO` 时输出 ERRNO + allowSyscalls 列表）；断言测试：`compileOciSeccomp(untrusted).defaultAction === "SCMP_ACT_ERRNO"` |
| 12.3 spawn stopped gate | `process/supervisor.ts`、`backends/host-audit.ts`、`backends/bubblewrap.ts` | Direct 后端：spawn（stopped/SIGSTOP）→ 等成功 spawn（spawn 失败时 PID undefined，禁 `pid ?? 0`）→ SafePid（startTicks 校验）→ journal PID → attach cgroup → 验证 `/proc/<pid>/cgroup` → SIGCONT → payload |
| 12.4 PDEATHSIG 真实实现 | `process/supervisor.ts`（child preload） | `prctl(PR_SET_PDEATHSIG, SIGKILL)` 经 spawn preload/包装注入；或 `killOnParentExit && backend===host-audit` 拒绝执行（fail-closed）——二选一，倾向真实实现 |
| 12.5 取消/超时 PID 归属校验 | `process/termination.ts:70-100` | `terminateTree` kill 前验证 `startTicks`（复用 broker `readProcStartTicks` 技术）；pid 复用窗口错杀归零 |
| 12.6 PathGuard 快照 TOCTOU | `backends/pathguard.ts:59-73` | `lstat` 不跟随 symlink（符号链接只记指纹）；open 后 fstat 二次确认 + 有界读（长度上限）；快照移出事件循环或异步化 |
| 12.7 进程层小项 | `supervisor.ts:67` | spawn 同步抛错时 seccompFd closeSync（fd 泄漏）；streamSupervised `queueDropped` 计入 exit 结果（不再静默丢块） |

**验收门**：BPF 模拟测试 4 路径全过；`ATTACH_BEFORE_EXEC: 0`（strace/钩子验证 attach 先于 payload 执行）；eval LX-033 升级为 filter 语义测试；PID 复用用例（kill 前 startTicks 不匹配拒绝）。

---

### PR-13 Agent Domain + Physical Workspace Lock + 聚合预算

- **目标**：多 Agent 隔离域的物理级单写者 + 聚合预算权威。
- **内容**：
  - 13.1 `AgentDomainManager` 以 `physicalWorkspaceKey` 签发锁（接 PR-9.2）；
  - 13.2 聚合预算：Domain 层 cgroup 限额（memory/pids/cpu）为唯一聚合权威，cell 层只能 ≤ Domain 预算（消除"单 Cell 预算冒充聚合"）；
  - 13.3 `closeDomain` 复用 `collectSubtreeDirs` 自底向上移除（agent 级残留修复）；
  - 13.4 `isolation-lock` 增加 TTL/强制释放（可用性，P3 提升）；`releaseAll` 接线到 cancelAgent。
- **验收门**：`MAIN_WORKSPACE_MULTI_WRITER: 0`（bind-mount alias 用例）；`CROSS_WORKTREE_SERIALIZATION: 0`；`RESOURCE_OVERCOMMIT: 0`（CPU 单位修复后重验）；closeDomain 残留扫描 = 0。

---

### PR-14 Podman create/start 生命周期 + Secret/物化 + Janitor

- **目标**：Container Backend 分离生命周期 + 容器级 cgroup 验证 + 物化清理闭环。
- **内容**：
  - 14.1 生命周期：`podman create` → containerId → journal（fsync）→ 验证 OCI 配置 → `podman start --attach` → 读取真实 container init PID/cgroup → 验证资源归属（cgroup 路径含 cell 标识）→ 执行；不再以 `podman run` 不可分解操作；
  - 14.2 镜像审批修正：`DIGEST_PATTERN` 加 `^` 锚定 + 拒绝 transport 前缀（`dir:`/`docker-archive:`/`containers-storage:`）；`approvedImage` 改为解析后 `(repo, digest)` 精确相等（删除前缀匹配）；
  - 14.3 cidfile 身份校验：内容必须匹配 `^[0-9a-f]{64}$` 且与 journal containerId 一致才允许 `rm -f`（跨租户误删归零）；cidfile 改放 `~/.orcana/runtime/linux/`（0700，移出 sticky /tmp）；
  - 14.4 secrets 加固：secretsRoot 0700 + 创建前 `lstat` 拒绝已存在条目（反符号链接预创建）；`expiresAt` 使用侧复核（service 长生命周期）；cleanup 失败计入 Receipt/告警（不再 best-effort 吞错）；
  - 14.5 dependency profile 网络矛盾（方案 A）：`dependency.network = none` + 网络安装场景标记 BLOCKED（等 proxy egress backend 再开放）；`proxy-allowlist` 在 podman validateSpec 拒绝面保持；
  - 14.6 Landlock/network-policy 死代码裁决：Landlock 在 bwrap 路径真实接线（ABI≥1）或从文档撤声明；network-policy 在 proxy-allowlist 开放前标记 `NOT_WIRED`（INV-P 豁免登记）；
  - 14.7 host-audit 自动降级：`enabled/enforced` 模式下 `build.allowDegradation = false`；host-audit 仅 shadow/diagnostics/显式 trusted-host override；
  - 14.8 podman 小项：env 键格式校验 `^[A-Za-z_][A-Za-z0-9_]*$`；`,Z` SELinux 副作用文档化；`containerRemoved` 真实验证（替换硬编码 true）。
- **验收门**：podman lane（真实容器）create/start 分离用例；`FLOATING_IMAGE_ACCEPTED: 0` 强化（transport 前缀用例）；`CONTAINER_SOCKET_VISIBLE: 0`；secrets 符号链接预创建攻击用例 fail-closed；`SECRET_TEMP_RESIDUE: 0`。

---

### PR-15 Final Receipt 单一权威 + 原子持久化 + Evidence 绑定

- **目标**：Receipt 无推定值、持久化原子、Evidence 绑定完整。
- **内容**：
  - 15.1 `worktreeRetained` 实测化（`receipt.ts:136` 抄 spec 推定 → ReceiptInput 实测字段，未测量显式缺省）；
  - 15.2 `receiptComplete` 语义：区分实测 0 与推定 0（cleanup 未验证不算完整）；`processesRemaining:-1`（未验证）不满足完整性门；
  - 15.3 Receipt 持久化失败不再静默（`broker.ts:567-570` → 告警 + journal FAILED 记录 + 重试一次）；
  - 15.4 持久化原子（temp+rename 接 PR-11.4）；Evidence 绑定 receiptDigest 保持，digest 宽度升级（接 9.x/11.x 的 256 位）。
- **验收门**：`SANDBOX_RECEIPT_INCOMPLETE: 0`；推定值用例（未验证 cleanup → receiptComplete=false）；持久化失败注入用例。

---

### PR-16 真机 Eval + 故障注入 + 安全 CI

- **目标**：验收真实性（INV-P）+ CI 安全。
- **内容**：
  - 16.1 eval 修正：LX-016~019 改走完整 broker 路径（不再直接 createCell）；LX-033 升级 filter 语义测试；新增各 PR 验收用例入库；
  - 16.2 故障注入：kill -9 于 journal 各 phase → Janitor 恢复归零（接 PR-11.5）；
  - 16.3 CI 安全（采纳远端修正）：**公共仓库 fork PR 不跑 persistent self-hosted runner**；GitHub-hosted lane（typecheck/unit/integration/bubblewrap capability）→ PR；ephemeral isolated runner 仅 protected main push / trusted merge queue / manual release-freeze workflow；
  - 16.4 Production Reachability Gate：新增脚本断言每个"已宣布能力"的生产调用链存在（network-policy/Landlock 类不再假绿）。
- **验收门**：`bun run eval:linux --strict` 全绿（真机 lane）；CI lane 分离生效；reachability 断言通过。

---

## 四、依赖链与顺序

```
R2-0 ──► PR-E1（旁路归零，P0 RCE 面）
         │
         ├──► PR-9（Authority 收紧）──► PR-11（Journal/Lease）
         │              │                        │
         │              ▼                        ▼
         │         PR-10（cgroup/资源）──► PR-12（Direct Gate + seccomp）
         │                                        │
         └──► PR-13（Domain/物理锁）◄──────────────┘
                        │
                        ▼
                  PR-14（Podman/Secret/Janitor）──► PR-15（Receipt）
                                                         │
                                                         ▼
                                                  PR-16（Eval/CI）──► 汇合门禁 ──► 0.8.27
```

依赖要点：
- PR-E1 独立可先行（不依赖 Authority 重构）；
- PR-12 的 12.1 seccomp 修复为**独立紧急项**，可脱离 PR-12 单独提前落地（阻塞 eval 语义测试）；
- PR-11 先于 PR-12/14（journal 必须先于 process/container 真实 side effect）；
- PR-10.4（授权链）与 PR-12.3（attach gate）有交叠——10.4 只修 enableControllers 契约，12.3 完成 attach-before-exec 时序。

## 五、版本线与发布

| 版本 | 内容 |
|---|---|
| 0.8.26.3 | R2-0 + PR-E1（旁路归零）+ 12.1 seccomp 修复（紧急） |
| 0.8.26.4 | PR-9 + PR-10 |
| 0.8.26.5 | PR-11 + PR-12 |
| 0.8.26.6 | PR-13 + PR-14 |
| 0.8.27 | PR-15 + PR-16 汇合（门禁全绿 + eval:linux --strict 真机 lane PASS）→ 恢复 LNXF Freeze 审议 → 解 M8 阻塞 |

## 六、风险与遗留

- **风险**：PR-12.3 spawn stopped gate 与 Bun spawn 兼容性（需验证 SIGSTOP 后 attach 窗口）；PR-14 create/start 分离对 podman 版本依赖；PR-9.7 导出面收窄可能破坏外部消费者（需 grep 全库调用方）。
- **遗留（本线不处理）**：跨进程资源协调（ledger 单进程边界，已知）；proxy-allowlist 网络后端（dependency profile 网络安装 BLOCKED 至后续线）；Windows Job Object 接线（Windows 单独计划线）。
- **冲突裁决**：A/B 冲突项一律以"source + reachability + runtime proof"三证据裁定（本计划中 probeWritable 误判即按此撤销）；B 报告打分（代码覆盖 4.5/5、内核语义 3.3/5）不改变发现归属，只影响验证强度要求。
