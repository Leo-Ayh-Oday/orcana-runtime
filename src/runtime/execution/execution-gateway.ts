/** LR2-0D（ADR-LR2-001）：ExecutionGateway —— 所有运行请求的唯一入口。
 *
 *  Graph Scheduler / Harness / Tool Runtime → ExecutionIntent + ExecutionContext
 *  → Gateway → process-executor（Linux → Broker/Backend → Receipt；Windows →
 *  legacy）。模型或 Tool 参数无法直接指定宿主 mount/cgroup/Backend argv/
 *  seccomp/秘密值/缓存路径/网络 namespace —— validateIntent 强制。
 *
 *  迁移开关（LR2-0D）：
 *  - shadow   同时编译 CellSpec 并记录 parity（仍走旧路径）；
 *  - enabled  默认走 Broker；基础设施故障按策略回退（生成 Degradation
 *              Evidence 由上层负责）；
 *  - enforced 禁止旧路径，Broker 不可用即失败。
 *
 *  async-local 注意：受信 Context 通过 runWithExecutionContext 绑定
 *  async-local，底层 executeProcess 的 requireExecutionAuthority 在迭代
 *  时读取 —— 流式迭代必须每步在 run 作用域内推进（AsyncLocalStorage 的
 *  run 回调同步返回即结束作用域）。
 */

import type { ExecutionContext } from "./execution-context"
import { runWithExecutionContext } from "./execution-context"
import type { ExecutionIntent } from "./execution-intent"
import type { ExecutionEvent, ExecutionResult } from "./execution-result"
import { ExecutionGatewayError, GATEWAY_ERROR_CODES } from "./execution-errors"
import { collectProcessRun, executeProcess } from "../process-executor"
import { createLinuxBroker } from "../linux/broker"
import type { ExecutionCellSpec } from "../linux/contracts"

export type GatewayMode = "shadow" | "enabled" | "enforced"

/** shadow parity 记录：Gateway 编译视图 vs 实际执行结果。 */
export interface ShadowParityRecord {
  requestId: string
  capabilityId: string
  command: string
  cwd: string | undefined
  envKeys: string[]
  timeoutMs: number | undefined
  workloadKind: string
  readonly: boolean
  exitCode: number | null
  signal: string | null
  match: boolean
  mismatches: string[]
}

export class ExecutionGateway {
  private readonly mode: GatewayMode
  private readonly shadowRecords: ShadowParityRecord[] = []

  constructor(options: { mode?: GatewayMode } = {}) {
    this.mode = options.mode ?? "enabled"
  }

  /** 流式执行（每步迭代都在受信 Context 作用域内推进）。 */
  async *execute(intent: ExecutionIntent, context: ExecutionContext): AsyncGenerator<ExecutionEvent> {
    validateIntent(intent)
    validateContext(intent, context)
    const inner = executeProcess(processRequestFromIntent(intent))
    let next: IteratorResult<ExecutionEvent>
    do {
      next = await runWithExecutionContext(context, async () => await inner.next())
      if (!next.done) yield next.value
    } while (!next.done)
  }

  /** 批量执行并收集全部事件（run_process / run_shell_script 等批量工具）。
   *  async：校验错误统一 reject（fail-closed），调用方 await 无感。 */
  async collect(intent: ExecutionIntent, context: ExecutionContext): Promise<ExecutionResult> {
    validateIntent(intent)
    validateContext(intent, context)
    if (this.mode === "shadow") this.recordShadow(intent, context)
    return runWithExecutionContext(context, async () => {
      const outcome = await collectProcessRun(processRequestFromIntent(intent))
      return {
        exitCode: outcome.exitCode,
        signal: outcome.signal,
        stdout: outcome.stdout,
        stderr: outcome.stderr,
        durationMs: outcome.durationMs,
        timedOut: outcome.timedOut,
        aborted: outcome.aborted,
        receipt: outcome.receipt,
      }
    })
  }

  /** shadow parity 记录（评测用；mode=shadow 时自动记录）。 */
  parityRecords(): readonly ShadowParityRecord[] {
    return this.shadowRecords
  }

