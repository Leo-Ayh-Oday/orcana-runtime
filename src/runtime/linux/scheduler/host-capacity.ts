/** IC06: Resource Authority —— 权威容量记账（AUTHORITY_PROCESS=execd）。
 *
 *  HostCapacityAuthority（server-side）：SQLite durable per-reservation claims +
 *  owner-token hash + idempotent reserve（token rekey）+ release-requested
 *  reality 检查 + 内部 quarantine/transfer + reconcile（server 自读 OS reality）。
 *
 *  外部 trusted runtime client（broker / workflow scheduler）只经 CapacityClient
 *  （Unix IPC）使用；authority DB 不由 external client 直接打开。
 *
 *  容量 free 唯一条件 = server-side 独立 positive reality proof
 *  （OWNER_TOKEN_RELEASE_WITHOUT_TERMINATION_PROOF = 0）。
 */

import { Database } from "bun:sqlite"
import { randomUUID, createHash } from "node:crypto"
import { cpus, totalmem } from "node:os"
import { readdirSync, statSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { ResourceRequest } from "../contracts"

// ── claim phases（TERMINATION_PROVEN/RELEASED 只能由 server 独立 reality 设置）──

export type ClaimPhase =
  | "RESERVED"
  | "PRE_SPAWN"
  | "SPAWN_ATTEMPTING"
  | "SPAWN_IDENTITY_COMMITTED"
  | "EXECUTING"
  | "QUARANTINED"
  | "SUSPECT"
  | "TERMINATION_PROVEN"
  | "RELEASED"

/** client 可上报的 phase（不释放容量；TERMINATION_PROVEN/RELEASED 由 server 设置）。 */
export const CLIENT_REPORTABLE_PHASES: ReadonlySet<string> = new Set([
  "RESERVED",
  "PRE_SPAWN",
  "SPAWN_ATTEMPTING",
  "SPAWN_IDENTITY_COMMITTED",
  "EXECUTING",
])

// ── reality（server 独立 OS 现实）──

export interface ClaimReality {
  state: "proven" | "live" | "unknown"
  evidence: string
}

/** reality provider：server 端注入；默认实现读 /proc + cgroup。 */
export type RealityProvider = (claim: CapacityClaimView) => Promise<ClaimReality>

// ── 公开视图（序列化，不含 ownerToken 明文）──

export interface CapacityClaimView {
  claimId: string
  runId: string
  cellId: string
  agentId?: string
  backendId?: string
  phase: ClaimPhase
  requested: ResourceRequest
  createdAt: number
  updatedAt: number
  spawnedPid?: number
  spawnStartticks?: number
  cgroupPath?: string
}

export interface CapacityReserveRequest {
  request: ResourceRequest
  runId: string
  cellId: string
  agentId?: string
  backendId?: string
}

export type ReleaseRequestState = "RELEASED" | "QUARANTINED" | "SUSPECT" | "REJECTED"

export interface CapacityStatusView {
  capacity: { cpuQuota: number; memoryBytes: number; pids: number; networkSlots: number; tempBytes: number; concurrentCells: number }
  available: ResourceRequest
  charged: number
  claims: CapacityClaimView[]
}

/** 认证后的 client principal（uid/pid 来自 SO_PEERCRED，startticks 来自 OS，
 *  clientInstanceId 由 client 生命周期持有）。 */
export interface ClientPrincipal {
  uid: number
  pid: number
  startticks: number
  clientInstanceId: string
}

// ── 权威接口（in-process 与 IPC client 同一形状）──

export type ReserveOutcome =
  | { ok: true; claimId: string; ownerToken: string }
  | { ok: false; reason: string }

export interface CapacityAuthority {
  reserve(req: CapacityReserveRequest, idempotencyKey: string, principal: ClientPrincipal): Promise<ReserveOutcome>
  releaseRequested(claimId: string, ownerToken: string): Promise<{ state: ReleaseRequestState; phase: ClaimPhase }>
  updatePhase(claimId: string, ownerToken: string, phase: Exclude<ClaimPhase, "TERMINATION_PROVEN" | "RELEASED">, spawn?: { pid: number; startticks: number; cgroupPath?: string }): Promise<void>
  reconcile(principal: ClientPrincipal): Promise<{ freed: number; remainingCharged: number }>
  status(principal: ClientPrincipal): Promise<CapacityStatusView>
  close(): Promise<void>
}

// ── 配置与容量 ──

export interface HostCapacityConfig {
  dbPath: string
  /** 宿主保留（默认同 ResourceLedger）。 */
  hostReserve?: { cpuQuota: number; memoryBytes: number }
  maxConcurrentCells?: number
  /** 测试注入容量覆盖。 */
  capacityOverride?: Partial<{ cpuQuota: number; memoryBytes: number; pids: number; networkSlots: number; tempBytes: number }>
  /** 测试注入 reality（默认真实）。 */
  reality?: RealityProvider
}

function defaultHostReserve(): { cpuQuota: number; memoryBytes: number } {
  const cpuCount = Math.max(1, cpus().length)
  const cpuReserve = Math.max(1, Math.floor(cpuCount * 0.15))
  const memTotal = Math.max(1, totalmem())
  const memReserve = Math.max(1024 * 1024 * 1024, Math.floor(memTotal * 0.2))
  return { cpuQuota: cpuReserve, memoryBytes: memReserve }
}

// ── OS reality 工具 ──

/** /proc/PID/stat 第 22 字段（starttime 单位 = clock ticks；PID-reuse 安全）。 */
export function readProcessStartticks(pid: number): number | undefined {
  if (!pid || pid < 1) return undefined
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
    // comm 可含空格/括号：从最后一个 ')' 之后取字段。
    const closeIdx = stat.lastIndexOf(")")
    if (closeIdx < 0) return undefined
    const fields = stat.slice(closeIdx + 2).split(" ")
    const starttimeRaw = fields[19]
    if (starttimeRaw === undefined) return undefined
    return Number.parseInt(starttimeRaw, 10)
  } catch {
    return undefined
  }
}

