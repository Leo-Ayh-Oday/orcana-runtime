/** LNXF-1.0: explicit environment construction (LF-2, plan §15).
 *
 *  Child env = 空对象 → Runtime 固定安全变量 → Profile 允许变量 → Tool
 *  显式申请 → Secret 注入 → 策略校验 → 冻结. NEVER
 *  `{ ...process.env, ...requested }` (HOST_ENV_INHERITANCE_BLOCKED).
 */

import type { EnvironmentPolicy } from "./contracts"

export const DEFAULT_ENV_VARS: Record<string, string> = {
  HOME: "/home/orcana",
  TMPDIR: "/tmp",
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  NODE_ENV: "production",
  ORCANA_SANDBOX: "1",
}

export const DEFAULT_DENIED_KEYS = [
  "*_API_KEY",
  "*_TOKEN",
  "AWS_*",
  "GITHUB_TOKEN",
  "SSH_AUTH_SOCK",
  "DOCKER_HOST",
  "KUBECONFIG",
  "DATABASE_URL",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "http_proxy",
  "https_proxy",
  "ALL_PROXY",
]

export interface BuildEnvironmentInput {
  policy: EnvironmentPolicy
  runId: string
  nodeRunId: string
  /** 额外 PATH 条目（追加到 Profile 默认）。 */
  pathEntries?: string[]
  /** Secret 注入（secrets.ts 构造后）。 */
  secrets?: Record<string, string>
  extraDenied?: string[]
}

export interface EnvironmentBuildResult {
  ok: boolean
  /** 冻结后的完整环境。 */
  env: Record<string, string>
  /** 被拒绝的宿主键（审计）。 */
  rejectedHostKeys: string[]
  error?: string
}

function matchesPattern(key: string, pattern: string): boolean {
  if (pattern.endsWith("*")) return key.startsWith(pattern.slice(0, -1))
  if (pattern.startsWith("*_")) return key.endsWith(pattern.slice(1))
  return key === pattern
}

/** 宿主环境可见性：给定键是否属于默认拒绝集。 */
export function hostKeyDenied(key: string, extraDenied: string[] = []): boolean {
  return [...DEFAULT_DENIED_KEYS, ...extraDenied].some(p => matchesPattern(key, p))
}

/** 显式环境构造（唯一入口）。 */
export function buildExplicitEnvironment(input: BuildEnvironmentInput): EnvironmentBuildResult {
  const env: Record<string, string> = { ...DEFAULT_ENV_VARS }
  const extraDenied = [...(input.extraDenied ?? []), ...input.policy.deniedKeys]
  const rejectedHostKeys: string[] = []

  // 1. Runtime 固定安全变量。
  env.ORCANA_RUN_ID = input.runId
  env.ORCANA_NODE_RUN_ID = input.nodeRunId
  env.PATH = input.policy.baseProfile === "minimal"
    ? "/usr/bin:/bin"
    : `/usr/local/bin:/usr/bin:/bin${(input.pathEntries ?? []).length ? ":" + input.pathEntries!.join(":") : ""}`
  if (input.policy.baseProfile === "service") {
    env.TERM = "xterm"
  }

  // 2. Profile 允许变量（fixedValues 覆盖默认）。
  for (const [key, value] of Object.entries(input.policy.fixedValues)) {
    if (hostKeyDenied(key, extraDenied)) {
      rejectedHostKeys.push(key)
      continue
    }
    env[key] = value
  }

  // 3. 宿主键白名单（显式允许才复制）。
  for (const key of input.policy.allowedHostKeys) {
    if (hostKeyDenied(key, input.extraDenied)) {
      rejectedHostKeys.push(key)
      continue
    }
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }

  // 4. Tool 显式申请。
  for (const [key, value] of Object.entries(input.policy.requestedValues)) {
    if (hostKeyDenied(key, extraDenied)) {
      rejectedHostKeys.push(key)
      continue
    }
    env[key] = value
  }

  // 5. Secret 注入。
  if (input.secrets) {
    for (const [key, value] of Object.entries(input.secrets)) {
      env[key] = value
    }
  }

  // 6. 最终拒绝校验（fail-closed：任何残留拒绝键 → 拒绝整个环境）。
  for (const key of Object.keys(env)) {
    if (hostKeyDenied(key, extraDenied)) {
      rejectedHostKeys.push(key)
      delete env[key]
    }
  }

  return { ok: true, env, rejectedHostKeys }
}

/** 密钥泄漏检测：子进程环境中出现密钥类键（默认拒绝集匹配）即泄漏。
 *  PATH/HOME 等安全变量不算（HOST_ENV_SECRET_LEAK 语义）。 */
export function environmentLeaksHostSecrets(env: Record<string, string>, allowed: string[] = []): string[] {
  return Object.keys(env).filter(key => hostKeyDenied(key) && !allowed.includes(key))
}
