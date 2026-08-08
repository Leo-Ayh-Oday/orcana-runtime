# Strong Isolation 实现计划（LR2-4）

**计划编号：** LR2-4
**英文名称：** Strong Isolation — seccomp Profiles + Egress Gateway + orcana-cell-init + MicroVM
**上一版：** [LR2-3 Adaptive Scheduler](lr2-3-adaptive-scheduler-plan.md)（P3-A~F 完成，含独立审核）
**基线：** `36eb1a2`（LR2-3 Gate 验收，门禁 329/329）
**定位：** 强隔离层：seccomp Profile 体系 + Egress Gateway 记录/强制 + native cell-init（Rust）+ MicroVM 决策。

> 记录说明：push/release 按 LR2 计划线点名拆分。

## 零、现状盘点（2026-08-09）

- 已有：`seccomp-bpf.ts`（BPF 编译）/ `seccomp-oci.ts`（OCI 编译）——SeccompProfile 编译基础；
- 已有：`landlock-seccomp.ts`（Landlock 规则生成 + 可用性判定——本机 WSL LSM 未启用）；
- 本机：rust/cargo 可用（native 可真实编译）；无 KVM（MicroVM 仅决策 + 探测）；
- 无：seccomp Profile 维度系统 / 演进流程 / Egress Gateway / cell-init。

## 一、阶段划分

### P4-A seccomp Profile 体系（`src/runtime/linux/seccomp/profiles.ts`）

- Profile 维度：`runtimeFamily + toolKind + sandboxProfile + architecture`（计划 §8.2）。
- 首批 6 个：`node-bun-readonly / node-bun-build / python-readonly / git / compiler / unknown-deny`（unknown-deny 默认拒绝一切未分类 syscall）。
- 演进流程状态机：`observe → candidate → compatibility replay → security replay → canary → enforce`；**观察只生成候选，不允许自动晋升**（SECCOMP_AUTO_PROMOTION = 0）。
- 复用现有 SeccompProfile 编译（bpf/oci）。
- 验收：维度键稳定、unknown-deny 全拒绝、演进状态机（无自动晋升）、各 Profile 编译输出非空。

### P4-B Egress Gateway（`src/runtime/linux/egress/`）

- E1 记录模式：HTTP 代理记录 DNS 解析、目标 Host、端口、方法、字节数（真实观测；**不宣称无法绕过**）。
- E2 强制路由：接口定义 + 决策文档（Cell netns → 无外部默认路由 → 只能到 Gateway；本机 netns 受限——接口 + 文档，实际强制在具备 netns 能力环境启用）。
- E3 泄漏检测：上传字节预算、敏感模式扫描、重定向逐跳、DNS rebinding 防护、方法限制、目标分类（决策函数 + 测试）。
- 验收：E1 记录完整（每次请求一条记录）、E2 决策接口、E3 预算/模式检测、评测场景（重定向绕过检测）。

### P4-C orcana-cell-init（`native/orcana-cell-init/`，Rust）

- 模块：plan.rs / fd.rs / landlock.rs / seccomp.rs / rlimit.rs / env.rs / exec.rs。
- 固定执行顺序（9 步）：受保护 FD 读 CellPlan → 校验 schema/digest/授权 → 关闭未授权 FD → rlimits → no_new_privs → Landlock → seccomp → cwd+显式环境 → execve。
- 本机可 `cargo build`（真实二进制）；集成：TS 侧构造 plan → 二进制执行（条件测试：seccomp 可用时）。
- 验收：顺序不可变（代码结构 + 测试）、fd 关闭（未授权 FD 不继承）、plan 校验拒绝坏输入、exec 语义。

### P4-D MicroVM 决策（`docs/linux-foundation/lr2-4-microvm.md`）

- KVM 探测（/dev/kvm）+ Firecracker 适用/不适用清单（计划 §8.4）；本机无 KVM → 探测失败明确拒绝（MICROVM_WITHOUT_KVM = 0）。
- 产出：决策文档 + 探测函数 + 测试。

### P4-E LR2-4 Gate 验收 + 独立审核

```text
SECCOMP_AUTO_PROMOTION          = 0
UNCLASSIFIED_SYSCALL_ALLOWED    = 0
EGRESS_UNRECORDED               = 0
CELL_INIT_ORDER_VIOLATION       = 0
MICROVM_WITHOUT_KVM             = 0
```

每项一条验收测试 + 独立 subagent 审核（同流程）。

## 二、文件布局

```text
src/runtime/linux/seccomp/profiles.ts     Profile 维度 + 6 首批 + 演进状态机
src/runtime/linux/egress/gateway.ts        E1 记录 + E2/E3 决策
native/orcana-cell-init/                  Rust：plan/fd/landlock/seccomp/rlimit/env/exec
docs/linux-foundation/lr2-4-microvm.md     MicroVM 决策
tests/runtime/linux/seccomp/  tests/runtime/linux/egress/  验收测试
```

## 三、风险与决策

- **Landlock 本机不可用**：规则生成代码存在（条件启用），cell-init 的 Landlock 步骤在无 LSM 环境跳过（如实记录，不假装生效）。
- **Rust 编译**：cargo build 进 CI 门禁前先本地验证；二进制不打包进 npm（开发期 native 目录）。
- **Egress E2 强制**：本机无 netns 权限——接口 + 文档落地，强制路由在具备能力环境启用（E1 记录始终启用）。