/** 真实 reality provider：pid+startticks 主判据；cgroup 声明额外校验。 */
export function createProcessRealityProvider(): RealityProvider {
  return async (claim) => {
    if (claim.spawnedPid && claim.spawnedPid > 0) {
      const nowTicks = readProcessStartticks(claim.spawnedPid)
      if (nowTicks === undefined) {
        return { state: "proven", evidence: `pid ${claim.spawnedPid} not present in /proc` }
      }
      if (claim.spawnStartticks !== undefined && nowTicks !== claim.spawnStartticks) {
        return { state: "proven", evidence: `pid ${claim.spawnedPid} startticks changed (PID reuse or replaced)` }
      }
      if (claim.cgroupPath) {
        try {
          if (!statSync(claim.cgroupPath).isDirectory()) {
            return { state: "proven", evidence: `cgroup ${claim.cgroupPath} removed while pid present (cgroup killed)` }
          }
        } catch {
          return { state: "proven", evidence: `cgroup ${claim.cgroupPath} removed (killed)` }
        }
      }
      return { state: "live", evidence: `pid ${claim.spawnedPid} alive` }
    }
    return { state: "unknown", evidence: "no spawn identity recorded" }
  }
}

// ── server-side authority ──

interface ClaimRow {
  claim_id: string
  run_id: string
  cell_id: string
  agent_id: string | null
  backend_id: string | null
  phase: string
  requested_json: string
  owner_token_hash: string
  principal: string
  client_instance_id: string
  idempotency_key: string
  request_digest: string
  created_at: number
  updated_at: number
  spawned_pid: number | null
  spawn_startticks: number | null
  cgroup_path: string | null
}

export class HostCapacityAuthority implements CapacityAuthority {
  private readonly db: Database
  private readonly reality: RealityProvider
  private readonly capacity: { cpuQuota: number; memoryBytes: number; pids: number; networkSlots: number; tempBytes: number }
  private readonly maxConcurrentCells: number
  private readonly tokens = new Map<string, string>() // claimId → plaintext token（仅内存）

