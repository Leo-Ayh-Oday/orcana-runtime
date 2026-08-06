# Orcana Reliability Execution Plan（RC-00）

> 策略：先建立统一状态契约与可失败测试，再按
> Truth → Security → Execution → Durability → Provider/Tool → Context 顺序关闭缺陷。
> 发布线：v0.8.17 合流推送（Linux 底座修复 + 本计划同版交付）。

## 波次总览

| Wave | 主题 | 关闭 defect | 发布 |
|---|---|---|---|
| RC-00 | 基线与契约 | —（文档 + CI lane） | v0.8.17 |
| RC-01 | Verification 统一语义 | A1 A2 | v0.8.17 |
| RC-02 | Completion Tri-State | A3 A4 A5 A6 | v0.8.17 |
| RC-02.5 | ContextGuard（压缩专项） | X1 X2 | v0.8.17 |
| RC-03 | LSP/Patch 真实性 | A8 G1 | v0.8.17 |
| RC-04a | 权限 Intent 化（危险命令） | B1 B2 | v0.8.17 |
| RC-04b | 全工具 Intent + 路径规范化 | B3 H11 | v0.8.18 |
| RC-05 | 配置安全模式 / Ripple 独立 / MCP 能力 | B4 B5 | v0.8.18 |
| RC-06 | Seccomp deny-by-default | B6 | v0.8.18 |
| RC-07 | Profile 权威 / CPU 单位 / 锁队列 | C1 C2 C3 C4 H2 | v0.8.18 |
| RC-08 | 资源作用域 / Receipt 实测 | C5 F3 F4 F7 | v0.8.18 |
| RC-09 | 取消/Janitor 闭环 | F1 F2 F5 F6 | v0.8.18 |
| RC-10 | Session 幂等持久化 | D1 D2 D5 D6 H5 | v0.8.19 |
| RC-11 | Checkpoint 真恢复 | D3 D4 H8 H9 | v0.8.19 |
| RC-12 | SQLite/Compactor 原子性 | H6 H7 | v0.8.19 |
| RC-13 | 内核恢复 | E1 E2 E3 E4 E5 | v0.8.19 |
| RC-14 | Provider 流协议 | G3 G6 G9 G11 | v0.9.0-rc.1 |
| RC-15 | MCP 请求关联 | G2 | v0.9.0-rc.1 |
| RC-16 | 工具真实性与资源 | G4 G5 G7 G8 G10 G12 | v0.9.0-rc.1 |
| RC-17 | 代码卫生 | H1 H3 H4 H10 H12 A7 | v0.9.0-rc.1 |
| RC-18 | Context Authority（压缩终态） | —（承接 RC-02.5） | v0.9.0-rc.1 |

## 核心契约（先行）

### 契约 1：VerificationResult（六态）

```typescript
type VerificationStatus = "passed" | "failed" | "unavailable" | "error" | "timed_out" | "cancelled"
```

唯一进入通过证据的条件：

```typescript
result.status === "passed" && result.available && result.exitCode === 0
```

禁止调用方自行推导 `passed: available ? passed : true`。

### 契约 2：GateDecision（三态 + 终态）

```typescript
type GateDecision =
  | { status: "passed"; evidenceIds: string[] }
  | { status: "blocked"; reason: string }
  | { status: "incomplete"; reason: string }
  | { status: "unavailable"; reason: string }

type RunTerminalState = "completed" | "incomplete" | "blocked" | "cancelled" | "failed"
```

不变量：`BUDGET_EXHAUSTED ≠ COMPLETED`，`GATE_UNAVAILABLE ≠ PASSED`。

### 契约 3：OperationIntent（分期）

```typescript
interface OperationIntent {
  kind: "process" | "file_read" | "file_write" | "file_delete" | "network" | "service" | "git" | "mcp_unknown"
  executable?: string; argv?: string[]; shellCommand?: string
  cwd?: string; paths: string[]; networkTargets: string[]
  sideEffect: "none" | "local" | "external"; riskLevel: number
}
```

RC-04a 只做 `normalizeProcessIntent`（危险命令别名归一），RC-04b 全量。

### 契约 4：Resource Ownership Record

`runId / agentId / cellId / pid / cgroupPath / containerId / portLeases / lockKeys / tempFiles / secretBindings / state(allocating|running|cancelling|cleaning|cleaned|cleanup_failed)`
—— 在 RuntimeStateStore 基础上扩展，不建第三套存储。

### 契约 5：Stable Session Identity

`messageId + sessionId + sequence + contentHash + createdAt`，DB 约束 `UNIQUE(session_id, message_id)` + `UNIQUE(session_id, sequence)`，保存只写 `sequence > highWaterMark`。

## PR 强制模板

每个 RC PR 必须包含：
1. 关闭哪些 defect ID
2. 修复了哪个 invariant（引用 invariants.md 编号）
3. 修复前失败测试（红）
4. 修复后通过测试（绿）
5. 新增哪些故障注入
6. 是否改变兼容性
7. 是否引入降级路径
8. 降级是否可观察
9. 是否更新 gate-matrix
10. 是否更新 CHANGELOG
11. `git diff --check` + 全量测试对比基线（当前 3109/249），禁止回归

## 本地门禁（CI 账号锁定期间以本地为准）

```bash
bun run typecheck
bun run test          # 基线 3109 tests / 249 files
bun run build
bun run eval:linux    # 35 场景，34 PASS + 1 SKIP
bun run bench:mini
npm pack --dry-run
git diff --check
```

## 故障注入矩阵（evals/reliability/）

- 验证链：exit 1 / 命令不存在 / 超时 / 取消 / LSP 旧版本 / Judge 超时 / 末轮缺证据 / Patch 阶段 2 未应用
- 权限链：shell/run_process/run_shell_script 的 rm -rf / / 路径 ../ / 符号链接逃逸 / 损坏配置 / MCP 未声明能力 / seccomp unavailable
- Runtime：锁竞争 / 锁取消 / cgroup attach 失败 / 无 worktree / Broker SIGKILL / Run 取消 / pid=0 / 临时文件清理失败
- 持久化：100 次保存不膨胀 / 同内容两条消息 / EOF / SIGINT / 单次模式 / 保存中崩溃 / WAL 残留 / checkpoint 后 workspace 改动
- Provider：流半断 / tool call JSON 半断 / abort during backoff / Retry-After 429 超大 / MCP 并发反序 / MCP 退出 pending / thinking 分片

## 压缩专项（RC-02.5，用户已定稿）

- X1 用户约束滚动蒸馏：flash 提取硬约束（禁止/必须/验收标准/负面反馈）→ planStateContext，触发点：epoch rollover 前 / 入口窗口截断 / M0 创建
- X2 错误特征行保留：microcompact 保留 head 300 + error/fail/traceback 行 ≤3 行 + exit code/is_error
