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

  test("configures and persists a local Ollama model without requiring an API key", async () => {
    const globalPath = makeTempConfigPath()
    const authStore = new MemoryAuthStore()
    const runtime = await createRuntime({
      enableMCP: false,
      enableLSP: false,
      allowMissingProviderAuth: true,
      useEnvAuth: false,
      authStore,
      configOptions: { globalPath, applyEnv: false, loadProject: false },
    })

    try {
      await runtime.configureModel({
        providerId: "ollama",
        modelId: "qwen3-coder:8b",
        custom: true,
      })

      expect(runtime.modelRouter.getSessionModel()).toBe("qwen3-coder:8b")
      expect(runtime.isProviderConfigured("ollama")).toBe(true)
      expect(await authStore.get("ollama")).toBeUndefined()

      const saved = JSON.parse(readFileSync(globalPath, "utf-8"))
      expect(saved.providers.ollama.baseUrl).toBe("http://localhost:11434/v1")
      expect(saved.providers.ollama.models["qwen3-coder:8b"]).toBeDefined()
    } finally {
      runtime.dispose()
    }
  })

  test("restores the configured relay model and credential after a runtime restart", async () => {
    const globalPath = makeTempConfigPath()
    const authStore = new MemoryAuthStore()
    const commonOptions = {
      enableMCP: false,
      enableLSP: false,
      useEnvAuth: false,
      authStore,
      configOptions: { globalPath, applyEnv: false, loadProject: false },
    }

    const first = await createRuntime({ ...commonOptions, allowMissingProviderAuth: true })
    try {
      await first.configureModel({
        providerId: "qwen",
        modelId: "relay-gpt",
        apiKey: "sk-persisted",
        custom: true,
        baseUrl: "https://relay.example.com/v1",
      })
    } finally {
      first.dispose()
    }

    const restarted = await createRuntime(commonOptions)
    try {
      expect(restarted.config.defaultProvider).toBe("qwen")
      expect(restarted.modelRouter.getSessionModel()).toBe("relay-gpt")
      expect(restarted.registry.resolveModel("relay-gpt")?.providerId).toBe("qwen")
      expect(restarted.isProviderConfigured("qwen")).toBe(true)
      expect((await authStore.getCredential?.("qwen/default"))?.baseUrl).toBe("https://relay.example.com/v1")
    } finally {
      restarted.dispose()
    }
  })
})
