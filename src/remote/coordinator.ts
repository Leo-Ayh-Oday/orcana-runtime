/** LR2-7（P7-C）：Coordinator —— Worker 注册 / 能力匹配选择 / 分配 /
 *  签名 Receipt 验证 / Evidence 转发。
 *
 *  权威边界：Coordinator 持 Graph 权威、Assignment、Policy 授权、Lease、
 *  Receipt 验证、Evidence binding、Completion —— Worker 永远不能拥有
 *  全局完成权（WORKER_HOLDS_COMPLETION_AUTHORITY = 0）。
 */

import type { RemoteCellPlan } from "./cellplan"
import { cellPlanSigner, validateCellPlanShape } from "./cellplan"
import { randomId } from "./worker"

/** Worker 能力声明（注册时上报）。 */
export interface WorkerCapabilities {
  capabilities: string[]
  runtimeVersion: string
  platform: string
  /** worker 自报的可用性（first version: 仅声明，不做负载均衡）。 */
  status: "online" | "offline" | "busy"
}

export interface WorkerRecord {
  workerId: string
  publicKeyPem: string
  capabilities: WorkerCapabilities
  lastSeenAt: string
  /** 当前持有的 assignment（busy 时非空）。 */
  currentAssignmentId?: string
}

export interface Assignment {
  assignmentId: string
  workerId: string
  plan: RemoteCellPlan
  /** Lease fencing token（worker 续期必须回传 —— LEASE_FENCING_ABSENT = 0）。 */
  leaseToken: string
  issuedAt: string
  /** 绝对过期时间（ms epoch）。 */
  leaseExpiresAt: number
}

/** Worker 上报的签名 Receipt。 */
export interface RemoteReceipt {
  receiptId: string
  assignmentId: string
  workerId: string
  exitCode: number | null
  /** M4：真实观测 —— 信号（被杀/超时）与 spawn 失败显式记录。 */
  signal?: string | null
  spawnFailed?: boolean
  /** 真实观测字段（不写假事实）。 */
  observed: {
    cgroupRemoved?: boolean
    metrics: Record<string, number>
    writes: string[]
  }
  /** Ed25519 签名（hex）。 */
  signature: string
}

export type AssignmentVerdict =
  | { ok: true; reason: string }
  | { ok: false; reason: string }

/** 分配结果（含 Receipt 验证错误码）。 */
export type ReceiptVerdict =
  | { ok: true; reason: string; verified: true }
  | { ok: false; reason: string; code: "UNSIGNED_RECEIPT" | "RECEIPT_ASSIGNMENT_MISMATCH" | "SIGNATURE_INVALID" | "WORKER_UNKNOWN" | "EXIT_NOT_OBSERVED" }

export class RemoteCoordinator {
  private workers = new Map<string, WorkerRecord>()
  private assignments = new Map<string, Assignment>()
  private coordinatorKey: ReturnType<typeof generateCoordinatorKey>
  /** 服务端 lease TTL 上限（worker 自报 TTL 不得超过 —— M3）。 */
  private readonly maxLeaseTtlMs: number

  constructor(private readonly opts: { coordinatorId: string; privateKeyPem: string; leaseTtlMs?: number; maxLeaseTtlMs?: number }) {
    this.coordinatorKey = { privateKeyPem: opts.privateKeyPem }
    this.maxLeaseTtlMs = opts.maxLeaseTtlMs ?? 10 * 60_000 // 默认 10 分钟上限
  }

  /** Worker 注册（公钥指纹 = workerId）。 */
  registerWorker(workerId: string, publicKeyPem: string, caps: WorkerCapabilities): { ok: true; workerId: string } | { ok: false; reason: string } {
    if (this.workers.has(workerId)) {
      // 重复注册 = 更新心跳
      const w = this.workers.get(workerId)!
      w.capabilities = caps
      w.lastSeenAt = new Date().toISOString()
      return { ok: true, workerId }
    }
    this.workers.set(workerId, { workerId, publicKeyPem, capabilities: caps, lastSeenAt: new Date().toISOString() })
    return { ok: true, workerId }
  }

  getWorker(workerId: string): WorkerRecord | undefined {
    return this.workers.get(workerId)
  }

  listWorkers(): WorkerRecord[] {
    return [...this.workers.values()]
  }

