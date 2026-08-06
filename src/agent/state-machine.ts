/** Agent State Machine — explicit lifecycle states replace implicit boolean flags.
 *
 * Lifecycle:
 *   IDLE → UNDERSTAND → SEARCH ⇄ PLAN → CODE → VERIFY → DONE
 *                                            ↑        ↓
 *                                            └─ REPAIR ←┘
 *   Any state → BLOCKED (fatal/unrecoverable)
 *
 * Invariants:
 *   - roundNum increases monotonically
 *   - errorCount ≤ maxConsecutiveErrors before BLOCKED
 *   - tool calls per round ≤ MAX_TOOLS_PER_ROUND
 */

import type { ToolResult } from "../tools/registry"

// ── State enum ──

export enum AgentState {
  /** Initial / reset state. No work done yet. */
  IDLE = "idle",

  /** Parsing user intent, reading project context. Expected: read-only tools. */
  UNDERSTAND = "understand",

  /** Gathering information triggered by the task. read_file, web_search, find_symbol. */
  SEARCH = "search",

  /** Designing the approach before coding. Can go back to SEARCH if info missing. */
  PLAN = "plan",

  /** Writing edits. write_file, edit_file, edit_fim allowed. */
  CODE = "code",

  /** Post-edit verification. typecheck, test, lint. */
  VERIFY = "verify",

  /** Auto-fix loop: diagnose failure → repair → retry. */
  REPAIR = "repair",

  /** Task complete, no more work. */
  DONE = "done",

  /** Unrecoverable — max errors, timeout, or explicit block. */
  BLOCKED = "blocked",
}

// ── Transition descriptor ──

export interface TransitionDef {
  from: AgentState | AgentState[]
  to: AgentState
  /** Human-readable reason for this transition (logged) */
  reason: string
}

// ── Agent context (carried across states) ──

export interface AgentContext {
  state: AgentState
  roundNum: number
  priorTools: string[]
  priorFiles: Set<string>
  errorCount: number
  consecutiveErrors: number
  toolResults: Map<string, ToolResult>
}

// ── State machine ──

const ALLOWED_TRANSITIONS: Map<AgentState, Set<AgentState>> = new Map([
  [AgentState.IDLE, new Set<AgentState>([AgentState.UNDERSTAND])],
  // DONE 出口：post-loop updateStateMachine 的 isDone 分支优先（task complete
  // 可在任意执行状态发生——本轮验证通过、或工具失败后任务恰好完成），
  // 转换表必须与之一致（此前仅 VERIFY→DONE，REPAIR 等状态完成任务打非法转换）。
  [AgentState.UNDERSTAND, new Set<AgentState>([AgentState.SEARCH, AgentState.PLAN, AgentState.CODE, AgentState.REPAIR, AgentState.DONE, AgentState.BLOCKED])],
  [AgentState.SEARCH, new Set<AgentState>([AgentState.SEARCH, AgentState.PLAN, AgentState.CODE, AgentState.UNDERSTAND, AgentState.REPAIR, AgentState.DONE, AgentState.BLOCKED])],
  [AgentState.PLAN, new Set<AgentState>([AgentState.CODE, AgentState.SEARCH, AgentState.DONE, AgentState.BLOCKED])],
  [AgentState.CODE, new Set<AgentState>([AgentState.VERIFY, AgentState.CODE, AgentState.SEARCH, AgentState.REPAIR, AgentState.DONE, AgentState.BLOCKED])],
  [AgentState.VERIFY, new Set<AgentState>([AgentState.DONE, AgentState.REPAIR, AgentState.BLOCKED])],
  [AgentState.REPAIR, new Set<AgentState>([AgentState.CODE, AgentState.SEARCH, AgentState.VERIFY, AgentState.DONE, AgentState.BLOCKED])],
  [AgentState.DONE, new Set<AgentState>()],
  [AgentState.BLOCKED, new Set<AgentState>()],
])

/** Read-only states — only readonly / concurrency-safe tools allowed */
export const READ_ONLY_STATES = new Set<AgentState>([
  AgentState.IDLE,
  AgentState.UNDERSTAND,
  AgentState.SEARCH,
  AgentState.PLAN,
  AgentState.VERIFY,
])

/** States where write tools are permitted */
export const WRITE_STATES = new Set<AgentState>([
  AgentState.CODE,
  AgentState.REPAIR,
])

export class StateMachine {
  ctx: AgentContext
  private history: TransitionDef[] = []

  constructor() {
    this.ctx = {
      state: AgentState.IDLE,
      roundNum: 0,
      priorTools: [],
      priorFiles: new Set(),
      errorCount: 0,
      consecutiveErrors: 0,
      toolResults: new Map(),
    }
  }

  /** Attempt a transition. Throws if invalid. */
  transition(to: AgentState, reason: string): void {
    const allowed = ALLOWED_TRANSITIONS.get(this.ctx.state)
    if (!allowed?.has(to)) {
      throw new Error(
        `[StateMachine] Invalid transition: ${this.ctx.state} → ${to}. ` +
        `Allowed: [${[...(allowed ?? [])].join(", ")}]. Reason: ${reason}`
      )
    }
    this.history.push({ from: this.ctx.state, to, reason })
    this.ctx.state = to
  }

  get currentState(): AgentState { return this.ctx.state }

  get transitionHistory(): readonly TransitionDef[] { return this.history }

  /** Check if a transition is legal without performing it */
  canTransition(to: AgentState): boolean {
    return ALLOWED_TRANSITIONS.get(this.ctx.state)?.has(to) ?? false
  }

  /** Force a state (skip validation — use for recovery only) */
  forceState(state: AgentState, reason: string): void {
    this.history.push({ from: this.ctx.state, to: state, reason: `[force] ${reason}` })
    this.ctx.state = state
  }
}
