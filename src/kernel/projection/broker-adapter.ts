/**
 * AK-2 Linux Broker Projection Executor Adapter。
 *
 * 只消费 Linux Execution Fabric 的公开边界：
 * - `broker.compileRequest(request, authority)`（PR-9：身份/工作区只来自
 *   TrustedExecutionAuthority，enabled 缺 authority fail-closed）；
 * - `broker.execute(spec, { authority, abortSignal })`（R2 完整执行事务）。
 *
 * 约束：
 * - **adapter 不持有、不调用 WorldStore**；
 * - 只接收 projection workspace/context（authority.workspace.hostRoot 必须
 *   等于 merged 视图；调用方以最小 writable ownership 注册）；
 * - SandboxReceipt 只证明 Linux Execution —— outcome 只携带 exitCode/
 *   timeout/cancel/violation + executionReceiptId，不产生任何 World/
 *   Evidence/Graph completion 字段；
 * - adapter 不能根据 backend 放大权限：spec 完全由 plan scope 决定
 *   （writable/readonly mounts 来自 plan），不读取 backend 选择；
 * - Linux cleanup/lease/resource ownership 语义由 broker.execute 事务
 *   保持，adapter 不复制第二套清理。
 */

import { lstatSync } from "node:fs"
import { resolve } from "node:path"
import type { LinuxExecutionBroker } from "../../runtime/linux/broker"
import { profileDefaults as profileDefaultsOf } from "../../runtime/linux/profiles"
import { digestOf } from "../../runtime/linux/receipt"
import type {
  ExecutionProfile,
  NetworkMode,
  RequestedMount,
  TrustedExecutionAuthority,
  UntrustedCapabilityRequest,
} from "../../runtime/linux/contracts"
import { ProjectionError, projectionIntentDigest } from "./contracts"
import type { ProjectionExecutionOutcome } from "./validator"
import type { ProjectionReceiptAuthority, ProjectionReceiptBinding } from "./receipt-authority"

export interface ProjectionBrokerAdapterOptions {
  readonly broker: LinuxExecutionBroker
  /** 已注册的 projection workspace 权威（hostRoot === merged path）。 */
  readonly authority: TrustedExecutionAuthority
  /** projection 上下文（plan scope 决定执行写权限；backend 无关）。 */
  readonly writableRoots: readonly string[]
  readonly readonlyRoots: readonly string[]
  readonly profile: ExecutionProfile
  readonly network?: { mode: NetworkMode; allowedHosts?: string[]; allowedPorts?: number[] }
  /** 默认墙钟（单个执行命令）。 */
  readonly timeoutMs?: number
  /** 最终 receipt 权威（P0-2/P1-6）：用于读取 cleanup-finalized 的持久化
   *  receipt。缺失时 adapter 无法证明 final truth —— outcome 不携带
   *  executionReceiptId（coordinator 将拒绝 production commit）。 */
  readonly receiptAuthority?: ProjectionReceiptAuthority
}

export interface BrokerProjectionExecution {
  readonly outcome: ProjectionExecutionOutcome
  /** SandboxReceipt（只证明 Execution；由调用方决定是否归档）。 */
  readonly receipt?: import("../../runtime/linux/contracts").SandboxReceipt
}

export class LinuxBrokerProjectionExecutor {
  readonly id = "linux-broker"

  /** R4-03.8：一个 intent 只能对应一个授权 cell —— 同一 intentId 第二次
   *  execute 拒绝（防止一次 intent 派生多个执行 cell）。 */
  private readonly usedIntents = new Set<string>()

  constructor(private readonly options: ProjectionBrokerAdapterOptions) {}

