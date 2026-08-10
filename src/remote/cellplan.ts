/** LR2-7（P7-B）：RemoteCellPlan + Ed25519 签名/验证。
 *
 *  RemoteCellPlan 是编译后 CellSpec 的可传输形状：
 *  - 秘密只传句柄（secretHandles），不传真实值（SECRET_VALUE_LEAK_IN_PLAN = 0）；
 *  - 签名覆盖 canonical JSON digest —— 篡改任何字段 → 验证失败。
 */

import { createHash } from "node:crypto"
import { canonicalJson } from "../runtime/linux/receipt"

/** 秘密句柄（仅 ID —— 真实值由提供方持有）。 */
export interface SecretHandleRef {
  handleId: string
  purpose: string
}

export interface RemoteCellPlan {
  planSchemaVersion: string
  planId: string
  capabilityId: string
  executable: string
  args: string[]
  cwdRef?: string
  timeoutMs?: number
  readonly: boolean
  workloadKind: "inspect" | "build" | "test" | "dependency" | "service"
  /** 资源（可选；缺省由 worker 按 capability 模板）。 */
  resources?: {
    memoryMaxBytes?: number
    pidsMax?: number
    cpuQuotaMicros?: number
  }
  /** 秘密句柄（非值）。 */
  secretHandles?: SecretHandleRef[]
  /** 显式环境（只含策略允许的键；不含真实秘密）。 */
  environment?: Record<string, string>
  /** 签名（Ed25519 hex —— 由 Coordinator 持有私钥签发）。 */
  signature: string
}

export const CELLPLAN_SCHEMA_VERSION = "1.0"

/** 签名覆盖的全部字段（canonical JSON）。 */
export function cellplanPayloadDigest(plan: Omit<RemoteCellPlan, "signature">): string {
  return createHash("sha256").update(canonicalJson({
    planSchemaVersion: plan.planSchemaVersion,
    planId: plan.planId,
    capabilityId: plan.capabilityId,
    executable: plan.executable,
    args: plan.args,
    cwdRef: plan.cwdRef,
    timeoutMs: plan.timeoutMs,
    readonly: plan.readonly,
    workloadKind: plan.workloadKind,
    resources: plan.resources,
    secretHandles: plan.secretHandles,
    environment: plan.environment,
  })).digest("hex")
}

export interface CellPlanSigner {
  /** 构造并签发 plan（payload digest + Ed25519 签名）。 */
  signPlan(plan: Omit<RemoteCellPlan, "signature">, privateKeyPem: string): RemoteCellPlan
  /** 验证签名（digest 重算 + Ed25519 验证）。 */
  verifyPlan(plan: RemoteCellPlan, coordinatorPublicKeyPem: string): { ok: boolean; reason: string }
}

export const cellPlanSigner: CellPlanSigner = {
  signPlan(plan, privateKeyPem) {
    const digest = cellplanPayloadDigest(plan)
    const { sign } = require("node:crypto") as typeof import("node:crypto")
    const { createPrivateKey } = require("node:crypto") as typeof import("node:crypto")
    const signature = sign(null, Buffer.from(digest, "utf8"), createPrivateKey(privateKeyPem)).toString("hex")
    return { ...plan, signature }
  },
  verifyPlan(plan, coordinatorPublicKeyPem) {
    const digest = cellplanPayloadDigest(plan)
    if (plan.planSchemaVersion !== CELLPLAN_SCHEMA_VERSION) {
      return { ok: false, reason: `cellplan schema version mismatch: ${plan.planSchemaVersion}` }
    }
    const { verify, createPublicKey } = require("node:crypto") as typeof import("node:crypto")
    const valid = verify(null, Buffer.from(digest, "utf8"), createPublicKey(coordinatorPublicKeyPem), Buffer.from(plan.signature, "hex"))
    if (!valid) return { ok: false, reason: "cellplan signature invalid (tampered plan)" }
    return { ok: true, reason: "cellplan verified" }
  },
}

/** 校验 plan 形状（无签名 —— 用于构造/测试）。 */
export function validateCellPlanShape(plan: Omit<RemoteCellPlan, "signature">): { ok: true } | { ok: false; errors: string[] } {
  const errors: string[] = []
  if (!plan.planId || !plan.capabilityId) errors.push("planId/capabilityId required")
  if (!plan.executable || plan.executable.length === 0) errors.push("executable required")
  if (!["inspect", "build", "test", "dependency", "service"].includes(plan.workloadKind)) {
    errors.push(`invalid workloadKind: ${plan.workloadKind}`)
  }
  // 秘密句柄必须含 handleId/purpose
  for (const s of plan.secretHandles ?? []) {
    if (!s.handleId || !s.purpose) errors.push(`secret handle missing id/purpose: ${JSON.stringify(s)}`)
  }
  // 显式环境不得包含疑似秘密键（key 层面防护）
  for (const [k, v] of Object.entries(plan.environment ?? {})) {
    if (v === undefined || v === "") errors.push(`environment key with empty value: ${k}`)
    if (/secret|token|password|api[_-]?key|private[_-]?key/i.test(k)) {
      errors.push(`environment key looks like a secret and must use secretHandles: ${k}`)
    }
  }
  if (errors.length > 0) return { ok: false, errors }
  return { ok: true }
}
