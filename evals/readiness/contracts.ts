/** OBRDS v0.1 — 核心契约（OBRDS DESIGN.md §2/§3/§4/§19）。
 *  Eval 基础设施类型：统一判定、Observer 记录、Scenario 契约、退出码。 */

// ── §2 统一结果状态 ──

export type DiagnosticVerdict =
  | "PASS"
  | "MODEL_FAIL"
  | "INFRA_FAIL"
  | "HARNESS_FAIL"
  | "ENV_BLOCKED"
  | "INCOMPLETE"

/** 退出码（§21）：CI 区分 Agent 能力回退 / Runtime 回退 / 测试环境损坏。 */
export enum ExitCode {
  AllHardGatesPass = 0,
  FunctionalFail = 1,
  InfraIntegrityFail = 2,
  HarnessFixtureFail = 3,
  EnvInsufficient = 4,
  RunnerError = 5,
}

// ── §3 Observer 记录 ──

export interface ProviderRequestRecord {
  requestId: string
  round: number
  requestedModel: string
  actualModel?: string
  thinkingMode?: string
  maxTokens: number
  systemHash: string
  messageHashes: string[]
  toolSchemaHash: string
  toolCount: number
  estimatedInputTokens: number
  providerInputTokens?: number
  reasoningTokens?: number
  outputTokens?: number
  startedAt: number
  firstEventAt?: number
  finishedAt?: number
  stopReason?: string
  retryCount: number
  aborted: boolean
}

export interface ToolExecutionRecord {
  toolCallId: string
  toolName: string
  argsHash: string
  startedAt: number
  finishedAt: number
  success: boolean
  exitCode?: number | null
  resultHash: string
  resultChars: number
  sideEffectKey?: string
  duplicateOf?: string
  artifactId?: string
  evidenceIds: string[]
}

export interface WorkspaceSnapshot {
  gitStatus: string
  fileHashes: Record<string, string>
  created: string[]
  deleted: string[]
  modified: string[]
  symlinks: string[]
  generation: number
}

export interface ProcessRecord {
  pid: number
  ppid: number
  processGroup: number
  cgroup: string
  containerId?: string
  listeningPorts: number[]
  tempFiles: string[]
  locks: string[]
  reservations: string[]
}

export interface SessionRecord {
  messageId: string
  sequence: number
  sessionId: string
  checkpoint: string | null
  walShm: string | null
  compactorState: string | null
  highWaterMark: number
  resumeGeneration: number
}

export interface EvidenceAuditRecord {
  evidenceId: string
  kind: string
  status: string
  toolCallId?: string
  artifactId?: string
  producedGeneration: number
  currentGeneration: number
  fresh: boolean
  acceptedByCompletion: boolean
}

// ── §4 Trace 固定事件名 ──

export const TRACE_EVENTS = [
  "run.started",
  "provider.request.started",
  "provider.event",
  "provider.request.finished",
  "context.compiled",
  "context.compacted",
  "tool.call.started",
  "tool.call.finished",
  "workspace.changed",
  "verification.ingested",
  "gate.decided",
  "checkpoint.written",
  "checkpoint.restored",
  "process.started",
  "process.exited",
  "cleanup.finished",
  "run.finished",
  "verifier.finished",
] as const
export type TraceEventName = (typeof TRACE_EVENTS)[number]

export interface TraceEvent {
  runId: string
  timestamp: string
  type: TraceEventName
  data?: unknown
}

// ── §5 全局 Hard Gates ──

export const HARD_GATES = [
  "FALSE_COMPLETION",
  "DUPLICATE_SIDE_EFFECT",
  "STALE_EVIDENCE_ACCEPTED",
  "INVALID_TRANSCRIPT",
  "USER_CONSTRAINT_VIOLATION",
  "TOOL_FALSE_SUCCESS",
  "ORPHAN_PROCESS",
  "CROSS_WORKSPACE_WRITE",
  "UNARCHIVED_LOSSY_COMPACTION",
  "SESSION_MESSAGE_LOSS",
] as const
export type HardGateName = (typeof HARD_GATES)[number]

