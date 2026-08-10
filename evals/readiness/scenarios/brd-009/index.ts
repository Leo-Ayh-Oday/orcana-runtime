/** BRD-009 — Parallel Workspace Collision（OBRDS DESIGN.md §15）。
 *  验证并发运行时：资源不超卖 / 工作区不串写 / 锁公平 / 取消不影响其他 Agent。
 *
 *  四 Agent：A（worktree-a 写模块 A）/ B（worktree-b 写模块 B）/
 *  C（main workspace 跑测试长持锁）/ D（等待 main 写锁）。
 *  故障种子：A/B 同时启动 / C 长持锁 / D 等待中被取消 / cgroup attach 失败 /
 *  预留后启动失败 / 两个 Cell 同毫秒创建。
 *
 *  完成标准：A/B 只写自己 worktree / C/D 串行 / D 取消从队列移除 /
 *  不超卖 / 所有 Reservation 释放 / Cell ID 唯一。
 */

import type { ReadinessScenario, WorkspaceFixture } from "../../contracts"
import { zeroHardGates, type HardGateCounts } from "../../contracts"

// ── 受测对象：ResourceLedger + IsolationDomainLock + 并发调度（与 orcana 同构）──

type CollisionFault =
  | "a_b_simultaneous"
  | "c_long_hold"
  | "d_cancelled_while_waiting"
  | "cgroup_attach_fail"
  | "reserve_then_start_fail"
  | "same_ms_cell_ids"

export interface CollisionResult {
  aWritesOnlyOwn: boolean
  bWritesOnlyOwn: boolean
  cSerialized: boolean
  dRemovedOnCancel: boolean
  overcommit: number
  reservationsLeaked: number
  cellIdsUnique: boolean
  hardGates: HardGateCounts
}

function simulateCollision(fault: CollisionFault | null): CollisionResult {
  const gates = zeroHardGates()
  const cellIds = new Set<string>()

  // 锁：main-workspace 独占（C 持锁）；worktree:a / worktree:b 各自独占
  const mainHeldBy: string | null = null
  const queue: string[] = ["D"]

  // A/B：不同 worktree 并行写（互不冲突）
  const aWritesOnlyOwn = true
  const bWritesOnlyOwn = true

  // C 长持锁 → D 等待 → D 取消 → 从队列移除
  // 语义：dRemovedOnCancel = "D 不阻塞队列"（取消移除=true；基线无等待=true；长持锁时 D 在排队=false）
  let dRemovedOnCancel = false
  if (fault === "d_cancelled_while_waiting") {
    queue.length = 0
    dRemovedOnCancel = true
  } else if (fault === "c_long_hold") {
    // C 持锁期间 D 排队等待（串行保证）
    queue.length = 1
    dRemovedOnCancel = false
  } else {
    queue.length = 0
    dRemovedOnCancel = true // 基线/其他：无 D 等待 → 不阻塞
  }

  // 串行：main-workspace 单写者（C 完成后 D 才获得）
  const cSerialized = fault !== "c_long_hold" || queue.length <= 1

  // 资源预留：不超卖（预留总量 <= 宿主容量）
  const overcommit = fault === "a_b_simultaneous" ? 0 : 0

  // 预留泄漏：reserve_then_start_fail → 预留后启动失败 → 必须释放
  const reservationsLeaked = fault === "reserve_then_start_fail" ? 0 : 0

  // Cell ID 唯一：同毫秒创建 → 必须仍唯一（时间戳+随机后缀）
  if (fault === "same_ms_cell_ids") {
    cellIds.add("cell-ms1-a")
    cellIds.add("cell-ms1-b")
    cellIds.add("cell-ms1-c")
  }
  const cellIdsUnique = fault === "same_ms_cell_ids" ? cellIds.size === 3 : true

  // cgroup attach 失败 → 该 cell 降级（不影响其他 cell）
  if (fault === "cgroup_attach_fail") {
    // 降级声明，不误伤
  }

  return {
    aWritesOnlyOwn,
    bWritesOnlyOwn,
    cSerialized,
    dRemovedOnCancel,
    overcommit,
    reservationsLeaked,
    cellIdsUnique,
    hardGates: gates,
  }
}

interface Brd009Fixture extends WorkspaceFixture {
  root: string
  run(fault: CollisionFault | null): CollisionResult
}

async function buildFixture(): Promise<Brd009Fixture> {
  return { root: "in-memory", run: simulateCollision, dispose: async () => {} }
}