  constructor(private readonly config: HostCapacityConfig) {
    const reserve = config.hostReserve ?? defaultHostReserve()
    const cpuCount = Math.max(1, cpus().length)
    const memTotal = Math.max(1, totalmem())
    this.capacity = {
      cpuQuota: Math.round(Math.max(1, cpuCount - reserve.cpuQuota) * 1000),
      memoryBytes: Math.max(0, memTotal - reserve.memoryBytes),
      pids: 32_768,
      networkSlots: 4,
      tempBytes: 10 * 1024 * 1024 * 1024,
      ...config.capacityOverride,
    }
    this.maxConcurrentCells = config.maxConcurrentCells ?? 6
    this.reality = config.reality ?? createProcessRealityProvider()
    this.db = new Database(config.dbPath)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS claims (
        claim_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        cell_id TEXT NOT NULL,
        agent_id TEXT,
        backend_id TEXT,
        phase TEXT NOT NULL,
        requested_json TEXT NOT NULL,
        owner_token_hash TEXT NOT NULL,
        principal TEXT NOT NULL,
        client_instance_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_digest TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        spawned_pid INTEGER,
        spawn_startticks INTEGER,
        cgroup_path TEXT,
        UNIQUE (run_id, cell_id)
      );
      CREATE TABLE IF NOT EXISTS authority_idempotency (
        method TEXT NOT NULL,
        principal TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_digest TEXT NOT NULL,
        claim_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (method, principal, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS idx_claims_phase ON claims (phase);
    `)
  }

  static tokenHash(token: string): string {
    return createHash("sha256").update(token).digest("hex")
  }

  static digestOf(request: ResourceRequest): string {
    return createHash("sha256").update(JSON.stringify(request)).digest("hex")
  }

  private principalKey(p: ClientPrincipal): string {
    return `${p.uid}:${p.pid}:${p.startticks}:${p.clientInstanceId}`
  }

  private view(row: ClaimRow): CapacityClaimView {
    return {
      claimId: row.claim_id,
      runId: row.run_id,
      cellId: row.cell_id,
      agentId: row.agent_id ?? undefined,
      backendId: row.backend_id ?? undefined,
      phase: row.phase as ClaimPhase,
      requested: JSON.parse(row.requested_json) as ResourceRequest,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      spawnedPid: row.spawned_pid ?? undefined,
      spawnStartticks: row.spawn_startticks ?? undefined,
      cgroupPath: row.cgroup_path ?? undefined,
    }
  }

  private chargedBytes(): { cpuQuota: number; memoryBytes: number; pids: number; networkSlots: number; tempBytes: number } {
    const rows = this.db.query(`SELECT requested_json FROM claims WHERE phase NOT IN ('RELEASED')`).all() as Array<{ requested_json: string }>
    let cpuQuota = 0, memoryBytes = 0, pids = 0, networkSlots = 0, tempBytes = 0
    for (const row of rows) {
      const r = JSON.parse(row.requested_json) as ResourceRequest
      cpuQuota += r.cpuQuota
      memoryBytes += r.memoryBytes
      pids += r.pids
      networkSlots += r.networkSlots
      tempBytes += r.tempBytes
    }
    return { cpuQuota, memoryBytes, pids, networkSlots, tempBytes }
  }

  private available(): ResourceRequest {
    const used = this.chargedBytes()
    return {
      cpuQuota: this.capacity.cpuQuota - used.cpuQuota,
      memoryBytes: this.capacity.memoryBytes - used.memoryBytes,
      pids: this.capacity.pids - used.pids,
      ioWeight: 0,
      networkSlots: this.capacity.networkSlots - used.networkSlots,
      tempBytes: this.capacity.tempBytes - used.tempBytes,
    }
  }

  /** reserve：幂等（same principal + key + digest → same claim + token rekey）。 */
  async reserve(req: CapacityReserveRequest, idempotencyKey: string, principal: ClientPrincipal): Promise<ReserveOutcome> {
    const pkey = this.principalKey(principal)
    const digest = HostCapacityAuthority.digestOf(req.request)
    // RESOURCE_DOUBLE_ACQUIRE=0：同 (run_id, cell_id) 已有 active claim →
    // 拒绝（scheduler claim + broker second claim 双记账场景由 authority 端
    // 去重保证，不依赖调用方正确性）。
    const existing = this.db.query(`SELECT claim_id FROM claims WHERE run_id=? AND cell_id=? AND phase NOT IN ('RELEASED')`).get(req.runId, req.cellId) as { claim_id: string } | null
    if (existing && existing.claim_id !== (this.db.query(`SELECT claim_id FROM authority_idempotency WHERE method='reserve' AND principal=? AND idempotency_key=?`).get(pkey, idempotencyKey) as { claim_id?: string } | null)?.claim_id) {
      return { ok: false, reason: "RESOURCE_DOUBLE_ACQUIRE: active claim already exists for this run/cell" }
    }
    const hit = this.db.query(`SELECT claim_id, request_digest FROM authority_idempotency WHERE method='reserve' AND principal=? AND idempotency_key=?`).get(pkey, idempotencyKey) as { claim_id: string; request_digest: string } | null
    if (hit) {
      if (hit.request_digest !== digest) {
        return { ok: false, reason: "IDEMPOTENCY_MISMATCH: same idempotency key with different ResourceRequest" }
      }
      // token rekey：原子轮换新 token（同 claim，不创建第二 claim）。
      return this.db.transaction(() => {
        const row = this.db.query(`SELECT * FROM claims WHERE claim_id=?`).get(hit.claim_id) as ClaimRow | null
        if (!row) return { ok: false, reason: "IDEMPOTENT_CLAIM_LOST" } as ReserveOutcome
        const newToken = `tok_${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "")}`
        this.db.query(`UPDATE claims SET owner_token_hash=?, updated_at=? WHERE claim_id=?`).run(HostCapacityAuthority.tokenHash(newToken), Date.now(), hit.claim_id)
        this.tokens.set(hit.claim_id, newToken)
        return { ok: true, claimId: hit.claim_id, ownerToken: newToken } as ReserveOutcome
      })()
    }
    // 容量检查（原子：全满足才授予）。
    const avail = this.available()
    const over: string[] = []
    if (req.request.cpuQuota > avail.cpuQuota) over.push("cpu")
    if (req.request.memoryBytes > avail.memoryBytes) over.push("memory")
    if (req.request.pids > avail.pids) over.push("pids")
    if (req.request.networkSlots > avail.networkSlots) over.push("network")
    if (req.request.tempBytes > avail.tempBytes) over.push("temp")
    const active = this.db.query(`SELECT COUNT(*) AS n FROM claims WHERE phase NOT IN ('RELEASED')`).get() as { n: number }
    if (active.n >= this.maxConcurrentCells) over.push("cells")
    if (over.length > 0) {
      return { ok: false, reason: `insufficient resources: ${over.join(", ")}` }
    }
    const claimId = `claim_${randomUUID().replace(/-/g, "")}`
    const ownerToken = `tok_${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "")}`
    const now = Date.now()
    this.db.transaction(() => {
      this.db.query(`INSERT INTO claims (claim_id, run_id, cell_id, agent_id, backend_id, phase, requested_json, owner_token_hash, principal, client_instance_id, idempotency_key, request_digest, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        claimId, req.runId, req.cellId, req.agentId ?? null, req.backendId ?? null, "RESERVED",
        JSON.stringify(req.request), HostCapacityAuthority.tokenHash(ownerToken), pkey, principal.clientInstanceId,
        idempotencyKey, digest, now, now,
      )
      this.db.query(`INSERT INTO authority_idempotency (method, principal, idempotency_key, request_digest, claim_id, created_at) VALUES ('reserve',?,?,?,?,?)`).run(pkey, idempotencyKey, digest, claimId, now)
    })()
    this.tokens.set(claimId, ownerToken)
    return { ok: true, claimId, ownerToken }
  }

  /** 同 (run_id, cell_id) 有 active claim → 拒绝（RESOURCE_DOUBLE_ACQUIRE=0）。 */
  hasActiveClaimFor(runId: string, cellId: string): boolean {
    const row = this.db.query(`SELECT claim_id FROM claims WHERE run_id=? AND cell_id=? AND phase NOT IN ('RELEASED')`).get(runId, cellId) as { claim_id: string } | null
    return row !== null
  }

  /** releaseRequested：token 只授权"请求释放"，free 由 server 独立 reality 决定。 */
  async releaseRequested(claimId: string, ownerToken: string): Promise<{ state: ReleaseRequestState; phase: ClaimPhase }> {
    const row = this.db.query(`SELECT * FROM claims WHERE claim_id=?`).get(claimId) as ClaimRow | null
    if (!row) return { state: "REJECTED", phase: "RELEASED" }
    if (row.owner_token_hash !== HostCapacityAuthority.tokenHash(ownerToken)) {
      return { state: "REJECTED", phase: row.phase as ClaimPhase }
    }
    const claim = this.view(row)
    // 无 spawn identity 且 phase 未越过 SPAWN_ATTEMPTING → durable phase 证明
    // spawn 未发生（RESERVED/PRE_SPAWN 无进程现实）。
    if (!claim.spawnedPid && (claim.phase === "RESERVED" || claim.phase === "PRE_SPAWN")) {
      return this.settle(claimId, "RELEASED")
    }
    if (!claim.spawnedPid && (claim.phase === "SPAWN_ATTEMPTING" || claim.phase === "SPAWN_IDENTITY_COMMITTED")) {
      // 无 durable PID 可验证 → 不确定 → SUSPECT（不 free）。
      return this.settle(claimId, "SUSPECT")
    }
    const reality = await this.reality(claim)
    if (reality.state === "proven") {
      return this.settle(claimId, "RELEASED")
    }
    if (reality.state === "live") {
      // REVERSE_GHOST：resource 仍活着 → QUARANTINED（容量保持 charged）。
      return this.settle(claimId, "QUARANTINED")
    }
    return this.settle(claimId, "SUSPECT")
  }

  private settle(claimId: string, to: "RELEASED" | "QUARANTINED" | "SUSPECT"): { state: ReleaseRequestState; phase: ClaimPhase } {
    this.db.query(`UPDATE claims SET phase=?, updated_at=? WHERE claim_id=?`).run(to, Date.now(), claimId)
    if (to === "RELEASED") this.tokens.delete(claimId)
    const state: ReleaseRequestState = to === "RELEASED" ? "RELEASED" : to === "QUARANTINED" ? "QUARANTINED" : "SUSPECT"
    return { state, phase: to }
  }

  /** phase 上报（client；TERMINATION_PROVEN/RELEASED 禁止 —— 只有 server reality 设置）。 */
  async updatePhase(claimId: string, ownerToken: string, phase: Exclude<ClaimPhase, "TERMINATION_PROVEN" | "RELEASED">, spawn?: { pid: number; startticks: number; cgroupPath?: string }): Promise<void> {
    const row = this.db.query(`SELECT * FROM claims WHERE claim_id=?`).get(claimId) as ClaimRow | null
    if (!row) throw new Error("CLAIM_NOT_FOUND")
    if (row.owner_token_hash !== HostCapacityAuthority.tokenHash(ownerToken)) throw new Error("CLAIM_TOKEN_MISMATCH")
    this.db.query(`UPDATE claims SET phase=?, spawned_pid=COALESCE(?, spawned_pid), spawn_startticks=COALESCE(?, spawn_startticks), cgroup_path=COALESCE(?, cgroup_path), updated_at=? WHERE claim_id=?`)
      .run(phase, spawn?.pid ?? null, spawn?.startticks ?? null, spawn?.cgroupPath ?? null, Date.now(), claimId)
  }

  /** 内部 quarantine（server 内部调用；不经 IPC）。 */
  quarantine(claimId: string): void {
    this.db.query(`UPDATE claims SET phase='QUARANTINED', updated_at=? WHERE claim_id=?`).run(Date.now(), claimId)
  }

  /** 内部 transfer/adopt（server/recovery 内部；不经 IPC —— CLIENT_FORGED_CLAIM_TRANSFER=0）。 */
  adopt(claimId: string, targetRunId: string, targetCellId: string): void {
    this.db.query(`UPDATE claims SET run_id=?, cell_id=?, updated_at=? WHERE claim_id=?`).run(targetRunId, targetCellId, Date.now(), claimId)
  }

  /** reconcile：server 自读 OS reality（client 仅 trigger）。 */
  async reconcile(_principal: ClientPrincipal): Promise<{ freed: number; remainingCharged: number }> {
    const rows = this.db.query(`SELECT * FROM claims WHERE phase IN ('QUARANTINED','SUSPECT','EXECUTING','SPAWN_ATTEMPTING','SPAWN_IDENTITY_COMMITTED')`).all() as ClaimRow[]
    let freed = 0
    for (const row of rows) {
      const claim = this.view(row)
      const reality = await this.reality(claim)
      if (reality.state === "proven") {
        this.db.query(`UPDATE claims SET phase='RELEASED', updated_at=? WHERE claim_id=?`).run(Date.now(), claim.claimId)
        this.tokens.delete(claim.claimId)
        freed += 1
      } else if (reality.state === "live") {
        this.db.query(`UPDATE claims SET phase='QUARANTINED', updated_at=? WHERE claim_id=?`).run(Date.now(), claim.claimId)
      } else {
        this.db.query(`UPDATE claims SET phase='SUSPECT', updated_at=? WHERE claim_id=?`).run(Date.now(), claim.claimId)
      }
    }
    const charged = this.db.query(`SELECT COUNT(*) AS n FROM claims WHERE phase NOT IN ('RELEASED')`).get() as { n: number }
    return { freed, remainingCharged: charged.n }
  }

  async status(_principal: ClientPrincipal): Promise<CapacityStatusView> {
    const rows = this.db.query(`SELECT * FROM claims`).all() as ClaimRow[]
    return {
      capacity: { ...this.capacity, concurrentCells: this.maxConcurrentCells },
      available: this.available(),
      charged: rows.filter(r => r.phase !== "RELEASED").length,
      claims: rows.map(r => this.view(r)),
    }
  }

  async close(): Promise<void> {
    this.db.close()
    this.tokens.clear()
  }
}

