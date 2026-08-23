/**
 * AK2-R4 —— test-only fixture factory。
 *
 * R4-01：fixture backend 从生产模块移出（src/kernel/projection/backend.ts
 * 不再导出任何 fixture 执行能力 —— PUBLIC_FIXTURE_AUTHORITY = 0）。
 * 本文件位于 tests/（非生产导出面）。
 *
 * 只允许经 `allowTestBackends: true` 的 test coordinator 使用；production
 * backend（kind !== "fixture"）永远不满足 receiptless gate。
 */

import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs"
import { join, resolve, sep } from "node:path"
import type {
  CreateProjectionInput,
  NativeProjectionBackend,
  ProjectionInstance,
} from "../../../src/kernel/projection/backend"
import { ProjectionError, projectionIntentDigest, type ProjectionExecutionIntent } from "../../../src/kernel/projection/contracts"
import type {
  ProjectionReceiptAuthority,
  ProjectionReceiptBinding,
} from "../../../src/kernel/projection/receipt-authority"

import { ProjectionCoordinator, expectedProjectionFilesystemPolicyDigest, type ProjectionCoordinatorOptions, type ProjectionExecutor } from "../../../src/kernel/projection/coordinator"
import { expectedProjectionCellSpecDigestForCell } from "../../../src/kernel/projection/spec-binding"
import type { ProjectionExecutionOutcome } from "../../../src/kernel/projection/validator"
import type { SandboxReceipt } from "../../../src/runtime/linux/contracts"
import type { WorldProjectionPlan } from "../../../src/kernel/projection/contracts"

/**
 * AK2-R5 —— test-only TestReceiptAuthority（显式 test receipt authority）。
 *
 * R5-01：测试 fixture 也必须提供明确的 test receipt authority —— 不再存在
 * receiptless commit 分支。本 authority 只存在于 tests/（非生产导出面），
 * trustLevel = "test-harness"（与 kernel-authenticated 明确区分；生产
 * acceptance 对 same-uid-untrusted 一律 fail-closed）。
 */
export class TestReceiptAuthority implements ProjectionReceiptAuthority {
  /** 显式 trust level：test-harness（仅测试使用；生产不可接受）。 */
  readonly trustLevel = "test-harness" as const

  private readonly receipts = new Map<string, SandboxReceipt>()

  constructor(private readonly options: { cellSpecDigest?: string; cleanupFinalized?: boolean } = {}) {
    // R7-01：test-only authority 只存在于 tests/**（无生产 brand）。
  }

  private key(runId: string, cellId: string): string {
    return `${runId}\u0000${cellId}`
  }

  /** fixture executor 在“执行”后注册最终 receipt（与 broker 持久化行为同构）。 */
  recordFinalReceipt(
    intent: ProjectionExecutionIntent,
    cellId: string,
    overrides: Partial<SandboxReceipt> = {},
  ): SandboxReceipt {
    const { computeReceiptDigest } = require("../../../src/runtime/linux/receipt") as typeof import("../../../src/runtime/linux/receipt")
    const base: SandboxReceipt = {
      schemaVersion: "1.0",
      cellId,
      runId: intent.intentId,
      nodeRunId: `${intent.intentId}:n1`,
      attempt: 1,
      backend: "bubblewrap",
      profile: "build",
      capabilitiesDigest: "b".repeat(64),
      // R6-03：happy path 的 receipt 必须携带 kernel 派生的期望 spec
      // digest —— 用**真实 cellId** 重编译（commit 时 coordinator 用同一
      // cellId 重编译并直接比较；intent.expectedCellSpecDigest 是规范化
      // 形式（pre-spawn 比对用），这里用 raw 形式。显式 overrides 用于
      // 伪造/偏差反例。
      cellSpecDigest: this.options.cellSpecDigest ??
        expectedProjectionCellSpecDigestForCell(
          intent,
          intent.workspaceIdentity.path,
          [...intent.filesystemScope.writableRoots],
          cellId,
        ),
      filesystemPolicyDigest: expectedProjectionFilesystemPolicyDigest(
        {
          writableRoots: intent.filesystemScope.writableRoots,
          readonlyRoots: intent.filesystemScope.readonlyRoots,
        } as WorldProjectionPlan,
        intent.workspaceIdentity.path,
      ),
      networkPolicyDigest: "e".repeat(64),
      resourcePolicyDigest: "f".repeat(64),
      startedAt: 1,
      finishedAt: 2,
      durationMs: 1,
      exitCode: 0,
      signal: null,
      timedOut: false,
      cancelled: false,
      oomKilled: false,
      pidLimitHit: false,
      outputLimitHit: false,
      tempLimitHit: false,
      metrics: { status: "unknown", reason: "test fixture" },
      observedWrites: [],
      observedDeletes: [],
      unexpectedWrites: [],
      networkMode: "none",
      secretBindingIds: [],
      violations: [],
      degradationReasons: [],
      cleanup: {
        processesRemaining: 0,
        mountsReleased: true,
        cgroupRemoved: true,
        worktreeRetained: false,
        cleanupVerified: this.options.cleanupFinalized ?? true,
      },
      receiptDigest: "",
      ...overrides,
    }
    const withIntent = { ...base, projectionIntentDigest: projectionIntentDigest(intent) }
    const receipt = { ...withIntent, receiptDigest: computeReceiptDigest(withIntent) } as SandboxReceipt
    this.receipts.set(this.key(intent.intentId, cellId), receipt)
    return receipt
  }

