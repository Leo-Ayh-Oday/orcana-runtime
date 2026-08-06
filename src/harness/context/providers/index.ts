/** Default context provider set (H10, plan §16.4) — registration order is
 *  the collection order; layer+priority drive final message order.
 *
 *  RC-18 re-exports (K7/K54/K55): the authority / freshness-contract
 *  extension surface defined in ./request, for pipeline-side consumers
 *  (RC-18 D1) to import from one hub.
 */

import type { ContextProvider } from "../../contracts/context"
import { LANG_INSTRUCTION_PROVIDER, STABLE_MEMORY_PROVIDER, PROJECT_KERNEL_PROVIDER, CONTEXT_MAP_PROVIDER, SKILLS_PROVIDER } from "./stable"
import { PLAN_STATE_PROVIDER, RESEARCH_PROVIDER } from "./plan"
import { STAGED_CONTEXT_PROVIDER, THINKING_PROVIDER, KNOWLEDGE_PROVIDER, PLANNING_PROVIDER, MODE_CONTRACT_PROVIDER, CONVERSATION_TAIL_PROVIDER } from "./volatile"

export function createDefaultContextProviders(): ContextProvider[] {
  return [
    LANG_INSTRUCTION_PROVIDER,
    STABLE_MEMORY_PROVIDER,
    PROJECT_KERNEL_PROVIDER,
    CONTEXT_MAP_PROVIDER,
    SKILLS_PROVIDER,
    PLAN_STATE_PROVIDER,
    RESEARCH_PROVIDER,
    STAGED_CONTEXT_PROVIDER,
    THINKING_PROVIDER,
    KNOWLEDGE_PROVIDER,
    PLANNING_PROVIDER,
    MODE_CONTRACT_PROVIDER,
    CONVERSATION_TAIL_PROVIDER,
  ]
}

export {
  LANG_INSTRUCTION_PROVIDER,
  STABLE_MEMORY_PROVIDER,
  PROJECT_KERNEL_PROVIDER,
  CONTEXT_MAP_PROVIDER,
  SKILLS_PROVIDER,
  PLAN_STATE_PROVIDER,
  RESEARCH_PROVIDER,
  STAGED_CONTEXT_PROVIDER,
  THINKING_PROVIDER,
  KNOWLEDGE_PROVIDER,
  PLANNING_PROVIDER,
  MODE_CONTRACT_PROVIDER,
  CONVERSATION_TAIL_PROVIDER,
}

// RC-18 K7/K54/K55: extension surface for pipeline-side consumers (D1).
export {
  AUTHORITY_PRIORITY,
  contentDigest,
  buildPlanStateDecisions,
  createContextRequest,
} from "../request"
export type {
  ContextAuthority,
  FreshnessContract,
  AuthorityConflictSignal,
} from "../request"
