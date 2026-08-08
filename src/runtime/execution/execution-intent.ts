/** LR2-0D（ADR-LR2-001）：ExecutionIntent —— 业务层声明"想做什么"。
 *
 *  不变量：Intent 不得携带宿主 mount source、cgroup 路径、Backend argv、
 *  seccomp 文件路径、真实秘密值、缓存宿主路径、任意网络 namespace、
 *  allowDegradation —— 这些只能由 Policy Compiler 从受信 ExecutionContext
 *  生成（模型/Tool 参数无法控制隔离边界）。
 */

export type WorkloadKind = "inspect" | "build" | "test" | "dependency" | "service"

export interface ExecutionIntent {
  /** 幂等键：同一 requestId 不重复启动第二个 Cell（LR2-1 idempotency）。 */
  requestId: string
  /** 以下身份字段缺省时由 ExecutionGateway 从受信 Context 注入。 */
  runId?: string
  nodeRunId?: string
  attempt?: number

  tool: {
    /** Harness 批准的能力 ID（如 "run_process" / "run_shell_script"）。 */
    capabilityId: string
    executable: string
    args: string[]
    /** 工作区相对路径（不携带宿主绝对路径）。 */
    cwdRef?: string
  }

  workload: {
    kind: WorkloadKind
    /** true = 只读执行（不产生未批准写入）。 */
    readonly: boolean
    expectedOutputs?: string[]
  }

  timeoutMs?: number
  /** 显式声明的环境变量（进入 requestedValues，受拒绝规则约束）。 */
  env?: Record<string, string>
  abortSignal?: AbortSignal
  requestedResources?: Partial<{
    memoryMaxBytes: number
    pidsMax: number
    stdoutMaxBytes: number
    stderrMaxBytes: number
  }>
  requestedNetwork?: { mode: "none" | "loopback" | "full-approved" }
}
