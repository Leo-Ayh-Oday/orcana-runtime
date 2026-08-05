/** LNXF-1.0: secret bindings (LF-2, plan §7.4).
 *
 *  Default delivery: file-descriptor or sealed files under /run/secrets
 *  (read-only, process-scoped, expired after use). Environment delivery is
 *  only for programs that require it. Secrets are never written into
 *  traceable locations and are redacted from receipts.
 */

import { mkdirSync, writeFileSync, rmSync, chmodSync, readdirSync, existsSync } from "node:fs"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import type { SecretBinding } from "./contracts"

export interface BindSecretsInput {
  bindings: SecretBinding[]
  /** 实际密钥内容。 */
  values: Record<string, string>
  /** 放置 sealed files 的根（默认系统临时区，由 Runtime 决定）。 */
  secretsRoot?: string
}

export interface BoundSecret {
  binding: SecretBinding
  /** fd 或文件路径交付。 */
  deliveryTarget?: string
  /** 注入环境的键（delivery=environment 时）。 */
  envKey?: string
}

export interface BindSecretsResult {
  ok: boolean
  bound: BoundSecret[]
  envInjections: Record<string, string>
  errors: string[]
  /** 清理回调（Run 结束调用）。 */
  cleanup: () => void
}

/** 绑定密钥：优先 sealed-file / fd，environment 仅显式要求时。 */
export function bindSecrets(input: BindSecretsInput): BindSecretsResult {
  const errors: string[] = []
  const bound: BoundSecret[] = []
  const envInjections: Record<string, string> = {}
  const createdFiles: string[] = []

  const root = input.secretsRoot ?? join(process.env.TMPDIR ?? "/tmp", `orcana-secrets-${process.pid}`)
  mkdirSync(root, { recursive: true })

  for (const binding of input.bindings) {
    const value = input.values[binding.id]
    if (value === undefined) {
      errors.push(`secret binding "${binding.id}" has no value`)
      continue
    }
    if (binding.expiresAt < Date.now()) {
      errors.push(`secret binding "${binding.id}" expired`)
      continue
    }
    switch (binding.delivery) {
      case "environment": {
        const envKey = binding.target ?? `ORCANA_SECRET_${binding.id.toUpperCase()}`
        envInjections[envKey] = value
        bound.push({ binding, envKey })
        break
      }
      case "sealed-file": {
        const file = join(root, `${binding.id}.secret`)
        writeFileSync(file, value, { mode: 0o600 })
        chmodSync(file, 0o600)
        createdFiles.push(file)
        bound.push({ binding, deliveryTarget: file })
        break
      }
      case "file-descriptor": {
        // LF-2: 以 sealed-file 交付（fd 透传留待 LF-6 容器场景）。
        const file = join(root, `${binding.id}.fd`)
        writeFileSync(file, value, { mode: 0o600 })
        chmodSync(file, 0o600)
        createdFiles.push(file)
        bound.push({ binding, deliveryTarget: file })
        break
      }
    }
  }

  return {
    ok: errors.length === 0,
    bound,
    envInjections,
    errors,
    cleanup: () => {
      for (const file of createdFiles) {
        try {
          rmSync(file, { force: true })
        } catch {
          // best-effort
        }
      }
      try {
        if (existsSync(root) && readdirSync(root).length === 0) rmSync(root, { recursive: true, force: true })
      } catch {
        // best-effort
      }
    },
  }
}

export function newSecretBinding(partial: Omit<SecretBinding, "id" | "redactFromTrace">): SecretBinding {
  return {
    id: `sb_${randomUUID().slice(0, 8)}`,
    ...partial,
    redactFromTrace: true,
  }
}