  /** R4-03.2：spawn 前逐字段验证 —— adapter 不得同时提供「声明」和
   *  「证明」：expected binding 来自 coordinator 生成的 intent
   *  （kernel-owned），不是 adapter 选项自报。任何字段不一致 → 在
   *  broker.execute 之前拒绝（command 从未 spawn）。 */
  private assertIntentBinding(
    cwd: string,
    intent: import("./contracts").ProjectionExecutionIntent,
    command: { executable: string; args: readonly string[]; timeoutMs?: number },
  ): void {
    const mismatch = (detail: string): never => {
      throw new ProjectionError(
        "EXECUTION_RECEIPT_BINDING_MISMATCH",
        `intent binding mismatch before spawn: ${detail}`,
      )
    }
    // workspace identity：canonical path + dev/ino。
    const hostRoot = resolve(cwd)
    if (intent.workspaceIdentity.path !== hostRoot) {
      mismatch(`workspace path ${hostRoot} != intent ${intent.workspaceIdentity.path}`)
    }
    let stat: ReturnType<typeof lstatSync> | undefined
    try {
      stat = lstatSync(hostRoot)
    } catch {
      mismatch(`workspace ${hostRoot} is not accessible`)
    }
    if (stat === undefined || stat.dev !== intent.workspaceIdentity.dev || stat.ino !== intent.workspaceIdentity.ino) {
      mismatch(`workspace identity (dev/ino) does not match intent`)
    }
    // command：executable/args/timeoutMs 必须与 intent.command 逐字段一致。
    if (intent.command.executable !== command.executable) {
      mismatch(`executable ${command.executable} != intent ${intent.command.executable}`)
    }
    const intentArgs = [...intent.command.args]
    const actualArgs = [...command.args]
    if (intentArgs.length !== actualArgs.length || intentArgs.some((arg, index) => arg !== actualArgs[index])) {
      mismatch(`args ${JSON.stringify(actualArgs)} != intent ${JSON.stringify(intentArgs)}`)
    }
    if ((intent.command.timeoutMs ?? undefined) !== (command.timeoutMs ?? undefined)) {
      mismatch(`timeoutMs ${String(command.timeoutMs)} != intent ${String(intent.command.timeoutMs)}`)
    }
    // filesystem scope：canonical roots 必须与 intent.filesystemScope 完全一致
    // （顺序即 canonical 顺序 —— plan 校验器已规范化）。
    const sameList = (actual: readonly string[], expected: readonly string[]): boolean =>
      actual.length === expected.length && actual.every((value, index) => value === expected[index])
    if (!sameList(this.options.writableRoots, intent.filesystemScope.writableRoots)) {
      mismatch(`writable roots ${JSON.stringify(this.options.writableRoots)} != intent ${JSON.stringify(intent.filesystemScope.writableRoots)}`)
    }
    if (!sameList(this.options.readonlyRoots, intent.filesystemScope.readonlyRoots)) {
      mismatch(`readonly roots ${JSON.stringify(this.options.readonlyRoots)} != intent ${JSON.stringify(intent.filesystemScope.readonlyRoots)}`)
    }
    // 投影契约：ownerFiles === writable roots（pathguard 的 owned 范围），
    // profile 必须 emptyHome=true（filesystemPolicyDigest 派生前提）。
    const ownerFiles = this.options.authority.workspace.ownerFiles ?? []
    if (!sameList(ownerFiles, intent.filesystemScope.writableRoots)) {
      mismatch(`workspace ownerFiles must equal writable roots (pathguard contract)`)
    }
    if (profileDefaultsOf(this.options.profile).emptyHome !== true) {
      mismatch(`profile ${this.options.profile} must have emptyHome=true (projection contract)`)
    }
    // identity 字段：intentId/worldId/branchId/snapshotId/projectionId 必须
    // 非空（kernel-owned；经 intent digest 链绑定）。
    for (const [name, value] of Object.entries({
      intentId: intent.intentId,
      worldId: intent.worldId,
      branchId: intent.branchId,
      snapshotId: intent.snapshotId,
      projectionId: intent.projectionId,
    })) {
      if (typeof value !== "string" || value.length === 0) mismatch(`${name} must be non-empty`)
    }
  }

