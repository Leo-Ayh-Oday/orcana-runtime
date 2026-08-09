/** LR2-7（P7-C）：Coordinator —— Worker 注册 / 能力匹配选择 / 分配 /
 *  签名 Receipt 验证 / Evidence 转发。
 *
 *  权威边界：Coordinator 持 Graph 权威、Assignment、Policy 授权、Lease、
 *  Receipt 验证、Evidence binding、Completion —— Worker 永远不能拥有
 *  全局完成权（WORKER_HOLDS_COMPLETION_AUTHORITY = 0）。
 */

import type { RemoteCellPlan } from "./cellplan"
import { cellPlanSigner } from "./cellplan"

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
  | { ok: false; reason: string; code: "UNSIGNED_RECEIPT" | "RECEIPT_ASSIGNMENT_MISMATCH" | "SIGNATURE_INVALID" | "WORKER_UNKNOWN" }

export class RemoteCoordinator {
  private workers = new Map<string, WorkerRecord>()
  private assignments = new Map<string, Assignment>()
  private coordinatorKey: ReturnType<typeof generateCoordinatorKey>

  constructor(private readonly opts: { coordinatorId: string; privateKeyPem: string; leaseTtlMs?: number }) {
    this.coordinatorKey = { privateKeyPem: opts.privateKeyPem }
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

  /** 按能力匹配选择 worker（第一版：首个空闲在线 —— 无负载均衡）。 */
  selectWorker(capabilityId: string): { ok: true; worker: WorkerRecord } | { ok: false; reason: string } {
    for (const w of this.workers.values()) {
      if (w.capabilities.status !== "online") continue
      if (w.currentAssignmentId) continue
      if (w.capabilities.capabilities.includes(capabilityId)) {
        return { ok: true, worker: w }
      }
    }
    return { ok: false, reason: `no online worker with capability: ${capabilityId}` }
  }

  /** 分配：选择 worker + 签发 plan + 生成 lease fencing token。 */
  assign(plan: Omit<RemoteCellPlan, "signature">, capabilityId: string): { ok: true; assignment: Assignment } | { ok: false; reason: string } {
    const sel = this.selectWorker(capabilityId)
    if (!sel.ok) return sel
    const signed = cellPlanSigner.signPlan({ ...plan, capabilityId }, this.opts.privateKeyPem)
    const assignmentId = `asg-${Math.random().toString(36).slice(2, 10)}`
    const leaseToken = `fence-${Math.random().toString(36).slice(2, 12)}`
    const ttlMs = this.opts.leaseTtlMs ?? 30_000
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

  /** 续期：fencing token 必须匹配（LEASE_FENCING_ABSENT = 0）。 */
  renewLease(assignmentId: string, leaseToken: string, ttlMs: number): { ok: true; assignment: Assignment } | { ok: false; reason: string } {
    const a = this.assignments.get(assignmentId)
    if (!a) return { ok: false, reason: `unknown assignment: ${assignmentId}` }
    if (a.leaseToken !== leaseToken) return { ok: false, reason: "lease fencing token mismatch (stale or foreign lease)" }
    a.leaseExpiresAt = Date.now() + ttlMs
    return { ok: true, assignment: a }
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

  /** 验证 Worker 签名 Receipt（签名 + assignment 绑定 + worker 身份）。 */
  verifyReceipt(receipt: RemoteReceipt): ReceiptVerdict {
    const worker = this.workers.get(receipt.workerId)
    if (!worker) return { ok: false, reason: `unknown worker: ${receipt.workerId}`, code: "WORKER_UNKNOWN" }
    if (receipt.signature.length === 0) {
      return { ok: false, reason: "unsigned receipt", code: "UNSIGNED_RECEIPT" }
    }
    const a = this.assignments.get(receipt.assignmentId)
    if (!a || a.workerId !== receipt.workerId) {
      return { ok: false, reason: `receipt assignment mismatch: ${receipt.assignmentId}`, code: "RECEIPT_ASSIGNMENT_MISMATCH" }
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
    this.freeWorker(receipt.workerId)
    this.assignments.delete(receipt.assignmentId)
    return { ok: true, reason: "receipt verified; completion decision remains with Graph", verified: true }
  }

  /** Worker 心跳。 */
  heartbeat(workerId: string, status: WorkerCapabilities["status"]): { ok: boolean } {
    const w = this.workers.get(workerId)
    if (!w) return { ok: false }
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

/** Receipt 签名覆盖的摘要（assignmentId + workerId + 观测字段）。 */
export function receiptDigest(receipt: Omit<RemoteReceipt, "signature">): string {
  const { createHash } = require("node:crypto") as typeof import("node:crypto")
  const { canonicalJson } = require("../runtime/linux/receipt") as typeof import("../runtime/linux/receipt")
  return createHash("sha256").update(canonicalJson({
    receiptId: receipt.receiptId,
    assignmentId: receipt.assignmentId,
    workerId: receipt.workerId,
    exitCode: receipt.exitCode,
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