  getFinalReceipt(runId: string, cellId: string): SandboxReceipt | undefined {
    return this.receipts.get(this.key(runId, cellId))
  }

  isCleanupFinalized(_receipt: SandboxReceipt): boolean {
    return true
  }
}

/** fixture executor —— 执行 mutate(cwd) 后注册最终 receipt 并返回完成 outcome。
 *  R5-01：fixture 执行也必须产出 receipt（由 test authority 提供证明）。 */
export function fixtureExecutor(
  authority: TestReceiptAuthority,
  mutate?: (merged: string) => void,
  outcomeOverrides: Partial<ProjectionExecutionOutcome> = {},
): ProjectionExecutor {
  return async (cwd, command) => {
    if (mutate !== undefined) mutate(cwd)
    const intent = command.intent
    if (intent === undefined) {
      throw new ProjectionError(
        "EXECUTION_RECEIPT_REQUIRED",
        "fixture executor requires a kernel-owned execution intent to register a test receipt",
      )
    }
    const cellId = `cell-${intent.intentId}`
    const receipt = authority.recordFinalReceipt(intent, cellId)
    const binding: ProjectionReceiptBinding = {
      runId: intent.intentId,
      nodeRunId: `${intent.intentId}:n1`,
      cellId,
      cellSpecDigest: receipt.cellSpecDigest,
      filesystemPolicyDigest: receipt.filesystemPolicyDigest,
      workspaceHostRoot: intent.workspaceIdentity.path,
    }
    return {
      exitCode: 0,
      timedOut: false,
      cancelled: false,
      violation: false,
      executionReceiptId: receipt.receiptDigest,
      receiptBinding: binding,
      ...outcomeOverrides,
    }
  }
}

/** 一次构造 backend + authority + executor（确定性 fixture harness）。 */
export function createFixtureHarness(mutate?: (merged: string) => void): {
  readonly authority: TestReceiptAuthority
  readonly backend: CopyProjectionFixtureBackend
  readonly executor: ProjectionExecutor
} {
  const authority = new TestReceiptAuthority()
  return {
    authority,
    backend: new CopyProjectionFixtureBackend(),
    executor: fixtureExecutor(authority, mutate),
  }
}

function assertSafeLabel(label: string): string {
  if (typeof label !== "string" || !/^[A-Za-z0-9._-]+$/.test(label)) {
    throw new ProjectionError("BACKEND_UNAVAILABLE", `invalid projection label: ${String(label)}`)
  }
  return label
}

function assertSafeMountPath(path: string, projectionRoot: string): string {
  if (typeof path !== "string" || path.length === 0) {
    throw new ProjectionError("BACKEND_UNAVAILABLE", "mount path must be a non-empty string")
  }
  if (/[,:\n\0]/.test(path)) {
    throw new ProjectionError("BACKEND_UNAVAILABLE", `mount path contains delimiter/option injection chars: ${path}`)
  }
  const resolved = resolve(path)
  if (!resolved.startsWith(resolve(projectionRoot) + sep)) {
    throw new ProjectionError("BACKEND_UNAVAILABLE", `mount path escapes projection root: ${path}`)
  }
  return resolved
}



function assertRealDirectory(path: string, label: string): void {
  if (!existsSync(path)) throw new ProjectionError("BACKEND_UNAVAILABLE", `${label} does not exist: ${path}`)
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new ProjectionError("BACKEND_UNAVAILABLE", `${label} must be a real directory: ${path}`)
  }
}

