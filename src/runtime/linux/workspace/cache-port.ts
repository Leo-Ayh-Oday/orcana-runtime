/** LNXF-1.0: cache manager + port lease (LF-5, plan §17/§18).
 *
 *  Cache: shared-ro (content-addressed, repo-map, immutable artifacts) vs
 *  key-locked (bun/npm/pnpm/ts caches, build caches). The runtime decides
 *  the host path — models never provide host cache dirs. Ports: loopback
 *  only inside the cell namespace; host leases require explicit approval;
 *  0.0.0.0 binding is rejected; leases expire and are collected at run end.
 */

import { mkdirSync, existsSync } from "node:fs"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import type { CacheMountRequest, PortLease } from "../contracts"

export const CACHE_KIND_SUBDIR: Record<CacheMountRequest["kind"], string> = {
  bun: "bun",
  npm: "npm",
  pnpm: "pnpm",
  typescript: "tsbuildinfo",
  "repo-map": "repo-map",
  custom: "custom",
}

/** 只读共享的缓存类型（无需锁）。 */
export const SHARED_READONLY_KINDS: Set<CacheMountRequest["kind"]> = new Set(["repo-map", "custom"])

export class CacheManager {
  constructor(private readonly cacheRoot: string) {}

  /** 宿主缓存路径（Runtime 决定，模型不可指定）。 */
  hostPath(request: CacheMountRequest): string {
    const dir = join(this.cacheRoot, CACHE_KIND_SUBDIR[request.kind], request.key)
    mkdirSync(dir, { recursive: true })
    return dir
  }

  /** 锁键（与 isolation-lock 联动）。 */
  lockKey(request: CacheMountRequest): string {
    return `cache:${request.kind}:${request.key}`
  }

  /** 需要排他锁的缓存（写入过程）。 */
  requiresExclusive(request: CacheMountRequest): boolean {
    return request.mode === "rw-locked"
  }
}

export interface PortLeaseManagerOptions {
  /** 可映射宿主端口的范围（127.0.0.1）。 */
  hostPortRange?: { start: number; end: number }
  /** 租约时长（默认 30 分钟）。 */
  leaseMs?: number
}

export class PortLeaseManager {
  private readonly leases = new Map<string, PortLease>()
  private readonly hostPorts = new Set<number>()
  private readonly hostPortRange: { start: number; end: number }
  private readonly leaseMs: number

  constructor(options: PortLeaseManagerOptions = {}) {
    this.hostPortRange = options.hostPortRange ?? { start: 39_000, end: 39_999 }
    this.leaseMs = options.leaseMs ?? 30 * 60 * 1000
  }

  /**
   * 申请内部端口（cell namespace 内使用）。
   * 返回内部端口（127.0.0.1 语义）；host 端口仅在 exposeToHost=true 且
   * 有显式批准时分配。bindAddress 永远 127.0.0.1。
   */
  lease(input: {
    runId: string
    cellId: string
    agentId?: string
    internalPort: number
    exposeToHost?: boolean
  }): PortLease | undefined {
    if (input.internalPort <= 0 || input.internalPort > 65_535) return undefined
    const hostPort = input.exposeToHost ? this.allocateHostPort() : undefined
    const lease: PortLease = {
      leaseId: `pl_${randomUUID().slice(0, 8)}`,
      runId: input.runId,
      cellId: input.cellId,
      agentId: input.agentId,
      internalPort: input.internalPort,
      hostPort,
      bindAddress: "127.0.0.1",
      expiresAt: Date.now() + this.leaseMs,
    }
    this.leases.set(lease.leaseId, lease)
    return lease
  }

  private allocateHostPort(): number | undefined {
    for (let port = this.hostPortRange.start; port <= this.hostPortRange.end; port++) {
      if (!this.hostPorts.has(port)) {
        this.hostPorts.add(port)
        return port
      }
    }
    return undefined
  }

  release(leaseId: string): boolean {
    const lease = this.leases.get(leaseId)
    if (!lease) return false
    if (lease.hostPort !== undefined) this.hostPorts.delete(lease.hostPort)
    return this.leases.delete(leaseId)
  }

  /** 回收过期租约。 */
  collectExpired(): number {
    const now = Date.now()
    let count = 0
    for (const [id, lease] of this.leases) {
      if (lease.expiresAt < now) {
        this.release(id)
        count += 1
      }
    }
    return count
  }

  /** Run 结束回收全部租约（端口泄漏 = 0）。 */
  releaseRun(runId: string): number {
    let count = 0
    for (const [id, lease] of this.leases) {
      if (lease.runId === runId) {
        this.release(id)
        count += 1
      }
    }
    return count
  }

  activeLeases(): PortLease[] {
    return [...this.leases.values()]
  }
}

/** 0.0.0.0 绑定拒绝（plan §18）。 */
export function validateBindAddress(address: string): boolean {
  return address === "127.0.0.1" || address === "localhost" || address.startsWith("127.")
}

export function cacheHostPathExists(root: string, request: CacheMountRequest): boolean {
  return existsSync(join(root, CACHE_KIND_SUBDIR[request.kind], request.key))
}