  /** 按能力匹配选择 worker（第一版：首个空闲在线 —— 无负载均衡）。
   *  M3：先回收过期 assignment（expired lease = worker 假定死亡 → 释放）。 */
  selectWorker(capabilityId: string): { ok: true; worker: WorkerRecord } | { ok: false; reason: string } {
    this.sweepExpiredLeases()
    for (const w of this.workers.values()) {
      if (w.capabilities.status !== "online") continue
      if (w.currentAssignmentId) continue
      if (w.capabilities.capabilities.includes(capabilityId)) {
        return { ok: true, worker: w }
      }
    }
    return { ok: false, reason: `no online worker with capability: ${capabilityId}` }
  }

  /** 分配：选择 worker + 签发 plan + 生成 lease fencing token。
   *  M6：assign 前强制 plan 形状校验（含秘密键防护 —— 门禁接入流水线）。 */
  assign(plan: Omit<RemoteCellPlan, "signature">, capabilityId: string): { ok: true; assignment: Assignment } | { ok: false; reason: string } {
    const shape = validateCellPlanShape({ ...plan, capabilityId })
    if (!shape.ok) return { ok: false, reason: `cellplan shape invalid: ${shape.errors.join("; ")}` }
    const sel = this.selectWorker(capabilityId)
    if (!sel.ok) return sel
    const signed = cellPlanSigner.signPlan({ ...plan, capabilityId }, this.opts.privateKeyPem)
    // m1：密码学随机（fence token 不可预测）
    const assignmentId = randomId("asg")
    const leaseToken = randomId("fence")
    const ttlMs = Math.min(this.opts.leaseTtlMs ?? 30_000, this.maxLeaseTtlMs)
    const assignment: Assignment = {
      assignmentId,
      workerId: sel.worker.workerId,
      plan: signed,
      leaseToken,
      issuedAt: new Date().toISOString(),
      leaseExpiresAt: Date.now() + ttlMs,
    }
    this.assignments.set(assignmentId, assignment)
    sel.worker.currentAssignmentId = assignmentId
    sel.worker.capabilities = { ...sel.worker.capabilities, status: "busy" }
    return { ok: true, assignment }
  }

  /** 续期：fencing token 必须匹配（LEASE_FENCING_ABSENT = 0）。
   *  M3：已过期 lease 不得续期；TTL 由服务端封顶（worker 自报不受信）。 */
  renewLease(assignmentId: string, leaseToken: string, ttlMs: number): { ok: true; assignment: Assignment } | { ok: false; reason: string } {
    const a = this.assignments.get(assignmentId)
    if (!a) return { ok: false, reason: `unknown assignment: ${assignmentId}` }
    if (a.leaseToken !== leaseToken) return { ok: false, reason: "lease fencing token mismatch (stale or foreign lease)" }
    if (Date.now() > a.leaseExpiresAt) {
      this.freeWorker(a.workerId)
      this.assignments.delete(assignmentId)
      return { ok: false, reason: "lease already expired (cannot renew stale lease)" }
    }
    const capped = Math.min(ttlMs, this.maxLeaseTtlMs)
    a.leaseExpiresAt = Date.now() + capped
    return { ok: true, assignment: a }
  }

  /** M3：扫描并回收过期 lease（worker 死亡后 assignment 不泄漏）。 */
  private sweepExpiredLeases(): void {
    const now = Date.now()
    for (const [assignmentId, a] of this.assignments) {
      if (now > a.leaseExpiresAt) {
        this.freeWorker(a.workerId)
        this.assignments.delete(assignmentId)
      }
    }
  }

  /** 取消：释放 assignment + worker 回 online。 */
  cancel(assignmentId: string, leaseToken: string): { ok: true } | { ok: false; reason: string } {
    const a = this.assignments.get(assignmentId)
    if (!a) return { ok: false, reason: `unknown assignment: ${assignmentId}` }
    if (a.leaseToken !== leaseToken) return { ok: false, reason: "lease fencing token mismatch" }
    this.freeWorker(a.workerId)
    this.assignments.delete(assignmentId)
    return { ok: true }
  }

