# 进程执行点 Inventory（LR2-0C）

状态日期：2026-08-10

本文给出当前产品进程执行面的维护摘要。运行级隔离结论以
[Linux 沙盒当前状态与降级矩阵](../linux-foundation/current-status.md) 和单次
`SandboxReceipt` 为准。

## 当前结论

- 普通 Linux 短进程已经进入 `ProcessExecutor → LinuxExecutionBroker → Backend`。
- Broker 内部仍需运行少量受控宿主命令，用于 backend、能力探测、cgroup、workspace 和 cleanup。
- service、MCP、LSP 等长期进程已经有 ServiceCell/lifecycle 基础，但仍未完全进入普通 Broker/cgroup 权威。
- `legacy-process` 仍承担少量同步与兼容调用，统一进程 authority 尚未彻底收口。
- 静态旁路 Gate 已建立，但 allowlist 和 dynamic `require` 覆盖仍需收窄；`Gate = 0` 不应单独解释为所有进程都获得强沙盒。

## 执行面分类

| 分类 | 主要范围 | 当前解释 |
|---|---|---|
| 普通短进程 | shell、Git、TypeScript、test、verification | Linux 路径经 Broker；具体强度以真实 backend Receipt 为准 |
| Broker 内部 | supervisor、backend cleanup、capability/cgroup probe | 受控 runtime 操作，不等于普通 Cell 执行 |
| Workspace 管理 | overlay、worktree、临时目录 | 仍有同步宿主命令，需保持参数、路径和 cleanup 审计 |
| 长期服务 | service、MCP、LSP | 过渡 ServiceCell/lifecycle；不能继承普通 Cell 的 Bubblewrap/Podman/cgroup 声明 |
| Legacy/Remote | sync 兼容入口、remote worker | 待纳入统一 authority 或更小的明确例外 |
| 非产品 Runtime | scripts、bin、evals、测试夹具 | 不属于产品运行入口，按发布/CI 规则独立审计 |

## Gate 解释

检查脚本为 `bun scripts/check-process-bypass.ts`，允许清单为
`config/runtime-process-bypass-allowlist.json`。

Gate 的目标是阻止新增的未分类 `child_process`、`Bun.spawn`、
`Deno.Command` 或 `shell:true`。当前仍应完成两项收口：

1. 识别静态 import 与 dynamic require 等全部创建形式；
2. 把目录级 allowlist 收窄为明确文件和用途。

在这两项完成前，Gate 适合作为回归防线，不适合作为“唯一进程创建 authority
已经完成”的单一证明。

## 维护规则

1. 新增普通 Linux 产品进程必须进入 Broker。
2. 新增长期进程必须声明 Service identity、lease、readiness、取消与 cleanup。
3. Runtime 内部宿主命令必须保持固定用途、参数化调用和最小 allowlist。
4. 修改进程执行点后，更新本摘要并运行静态 Gate 与对应真实 backend 测试。

相关文档：

- [Linux 沙盒当前状态与降级矩阵](../linux-foundation/current-status.md)
- [后端契约](../linux-foundation/backend-contract.md)
- [安全模型](../linux-foundation/security-model.md)