function makeTreeWritable(root: string): void {
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      const stat = lstatSync(full)
      if (stat.isDirectory()) {
        chmodSync(full, 0o700)
        visit(full)
      } else if (stat.isFile()) {
        chmodSync(full, 0o600)
      }
    }
  }
  chmodSync(root, 0o700)
  visit(root)
}

/**
 * TEST FIXTURE ONLY —— 确定性 copy backend：把 lower 复制为可写 merged。
 * 不创建任何真实 overlay 语义；仅用于 coordinator/delta/commit 逻辑测试。
 * 绝对不作为真实 Linux backend 通过证据。
 *
 * R4-06：sealForScan 为 mode-based 只读（dirs 0555 / files 0444）——
 * 同 UID 可 chmod 还原，因此只是 fixture 语义；真实 seal 是生产 backend
 * 的 FUSE ro remount（内核 EROFS）。
 */
export class CopyProjectionFixtureBackend implements Omit<NativeProjectionBackend, "kind"> {
  readonly id = "fixture-copy"
  /** R6-01：production NativeBackendKind 已删除 fixture discriminant ——
   *  test-only fixture 的 kind 只存在于 tests/**。 */
  readonly kind = "fixture" as const
  readonly testFixtureOnly = true

  // R7-01：生产模块不再提供 test-only brand —— fixture 只存在于 tests/**；
  // 授权来自 tests/** 的 TestProjectionCoordinator test-only composition。

  create(input: CreateProjectionInput): ProjectionInstance {
    const label = assertSafeLabel(input.label)
    const projectionRoot = resolve(input.projectionRoot)
    const lower = assertSafeMountPath(input.lowerDir, projectionRoot)
    assertRealDirectory(lower, "lower")
    assertRealDirectory(projectionRoot, "projectionRoot")

    const merged = assertSafeMountPath(join(projectionRoot, `merged-${label}`), projectionRoot)
    mkdirSync(merged, { mode: 0o700 })
    // 复制 lower → merged（可写副本；lower 的只读 mode 不继承 —— upper 语义）。
    cpSync(lower, merged, { recursive: true })
    makeTreeWritable(merged)

    let sealed = false
    return {
      backend: "fixture" as unknown as import("../../../src/kernel/projection/backend").NativeBackendKind,
      mergedPath: merged,
      writeLayerPath: merged,
      assertReady: () => {
        statSync(merged)
        readdirSync(merged)
      },
      // R4-06：fixture seal —— mode-based 只读（test-only；同 UID 可还原，
      // 不冒充真实不可变证明）。
      sealForScan: () => {
        if (sealed) return { sealedPath: merged }
        const visit = (dir: string): void => {
          for (const entry of readdirSync(dir)) {
            const full = join(dir, entry)
            const stat = lstatSync(full)
            if (stat.isDirectory()) {
              chmodSync(full, 0o555)
              visit(full)
            } else if (stat.isFile()) {
              chmodSync(full, 0o444)
            }
          }
        }
        chmodSync(merged, 0o555)
        visit(merged)
        sealed = true
        return { sealedPath: merged }
      },
      cleanup: () => {
        if (!existsSync(merged)) return true
        // sealed 树（0555/0444）先还原可写再删除（rmSync 不能穿越只读目录）。
        try {
          makeTreeWritable(merged)
        } catch {
          return false
        }
        rmSync(merged, { recursive: true, force: true })
        return true
      },
    }
  }
}

/**
 * AK2-R7 —— 明确的 test-only composition（只存在于 tests/**）。

 * 生产 ProjectionCoordinator 不再包含任何公开可设置的 test authorization
 * （R7-01 已删除 mark* 导出）；production World commit 结构性 fail-closed。
 * fixture 正向测试（receipt 身份/binding、生命周期、reservation 等）必须
 * 通过本子类进入 commit 校验路径 —— 授权来自 tests/** 的显式子类，而非
 * 生产导出面的任何可调用能力。trustLevel/kind/cast 无法绕过生产 gate。
 */
export class TestProjectionCoordinator extends ProjectionCoordinator {
  constructor(options: ProjectionCoordinatorOptions) {
    super(options)
  }

  /** test-only：绕过 production authority 门（生产类恒 fail-closed）。 */
  protected isProductionCommitAuthorized(): boolean {
    return true
  }
}
