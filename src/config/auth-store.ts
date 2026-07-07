/** AuthStore — API key 安全存储。
 *
 *  要求：
 *    1. auth.json 放全局 config 目录（~/.deepseek-code/auth.json）
 *    2. 文件权限 0600（仅所有者可读写）
 *    3. trace/log/final 不输出 key
 *    4. project config 里不能出现 apiKey 明文
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, statSync } from "node:fs"
import { dirname } from "node:path"
import { authStorePath } from "./paths"

/** AuthStore 接口 — 可替换实现（如 keychain 后端）。 */
export interface AuthStore {
  /** 获取 provider 的 API key，不存在返回 undefined。 */
  get(providerId: string): Promise<string | undefined>
  /** 保存 provider 的 API key（加密/权限由实现负责）。 */
  set(providerId: string, apiKey: string): Promise<void>
  /** 删除 provider 的 API key。 */
  delete(providerId: string): Promise<void>
  /** 列出所有已存储 key 的 provider ID（不返回 key 本身）。 */
  list(): Promise<string[]>
  getCredential?(ref: string): Promise<CredentialProfile | undefined>
  setCredential?(profile: CredentialProfile): Promise<void>
  deleteCredential?(ref: string): Promise<void>
  listCredentials?(providerId?: string): Promise<CredentialProfileSummary[]>
}

export interface CredentialProfile {
  id: string
  providerId: string
  label: string
  apiKey: string
  baseUrl?: string
  createdAt: number
  updatedAt: number
}

export interface CredentialProfileSummary {
  id: string
  providerId: string
  label: string
  baseUrl?: string
  createdAt: number
  updatedAt: number
}

interface AuthFileV2 {
  version: 2
  credentials: Record<string, CredentialProfile>
}

type AuthFileData = AuthFileV2

/** 文件系统 AuthStore — 存储在 ~/.deepseek-code/auth.json，权限 0600。 */
export class FileAuthStore implements AuthStore {
  private readonly filePath: string

  constructor(filePath: string = authStorePath()) {
    this.filePath = filePath
  }

  async get(providerId: string): Promise<string | undefined> {
    return (await this.getCredential(`${providerId}/default`))?.apiKey
  }

  async set(providerId: string, apiKey: string): Promise<void> {
    await this.setCredential({
      id: `${providerId}/default`,
      providerId,
      label: "default",
      apiKey,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
  }

  async delete(providerId: string): Promise<void> {
    await this.deleteCredential(`${providerId}/default`)
  }

  async list(): Promise<string[]> {
    return [...new Set(Object.values(this.readAll().credentials).map(item => item.providerId))]
  }

  async getCredential(ref: string): Promise<CredentialProfile | undefined> {
    return this.readAll().credentials[ref]
  }

  async setCredential(profile: CredentialProfile): Promise<void> {
    const data = this.readAll()
    const existing = data.credentials[profile.id]
    const now = Date.now()
    data.credentials[profile.id] = {
      ...profile,
      createdAt: existing?.createdAt ?? profile.createdAt ?? now,
      updatedAt: now,
    }
    this.writeAll(data)
  }

  async deleteCredential(ref: string): Promise<void> {
    const data = this.readAll()
    delete data.credentials[ref]
    this.writeAll(data)
  }

  async listCredentials(providerId?: string): Promise<CredentialProfileSummary[]> {
    return Object.values(this.readAll().credentials)
      .filter(item => !providerId || item.providerId === providerId)
      .map(({ apiKey: _apiKey, ...summary }) => summary)
  }

  // ── 内部方法 ──

  private readAll(): AuthFileData {
    if (!existsSync(this.filePath)) return { version: 2, credentials: {} }
    try {
      const raw = readFileSync(this.filePath, "utf-8")
      const parsed = JSON.parse(raw)
      if (isRecord(parsed) && parsed.version === 2 && isRecord(parsed.credentials)) {
        return {
          version: 2,
          credentials: Object.fromEntries(
            Object.entries(parsed.credentials)
              .filter((entry): entry is [string, CredentialProfile] => isCredential(entry[0], entry[1]))
              .map(([id, value]) => [id, value]),
          ),
        }
      }
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const migrated = migrateLegacyAuth(parsed as Record<string, unknown>)
        if (Object.keys(migrated.credentials).length > 0) {
          this.writeAll(migrated)
        }
        return migrated
      }
      return { version: 2, credentials: {} }
    } catch {
      return { version: 2, credentials: {} }
    }
  }

  private writeAll(data: AuthFileData): void {
    const dir = dirname(this.filePath)
    mkdirSync(dir, { recursive: true })
    writeFileSync(this.filePath, JSON.stringify(data, null, 2), { mode: 0o600 })
    // 显式 chmod 确保权限（Windows 忽略，Unix 生效）
    try {
      chmodSync(this.filePath, 0o600)
    } catch {
      // Windows 或权限不足时静默
    }
  }
}

/** 内存 AuthStore — 用于测试，不持久化。 */
export class MemoryAuthStore implements AuthStore {
  private readonly store = new Map<string, CredentialProfile>()

