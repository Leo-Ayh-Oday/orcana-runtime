/**
 * H0: Session contract.
 *
 * A session holds long-lived conversation relationships across many runs. It
 * never owns single-run resources (those belong to AgentRun / AgentRunScope).
 */

export interface CreateSessionInput {
  projectRoot: string
  conversationRef?: string
  stableMemoryRef?: string
  metadata?: Record<string, unknown>
}

export interface AgentSession {
  sessionId: string
  createdAt: number
  updatedAt: number

  activeRunIds: string[]

  conversationRef?: string
  stableMemoryRef?: string
  projectRoot: string

  metadata: Record<string, unknown>
}
