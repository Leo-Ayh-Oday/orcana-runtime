/** LNXF-1.0: spec + policy digests and receipt construction (LF-1).
 *
 *  ExecutionCellSpec must be hashable/replayable: every digest is computed
 *  over canonical JSON. Receipts bind cell identity, backends, digests and
 *  observed outcomes (§7.6).
 */

import { createHash } from "node:crypto"
import type { ExecutionCellSpec, LinuxCapabilities, SandboxReceipt } from "./contracts"
import { capabilitiesDigest } from "./capability-probe"

export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, Object.keys(value as object).sort())
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
  cleanup?: Partial<SandboxReceipt["cleanup"]>
}

export function buildReceipt(input: ReceiptInput): SandboxReceipt {
  const { spec, capabilities } = input
  return {
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
    cleanup: {
      processesRemaining: 0,
      mountsReleased: true,
      cgroupRemoved: true,
      worktreeRetained: spec.lifecycle.retainOnFailure,
      ...input.cleanup,
    },
  }
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
