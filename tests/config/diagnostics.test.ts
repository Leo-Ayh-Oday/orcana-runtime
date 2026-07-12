import { describe, expect, test } from "bun:test"
import { MemoryAuthStore } from "../../src/config/auth-store"
import { diagnoseModelConfiguration } from "../../src/config/diagnostics"

describe("model configuration diagnostics", () => {
  test("reports the persisted TUI credential instead of requiring an environment key", async () => {
    const authStore = new MemoryAuthStore()
    await authStore.set("deepseek", "sk-persisted")

    const result = await diagnoseModelConfiguration({
      authStore,
      configOptions: { globalPath: "Z:/does-not-exist/orcana.jsonc", loadProject: false },
      env: {},
    })

    expect(result).toEqual({
      providerId: "deepseek",
      modelId: "deepseek-v4-pro",
      auth: "auth-store",
    })
  })

  test("does not claim environment auth unless the config explicitly enables it", async () => {
    const result = await diagnoseModelConfiguration({
      authStore: new MemoryAuthStore(),
      configOptions: { globalPath: "Z:/does-not-exist/orcana.jsonc", loadProject: false },
      env: { DEEPSEEK_API_KEY: "sk-env" },
    })

    expect(result.auth).toBe("missing")
  })
})