  /** 执行一个命令；返回 Execution 事实（receipt id 仅记录 Execution）。 */
  async execute(
    cwd: string,
    command: { executable: string; args: readonly string[]; timeoutMs?: number; signal?: AbortSignal; intent?: import("./contracts").ProjectionExecutionIntent },
  ): Promise<BrokerProjectionExecution> {
    const { broker } = this.options
    // R2-01：coordinator 注入的 Execution Intent —— runId 绑定 intent（不可
    // 复用 nonce）；intent digest 注入 spec 环境变量 → broker 填入 final
    // receipt.projectionIntentDigest（打破 outcome 自报 binding 循环）。
    const intent = command.intent
    if (intent !== undefined) {
      // R4-03.8：一个 intent 只能对应一个授权 cell。
      if (this.usedIntents.has(intent.intentId)) {
        throw new ProjectionError(
          "EXECUTION_RECEIPT_BINDING_MISMATCH",
          `intent ${intent.intentId} already authorized an execution cell (one intent = one cell)`,
        )
      }
      // R4-03.2：spawn 前逐字段验证（executable/args/timeout/roots/workspace
      // identity/intent ids）。任何不一致 → 拒绝，command 从未执行。
      this.assertIntentBinding(cwd, intent, command)
      this.usedIntents.add(intent.intentId)
    }
    const authority = intent === undefined
      ? this.options.authority
      : {
          ...this.options.authority,
          identity: {
            ...this.options.authority.identity,
            runId: intent.intentId,
            nodeRunId: `${intent.intentId}:n1`,
          },
        }
    // 只接收 projection workspace：authority 的物理根必须就是 merged 视图。
    if (resolve(authority.workspace.hostRoot) !== resolve(cwd)) {
      throw new ProjectionError(
        "PROJECTION_NOT_PROJECTED",
        `adapter workspace ${authority.workspace.hostRoot} does not match merged view ${cwd}`,
      )
    }
    if (authority.workspace.access !== "readwrite") {
      throw new ProjectionError("PROJECTION_NOT_PROJECTED", "projection workspace must be readwrite")
    }
    // R01.4：Host Audit 不是安全边界 —— 调用方 profile 必须声明
    // namespace/container 隔离（bubblewrap/podman），audit 显式 fail-closed。
    const profileDefaults = profileDefaultsOf(this.options.profile)
    if (profileDefaults.minimum === "audit" || profileDefaults.backend === "host-audit") {
      throw new ProjectionError(
        "HOST_AUDIT_ACCEPTED_AS_SECURITY_BOUNDARY",
        `projection profile ${this.options.profile} requires host-audit; host audit is not a security boundary (namespace/container required)`,
      )
    }

    // R4-02：投影受控视图 —— 只把 plan 声明的 roots 挂到 /workspace/<root>
    // （target 必须是 /workspace 前缀；runtime 的 ALLOWED_MOUNT_TARGET_PREFIXES
    // 已批准）。unscoped 路径不可达；readonly root 无更宽 RW ancestor。
    const writableMounts: RequestedMount[] = this.options.writableRoots.map(path => ({
      source: { type: "workspace-relative", path },
      target: `/workspace/${path}`,
      mode: "rw",
    }))
    const readonlyMounts: RequestedMount[] = this.options.readonlyRoots.map(path => ({
      source: { type: "workspace-relative", path },
      target: `/workspace/${path}`,
      mode: "ro",
    }))

    const request: UntrustedCapabilityRequest = {
      command: {
        executable: command.executable,
        args: [...command.args],
        relativeCwd: ".",
        stdin: "closed",
      },
      profile: this.options.profile,
      ...(this.options.network === undefined ? {} : { network: this.options.network }),
      timeoutMs: command.timeoutMs ?? this.options.timeoutMs,
      writableMounts,
      readonlyMounts,
      // R2-01：intent digest 注入环境变量（进入 cellSpecDigest → broker
      // 注入 final receipt.projectionIntentDigest）。
      ...(intent === undefined
        ? {}
        : { env: { ORCANA_PROJECTION_INTENT: projectionIntentDigest(intent) } }),
    }
    const spec = broker.compileRequest(request, authority)

    // R4-03.4（belt）：编译后的 spec.filesystem digest 必须等于 intent 的
    // 期望 filesystemPolicyDigest（coordinator 从 kernel-owned input 派生）
    // —— 即使逐字段验证被绕过，digest 层仍拒绝与计划不一致的 spec。
    if (intent !== undefined && digestOf(spec.filesystem) !== intent.filesystemPolicyDigest) {
      throw new ProjectionError(
        "EXECUTION_RECEIPT_BINDING_MISMATCH",
        `compiled spec filesystem policy digest does not match the coordinator-derived expected policy digest (plan scope binding)`,
      )
    }

    // P0-1：Host Audit 必须 pre-spawn fail-closed —— 在目标 command spawn
    // 之前，用 broker 的真实后端选择（当前 capabilities 下编译出的 spec
    // 会选中的 backend）确认 namespace/container。若最终无法保证
    // namespace/container backend，任何 command 都不得执行：
    //   selectBackendFor 返回 host-audit（含 degrade 到 audit 的路径）
    //   或抛错（isolation 不可用 / degradation 不允许）
    //   → 立即拒绝，command 从未 spawn。
    let selection
    try {
      selection = broker.selectBackendFor(spec)
    } catch (error) {
      throw new ProjectionError(
        "HOST_AUDIT_ACCEPTED_AS_SECURITY_BOUNDARY",
        `projection execution cannot guarantee namespace/container backend before spawn (${error instanceof Error ? error.message : String(error)}); refusing`,
        error,
      )
    }
    if (selection.backend === "host-audit") {
      throw new ProjectionError(
        "HOST_AUDIT_ACCEPTED_AS_SECURITY_BOUNDARY",
        `projection execution would run on host-audit (${selection.degradationReasons.join("; ") || "no namespace/container backend"}); refusing before spawn`,
      )
    }

    let exitCode: number | null = null
    let sawExit = false
    let receipt: import("../../runtime/linux/contracts").SandboxReceipt | undefined
    let cancelledState = false
    for await (const event of broker.execute(spec, { authority, abortSignal: command.signal })) {
      if (event.type === "cell.status" && event.state === "cancelled") cancelledState = true
      if (event.type === "cell.exit") {
        sawExit = true
        exitCode = event.exitCode
      }
      if (event.type === "cell.receipt") receipt = event.receipt
    }
    if (!sawExit && !cancelledState) {
      // 无 exit 事件且未取消：执行被拒绝/未启动。
      throw new ProjectionError("EXECUTION_FAILED", "broker produced no cell.exit event")
    }

    // P1-6：事件流中的 receipt 是 pre-final（cleanup truth 尚未合并）。
    // 最终 authoritative receipt 只存在于持久化 store（broker 在 cleanup
    // 后写入 final digest）。outcome 必须携带 final digest —— pre-final
    // digest 永远不能进入 World commit。
    let finalDigest: string | undefined
    let finalReceipt: import("../../runtime/linux/contracts").SandboxReceipt | undefined
    const authority_ = this.options.receiptAuthority
    if (authority_ !== undefined && receipt !== undefined) {
      finalReceipt = authority_.getFinalReceipt(receipt.runId, receipt.cellId)
      if (finalReceipt !== undefined && authority_.isCleanupFinalized(finalReceipt)) {
        finalDigest = finalReceipt.receiptDigest
      }
    }

    const outcome: ProjectionExecutionOutcome = {
      // abort 取消时 cell.exit 的 exitCode 为 null → 记为失败退出。
      exitCode: exitCode ?? (sawExit ? 1 : -1),
      timedOut: receipt?.timedOut ?? false,
      cancelled: cancelledState || (receipt?.cancelled ?? false),
      violation: (receipt?.violations.length ?? 0) > 0,
      // 只有确认最终持久化 receipt（cleanup-finalized + final digest）才
      // 携带 executionReceiptId；否则缺省（coordinator 拒绝 production commit）。
      ...(finalDigest === undefined ? {} : { executionReceiptId: finalDigest }),
      ...(finalReceipt === undefined || finalDigest === undefined
        ? {}
        : {
            receiptBinding: {
              runId: finalReceipt.runId,
              nodeRunId: finalReceipt.nodeRunId,
              cellId: finalReceipt.cellId,
              cellSpecDigest: finalReceipt.cellSpecDigest,
              filesystemPolicyDigest: finalReceipt.filesystemPolicyDigest,
              workspaceHostRoot: resolve(authority.workspace.hostRoot),
            } as ProjectionReceiptBinding,
          }),
    }
    // 纵深：事件流 receipt 若为 host-audit（pre-spawn 检查后的异常路径）
    // 也拒绝。
    if (receipt !== undefined && receipt.backend === "host-audit") {
      throw new ProjectionError(
        "HOST_AUDIT_ACCEPTED_AS_SECURITY_BOUNDARY",
        `receipt backend is host-audit; host audit is not a security boundary — refusing acceptance`,
      )
    }
    return { outcome, receipt: finalReceipt ?? receipt }
  }
}
