# Remote Workers 完成记录（LR2-7）

**计划编号：** LR2-7
**英文名称：** Remote Workers — Coordinator/Worker 委托执行与签名收据
**基线：** `23c3704` → 完成于 `732d14d`（含独立审核修复）
**状态：** ✅ 完成（P7-A~E + 独立审核闭环）

## 交付内容

| 阶段 | Commit | 内容 |
| --- | --- | --- |
| 计划 | `5cda547` | P7-A~E 阶段划分 |
| P7-A | `fc75648` | RemoteWire（Ed25519 签名消息：nonce/载荷摘要/版本检查） |
| P7-B | `1627b7c` | RemoteCellPlan（可传输 CellSpec + 签名 + 秘密句柄） |
| P7-C | `13ad933` | RemoteCoordinator（注册/选择/分配/Receipt 验证） |
| P7-D | `bc385ed` | RemoteWorker（执行/签名收据/artifact digest） |
| P7-E | `6f7bdce` | 8 项 Gate 逐条验收 |
| 审核修复 | `732d14d` | M1-M6 + m1-m8 全处置 |

## 独立审核（0 BLOCKER + 6 MAJOR + 8 MINOR，全部处置）

- **M1**：nonce 防重放未实现 → ReplayGuard（senderId+nonce 注册表，
  原样重放拒绝）。
- **M2**：wire 协议层未接入实际流程 → verifyReceipt 绑定 worker 身份/
  nonce 语义（内存管道第一版，签名链已强制）。
- **M3**：Lease 永不过期 → selectWorker 先 sweep 过期并释放 worker；
  过期 lease 不可续期；worker 自报 TTL 由服务端封顶（默认 10 分钟）。
- **M4**：exitCode=null（未跑/被杀）收据被接受 → EXIT_NOT_OBSERVED 拒绝；
  signal/spawnFailed 真实记录进签名收据。
- **M5**：defaultExecutor 伪造 writes（非 readonly 谎称 readonly）→ 移除，
  只写真实观测（函数执行器写面为空）。
- **M6**：SECRET_VALUE_LEAK 门禁未接入流水线 → validateCellPlanShape
  （含秘密键名防护）在 assign 与 worker.verifyPlan 强制执行。
- **m1-m8**：密码学随机 ID（randomId）、交叉伪造 workerId 路径测试、
  heartbeat 不自解挂（assignment 驱动 busy）、已验证收据幂等账本、
  cwd 回退语义、注释修正等。

## Gate 状态

```text
WORKER_HOLDS_COMPLETION_AUTHORITY    = 0 ✅（收据无完成判断，Graph 兜底）
UNSIGNED_RECEIPT_ACCEPTED            = 0 ✅
RECEIPT_ASSIGNMENT_MISMATCH          = 0 ✅（含交叉伪造路径）
SECRET_VALUE_LEAK_IN_PLAN            = 0 ✅（流水线强制执行）
CELLPLAN_TAMPER_ACCEPTED             = 0 ✅
UNMATCHED_CAPABILITY_ASSIGNMENT      = 0 ✅
LEASE_FENCING_ABSENT                 = 0 ✅（token 匹配 + 时间约束）
ARTIFACT_DIGEST_UNVERIFIED           = 0 ✅
```

## 测试

`tests/remote/` 6 个文件 58 测试全绿；全量门禁（typecheck/test/build/
diff-check）通过。

## 与现有组件的关系

- 复用：execd 协议语义（帧/事件/lease）、LR2-6 digest 体系、Receipt/
  Evidence 边界；
- 第一版内存传输（RemoteTransport 接口留待 mTLS 真实 socket）；
- Worker 收据与 coordinator 线上形状统一（同一 receiptDigest —— 签名
  双形状不一致已修复）。

## 遗留（v2 范围）

- 真实网络传输层（mTLS + 远程 socket）+ wire 消息编解码接入 coordinator/
  worker 全程；
- secret 句柄换取路径（当前只传 ID）；
- coordinator ↔ Graph 完成链接线（Evidence binding 自动化）。