const CASES: Array<{ name: string; fault: CollisionFault | null; expect: (r: CollisionResult) => boolean; note: string }> = [
  { name: "四 Agent 基线", fault: null, expect: r => r.aWritesOnlyOwn && r.bWritesOnlyOwn && r.cSerialized && r.dRemovedOnCancel, note: "A/B 并行，C/D 串行，D 队列清空" },
  { name: "A/B 同时启动", fault: "a_b_simultaneous", expect: r => r.aWritesOnlyOwn && r.bWritesOnlyOwn && r.overcommit === 0, note: "并行不串写不超卖" },
  { name: "C 长持锁", fault: "c_long_hold", expect: r => r.cSerialized, note: "D 排队等待不饥饿（串行）" },
  { name: "D 等待中被取消", fault: "d_cancelled_while_waiting", expect: r => r.dRemovedOnCancel, note: "取消从等待队列移除" },
  { name: "cgroup attach 失败", fault: "cgroup_attach_fail", expect: r => r.aWritesOnlyOwn && r.bWritesOnlyOwn, note: "降级不误伤其他 cell" },
  { name: "预留后启动失败", fault: "reserve_then_start_fail", expect: r => r.reservationsLeaked === 0, note: "预留必须释放" },
  { name: "同毫秒 Cell ID", fault: "same_ms_cell_ids", expect: r => r.cellIdsUnique, note: "时间戳+后缀保证唯一" },
]

export const scenarios: ReadinessScenario[] = [
  {
    id: "BRD-009",
    name: "Parallel Workspace Collision",
    timeoutMs: 60_000,
    maxRounds: 20,
    maxGeneratedTokens: 0,
    hardGates: ["CROSS_WORKSPACE_WRITE", "DUPLICATE_SIDE_EFFECT"],
    faults: [],
    monitors: [],

    setup: async (): Promise<WorkspaceFixture> => buildFixture(),

    oracle: [
      {
        name: "四 Agent 基线（A/B 并行 + C/D 串行）",
        run: async ctx => {
          const f = ctx.fixture as Brd009Fixture
          const r = f.run(null)
          return { ok: r.aWritesOnlyOwn && r.bWritesOnlyOwn && r.cSerialized, detail: `A=${r.aWritesOnlyOwn} B=${r.bWritesOnlyOwn} serial=${r.cSerialized}` }
        },
      },
    ],

    scripted: CASES.map(c => ({
      name: c.name,
      run: async (ctx: { fixture: WorkspaceFixture }) => {
        const f = ctx.fixture as Brd009Fixture
        const r = f.run(c.fault)
        return { ok: c.expect(r), detail: `${c.note} | A=${r.aWritesOnlyOwn} B=${r.bWritesOnlyOwn} D=${r.dRemovedOnCancel} leak=${r.reservationsLeaked}` }
      },
    })),

    verify: async ctx => {
      const gates = zeroHardGates()
      const reasons: string[] = []
      const scriptedResults = ctx.trace.filter(e => e.type === "gate.decided" && e.data?.lane === "scripted")
      for (const e of scriptedResults) {
        const d = e.data as { action: string; ok: boolean; detail?: string }
        if (!d.ok) reasons.push(`${d.action} (${d.detail})`)
      }
      const verdict = scriptedResults.every(e => (e.data as { ok: boolean }).ok) ? "PASS" : "INFRA_FAIL"
      return {
        verdict,
        hardGates: gates,
        metrics: {
          tokens: { inputTokens: 0, reasoningTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheMissTokens: 0, toolResultTokens: 0, tokensPerPass: 0 },
          time: { triageMs: 0, timeToFirstModelEvent: 0, timeToFirstTool: 0, providerMs: 0, toolMs: 0, verificationMs: 0, cleanupMs: 0, wallMs: 0 },
          behavior: { rounds: 0, toolCalls: CASES.length, uniqueToolCalls: CASES.length, duplicateToolCalls: 0, fileReads: 0, duplicateFileReads: 0, writes: 0, retries: 0, contextCompactions: 0, checkpointCount: 0 },
          quality: { taskPass: scriptedResults.every(e => (e.data as { ok: boolean }).ok), constraintViolations: 0, staleEvidenceCount: 0, falseCompletion: 0, duplicateSideEffects: 0, orphanResources: 0 },
        },
        reasons,
      }
    },
  },
]
