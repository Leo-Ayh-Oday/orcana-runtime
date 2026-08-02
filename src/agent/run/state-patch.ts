import type { AgentRunState } from "./types"

export type AgentRunStatePatch = {
  [Section in keyof AgentRunState]?: Partial<AgentRunState[Section]>
}

const STATE_SECTIONS: ReadonlyArray<keyof AgentRunState> = [
  "identity",
  "conversation",
  "planning",
  "research",
  "execution",
  "verification",
  "budget",
  "notices",
  "maintenance",
  "lifecycle",
]

/**
 * The only cross-phase commit primitive introduced in L1. It deliberately
 * patches one named ownership section at a time and never replaces the state
 * object, so compatibility references to arrays/Sets remain valid.
 */
export function applyAgentRunStatePatch(
  state: AgentRunState,
  patch: AgentRunStatePatch | undefined,
): AgentRunState {
  if (!patch) return state
  for (const section of STATE_SECTIONS) {
    const sectionPatch = patch[section]
    if (!sectionPatch) continue
    Object.assign(state[section], sectionPatch)
  }
  return state
}
