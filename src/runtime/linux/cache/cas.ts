/** LR2-2（P2-B）：内容寻址缓存（CAS）。
 *
 *  目录：~/.cache/orcana/{cas,objects,staging,locks,manifests,cache.db}。
 *  写入流程：staging（唯一临时名）→ 写 → digest → producer Receipt 校验
 *  → 原子 rename → 标记 immutable → 发布 manifest。
 *
 *  不变量（LR2-2 Gate）：
 *  - CACHE_KEY_COLLISION = 0：同 digest 不同内容 → 拒绝（hash 校验失败即碰撞）；
 *  - CONCURRENT_CACHE_WRITE_CORRUPT = 0：staging 唯一 + 原子 rename；
 *  - FAILED_CELL_POLLUTES_CACHE = 0：producer 失败（receipt 不完整）的产物
 *    不得晋升 VALID（QUARANTINED）；
 *  - CACHE_POISON_PROMOTION = 0：只有 VALID 可读，污染即 QUARANTINED。
 *
 *  v1 只缓存共享只读对象（repo-map / AST index / build info / RootFS）；
 *  禁止多个 Cell 直接共享可写 node_modules（计划要求）。
 */

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { CacheObjectState, READABLE_CACHE_STATES, type CacheObjectRecord } from "./cache-states"

/** M1：锁陈旧阈值（写入方崩溃遗留的锁超过此时长即接管）。 */
const LOCK_STALE_MS = 30_000

export interface ProducerReceipt {
  ok: boolean
  runId?: string
  cellId?: string
}

export interface CasOptions {
  root: string
  now?: () => number
}

export class ContentAddressedStore {
  private readonly root: string
  private readonly objectsDir: string
  private readonly stagingDir: string
  private readonly locksDir: string
  private readonly manifestsDir: string
  private readonly nowFn: () => number

  constructor(opts: CasOptions) {
    this.root = opts.root
    this.objectsDir = join(this.root, "objects")
    this.stagingDir = join(this.root, "staging")
    this.locksDir = join(this.root, "locks")
    this.manifestsDir = join(this.root, "manifests")
    this.nowFn = opts.now ?? (() => Date.now())
    for (const dir of [this.objectsDir, this.stagingDir, this.locksDir, this.manifestsDir]) {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
    }
  }

  private get now(): number {
    return this.nowFn()
  }

  /** M2 修复：digest 格式守卫（非 64-hex 直接抛错 —— 防路径穿越）。
   *  digest 只能来自内容哈希（内部生成）或 manifest 记录（外部可信面）。 */
  private assertDigestFormat(digest: string): void {
    if (!/^[a-f0-9]{64}$/.test(digest)) {
      throw new Error(`invalid cache digest: ${digest.slice(0, 32)}...`)
    }
  }

  private objectPath(digest: string): string {
    this.assertDigestFormat(digest)
    return join(this.objectsDir, digest)
  }

  private manifestPath(digest: string): string {
    this.assertDigestFormat(digest)
    return join(this.manifestsDir, `${digest}.json`)
  }

  /** 已存在且 VALID？ */
  hasValid(digest: string): boolean {
    const record = this.record(digest)
    return record !== undefined && READABLE_CACHE_STATES.has(record.state)
  }

  /** 读取 VALID 对象内容；非 VALID（QUARANTINED/INVALID/STAGING）拒绝。
   *  M5 修复：读取侧 sha256 校验（磁盘损坏/外部篡改 → 静默降级为
   *  QUARANTINED，不返回坏内容）。 */
  read(digest: string): Buffer | undefined {
    const record = this.record(digest)
    if (!record || !READABLE_CACHE_STATES.has(record.state)) return undefined
    const path = this.objectPath(digest)
    if (!existsSync(path)) return undefined
    const content = readFileSync(path)
    const actual = createHash("sha256").update(content).digest("hex")
    if (actual !== digest) {
      this.mark(digest, "QUARANTINED", "content hash mismatch on read")
      return undefined
    }
    return content
  }

  record(digest: string): CacheObjectRecord | undefined {
    const path = this.manifestPath(digest)
    if (!existsSync(path)) return undefined
    try {
      return JSON.parse(readFileSync(path, "utf8")) as CacheObjectRecord
    } catch {
      return undefined
    }
  }

