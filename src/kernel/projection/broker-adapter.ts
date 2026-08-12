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

import { resolve } from "node:path"
import type { LinuxExecutionBroker } from "../../runtime/linux/broker"
import { profileDefaults as profileDefaultsOf } from "../../runtime/linux/profiles"
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

  constructor(private readonly options: ProjectionBrokerAdapterOptions) {}

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

    const writableMounts: RequestedMount[] = this.options.writableRoots.map(path => ({
      source: { type: "workspace-relative", path },
      target: `/${path}`,
      mode: "rw",
    }))
    const readonlyMounts: RequestedMount[] = this.options.readonlyRoots.map(path => ({
      source: { type: "workspace-relative", path },
      target: `/${path}`,
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
