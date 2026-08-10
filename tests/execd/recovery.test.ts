/** LR2-1（L1-F）：Recovery 验收 —— 非终态 Attempt 收敛（kill -9 场景
 *  模拟：手工构造崩溃残留状态）+ 外部副作用不盲跑。 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Recovery } from "../../src/execd/recovery"
import { StateStore, type CellRecord } from "../../src/execd/state/store"

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "execd-rec-"))
  const state = new StateStore(join(dir, "execd.db"))
  const published: string[] = []
  const recovery = new Recovery({ state, publish: (e) => published.push(e.kind) })
  return { dir, state, recovery, published, cleanup: () => { state.close(); rmSync(dir, { recursive: true, force: true }) } }
}

function crashedCell(cellId: string, currentState: CellRecord["currentState"], runId = "run-1"): CellRecord {
  return {
    cellId, runId, nodeRunId: `${runId}:n1`, attempt: 1,
    capabilityId: "run_process", executable: "/bin/true", argsJson: "[]",
    currentState, createdAt: 1000, updatedAt: 1000,
  }
}

describe("Recovery (L1-F)", () => {
  test("RUNNING residue is marked LOST (process untrackable after execd restart)", () => {
    const { state, recovery, cleanup } = setup()
    try {
      state.upsertCell(crashedCell("c-running", "RUNNING"))
      const report = recovery.run()
      expect(report.scanned).toBe(1)
      expect(report.recovered[0]).toMatchObject({ cellId: "c-running", from: "RUNNING", to: "LOST" })
      expect(state.getCell("c-running")!.currentState).toBe("LOST")
    } finally {
      cleanup()
    }
  })

  test("ACCEPTED and POLICY_COMPILED residues converge to LOST", () => {
    const { state, recovery, cleanup } = setup()
    try {
      state.upsertCell(crashedCell("c-a", "ACCEPTED"))
      state.upsertCell(crashedCell("c-p", "POLICY_COMPILED"))
      const report = recovery.run()
      expect(report.scanned).toBe(2)
      expect(report.recovered.map(r => r.to)).toEqual(["LOST", "LOST"])
      expect(state.getCell("c-a")!.currentState).toBe("LOST")
      expect(state.getCell("c-p")!.currentState).toBe("LOST")
    } finally {
      cleanup()
    }
  })

  test("EXIT_OBSERVED without receipt gets a recovery receipt", () => {
    const { state, recovery, cleanup } = setup()
    try {
      state.upsertCell(crashedCell("c-exit", "EXIT_OBSERVED"))
      recovery.run()
      expect(state.getCell("c-exit")!.currentState).toBe("RECEIPT_COMMITTED")
      const receipt = state.receiptForCell("c-exit")
      expect(receipt).toBeDefined()
      const parsed = JSON.parse(receipt!.receiptJson) as { metrics: { status: string }; cleanup: { processesRemaining: number } }
      expect(parsed.metrics.status).toBe("unknown") // 未观测不得假成功
      expect(parsed.cleanup.processesRemaining).toBe(-1)
    } finally {
      cleanup()
    }
  })

  test("CLEANUP_PENDING resumes cleanup to CLEANED", () => {
    const { state, recovery, cleanup } = setup()
    try {
      state.upsertCell(crashedCell("c-cu", "CLEANUP_PENDING"))
      recovery.run()
      expect(state.getCell("c-cu")!.currentState).toBe("CLEANED")
    } finally {
      cleanup()
    }
  })

  test("SIDE_EFFECT_UNKNOWN never blind-retries (UNKNOWN_SIDE_EFFECT_BLIND_RETRY)", () => {
    const { state, recovery, published, cleanup } = setup()
    try {
      state.upsertCell(crashedCell("c-se", "SIDE_EFFECT_UNKNOWN"))
      const report = recovery.run()
      // SIDE_EFFECT_UNKNOWN 是终态（等待 reconcile）—— 恢复扫描不触碰：
      // 不迁移、不重跑、无广播（reconcile 是人工/外部流程）。
      expect(report.scanned).toBe(0)
      expect(state.getCell("c-se")!.currentState).toBe("SIDE_EFFECT_UNKNOWN")
      expect(published).toHaveLength(0)
    } finally {
      cleanup()
    }
  })

  test("same-boot crash: residues converge on every startup (SAME_BOOT_CRASH_UNRECOVERED)", () => {
    const { state, recovery, cleanup } = setup()
    try {
      // 第一次崩溃残留
      state.upsertCell(crashedCell("c1", "RUNNING"))
      recovery.run()
      // 第二次崩溃（同一次开机内）又留下新残留
      state.upsertCell(crashedCell("c2", "RUNNING"))
      const report = recovery.run()
      expect(report.scanned).toBe(1)
      expect(report.recovered[0]!.cellId).toBe("c2")
      // 无任何非终态残留
      expect(state.listNonTerminalCells()).toHaveLength(0)
    } finally {
      cleanup()
    }
  })
})
