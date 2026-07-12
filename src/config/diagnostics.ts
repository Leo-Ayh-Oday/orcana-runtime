import { getDefaultAuthStore, type AuthStore } from "./auth-store"
import { getProviderConfig, loadConfig, resolveModelForRole, type LoadConfigOptions } from "./config-loader"

export interface ModelConfigurationDiagnostic {
  providerId: string
  modelId: string
  auth: "auth-store" | "environment" | "local" | "missing"
}

export async function diagnoseModelConfiguration(options: {
  authStore?: AuthStore
  configOptions?: LoadConfigOptions
  env?: NodeJS.ProcessEnv
} = {}): Promise<ModelConfigurationDiagnostic> {
  const config = loadConfig({ applyEnv: false, ...options.configOptions })
  const authStore = options.authStore ?? getDefaultAuthStore()
  const env = options.env ?? process.env
  const providerId = config.defaultProvider ?? "deepseek"
  const modelId = resolveModelForRole("default", config)
  const provider = getProviderConfig(config, providerId)

  if (provider?.type === "ollama" || provider?.type === "lmstudio") {
    return { providerId, modelId, auth: "local" }
  }

  const credentialRef = provider?.credentialRef ?? `${providerId}/default`
  const stored = authStore.getCredential
    ? (await authStore.getCredential(credentialRef))?.apiKey
    : await authStore.get(providerId)
  if (stored) return { providerId, modelId, auth: "auth-store" }

  const envName = provider?.apiKeyEnv
  if (config.runtime?.allowEnvKeys && envName && env[envName]) {
    return { providerId, modelId, auth: "environment" }
  }
  return { providerId, modelId, auth: "missing" }
}
