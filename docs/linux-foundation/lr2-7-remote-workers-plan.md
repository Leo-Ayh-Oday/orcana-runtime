# Remote Workers 实现计划（LR2-7）

**计划编号：** LR2-7
**英文名称：** Remote Workers — Coordinator/Worker 委托执行与签名收据
**上一版：** [LR2-6 Evolution Lab](lr2-6-evolution-lab-plan.md)（P6-A~E 完成，含独立审核）
**基线：** `23c3704`（LR2-6 完成，门禁全绿）
**定位：** 远程协议复用本地语义（SubmitCell/WatchEvents/Cancel/Lease/Receipt/
Artifact/Recovery）。Coordinator 持 Graph/分配/授权/完成权威，Worker 只执行
并生成签名 Receipt —— **Worker 永远不能拥有全局完成权**。

> 记录说明：push/release 按 LR2 计划线点名拆分。

## 零、现状盘点（2026-08-09）

- 已有：LR2-1 execd 协议（`src/execd/protocol/`：messages/frame/events/
  peercred + PROTOCOL_VERSION=1）——**本地 Unix Socket RPC**；
- 已有：LR2-1 lease-manager（获取/续期/释放/过期幂等）、recovery；
- 已有：LR2-6 EvolutionManifest（ReplayCaseRef/评分器/digest 体系）；
- 已有：Receipt（LR2-0）与 Evidence（Graph Completion Gate）；
- 无：远程传输（mTLS/身份）、Coordinator 分配、Worker 执行端、CellPlan
  签名、Receipt 签名验证、Artifact 传输、Lease fencing。

## 一、阶段划分

### P7-A RemoteWire 契约（`src/remote/wire.ts`）

复用 execd 语义扩展为远程线协议：

```text
CoordinatorRole   // coordinator 身份声明
WorkerHello       // 能力声明：capabilities[] / runtimeVersion / platform
SubmitRemoteCell  // CellPlan（签名）→ worker 校验后执行
WatchRemoteEvents // 事件流（eventSequence 断点续读）
CancelRemoteCell
RenewRemoteLease  // lease fencing token
ReportReceipt     // 签名 Receipt 上报
FetchArtifact     // 上传/下载 artifact（digest 校验）
```

- 每个消息带 `workerId`/`coordinatorId` + `nonce` + `messageDigest`；
- 帧格式复用 execd 4-byte 长度帧（LR2-1），载荷为签名 JSON；
- 签名：Ed25519（Worker identity key）；第一版不做真实网络传输（内存
  管道模拟 mTLS），但签名/验证必须真实（crypto 库）。
- 验收：编解码 round-trip、坏签名拒绝、篡改检测、协议版本检查。

### P7-B CellPlan + 签名（`src/remote/cellplan.ts`）

- `RemoteCellPlan`：capabilityId/executable/args/cwdRef/资源/环境策略/
  网络策略/secrets（句柄非值）/timeout —— 即编译后的 CellSpec 可传输形状；
- `signCellPlan(plan, key)` → Ed25519 签名（覆盖 canonical JSON digest）；
- `verifyCellPlan(plan, sig, key)`：验证签名 + digest 重算；
- 秘密值不出 Coordinator（仅句柄）；Worker 用句柄向本机 secret 提供方
  换取（第一版：仅测试句柄，不传真实秘密）。
- 验收：签名/验证 round-trip、篡改拒绝、秘密句柄无值泄漏。

### P7-C Coordinator（`src/remote/coordinator.ts`）

- Worker 注册表：能力声明 + 心跳 + 状态（online/offline/busy）；
- Worker 选择：按 capability 匹配（第一版：首个空闲，不做负载均衡）；
- Assignment：`{ assignmentId, cellPlan（签名）, lease }` —— coordinator
  生成 lease fencing token；
- Receipt 验证：签名验证 + digest 校验 + 与 assignment 绑定（assignmentId
  必须一致）；
- Evidence binding + Completion 仍由 Graph 层（coordinator 只转发绑定所需
  材料，不替代 Graph 权威）。
- 验收：注册/选择/分配/收据验证链路；无能力 worker 不分配；
  Receipt 与 assignment 不符 → 拒绝。

### P7-D Worker（`src/remote/worker.ts`）

- 能力声明（复用 capability-probe）；
- CellPlan 验证（签名 + digest + 策略形状）；
- 执行：委托 Broker/execd 本地语义（现有 ExecutionGateway 路径）或纯
  函数执行（无沙箱时）—— 同 LR2-6 双后端原则；
- 生成签名 Receipt（真实观测：exit/cgroup/写路径，不写假事实）；
- Artifact 上传：digest 校验 + 内容寻址（LR2-2 CAS 语义）。
- 验收：签名收据真实字段、CAS 落盘校验、执行后端可替换。

### P7-E Gate 验收 + 独立审核

```text
WORKER_HOLDS_COMPLETION_AUTHORITY    = 0（Worker 无全局完成权）
UNSIGNED_RECEIPT_ACCEPTED            = 0
RECEIPT_ASSIGNMENT_MISMATCH          = 0
SECRET_VALUE_LEAK_IN_PLAN            = 0
CELLPLAN_TAMPER_ACCEPTED             = 0
UNMATCHED_CAPABILITY_ASSIGNMENT      = 0
LEASE_FENCING_ABSENT                 = 0
ARTIFACT_DIGEST_UNVERIFIED           = 0
```

每项一条验收测试 + 独立 subagent 审核（同流程）。

## 二、文件布局

```text
src/remote/
├── wire.ts        远程线协议（编解码 + 签名消息）
├── cellplan.ts    RemoteCellPlan + Ed25519 签名/验证
├── coordinator.ts Coordinator（注册/选择/分配/验证）
└── worker.ts      Worker（声明/验证/执行/收据/artifact）
tests/remote/      验收测试
```

## 三、风险与决策

- **无真实网络**：第一版用内存管道（Node 同进程 + 签名载荷）验证完整
  协议语义；mTLS 传输层留接口（`RemoteTransport`），后续换真实 socket；
- **Ed25519 密钥**：测试密钥生成用 `node:crypto`（bun 自带）——workerId
  = 公钥指纹，天然绑定身份；
- **秘密句柄**：第一版只传输句柄 ID，不传真实值；换取路径留接口
  （防 SECRET_VALUE_LEAK_IN_PLAN）；
- **Completion 权威**：coordinator 转发 Evidence 材料，Graph 完成判断
  不变（参考 LR2-0I 完成链）。

## 四、执行顺序

P7-A → P7-B → P7-C → P7-D → P7-E（每阶段：实现 → 门禁 → 提交）。