export type HardGateCounts = Record<HardGateName, number>

export function zeroHardGates(): HardGateCounts {
  return Object.fromEntries(HARD_GATES.map(g => [g, 0])) as HardGateCounts
}

export function hardGatesViolated(gates: HardGateCounts): HardGateName[] {
  return HARD_GATES.filter(g => gates[g] > 0)
}

// ── §17/§18 效率指标 ──

export interface EfficiencyMetrics {
  tokens: {
    inputTokens: number
    reasoningTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheMissTokens: number
    toolResultTokens: number
    tokensPerPass: number
  }
  time: {
    triageMs: number
    timeToFirstModelEvent: number
    timeToFirstTool: number
    providerMs: number
    toolMs: number
    verificationMs: number
    cleanupMs: number
    wallMs: number
  }
  behavior: {
    rounds: number
    toolCalls: number
    uniqueToolCalls: number
    duplicateToolCalls: number
    fileReads: number
    duplicateFileReads: number
    writes: number
    retries: number
    contextCompactions: number
    checkpointCount: number
  }
  quality: {
    taskPass: boolean
    constraintViolations: number
    staleEvidenceCount: number
    falseCompletion: number
    duplicateSideEffects: number
    orphanResources: number
  }
}

// ── §19 Scenario 契约 ──

export type Lane = "oracle" | "scripted" | "ceiling" | "production"

export interface WorkspaceFixture {
  root: string
  /** 清理 fixture（赛后删除）。 */
  dispose(): Promise<void>
}

export interface OracleAction {
  name: string
  run(ctx: VerificationContext): Promise<{ ok: boolean; detail?: string }>
}

export interface ScriptedAction {
  name: string
  run(ctx: VerificationContext): Promise<{ ok: boolean; detail?: string }>
}

export type FaultKind =
  | "tsc_exit_1"
  | "tsc_unavailable"
  | "lsp_stale_cache"
  | "patch_txn_applied_false"
  | "stale_evidence_retained"
  | "provider_thinking_split"
  | "provider_thinking_duplicate"
  | "provider_tool_json_split"
  | "provider_tool_json_cut"
  | "provider_network_drop_after_tool"
  | "provider_text_cut"
  | "provider_429"
  | "provider_500"
  | "provider_abort_during_backoff"
  | "provider_missing_stop_reason"
  | "max_rounds_reached"
  | "typecheck_unavailable"
  | "test_timeout"
  | "judge_timeout"
  | "test_fail_empty_output"
  | "agent_claims_complete"
  | "crash_after_write"
  | "crash_after_tool_result"
  | "crash_after_checkpoint"
  | "crash_during_test"
  | "crash_plan_node_switch"
  | "crash_session_save"
  | "external_modify_after_checkpoint"

export interface FaultProfile {
  kind: FaultKind
  /** 触发时机（"before"/"after" + 锚点事件名）。 */
  anchor: TraceEventName
  params?: Record<string, unknown>
}

export interface MonitorSpec {
  id: string
  /** observer 名称：provider/tool/workspace/process/session/evidence。 */
  observer: "provider" | "tool" | "workspace" | "process" | "session" | "evidence"
  events: TraceEventName[]
}

export interface ScenarioVerification {
  verdict: DiagnosticVerdict
  hardGates: HardGateCounts
  metrics: EfficiencyMetrics
  reasons: string[]
}

export interface ReadinessScenario {
  id: string
  name: string
  setup(seed: number): Promise<WorkspaceFixture>
  oracle: OracleAction[]
  scripted: ScriptedAction[]
  faults: FaultProfile[]
  monitors: MonitorSpec[]
  verify(ctx: VerificationContext): Promise<ScenarioVerification>
  hardGates: string[]
  timeoutMs: number
  maxRounds: number
  maxGeneratedTokens: number
}

export interface VerificationContext {
  fixture: WorkspaceFixture
  lane: Lane
  seed: number
  trace: TraceEvent[]
  hardGates: HardGateCounts
  runDir: string
}
