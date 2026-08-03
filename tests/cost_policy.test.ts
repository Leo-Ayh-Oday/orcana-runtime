import { describe, expect, test } from "bun:test"
import { currentCostMode, shouldSkipProviderPurpose } from "../src/provider/cost-policy"

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

describe("cost policy", () => {
  test("normal mode keeps auxiliary provider calls enabled", () => {
    const old = process.env.ORCANA_COST_MODE
    try {
      delete process.env.ORCANA_COST_MODE
      expect(currentCostMode()).toBe("normal")
      expect(shouldSkipProviderPurpose("chat_lite")).toBe(false)
      expect(shouldSkipProviderPurpose("flash_triage")).toBe(false)
      expect(shouldSkipProviderPurpose("agent_main")).toBe(false)
    } finally {
      restoreEnv("ORCANA_COST_MODE", old)
    }
  })

  test("strict mode disables auxiliary calls but preserves main agent and clarification", () => {
    const old = process.env.ORCANA_COST_MODE
    try {
      process.env.ORCANA_COST_MODE = "strict"
      expect(currentCostMode()).toBe("strict")
      expect(shouldSkipProviderPurpose("chat_lite")).toBe(true)
      expect(shouldSkipProviderPurpose("flash_triage")).toBe(true)
      expect(shouldSkipProviderPurpose("knowledge_distill")).toBe(true)
      expect(shouldSkipProviderPurpose("completion_judge")).toBe(true)
      expect(shouldSkipProviderPurpose("plan_judge")).toBe(true)
      expect(shouldSkipProviderPurpose("agent_main")).toBe(false)
      expect(shouldSkipProviderPurpose("clarification")).toBe(false)
    } finally {
      restoreEnv("ORCANA_COST_MODE", old)
    }
  })
})
