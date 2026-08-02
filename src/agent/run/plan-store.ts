import type { MasterPlan } from "../master-plan"

/**
 * Run-owned source of truth for the active MasterPlan.
 *
 * The plan itself remains mutable for the L2 compatibility window, but the
 * reference that selects the active plan is never shared between Agent Runs.
 */
export interface PlanStore {
  current: MasterPlan | null
  revision: number
}

export function createPlanStore(initial: MasterPlan | null = null): PlanStore {
  return {
    current: initial,
    revision: initial ? 1 : 0,
  }
}

export function setCurrentPlan(store: PlanStore, plan: MasterPlan | null): MasterPlan | null {
  if (store.current !== plan) {
    store.current = plan
    store.revision++
  }
  return store.current
}

export function clearPlanStore(store: PlanStore): void {
  setCurrentPlan(store, null)
}
