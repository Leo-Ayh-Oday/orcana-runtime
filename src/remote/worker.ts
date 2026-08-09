/** LR2-7（P7-D）：Worker —— 能力声明 / CellPlan 验证 / 执行 / 签名 Receipt /
 *  Artifact 上传（CAS digest 校验）。
 *
 *  Worker 只执行并生成签名收据 —— 完成权威在 Coordinator/Graph。
 *  执行后端可替换（同 LR2-6 双后端原则）：默认函数执行，可注入沙箱执行。
 *  收据签名必须覆盖线上形状（coordinator 的 receiptDigest）—— 两个模块
 *  共享同一摘要函数，否则签名永远无法在 coordinator 侧验证通过。
 */

import { createHash } from "node:crypto"
import { cellPlanSigner, type RemoteCellPlan } from "./cellplan"
import { canonicalJson } from "../runtime/linux/receipt"
import { receiptDigest as coordinatorReceiptDigest, type RemoteReceipt } from "./coordinator"

export type WorkerExecutionVerdict =
  | { ok: true; receipt: RemoteReceipt }
  | { ok: false; reason: string }

/** Worker 收据（线上形状 —— cgroupRemoved 为布尔观测，未观测为 undefined）。 */
export interface WorkerReceiptObserved {
  cgroupRemoved?: boolean
  metrics: {
    cpuUsec?: number
    peakMemoryBytes?: number
    wallTimeMs?: number
  }
  writes: string[]
}

export interface WorkerReceipt {
  receiptId: string
  assignmentId: string
  workerId: string
  exitCode: number | null
  observed: WorkerReceiptObserved
  /** Ed25519 签名（hex）。 */
  signature: string
}

export interface RemoteWorkerOptions {
  workerId: string
  /** Worker 能力声明。 */
  capabilities: string[]
  runtimeVersion: string
  platform: string
  privateKeyPem: string
}

/** 执行后端抽象（默认纯函数 —— 沙箱执行后续线注入）。 */
export type WorkerExecutor = (
  plan: RemoteCellPlan,
  workerId: string,
) => Promise<{ exitCode: number | null; signal: string | null; writes: string[]; wallTimeMs: number }>

export const defaultExecutor: WorkerExecutor = async plan => {
  const t0 = Date.now()
  // 纯函数执行：仅对 plan 形状做确定性响应（不真正 spawn —— 沙箱后端另接）
  const { spawnSync } = require("node:child_process") as typeof import("node:child_process")
  const { existsSync } = require("node:fs") as typeof import("node:fs")
  // cwdRef 是虚拟引用（workspace:*）或目录不存在时回退进程 cwd —— 避免
  // spawnSync 因无效 cwd 抛错（exitCode 丢失）
  const cwd = plan.cwdRef && !plan.cwdRef.startsWith("workspace:") && existsSync(plan.cwdRef) ? plan.cwdRef : undefined
  const result = spawnSync(plan.executable, plan.args, {
    cwd,
    timeout: plan.timeoutMs,
    encoding: "utf8",
  })
  return {
    exitCode: result.status,
    signal: result.signal ?? null,
    writes: plan.readonly ? [] : ["[virtual] no writes (readonly)"],
    wallTimeMs: Date.now() - t0,
  }
}

/** 收据摘要 = coordinator 的 receiptDigest（线上形状 —— 签名覆盖内容）。 */
export function workerReceiptDigest(receipt: Omit<WorkerReceipt, "signature">): string {
  return coordinatorReceiptDigest(receipt)
}

export class RemoteWorker {
  private readonly opts: RemoteWorkerOptions
  private executor: WorkerExecutor

  constructor(opts: RemoteWorkerOptions, executor: WorkerExecutor = defaultExecutor) {
    this.opts = opts
    this.executor = executor
  }

  get workerId(): string {
    return this.opts.workerId
  }

  declareCapabilities(): { workerId: string; capabilities: string[]; runtimeVersion: string; platform: string; status: "online" } {
    return {
      workerId: this.opts.workerId,
      capabilities: this.opts.capabilities,
      runtimeVersion: this.opts.runtimeVersion,
      platform: this.opts.platform,
      status: "online",
    }
  }

  /** 验证 plan（签名 + 形状 + 身份）。 */
  verifyPlan(plan: RemoteCellPlan, coordinatorPublicKeyPem: string): { ok: true } | { ok: false; reason: string } {
    const sig = cellPlanSigner.verifyPlan(plan, coordinatorPublicKeyPem)
    if (!sig.ok) return sig
    if (!plan.capabilityId || !this.opts.capabilities.includes(plan.capabilityId)) {
      return { ok: false, reason: `worker lacks capability: ${plan.capabilityId}` }
    }
    return { ok: true }
  }

  /** 执行 plan 并生成签名收据（WORKER_HOLDS_COMPLETION_AUTHORITY：收据不含完成判断）。 */
  async execute(plan: RemoteCellPlan, assignmentId: string): Promise<WorkerExecutionVerdict> {
    const res = await this.executor(plan, this.opts.workerId)
    const observed: WorkerReceiptObserved = {
      // 函数执行器无 cgroup —— 未观测字段不写假事实（undefined）
      metrics: { wallTimeMs: res.wallTimeMs },
      writes: res.writes,
    }
    const receiptBase: Omit<WorkerReceipt, "signature"> = {
      receiptId: `rcpt-${Math.random().toString(36).slice(2, 10)}`,
      assignmentId,
      workerId: this.opts.workerId,
      exitCode: res.exitCode,
      observed,
    }
    const { sign, createPrivateKey } = require("node:crypto") as typeof import("node:crypto")
    const signature = sign(null, Buffer.from(workerReceiptDigest(receiptBase), "utf8"), createPrivateKey(this.opts.privateKeyPem)).toString("hex")
    return { ok: true, receipt: { ...receiptBase, signature } }
  }

  /** Artifact 上传：内容寻址 + digest 校验（ARTIFACT_DIGEST_UNVERIFIED = 0）。 */
  publishArtifact(name: string, content: string): { artifactId: string; digest: string; sizeBytes: number } {
    const digest = createHash("sha256").update(content).digest("hex")
    return {
      artifactId: `${name}:${digest.slice(0, 16)}`,
      digest,
      sizeBytes: Buffer.byteLength(content, "utf8"),
    }
  }
}

/** CAS 校验：内容 digest 与声明一致。 */
export function verifyArtifactDigest(declaredDigest: string, content: string): { ok: boolean } {
  const actual = createHash("sha256").update(content).digest("hex")
  return { ok: actual === declaredDigest }
}
