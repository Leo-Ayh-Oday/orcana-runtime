/** LNXF-1.0: resource ledger (LF-5, plan §12).
 *
 *  Atomic reservation before start — never "start then observe OOM"
 *  (RESOURCE_OVERCOMMIT: 0). Host reserve defaults: 1 CPU core or 15%
 *  (whichever larger) and 1 GB or 20% memory (whichever larger), tunable.
 */

import { cpus, totalmem } from "node:os"
import { randomUUID } from "node:crypto"
import type { ResourceRequest, ResourceReservation } from "../contracts"

export interface HostReserve {
  cpuQuota: number
  memoryBytes: number
}

export function defaultHostReserve(): HostReserve {
  const cpuCount = Math.max(1, cpus().length)
  const cpuReserve = Math.max(1, Math.floor(cpuCount * 0.15))
  const memTotal = Math.max(1, totalmem())
  const memReserve = Math.max(1024 * 1024 * 1024, Math.floor(memTotal * 0.2))
  return { cpuQuota: cpuReserve, memoryBytes: memReserve }
}

export interface LedgerConfig {
  /** 宿主保留（不进可分配池）。 */
  hostReserve: HostReserve
  maxConcurrentCells: number
}

export interface LedgerCapacity {
  cpuQuota: number
  memoryBytes: number
  pids: number
  tempBytes: number
  networkSlots: number
  concurrentCells: number
}

/** 以 100ms 周期为单位的 CPU 配额。 */
export function cpuQuotaFromCores(cores: number): number {
  return Math.round(cores * 10_000)
}

export class ResourceLedger {
  private readonly capacity: LedgerCapacity
  private readonly reserved = new Map<string, ResourceReservation>()
  private readonly config: LedgerConfig

  constructor(overrides: { hostReserve?: HostReserve; maxConcurrentCells?: number; capacity?: Partial<LedgerCapacity> } = {}) {
    const reserve = overrides.hostReserve ?? defaultHostReserve()
    this.config = { hostReserve: reserve, maxConcurrentCells: overrides.maxConcurrentCells ?? 6 }
    const cpuCount = Math.max(1, cpus().length)
    const memTotal = Math.max(1, totalmem())
    this.capacity = {
      cpuQuota: cpuQuotaFromCores(Math.max(1, cpuCount - reserve.cpuQuota)),
      memoryBytes: Math.max(0, memTotal - reserve.memoryBytes),
      pids: 32_768,
      tempBytes: 10 * 1024 * 1024 * 1024,
      networkSlots: 4,
      concurrentCells: this.config.maxConcurrentCells,
      ...overrides.capacity,
    }
  }

  private used(): ResourceRequest {
    const used: ResourceRequest = { cpuQuota: 0, memoryBytes: 0, pids: 0, ioWeight: 0, networkSlots: 0, tempBytes: 0 }
    for (const reservation of this.reserved.values()) {
      used.cpuQuota += reservation.granted.cpuQuota
      used.memoryBytes += reservation.granted.memoryBytes
      used.pids += reservation.granted.pids
      used.networkSlots += reservation.granted.networkSlots
      used.tempBytes += reservation.granted.tempBytes
    }
    return used
  }

  /** 当前可用余量。 */
  available(): ResourceRequest {
    const used = this.used()
    return {
      cpuQuota: this.capacity.cpuQuota - used.cpuQuota,
      memoryBytes: this.capacity.memoryBytes - used.memoryBytes,
      pids: this.capacity.pids - used.pids,
      ioWeight: 0,
      networkSlots: this.capacity.networkSlots - used.networkSlots,
      tempBytes: this.capacity.tempBytes - used.tempBytes,
    }
  }

  /**
   * 原子预留：全部满足才授予（禁止部分预留）。授予量 = 请求量（不超过可用）。
   * 返回失败时不含任何保留（RESOURCE_OVERCOMMIT: 0）。
   */
  reserve(request: ResourceRequest, runId: string, cellId: string, agentId?: string): { ok: true; reservation: ResourceReservation } | { ok: false; reason: string; available: ResourceRequest } {
    const avail = this.available()
    const granted: ResourceRequest = { ...request }
    const over: string[] = []
    if (request.cpuQuota > avail.cpuQuota) over.push(`cpu`)
    if (request.memoryBytes > avail.memoryBytes) over.push("memory")
    if (request.pids > avail.pids) over.push("pids")
    if (request.networkSlots > avail.networkSlots) over.push("network")
    if (request.tempBytes > avail.tempBytes) over.push("temp")
    if (this.reserved.size >= this.capacity.concurrentCells) over.push("cells")
    if (over.length > 0) {
      return { ok: false, reason: `insufficient resources: ${over.join(", ")}`, available: avail }
    }
    const reservation: ResourceReservation = {
      reservationId: `res_${randomUUID().slice(0, 8)}`,
      runId,
      agentId,
      cellId,
      requested: { ...request },
      granted,
      createdAt: Date.now(),
    }
    this.reserved.set(reservation.reservationId, reservation)
    return { ok: true, reservation }
  }

  /** 释放保留。 */
  release(reservationId: string): boolean {
    return this.reserved.delete(reservationId)
  }

  /** 释放某 run 的全部保留（Run 结束）。 */
  releaseRun(runId: string): number {
    let count = 0
    for (const [id, reservation] of this.reserved) {
      if (reservation.runId === runId) {
        this.reserved.delete(id)
        count += 1
      }
    }
    return count
  }

  /** 释放某 agent 的全部保留（Agent 取消）。 */
  releaseAgent(agentId: string): number {
    let count = 0
    for (const [id, reservation] of this.reserved) {
      if (reservation.agentId === agentId) {
        this.reserved.delete(id)
        count += 1
      }
    }
    return count
  }

  outstanding(): ResourceReservation[] {
    return [...this.reserved.values()]
  }

  stats(): { capacity: LedgerCapacity; available: ResourceRequest; outstanding: number } {
    return { capacity: this.capacity, available: this.available(), outstanding: this.reserved.size }
  }
}
