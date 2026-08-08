# Performance Plane 实现计划（LR2-2）

**计划编号：** LR2-2
**英文名称：** Performance Plane — Sandbox Plan Cache / CAS / Overlay Workspace
**上一版：** [LR2-1 orcana-execd 实现计划](lr2-1-execd-implementation-plan.md)（L1-A~I 完成，含独立审核修复）
**基线：** `6f1a576`（LR2-1 完成，门禁 318/318）
**定位：** 执行平面的性能层：编译产物缓存、内容寻址存储、瞬时工作区；先固定基准再定硬阈值。

> 记录说明：push/release 按 LR2 计划线点名拆分。

## 零、现状盘点（2026-08-09）

- 已有：`CacheManager`（cache-port.ts）——缓存路径映射 + 锁键 + 只读/独占分类（LF-5）；
- 已有：workspace-lease / isolation-lock（跨进程写互斥）；
- 本机无 bwrap/podman（WSL）——Overlay 验证走 Git Worktree fallback + 探测链；
- 无：编译产物缓存（每次 compileRequest 全量重编译）、CAS、Overlay、性能基线。

## 一、阶段划分

### P2-A Sandbox Plan Cache（`src/runtime/linux/cache/plan-cache.ts`）

- 缓存对象 `CompiledSandboxPlan`：
  `profileDigest / toolContractDigest / runtimeVersion / platform / backendVersion / policyDigest / mountTemplate / environmentTemplate / backendArgvTemplate / seccompObjectRef / validationResult`。
- 缓存键 = 上述 digest 组合（policyDigest 由 LR2-0 的 canonical JSON 计算——含 schemaVersion + canonicalizationVersion）。
- **运行时只允许注入**：Cell identity / workspace path / resource values / arguments / secret handles / temporary paths。
- **缓存内容不得含**：秘密值、真实 Token、临时端口、某次 Cell 的路径（模板化 + 注入分离）。
- 存储：内存 Map + SQLite 表（execd store 加 plan_cache 表？——独立模块用文件缓存 `~/.cache/orcana/plans/` + manifest；v1 内存+文件双写）。
- 验收：同键命中不重编译；不同 policyDigest 不共享（CACHE_CROSS_POLICY_REUSE）；模板无秘密（golden 检查）；注入字段不进键。

### P2-B 内容寻址缓存（`src/runtime/linux/cache/cas.ts`）

- 目录：`~/.cache/orcana/`：`cas/sha256/ objects/ staging/ locks/ manifests/ cache.db`。
- 写入流程：staging → 写 → digest → 校验 producer Receipt → 原子 rename → 标记 immutable → 发布 manifest。
- 状态机：`STAGING / VALID / QUARANTINED / INVALID / EVICTING`。
- 并发写：staging 目录唯一（临时名）+ 原子 rename（CONCURRENT_CACHE_WRITE_CORRUPT = 0）；锁文件防双写。
- 碰撞检测：同 digest 不同内容 → 拒绝（CACHE_KEY_COLLISION = 0）；producer Receipt 校验（FAILED_CELL_POLLUTES_CACHE = 0：失败 Cell 的产物不得晋升 VALID）。
- 验收：写入/读取/碰撞/并发/污染拒绝；evict 幂等。

### P2-C Workspace Overlay（`src/runtime/linux/workspace/overlay.ts`）

- 抽象：`WorkspaceOverlay`（create/diff/discard/snapshot）。
- 探测链：native OverlayFS（mount 可用性）→ fuse-overlayfs → **Git Worktree fallback**（本机验证路径）。
- 结构：lowerdir = 只读仓库快照；upperdir = Agent 写层；workdir；merged。
- Git 负责版本事实/提交/回滚；Overlay 负责瞬时克隆/写入差异/失败丢弃/Reviewer 只读快照。
- **Landlock 注意**（文档 + 测试）：必须针对 merged hierarchy 建规则（各层在 Landlock 看来是独立层级）。
- 验收：fallback 路径创建/差异/丢弃；OVERLAY_WRITE_ESCAPES_UPPER = 0（写隔离验证）；探测链顺序。

### P2-D 执行路径接线

- Broker 编译路径接入 Plan Cache（compileRequest 前查缓存，命中注入运行时字段）；
- CAS 接入缓存挂载（repo-map/AST 索引等共享只读缓存走 CAS 对象）；
- CellManager 执行前准备 Overlay 工作区（v1：execd 配置 overlay 模式开/关）。
- 验收：热启动复用（WARM_START_REGRESSION）；集成测试（两次执行第二次命中）。

### P2-E 性能基线（`evals/perf/`）

- 固定基准脚本：冷启动 / 热启动（plan 缓存命中）/ CAS 命中 / Overlay 创建时间；
- 记录基线到 `docs/linux-foundation/lr2-2-baseline.md`（本机硬件/内核/后端版本）；
- **先基线后阈值**：不做无基线硬阈值（计划要求）。

### P2-F LR2-2 Gate 验收 + 独立审核

```text
CACHE_KEY_COLLISION             = 0
CACHE_CROSS_POLICY_REUSE        = 0
CACHE_POISON_PROMOTION          = 0
CONCURRENT_CACHE_WRITE_CORRUPT  = 0
FAILED_CELL_POLLUTES_CACHE      = 0
OVERLAY_WRITE_ESCAPES_UPPER     = 0
WARM_START_REGRESSION           = 0
```

每项一条验收测试 + 独立 subagent 审核（同 LR2-1 流程）。

## 二、文件布局

```text
src/runtime/linux/cache/
├── plan-cache.ts     CompiledSandboxPlan 缓存（键=digest 组合，注入分离）
├── cas.ts            内容寻址存储（staging→digest→rename→manifest）
└── cache-states.ts   缓存对象状态机（STAGING/VALID/QUARANTINED/INVALID/EVICTING）
src/runtime/linux/workspace/overlay.ts   Overlay 抽象 + 探测链 + fallback
evals/perf/           基准脚本
docs/linux-foundation/lr2-2-baseline.md  基线记录
tests/runtime/linux/cache/  验收测试
```

## 三、风险与决策

- **本机无 OverlayFS 权限**：fallback（Git Worktree）为验证主路径，native 探测保留（条件启用）；
- **Plan Cache 失效**：任何 digest 分量变化 → 新键（天然无碰撞）；
- **CAS 大对象**：v1 只缓存共享只读对象（repo-map/AST/build info），不缓存可写 node_modules（禁止多 Cell 共享可写 node_modules——计划要求）。
