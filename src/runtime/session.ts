import type { RuntimeStatus } from "./events"

export interface RuntimeSession {
  sessionId: string
  repoRoot: string
  status: RuntimeStatus
  createdAt: number
  updatedAt: number
}

export interface CreateRuntimeSessionInput {
  sessionId: string
  repoRoot: string
  status?: RuntimeStatus
  timestamp?: number
}

export function createRuntimeSession(input: CreateRuntimeSessionInput): RuntimeSession {
  const timestamp = input.timestamp ?? Date.now()
  return {
    sessionId: input.sessionId,
    repoRoot: input.repoRoot,
    status: input.status ?? "idle",
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}

export function updateRuntimeSessionStatus(
  session: RuntimeSession,
  status: RuntimeStatus,
  timestamp = Date.now(),
): RuntimeSession {
  return {
    ...session,
    status,
    updatedAt: timestamp,
  }
}