  /**
   * 写入对象：内容 → digest → 原子发布。
   *  - 同 digest 内容已 VALID：返回已有 digest（幂等）；
   *  - 同 digest 不同内容：碰撞（CACHE_KEY_COLLISION）→ 拒绝；
   *  - producer receipt 失败：QUARANTINED（FAILED_CELL_POLLUTES_CACHE）。
   *  @returns 发布状态（"published" | "existing" | "collision" | "quarantined"）
   */
  put(content: Buffer, producer: ProducerReceipt): "published" | "existing" | "collision" | "quarantined" {
    const digest = createHash("sha256").update(content).digest("hex")
    const existing = this.record(digest)
    if (existing) {
      if (READABLE_CACHE_STATES.has(existing.state)) {
        // 已存在：校验内容一致（防同名异内容——理论不可达但强制校验）
        const onDisk = existsSync(this.objectPath(digest)) ? readFileSync(this.objectPath(digest)) : undefined
        if (onDisk && onDisk.equals(content)) return "existing"
        this.mark(digest, "QUARANTINED", "content mismatch on existing object")
        return "collision"
      }
      // CACHE_POISON_PROMOTION：QUARANTINED 锁定 —— 污染对象不得因重试
      // 写入而自动恢复（人工 quarantine 解除才可重写）。
      if (existing.state === "QUARANTINED") return "quarantined"
      // INVALID/EVICTING：允许重写发布。
    }

    // 写锁（并发双写保护：staging 唯一 + 原子 rename）。
    // M1 修复：锁文件写 pid+timestamp；陈旧锁（写入方崩溃遗留）超时即
    // 视为失效并接管 —— 崩溃残留不得永久毒化该 digest。
    const lockPath = join(this.locksDir, `${digest}.lock`)
    if (existsSync(lockPath)) {
      if (this.isStaleLock(lockPath)) {
        rmSync(lockPath, { force: true })
      } else {
        return "existing"
      }
    }
    writeFileSync(lockPath, `${process.pid}:${this.now}`, { mode: 0o600 })

    try {
      // staging（唯一临时名）→ digest 校验 → 原子 rename
      const stagingPath = join(this.stagingDir, `${digest}.${process.pid}.${this.now}`)
      writeFileSync(stagingPath, content, { mode: 0o600 })
      const staged = createHash("sha256").update(readFileSync(stagingPath)).digest("hex")
      if (staged !== digest) {
        // 理论上不可达（同一内容两次 hash）；防御性碰撞检测
        rmSync(stagingPath, { force: true })
        this.mark(digest, "QUARANTINED", "staging hash mismatch")
        return "collision"
      }
      // 原子发布：rename 到 objects/（存在则覆盖 —— 同 digest 同内容）
      renameSync(stagingPath, this.objectPath(digest))

      // producer 校验：失败 Cell 的产物 → QUARANTINED（不得晋升 VALID）
      if (!producer.ok) {
        this.mark(digest, "QUARANTINED", `producer failed: ${producer.cellId ?? "unknown"}`)
        return "quarantined"
      }
      this.mark(digest, "VALID", undefined, producer)
      return "published"
    } finally {
      rmSync(lockPath, { force: true })
    }
  }

  private mark(digest: string, state: CacheObjectState, reason?: string, producer?: ProducerReceipt): void {
    const existing = this.record(digest)
    const record: CacheObjectRecord = existing ?? {
      digest,
      state,
      bytes: existsSync(this.objectPath(digest)) ? statSync(this.objectPath(digest)).size : 0,
      createdAt: this.now,
    }
    record.state = state
    if (reason) record.quarantinedReason = reason
    if (producer) {
      record.producerRunId = producer.runId
      record.producerCellId = producer.cellId
    }
    // 原子写 manifest（temp + rename）
    const temp = join(this.manifestsDir, `.${digest}.${this.now}.tmp`)
    writeFileSync(temp, JSON.stringify(record))
    renameSync(temp, this.manifestPath(digest))
  }

  /** M1：锁陈旧判定 —— 锁内容 "pid:ts"，超时（默认 30s）或 pid 已退出
   *  即视为崩溃遗留。 */
  private isStaleLock(lockPath: string): boolean {
    try {
      const [pidStr, tsStr] = readFileSync(lockPath, "utf8").split(":")
      const ts = Number(tsStr)
      if (Number.isFinite(ts) && this.now - ts > LOCK_STALE_MS) return true
      const pid = Number(pidStr)
      if (Number.isFinite(pid) && pid > 0) {
        // pid 存活检查（尽力而为：ESRCH = 已退出 → 陈旧）
        try {
          process.kill(pid, 0)
          return false // 写入方还活着 → 不接管
        } catch {
          return true // 进程已退出 → 陈旧
        }
      }
      return true
    } catch {
      return true
    }
  }

  /** 淘汰（EVICTING → 删除对象 + manifest + 锁）。幂等。 */
  evict(digest: string): boolean {
    const record = this.record(digest)
    if (!record) return false
    this.mark(digest, "EVICTING")
    rmSync(this.objectPath(digest), { force: true })
    rmSync(this.manifestPath(digest), { force: true })
    rmSync(join(this.locksDir, `${digest}.lock`), { force: true })
    return true
  }

  /** 全部对象清单（观测/基线）。 */
  list(): CacheObjectRecord[] {
    return readdirSync(this.manifestsDir)
      .filter(f => f.endsWith(".json") && !f.startsWith("."))
      .map(f => this.record(f.slice(0, -5)))
      .filter((r): r is CacheObjectRecord => r !== undefined)
  }

  get size(): number {
    return this.list().length
  }
}