  async get(providerId: string): Promise<string | undefined> {
    return this.store.get(`${providerId}/default`)?.apiKey
  }

  async set(providerId: string, apiKey: string): Promise<void> {
    await this.setCredential({
      id: `${providerId}/default`,
      providerId,
      label: "default",
      apiKey,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
  }

  async delete(providerId: string): Promise<void> {
    this.store.delete(`${providerId}/default`)
  }

  async list(): Promise<string[]> {
    return [...new Set(Array.from(this.store.values()).map(item => item.providerId))]
  }

  async getCredential(ref: string): Promise<CredentialProfile | undefined> {
    return this.store.get(ref)
  }

  async setCredential(profile: CredentialProfile): Promise<void> {
    this.store.set(profile.id, { ...profile, updatedAt: Date.now() })
  }

  async deleteCredential(ref: string): Promise<void> {
    this.store.delete(ref)
  }

  async listCredentials(providerId?: string): Promise<CredentialProfileSummary[]> {
    return Array.from(this.store.values())
      .filter(item => !providerId || item.providerId === providerId)
      .map(({ apiKey: _apiKey, ...summary }) => summary)
  }
}

function migrateLegacyAuth(data: Record<string, unknown>): AuthFileV2 {
  const now = Date.now()
  const credentials: Record<string, CredentialProfile> = {}
  for (const [providerId, apiKey] of Object.entries(data)) {
    if (typeof apiKey !== "string" || !apiKey.trim()) continue
    const id = `${providerId}/default`
    credentials[id] = {
      id,
      providerId,
      label: "default",
      apiKey,
      createdAt: now,
      updatedAt: now,
    }
  }
  return { version: 2, credentials }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isCredential(id: string, value: unknown): value is CredentialProfile {
  if (!isRecord(value)) return false
  return value.id === id
    && typeof value.providerId === "string"
    && typeof value.label === "string"
    && typeof value.apiKey === "string"
    && typeof value.createdAt === "number"
    && typeof value.updatedAt === "number"
}

/** 检查 auth 文件权限是否安全（0600）。
 *  仅在 Unix 系统有意义，Windows 总是返回 true。 */
export function isAuthFileSecure(filePath: string = authStorePath()): boolean {
  if (process.platform === "win32") return true
  if (!existsSync(filePath)) return true
  try {
    const stat = statSync(filePath)
    // 检查权限位：仅所有者可读写 (0600)
    return (stat.mode & 0o077) === 0
  } catch {
    return false
  }
}

/** 默认 AuthStore 实例（延迟创建）。 */
let _defaultStore: AuthStore | null = null
export function getDefaultAuthStore(): AuthStore {
  if (_defaultStore === null) {
    _defaultStore = new FileAuthStore()
  }
  return _defaultStore
}