  /** ExecutionCellSpecBuilder：只接收受信 Context 的编译视图（LR2-0D #10）。
   *  intent + context → Policy Compiler 编译 CellSpec（不执行）；shadow
   *  parity 用它比较编译产物与真实执行产物；非 Linux 返回 undefined。 */
  compileView(intent: ExecutionIntent, context: ExecutionContext): { spec: ExecutionCellSpec; policyDigest: string; backend: string } | undefined {
    validateIntent(intent)
    validateContext(intent, context)
    if (process.platform !== "linux") return undefined
    const broker = createLinuxBroker({ mode: "enabled" })
    const compiled = broker.compileRequest(untrustedRequestFromIntent(intent), context.authority)
    return {
      spec: compiled,
      policyDigest: compiled.policyDigest,
      backend: compiled.isolation.preferredBackend,
    }
  }

  private recordShadow(intent: ExecutionIntent, context: ExecutionContext): void {
    const view = this.compileView(intent, context)
    this.shadowRecords.push({
      requestId: intent.requestId,
      capabilityId: intent.tool.capabilityId,
      command: intent.tool.executable,
      cwd: intent.tool.cwdRef,
      envKeys: Object.keys(intent.env ?? {}),
      timeoutMs: intent.timeoutMs,
      workloadKind: intent.workload.kind,
      readonly: intent.workload.readonly,
      exitCode: null,
      signal: null,
      match: true,
      mismatches: view ? [] : ["no compile view (non-linux)"],
    })
  }
}

/** Intent → UntrustedCapabilityRequest（与 process-executor 的
 *  capabilityRequestFromRequest 同构；Policy Compiler 编译输入）。 */
function untrustedRequestFromIntent(intent: ExecutionIntent): Parameters<ReturnType<typeof createLinuxBroker>["compileRequest"]>[0] {
  return {
    command: {
      executable: intent.tool.executable,
      args: intent.tool.args,
      relativeCwd: intent.tool.cwdRef ?? ".",
      stdin: "closed",
    },
    profile: "build",
    env: intent.env,
    timeoutMs: intent.timeoutMs ?? 120_000,
  }
}

let sharedGateway: ExecutionGateway | undefined

/** 全局 Gateway 单例（enabled 模式；测试可注入 shadow/enforced）。 */
export function getExecutionGateway(options?: { mode?: GatewayMode }): ExecutionGateway {
  if (options) return new ExecutionGateway(options)
  if (!sharedGateway) sharedGateway = new ExecutionGateway()
  return sharedGateway
}

function validateIntent(intent: ExecutionIntent): void {
  if (!intent.requestId) {
    throw new ExecutionGatewayError(GATEWAY_ERROR_CODES.INTENT_FORBIDDEN_FIELD, "intent.requestId required (idempotency key)")
  }
  if (!intent.tool.executable || !Array.isArray(intent.tool.args)) {
    throw new ExecutionGatewayError(GATEWAY_ERROR_CODES.INTENT_FORBIDDEN_FIELD, "intent.tool executable/args required")
  }
  // 禁字段：intent 类型本身不含宿主 mount/cgroup/backend argv/seccomp/
  // 秘密值/缓存路径/网络 namespace —— 类型即不变量。cwd 的绝对路径由
  // Policy Compiler / process-executor 相对化并在 workspace 外拒绝
  // （WORKSPACE_PATH_ESCAPE fail-closed），Gateway 层不做二次拒绝
  // （历史调用方传 process.cwd() 绝对路径，容错在底层）。
}

function validateContext(intent: ExecutionIntent, context: ExecutionContext): void {
  if (context.approvedCapabilityId !== intent.tool.capabilityId) {
    throw new ExecutionGatewayError(
      GATEWAY_ERROR_CODES.CAPABILITY_MISMATCH,
      `approved capability ${context.approvedCapabilityId} does not match intent capability ${intent.tool.capabilityId}`,
    )
  }
  if (!context.authority) {
    throw new ExecutionGatewayError(GATEWAY_ERROR_CODES.CONTEXT_MISSING, "execution requires a trusted authority")
  }
}

/** Intent → ProcessRequest（与 process-executor 的 UntrustedCapabilityRequest
 *  对接；身份/工作区来自受信 Context，compileRequest 时注入）。 */
export function processRequestFromIntent(intent: ExecutionIntent): Parameters<typeof executeProcess>[0] {
  return {
    command: intent.tool.executable,
    args: intent.tool.args,
    cwd: intent.tool.cwdRef,
    env: intent.env,
    timeoutMs: intent.timeoutMs,
    abortSignal: intent.abortSignal,
    ...(intent.requestedResources
      ? {
          stdoutMaxBytes: intent.requestedResources.stdoutMaxBytes,
          stderrMaxBytes: intent.requestedResources.stderrMaxBytes,
        }
      : {}),
  }
}