export function createHostCapacityAuthority(config: HostCapacityConfig): HostCapacityAuthority {
  return new HostCapacityAuthority(config)
}

// ── client 侧：Unix IPC adapter（external trusted runtime）──

export interface CapacityRpcTransport {
  request(method: string, payload: unknown, idempotencyKey: string): Promise<unknown>
  close(): Promise<void>
}

const EXECD_SOCKET_DEFAULT = () => join(process.env.XDG_RUNTIME_DIR ?? "/run/user/0", "orcana", "execd.sock")

/** 校验 authority socket 的创建者属于 orcana-execd 服务（R73：
 *  FAKE_EXECD_SOCKET_AUTHORITY_BYPASS=0）。扫描 /proc/PID/fd（每进程 fd 目录）
 *  找持有该 socket inode 的进程，读其 cgroup 断言含 orcana-execd。 */
export function verifyAuthoritySocket(sockPath: string): { ok: boolean; reason?: string } {
  let inode: number | undefined
  try {
    inode = statSync(sockPath).ino
  } catch {
    return { ok: false, reason: `socket not found: ${sockPath}` }
  }
  const procs = readdirSync("/proc").filter(p => /^\d+$/.test(p))
  for (const p of procs) {
    const fdDir = `/proc/${p}/fd`
    let entries: string[]
    try {
      entries = readdirSync(fdDir)
    } catch {
      continue // 权限/竞态
    }
    for (const fd of entries) {
      try {
        if (statSync(`${fdDir}/${fd}`).ino === inode) {
          try {
            const cgroup = readFileSync(`/proc/${p}/cgroup`, "utf8")
            if (cgroup.includes("orcana-execd")) {
              return { ok: true }
            }
            return { ok: false, reason: `socket owner pid ${p} is not in orcana-execd service cgroup` }
          } catch {
            continue
          }
        }
      } catch {
        continue
      }
    }
  }
  return { ok: false, reason: "no process holds the authority socket inode" }
}

