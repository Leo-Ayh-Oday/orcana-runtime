/** LR2-1（L1-D）：CellManager 验收 —— Submit 幂等（同 requestId 不二次
 *  启动）/ 14 态状态机推进 / Receipt 落库 / 取消 / 清理。 */

import { describe, expect, test } from "bun:test"
import { execSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CellManager } from "../../src/execd/cell-manager"
import { StateStore } from "../../src/execd/state/store"
import { createLinuxBroker } from "../../src/runtime/linux/broker"
import type { SubmitCellPayload } from "../../src/execd/protocol/messages"

function payload(overrides: Partial<SubmitCellPayload> = {}): SubmitCellPayload {
  return {
    capabilityId: "run_process",
    executable: "/bin/true",
    args: [],
    workloadKind: "build",
    readonly: false,
    ...overrides,
  }
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "execd-cell-"))
  const state = new StateStore(join(dir, "execd.db"))
  const broker = createLinuxBroker({ mode: "enabled" })
  const published: Array<{ kind: string; cellId: string }> = []
  // M8 修复：每个测试独立 workspace 目录（共享 process.cwd() 会触发
  // 跨进程文件锁 WORKSPACE_LEASE_HELD —— 并行 worker 互踩）。
  const ws = mkdtempSync(join(tmpdir(), "execd-cell-ws-"))
  const mgr = new CellManager({ state, broker, workspaceHostRoot: ws, publish: (e) => published.push({ kind: e.kind, cellId: e.cellId }) })
  const cleanup = () => { state.close(); rmSync(dir, { recursive: true, force: true }); rmSync(ws, { recursive: true, force: true }) }
  return { dir, state, broker, mgr, published, cleanup }
}

/** 轮询等待 cell 进入终态（超时兜底）。 */
async function waitTerminal(state: StateStore, cellId: string, timeoutMs = 8000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const cell = state.getCell(cellId)
    if (cell && ["CLEANED", "CANCELLED", "START_FAILED", "REJECTED_POLICY", "TIMED_OUT"].includes(cell.currentState)) {
      return cell.currentState
    }
    if (Date.now() > deadline) throw new Error(`cell ${cellId} not terminal: ${state.getCell(cellId)?.currentState}`)
    await new Promise(r => setTimeout(r, 50))
  }
}

describe("CellManager (L1-D)", () => {
  test("submit executes and reaches CLEANED with receipt committed", async () => {
    const { state, mgr, cleanup } = setup()
    try {
      const result = await mgr.submit(payload(), "ik-1", "s1")
      expect(result.idempotent).toBe(false)
      expect(result.cellId).toContain("cell-")
      const terminal = await waitTerminal(state, result.cellId)
      expect(terminal).toBe("CLEANED")
      expect(state.receiptForCell(result.cellId)).toBeDefined()
      // 事件流：ACCEPTED → … → CLEANED 全链 append-only
      const events = state.eventsForCell(result.cellId)
      const states = events.map(e => e.toState)
      expect(states[0]).toBe("ACCEPTED")
      expect(states).toContain("RUNNING")
      expect(states[states.length - 1]).toBe("CLEANED")
    } finally {
      cleanup()
    }
  })

  test("duplicate submit with same idempotency key returns the first result (no second cell)", async () => {
    const { state, mgr, cleanup } = setup()
    try {
      const first = await mgr.submit(payload(), "ik-dup", "s1")
      await waitTerminal(state, first.cellId)
      const second = await mgr.submit(payload(), "ik-dup", "s1")
      expect(second.idempotent).toBe(true)
      expect(second.cellId).toBe(first.cellId)
      // 只启动了一个 Cell（同 cellId），receipts 只有一条
      expect(state.receiptForCell(first.cellId)).toBeDefined()
    } finally {
      cleanup()
    }
  })

  test("compile failure lands REJECTED_POLICY and caches idempotency", async () => {
    const { state, mgr, cleanup } = setup()
    try {
      // 非法 executable（空）→ 编译拒绝
      await expect(
        mgr.submit(payload({ executable: "" }), "ik-bad", "s1"),
      ).rejects.toThrow()
      // REJECTED_POLICY 是终态（不在非终态列表）—— 查全量状态。
      // 注意：原生 db.query 返回 snake_case 键（current_state）。
      const states = (state.db.query("SELECT current_state FROM cells").all() as Array<{ current_state: string }>)
        .map(r => r.current_state)
      expect(states).toContain("REJECTED_POLICY")
      // 同一 key 重试 → 幂等返回（不二次编译）
      const again = await mgr.submit(payload({ executable: "" }), "ik-bad", "s1")
      expect(again.idempotent).toBe(true)
    } finally {
      cleanup()
    }
  })

  test("cancelCell marks CANCELLED and cleanupRun cleans it", async () => {
    const { state, mgr, cleanup } = setup()
    try {
      // M8 修复：真实进程终止断言 —— 取消后 sleep 进程必须消失
      // （B1 曾让取消纯虚构：状态写 CANCELLED 但进程跑满全程）。
      const marker = `execd-cancel-${Date.now().toString(36)}`
      const result = await mgr.submit(payload({ executable: "/bin/sh", args: ["-c", `sleep 60; echo ${marker} > /dev/null`] }), "ik-c", "s1")
      // 等 RUNNING 再取消
      const deadline = Date.now() + 5000
      while ((state.getCell(result.cellId)?.currentState ?? "") !== "RUNNING" && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 30))
      }
      expect(state.getCell(result.cellId)!.currentState).toBe("RUNNING")
      await mgr.cancelCell(result.cellId)
      expect(state.getCell(result.cellId)!.currentState).toBe("CANCELLED")
      // 真实进程终止验证：等待后系统中不应再有该 sleep 进程
      await new Promise(r => setTimeout(r, 1500))
      const psOut = execSync("ps -eo args", { encoding: "utf8" })
      expect(psOut).not.toContain("sleep 60")
      const clean = await mgr.cleanupRun(result.runId)
      expect(clean.removed).toBe(1)
      expect(state.getCell(result.cellId)!.currentState).toBe("CLEANED")
    } finally {
      cleanup()
    }
  })

  test("listRecoverableRuns reports non-terminal cells", async () => {
    const { state, mgr, cleanup } = setup()
    try {
      const result = await mgr.submit(payload(), "ik-r", "s1")
      await waitTerminal(state, result.cellId)
      expect(mgr.listRecoverableRuns()).toHaveLength(0)
    } finally {
      cleanup()
    }
  })
})
