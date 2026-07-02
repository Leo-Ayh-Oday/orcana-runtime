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
}

/** 文件系统 AuthStore — 存储在 ~/.deepseek-code/auth.json，权限 0600。 */
export class FileAuthStore implements AuthStore {
  private readonly filePath: string

  constructor(filePath: string = authStorePath()) {
    this.filePath = filePath
  }

  async get(providerId: string): Promise<string | undefined> {
    const data = this.readAll()
    return data[providerId]
  }

  async set(providerId: string, apiKey: string): Promise<void> {
    const data = this.readAll()
    data[providerId] = apiKey
    this.writeAll(data)
  }

  async delete(providerId: string): Promise<void> {
    const data = this.readAll()
    delete data[providerId]
    this.writeAll(data)
  }

  async list(): Promise<string[]> {
    return Object.keys(this.readAll())
  }

  // ── 内部方法 ──

  private readAll(): Record<string, string> {
    if (!existsSync(this.filePath)) return {}
    try {
      const raw = readFileSync(this.filePath, "utf-8")
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, string>
      }
      return {}
    } catch {
      return {}
    }
  }

  private writeAll(data: Record<string, string>): void {
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
  private readonly store = new Map<string, string>()

  async get(providerId: string): Promise<string | undefined> {
    return this.store.get(providerId)
  }

  async set(providerId: string, apiKey: string): Promise<void> {
    this.store.set(providerId, apiKey)
  }

  async delete(providerId: string): Promise<void> {
    this.store.delete(providerId)
  }

  async list(): Promise<string[]> {
    return Array.from(this.store.keys())
  }
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
