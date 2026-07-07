import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "bun:test"
import { MemoryAuthStore } from "../src/config/auth-store"
import { createRuntime } from "../src/runtime/bootstrap"

const tempDirs: string[] = []

function makeTempConfigPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "orcana-runtime-model-"))
  tempDirs.push(dir)
  return join(dir, "orcana.json")
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe("runtime model configuration", () => {
  test("configureModel registers and persists a custom model in the global config file", async () => {
    const globalPath = makeTempConfigPath()
    const runtime = await createRuntime({
      enableMCP: false,
      enableLSP: false,
      allowMissingProviderAuth: true,
      useEnvAuth: false,
      authStore: new MemoryAuthStore(),
      configOptions: { globalPath, applyEnv: false, loadProject: false },
    })

    try {
      await runtime.configureModel({
        providerId: "qwen",
        modelId: "custom-qwen-agent",
        apiKey: "sk-test",
        custom: true,
        baseUrl: "https://relay.example.com/v1",
      })

      expect(runtime.modelRouter.getSessionModel()).toBe("custom-qwen-agent")
      expect(runtime.registry.resolveModel("custom-qwen-agent")?.providerId).toBe("qwen")
      expect(runtime.config.providers?.qwen?.models["custom-qwen-agent"]).toBeDefined()

      const saved = JSON.parse(readFileSync(globalPath, "utf-8"))
      expect(saved.defaultProvider).toBe("qwen")
      expect(saved.models.default).toBe("custom-qwen-agent")
      expect(saved.providers.qwen.models["custom-qwen-agent"].tags).toContain("custom")
      expect(saved.providers.qwen.credentialRef).toBe("qwen/default")
      expect(saved.providers.qwen.baseUrl).toBe("https://relay.example.com/v1")
      expect((await runtime.authStore.getCredential?.("qwen/default"))?.baseUrl).toBe("https://relay.example.com/v1")
    } finally {
      runtime.dispose()
    }
  })
})