  /** 验证 Worker 签名 Receipt（签名 + assignment 绑定 + worker 身份）。
   *  M4：exitCode=null（进程未跑/被杀）的收据拒绝 —— EXIT_NOT_OBSERVED。 */
  verifyReceipt(receipt: RemoteReceipt): ReceiptVerdict {
    const worker = this.workers.get(receipt.workerId)
    if (!worker) return { ok: false, reason: `unknown worker: ${receipt.workerId}`, code: "WORKER_UNKNOWN" }
    if (receipt.signature.length === 0) {
      return { ok: false, reason: "unsigned receipt", code: "UNSIGNED_RECEIPT" }
    }
    if (receipt.exitCode === null || receipt.spawnFailed) {
      return { ok: false, reason: `exit not observed (exitCode=${receipt.exitCode} spawnFailed=${receipt.spawnFailed})`, code: "EXIT_NOT_OBSERVED" }
    }
    const a = this.assignments.get(receipt.assignmentId)
    if (!a) return { ok: false, reason: `unknown assignment: ${receipt.assignmentId}`, code: "RECEIPT_ASSIGNMENT_MISMATCH" }
    if (a.workerId !== receipt.workerId) {
      // m2：assignment 存在但属于他人 —— 交叉伪造（经典路径）
      return { ok: false, reason: `receipt worker ${receipt.workerId} != assignment worker ${a.workerId}`, code: "RECEIPT_ASSIGNMENT_MISMATCH" }
    }
    const digest = receiptDigest(receipt)
    const { verify, createPublicKey } = require("node:crypto") as typeof import("node:crypto")
    let valid = false
    try {
      valid = verify(null, Buffer.from(digest, "utf8"), createPublicKey(worker.publicKeyPem), Buffer.from(receipt.signature, "hex"))
    } catch {
      return { ok: false, reason: "receipt signature verification failed", code: "SIGNATURE_INVALID" }
    }
    if (!valid) return { ok: false, reason: "receipt signature invalid", code: "SIGNATURE_INVALID" }
    // 完成权威仍由 Graph 层：coordinator 只标记收据已验证 + 释放 worker
    // m8：已验证收据记账（重放返回幂等结果，不误报 MISMATCH）
    this.verifiedReceipts.set(receipt.receiptId, receipt)
    this.freeWorker(receipt.workerId)
    this.assignments.delete(receipt.assignmentId)
    return { ok: true, reason: "receipt verified; completion decision remains with Graph", verified: true }
  }

  /** m8：已验证收据账本（幂等重放）。 */
  private verifiedReceipts = new Map<string, RemoteReceipt>()

  /** m8：幂等查询 —— 重放的已验证收据返回 ok。 */
  isVerifiedReceipt(receiptId: string): boolean {
    return this.verifiedReceipts.has(receiptId)
  }

  /** Worker 心跳。
   *  m5：持有 assignment 时不得自行改为 online（busy 由 assignment 状态驱动）。 */
  heartbeat(workerId: string, status: WorkerCapabilities["status"]): { ok: boolean; assigned?: boolean } {
    const w = this.workers.get(workerId)
    if (!w) return { ok: false }
    if (w.currentAssignmentId && status === "online") {
      w.lastSeenAt = new Date().toISOString()
      return { ok: true, assigned: true }
    }
    w.capabilities = { ...w.capabilities, status }
    w.lastSeenAt = new Date().toISOString()
    return { ok: true }
  }

  private freeWorker(workerId: string): void {
    const w = this.workers.get(workerId)
    if (!w) return
    w.currentAssignmentId = undefined
    w.capabilities = { ...w.capabilities, status: "online" }
  }
}

function generateCoordinatorKey(): { privateKeyPem: string } {
  const { generateKeyPairSync } = require("node:crypto") as typeof import("node:crypto")
  const { privateKey } = generateKeyPairSync("ed25519")
  return { privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString() }
}

/** Receipt 签名覆盖的摘要（assignmentId + workerId + 观测字段）。
 *  线上形状 —— worker.ts 复用同一函数（两侧摘要必须同构）。 */
export function receiptDigest(receipt: Omit<RemoteReceipt, "signature">): string {
  const { createHash } = require("node:crypto") as typeof import("node:crypto")
  const { canonicalJson } = require("../runtime/linux/receipt") as typeof import("../runtime/linux/receipt")
  return createHash("sha256").update(canonicalJson({
    receiptId: receipt.receiptId,
    assignmentId: receipt.assignmentId,
    workerId: receipt.workerId,
    exitCode: receipt.exitCode,
    signal: receipt.signal ?? null,
    spawnFailed: receipt.spawnFailed ?? false,
    observed: receipt.observed,
  })).digest("hex")
}

/** 工具：coordinator 密钥对（测试/启动用）。 */
export function createCoordinatorKeypair(): { publicKeyPem: string; privateKeyPem: string } {
  const { generateKeyPairSync } = require("node:crypto") as typeof import("node:crypto")
  const { publicKey, privateKey } = generateKeyPairSync("ed25519")
  return {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  }
}
