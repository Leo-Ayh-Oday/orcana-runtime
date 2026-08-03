import { afterEach, describe, expect, test } from "bun:test"
import { applyLegacyEnvCompat } from "../src/config/env-compat"

// Rename migration: legacy DEEPSEEK_* env vars mirror to ORCANA_* so existing
// user configurations keep working; DeepSeek API vars keep canonical names.

const LEGACY = [
  "DEEPSEEK_MAX_ROUNDS",
  "DEEPSEEK_FLASH_TRIAGE",
  "DEEPSEEK_TUI_SPLASH",
  "DEEPSEEK_SANDBOX_TIMEOUT_SEC",
] as const

afterEach(() => {
  for (const key of LEGACY) delete process.env[key]
  for (const key of LEGACY) delete process.env[key.replace("DEEPSEEK_", "ORCANA_")]
  delete process.env.ORCANA_API_KEY
})

describe("legacy env compatibility", () => {
  test("legacy DEEPSEEK_* vars mirror to ORCANA_* when the new name is unset", () => {
    process.env.DEEPSEEK_MAX_ROUNDS = "42"
    process.env.DEEPSEEK_FLASH_TRIAGE = "off"
    applyLegacyEnvCompat()
    expect(process.env.ORCANA_MAX_ROUNDS).toBe("42")
    expect(process.env.ORCANA_FLASH_TRIAGE).toBe("off")
  })

  test("the new ORCANA_* name wins when both are set", () => {
    process.env.DEEPSEEK_MAX_ROUNDS = "42"
    process.env.ORCANA_MAX_ROUNDS = "99"
    applyLegacyEnvCompat()
    expect(process.env.ORCANA_MAX_ROUNDS).toBe("99")
  })

  test("DeepSeek API vars are NOT mirrored (canonical names kept)", () => {
    process.env.DEEPSEEK_API_KEY = "sk-legacy"
    applyLegacyEnvCompat()
    expect(process.env.ORCANA_API_KEY).toBeUndefined()
    expect(process.env.DEEPSEEK_API_KEY).toBe("sk-legacy")
  })

  test("mapping is idempotent", () => {
    process.env.DEEPSEEK_MAX_ROUNDS = "42"
    applyLegacyEnvCompat()
    applyLegacyEnvCompat()
    expect(process.env.ORCANA_MAX_ROUNDS).toBe("42")
  })
})
