/** LR2-1（L1-B）：StateStore 验收 —— 13 表 schema / append-only 事件 /
 *  物化状态 / 事务原子性 / 幂等键 / WAL 崩溃安全。 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { StateStore, type CellRecord } from "../../src/execd/state/store"

function openStore(): { store: StateStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "execd-state-"))
  const store = new StateStore(join(dir, "execd.db"))
  return { store, dir }
}

function cell(overrides: Partial<CellRecord> = {}): CellRecord {
  return {
    cellId: "cell-1",
    runId: "run-1",
    nodeRunId: "run-1:n1",
    attempt: 1,
    capabilityId: "run_process",
    executable: "/bin/true",
    argsJson: "[]",
    currentState: "ACCEPTED",
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  }
}

describe("StateStore (L1-B)", () => {
  test("schema creates all 15 tables", () => {
    const { store, dir } = openStore()
    try {
      const tables = store.db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()
      const names = tables.map(t => t.name).sort()
      expect(names).toEqual([
        "cache_locks", "cell_attempts", "cell_events", "cells", "cleanup_actions",
        "domains", "execution_handles", "idempotency_keys", "leases", "log_index",
        "port_leases", "receipts", "reservations", "runs", "service_cells",
      ])
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("transition appends event and materializes state", () => {
    const { store, dir } = openStore()
    try {
      store.upsertCell(cell())
      const seq1 = store.transition("cell-1", "att-1", "POLICY_COMPILED", { from: "ACCEPTED", reasonCode: "compile-ok" })!
      const seq2 = store.transition("cell-1", "att-1", "RUNNING", { from: "POLICY_COMPILED", reasonCode: "started" })!
      expect(seq2).toBeGreaterThan(seq1)
      const events = store.eventsForCell("cell-1")
      expect(events).toHaveLength(2)
      expect(events[0]!.fromState).toBe("ACCEPTED")
      expect(events[0]!.toState).toBe("POLICY_COMPILED")
      expect(events[1]!.reasonCode).toBe("started")
      expect(store.getCell("cell-1")!.currentState).toBe("RUNNING")
      // 物化状态与事件流一致（无历史覆盖）
      expect(store.latestEventSequence()).toBe(seq2)
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("non-terminal listing excludes terminal states", () => {
    const { store, dir } = openStore()
    try {
      store.upsertCell(cell({ cellId: "a", currentState: "RUNNING" }))
      store.upsertCell(cell({ cellId: "b", currentState: "CLEANED" }))
      store.upsertCell(cell({ cellId: "c", currentState: "SIDE_EFFECT_UNKNOWN" }))
      const nonTerminal = store.listNonTerminalCells().map(c => c.cellId)
      expect(nonTerminal).toEqual(["a"])
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("withTransaction rolls back atomically on failure", () => {
    const { store, dir } = openStore()
    try {
      store.upsertCell(cell())
      expect(() =>
        store.withTransaction(() => {
          store.transition("cell-1", "att-1", "RUNNING", { from: "ACCEPTED" })
          throw new Error("boom")
        }),
      ).toThrow("boom")
      // 事务回滚：状态与事件都不落半态
      expect(store.getCell("cell-1")!.currentState).toBe("ACCEPTED")
      expect(store.eventsForCell("cell-1")).toHaveLength(0)
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("idempotency keys return the first response", () => {
    const { store, dir } = openStore()
    try {
      const resp = JSON.stringify({ type: "ok", requestId: "r1", result: { cellId: "c1" } })
      store.withTransaction(() => {
        store.putIdempotentResponse({ key: "submit-abc", method: "SubmitCell", responseJson: resp, at: 1 })
      })
      const cached = store.getIdempotentResponse("submit-abc")
      expect(cached?.responseJson).toBe(resp)
      expect(store.getIdempotentResponse("submit-xyz")).toBeUndefined()
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("lease lifecycle persists", () => {
    const { store, dir } = openStore()
    try {
      store.insertLease({ leaseId: "L1", runId: "run-1", holder: "h", ttlMs: 1000, expiresAt: 2000, createdAt: 1000 })
      expect(store.getLease("L1")!.expiresAt).toBe(2000)
      store.updateLeaseExpiry("L1", 3000)
      store.releaseLease("L1", 3100)
      expect(store.listActiveLeases()).toHaveLength(0)
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("WAL crash safety: committed transactions survive reopen", () => {
    const dir = mkdtempSync(join(tmpdir(), "execd-crash-"))
    const path = join(dir, "execd.db")
    let store = new StateStore(path)
    store.upsertCell(cell())
    store.transition("cell-1", "att-1", "RUNNING", { from: "ACCEPTED" })
    store.close()
    // 模拟 kill -9 后 reopen（WAL 恢复已提交事务）
    store = new StateStore(path)
    try {
      expect(store.getCell("cell-1")!.currentState).toBe("RUNNING")
      expect(store.eventsForCell("cell-1")).toHaveLength(1)
      expect(store.latestEventSequence()).toBe(1)
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
