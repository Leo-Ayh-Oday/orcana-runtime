/**
 * H0: AgentHarness contract — the single production entry point.
 *
 * CLI / TUI / tests / future Graph all drive runs through this interface.
 * Production code must never call agentLoop(prompt, options) directly; during
 * transition it goes through a LegacyLoopAdapter behind this facade.
 */

import type { AgentSession, CreateSessionInput } from "./session"
import type { AgentRunInput } from "./run"
import type { HarnessEvent } from "./events"
import type { InterruptResponse } from "./interrupt"
import type { RunSnapshot } from "./snapshot"

export interface AgentHarness {
  createSession(input?: CreateSessionInput): Promise<AgentSession>

  run(sessionId: string, input: AgentRunInput): AsyncIterable<HarnessEvent>

  resume(runId: string, response: InterruptResponse): AsyncIterable<HarnessEvent>

  cancel(runId: string, reason?: string): Promise<void>

  inspect(runId: string): Promise<RunSnapshot>

  dispose(): Promise<void>
}
