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
import type {
  ExecutionCellEvent,
  ExecutionProfile,
  NetworkMode,
  RequestedMount,
  TrustedExecutionAuthority,
  UntrustedCapabilityRequest,
} from "../../runtime/linux/contracts"
import { ProjectionError } from "./contracts"
import type { ProjectionExecutionOutcome } from "./validator"

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
    command: { executable: string; args: readonly string[]; timeoutMs?: number; signal?: AbortSignal },
  ): Promise<BrokerProjectionExecution> {
    const { broker, authority } = this.options
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
    }
    const spec = broker.compileRequest(request, authority)

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
    const outcome: ProjectionExecutionOutcome = {
      // abort 取消时 cell.exit 的 exitCode 为 null → 记为失败退出。
      exitCode: exitCode ?? (sawExit ? 1 : -1),
      timedOut: receipt?.timedOut ?? false,
      cancelled: cancelledState || (receipt?.cancelled ?? false),
      violation: (receipt?.violations.length ?? 0) > 0,
      ...(receipt === undefined ? {} : { executionReceiptId: receipt.receiptDigest }),
    }
    return { outcome, receipt }
  }
}