/** 基于 Unix socket 的 CapacityClient：连接 execd → capacity.* 消息。 */
export class CapacityClient implements CapacityAuthority {
  private transport?: CapacityRpcTransport
  private closed = false
  readonly clientInstanceId: string

  constructor(private readonly options: { sockPath?: string; transport?: CapacityRpcTransport; clientInstanceId?: string } = {}) {
    this.clientInstanceId = options.clientInstanceId ?? `cli_${randomUUID().replace(/-/g, "").slice(0, 12)}`
    if (options.transport) this.transport = options.transport
  }

  private async connect(): Promise<CapacityRpcTransport> {
    if (this.transport) return this.transport
    const sockPath = this.options.sockPath ?? EXECD_SOCKET_DEFAULT()
    const verified = verifyAuthoritySocket(sockPath)
    if (!verified.ok) {
      throw new Error(`CAPACITY_AUTHORITY_SOCKET_REJECTED: ${verified.reason}`)
    }
    const { connectCapacitySocket } = await import("./capacity-socket")
    this.transport = await connectCapacitySocket(sockPath)
    return this.transport
  }

  private principal(): ClientPrincipal {
    return {
      uid: process.getuid?.() ?? -1,
      pid: process.pid,
      startticks: readProcessStartticks(process.pid) ?? 0,
      clientInstanceId: this.clientInstanceId,
    }
  }

