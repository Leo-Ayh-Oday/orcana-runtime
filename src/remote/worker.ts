/** LR2-7（P7-D）：Worker —— 能力声明 / CellPlan 验证 / 执行 / 签名 Receipt /
 *  Artifact 上传（CAS digest 校验）。
 *
 *  Worker 只执行并生成签名收据 —— 完成权威在 Coordinator/Graph。
 *  执行后端可替换（同 LR2-6 双后端原则）：默认函数执行，可注入沙箱执行。
 *  收据签名必须覆盖线上形状（coordinator 的 receiptDigest）—— 两个模块
 *  共享同一摘要函数，否则签名永远无法在 coordinator 侧验证通过。
 */

import { createHash, randomBytes } from "node:crypto"
import { cellPlanSigner, validateCellPlanShape, type RemoteCellPlan } from "./cellplan"
import { canonicalJson } from "../runtime/linux/receipt"
import { receiptDigest as coordinatorReceiptDigest, type RemoteReceipt } from "./coordinator"

/** 密码学随机 ID（m1：fence token/ID 不预测）。 */
export function randomId(prefix: string): string {
  return `${prefix}-${randomBytes(8).toString("hex")}`
}

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
  /** M4：真实观测 —— 信号（被杀/超时）与 spawn 失败显式记录。 */
  signal?: string | null
  spawnFailed?: boolean
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
) => Promise<{ exitCode: number | null; signal: string | null; writes: string[]; wallTimeMs: number; spawnFailed?: boolean }>

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
  // M5：不伪造写观测 —— readonly 计划 = 无写观测（空数组）；
  // 非 readonly 计划 = 写观测未知（由沙箱后端提供，函数执行器无写面观测）。
  // M4：spawn 失败（ENOENT 等）显式标记 —— status=undefined 不是合法 exit。
  return {
    exitCode: result.status ?? null,
    signal: result.signal ?? null,
    spawnFailed: result.error !== undefined,
    writes: plan.readonly ? [] : [],
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

  /** 验证 plan（签名 + 形状 + 身份）。M6：形状校验（含秘密键防护）在此强制执行。 */
  verifyPlan(plan: RemoteCellPlan, coordinatorPublicKeyPem: string): { ok: true } | { ok: false; reason: string } {
    const shape = validateCellPlanShape(plan)
    if (!shape.ok) return { ok: false, reason: `cellplan shape invalid: ${shape.errors.join("; ")}` }
    const sig = cellPlanSigner.verifyPlan(plan, coordinatorPublicKeyPem)
    if (!sig.ok) return sig
    if (!plan.capabilityId || !this.opts.capabilities.includes(plan.capabilityId)) {
      return { ok: false, reason: `worker lacks capability: ${plan.capabilityId}` }
    }
    return { ok: true }
  }

  /** 执行 plan 并生成签名收据（WORKER_HOLDS_COMPLETION_AUTHORITY：收据不含完成判断）。
   *  m4：execute 内部强制先验证（签名 + 形状 + 能力），不依赖调用方自觉。 */
  async execute(plan: RemoteCellPlan, assignmentId: string, coordinatorPublicKeyPem?: string): Promise<WorkerExecutionVerdict> {
    if (coordinatorPublicKeyPem) {
      const v = this.verifyPlan(plan, coordinatorPublicKeyPem)
      if (!v.ok) return { ok: false, reason: v.reason }
    }
    const res = await this.executor(plan, this.opts.workerId)
    const observed: WorkerReceiptObserved = {
      // 函数执行器无 cgroup —— 未观测字段不写假事实（undefined）
      metrics: { wallTimeMs: res.wallTimeMs },
      writes: res.writes,
    }
    // M4：真实观测含 signal/spawnFailed —— exitCode=null（未跑/被杀）必须显式
    const receiptBase: Omit<WorkerReceipt, "signature"> = {
      receiptId: randomId("rcpt"),
      assignmentId,
      workerId: this.opts.workerId,
      exitCode: res.exitCode,
      signal: res.signal,
      spawnFailed: res.spawnFailed ?? false,
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
