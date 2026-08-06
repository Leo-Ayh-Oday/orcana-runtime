/** LNXF-1.0: spec + policy digests and receipt construction (LF-1).
 *
 *  ExecutionCellSpec must be hashable/replayable: every digest is computed
 *  over canonical JSON. Receipts bind cell identity, backends, digests and
 *  observed outcomes (§7.6).
 */

import { createHash } from "node:crypto"
import type { ExecutionCellSpec, LinuxCapabilities, SandboxReceipt } from "./contracts"
import { capabilitiesDigest } from "./capability-probe"

/** 递归 canonical JSON：每一层键排序，任意嵌套的对象/数组参与序列化。
 *
 *  P0-1 修复：JSON.stringify 的数组型 replacer 会同时充当所有嵌套层级的
 *  属性白名单，导致 `{network:{mode:"none"}}` 与 `{network:{mode:"full-approved"}}`
 *  都序列化为 `{"network":{}}`（策略不同而 digest 相同）。这里递归展开：
 *  - 对象：键排序后递归；
 *  - 数组：逐元素递归；
 *  - 值为 undefined 的键被丢弃（与 JSON.stringify 语义一致）；
 *  - 其余值交给 JSON.stringify（保持 number/string/bool/null/NaN→null 语义）。
 */
export function canonicalJson(value: unknown): string {
  return canonicalStringify(value)
}

function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null"
  }
  if (Array.isArray(value)) {
    return "[" + value.map(v => canonicalStringify(v)).join(",") + "]"
  }
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).filter(k => obj[k] !== undefined).sort()
  return "{" + keys.map(k => JSON.stringify(k) + ":" + canonicalStringify(obj[k])).join(",") + "}"
}

export function digestOf(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex").slice(0, 16)
}

/** policyDigest covers everything the sandbox enforces. */
export function computePolicyDigest(spec: ExecutionCellSpec): string {
  return digestOf({
    isolation: spec.isolation,
    filesystem: spec.filesystem,
    network: spec.network,
    resources: spec.resources,
    environment: spec.environment,
    secrets: spec.secrets.map(s => ({ id: s.id, purpose: s.purpose, delivery: s.delivery })),
    cache: spec.cache,
  })
}

export function cellSpecDigest(spec: ExecutionCellSpec): string {
  return digestOf(spec)
}

export interface ReceiptInput {
  spec: ExecutionCellSpec
  capabilities: LinuxCapabilities
  backend: SandboxReceipt["backend"]
  backendVersion?: string
  startedAt: number
  finishedAt: number
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  cancelled: boolean
  oomKilled: boolean
  pidLimitHit: boolean
  outputLimitHit: boolean
  tempLimitHit: boolean
  metrics?: SandboxReceipt["metrics"]
  observedWrites?: string[]
  observedDeletes?: string[]
  unexpectedWrites?: string[]
  violations?: SandboxReceipt["violations"]
  degradationReasons?: string[]
  /** 清理结果 —— 必须来自真实测量（PR-2：无默认成功值；
   *  未测量时 processesRemaining=-1 / cgroupRemoved=false，绝不假装 0/true）。 */
  cleanup: Partial<SandboxReceipt["cleanup"]>
}

/** Receipt 自摘要：对去除 receiptDigest 字段的完整 Receipt 计算 sha256。
 *  Evidence 绑定此摘要（而非 cellSpecDigest）——绑定退出结果、清理状态、
 *  指标与违规信息（PR-2）。 */
export function computeReceiptDigest(receipt: Omit<SandboxReceipt, "receiptDigest">): string {
  return digestOf(receipt)
}

export function buildReceipt(input: ReceiptInput): SandboxReceipt {
  const { spec, capabilities } = input
  const receipt: Omit<SandboxReceipt, "receiptDigest"> = {
    schemaVersion: "1.0",
    cellId: spec.identity.cellId,
    runId: spec.identity.runId,
    nodeRunId: spec.identity.nodeRunId,
    attempt: spec.identity.attempt,
    agentId: spec.identity.agentId,
    backend: input.backend,
    backendVersion: input.backendVersion,
    profile: spec.profile,
    capabilitiesDigest: capabilitiesDigest(capabilities),
    cellSpecDigest: cellSpecDigest(spec),
    filesystemPolicyDigest: digestOf(spec.filesystem),
    networkPolicyDigest: digestOf(spec.network),
    resourcePolicyDigest: digestOf(spec.resources),
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    durationMs: Math.max(0, input.finishedAt - input.startedAt),
    exitCode: input.exitCode,
    signal: input.signal,
    timedOut: input.timedOut,
    cancelled: input.cancelled,
    oomKilled: input.oomKilled,
    pidLimitHit: input.pidLimitHit,
    outputLimitHit: input.outputLimitHit,
    tempLimitHit: input.tempLimitHit,
    metrics: input.metrics ?? {},
    observedWrites: input.observedWrites ?? [],
    observedDeletes: input.observedDeletes ?? [],
    unexpectedWrites: input.unexpectedWrites ?? [],
    networkMode: spec.network.mode,
    secretBindingIds: spec.secrets.map(s => s.id),
    violations: input.violations ?? [],
    degradationReasons: input.degradationReasons ?? [],
    // PR-2：只保留输入中的真实值；缺失 → -1/false（未验证 ≠ 干净）。
    cleanup: {
      processesRemaining: input.cleanup.processesRemaining ?? -1,
      mountsReleased: input.cleanup.mountsReleased ?? false,
      cgroupRemoved: input.cleanup.cgroupRemoved ?? false,
      containerRemoved: input.cleanup.containerRemoved ?? false,
      worktreeRetained: spec.lifecycle.retainOnFailure,
      ...input.cleanup,
    },
  }
  return { ...receipt, receiptDigest: computeReceiptDigest(receipt) }
}

/** Receipt completeness gate: a receipt without backend + digests is not
 *  usable for evidence binding. */
export function receiptComplete(receipt: SandboxReceipt): boolean {
  return (
    receipt.cellSpecDigest.length === 16 &&
    receipt.capabilitiesDigest.length === 16 &&
    receipt.finishedAt > 0 &&
    receipt.exitCode !== undefined &&
    receipt.cleanup.processesRemaining === 0
  )
}