  async reserve(req: CapacityReserveRequest, idempotencyKey: string, _principal: ClientPrincipal): Promise<ReserveOutcome> {
    const transport = await this.connect()
    const result = (await transport.request("CapacityReserve", { ...req, clientInstanceId: this.clientInstanceId }, idempotencyKey)) as ReserveOutcome
    return result
  }

  async releaseRequested(claimId: string, ownerToken: string): Promise<{ state: ReleaseRequestState; phase: ClaimPhase }> {
    const transport = await this.connect()
    return (await transport.request("CapacityReleaseRequest", { claimId, ownerToken, clientInstanceId: this.clientInstanceId }, `rel-${claimId}`)) as { state: ReleaseRequestState; phase: ClaimPhase }
  }

  async updatePhase(claimId: string, ownerToken: string, phase: Exclude<ClaimPhase, "TERMINATION_PROVEN" | "RELEASED">, spawn?: { pid: number; startticks: number; cgroupPath?: string }): Promise<void> {
    const transport = await this.connect()
    await transport.request("CapacityPhase", { claimId, ownerToken, phase, spawn, clientInstanceId: this.clientInstanceId }, `ph-${claimId}-${phase}`)
  }

  async reconcile(_principal: ClientPrincipal): Promise<{ freed: number; remainingCharged: number }> {
    const transport = await this.connect()
    return (await transport.request("CapacityReconcile", { clientInstanceId: this.clientInstanceId }, `rec-${Date.now()}`)) as { freed: number; remainingCharged: number }
  }

  async status(_principal: ClientPrincipal): Promise<CapacityStatusView> {
    const transport = await this.connect()
    return (await transport.request("CapacityStatus", { clientInstanceId: this.clientInstanceId }, `st-${Date.now()}`)) as CapacityStatusView
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.transport?.close()
  }
}
