import { describe, expect, test } from "bun:test"
import type { Runtime } from "../../src/runtime/bootstrap"
import { buildModelOptions } from "../../src/tui/main"

describe("TUI model options", () => {
  test("routes relay models entered under DeepSeek through the OpenAI-compatible custom provider", () => {
    const runtime = {
      registry: { allModels: [] },
      config: {
        providers: {
          deepseek: {
            type: "deepseek",
            displayName: "DeepSeek",
            baseUrl: "https://api.deepseek.com",
            models: {},
          },
          custom: {
            type: "openai-compatible",
            displayName: "Custom OpenAI-compatible",
            models: {},
          },
        },
      },
      isProviderConfigured: (providerId: string) => providerId === "deepseek",
    } as unknown as Runtime

    const options = buildModelOptions(runtime, "", "", "deepseek")

    expect(options[0]).toMatchObject({
      providerId: "custom",
      providerName: "OpenAI-compatible",
      custom: true,
      configured: false,
    })
  })

  test("offers a custom model ID entry for an empty local provider catalog", () => {
    const runtime = {
      registry: { allModels: [] },
      config: {
        providers: {
          ollama: {
            type: "ollama",
            displayName: "Ollama (local)",
            baseUrl: "http://localhost:11434/v1",
            models: {},
          },
        },
      },
      isProviderConfigured: (providerId: string) => providerId === "ollama",
    } as unknown as Runtime

    const options = buildModelOptions(runtime, "", "", "ollama")

    expect(options).toHaveLength(1)
    expect(options[0]).toMatchObject({
      providerId: "ollama",
      providerName: "Ollama (local)",
      custom: true,
      configured: true,
    })
  })
})
