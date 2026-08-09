/** LR2-1 Gate 验收（L1-H）：7 项 Gate 各一条显式断言。
 *
 *  CLIENT_CRASH_LOSES_CELL                  = 0
 *  DUPLICATE_SUBMIT_STARTS_SECOND_CELL      = 0
 *  UNAUTHENTICATED_LOCAL_CLIENT             = 0
 *  EVENT_SEQUENCE_GAP_UNDETECTED            = 0
 *  NONTERMINAL_CELL_LOST_AFTER_RESTART       = 0
 *  SAME_BOOT_CRASH_UNRECOVERED               = 0
 *  UNKNOWN_SIDE_EFFECT_BLIND_RETRY           = 0
 *
 *  每条 Gate 断言其核心防御行为（详细场景在对应模块测试）。
 */

import { describe, expect, test } from "bun:test"
import net from "node:net"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createExecd, type Execd } from "../../src/execd/execd"
import { ExecdServer } from "../../src/execd/server"
import { fixedApprovalTokenProvider } from "../../src/execd/approval"
import { StateStore } from "../../src/execd/state/store"
import { Recovery } from "../../src/execd/recovery"
import { FrameCodec, encodeFrame } from "../../src/execd/protocol/frame"
import { PROTOCOL_VERSION } from "../../src/execd/protocol/messages"

function connect(sockPath: string): { socket: net.Socket; send: (m: unknown) => void; next: () => Promise<unknown> } {
  const codec = new FrameCodec()
  const queue: unknown[] = []
  const waiters: Array<(item: unknown) => void> = []
  const socket = net.createConnection(sockPath)
  socket.on("data", chunk => {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk
    for (const frame of codec.feed(buf)) {
      const data = JSON.parse(frame.payload)
      const w = waiters.shift()
      if (w) w(data)
      else queue.push(data)
    }
  })
  return {
    socket,
    send(m) { socket.write(encodeFrame(JSON.stringify(m))) },
    next() {
      if (queue.length > 0) return Promise.resolve(queue.shift())
      return new Promise(resolve => waiters.push(resolve))
    },
  }
}

function req(method: string, payload?: unknown, idempotencyKey = `g-${Math.random().toString(36).slice(2, 8)}`): Record<string, unknown> {
  return {
    protocolVersion: PROTOCOL_VERSION,
    requestId: `g-${Date.now().toString(36)}`,
    idempotencyKey,
    sessionId: "gates",
    sequence: 1,
    method,
    approvalToken: GATES_TOKEN,
    ...(payload !== undefined ? { payload } : {}),
  }
}

const GATES_TOKEN = "gates-test-token"

async function setup(): Promise<{ execd: Execd; sockPath: string; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), "execd-gates-"))
  const sockPath = join(dir, "execd.sock")
  // workspace 根必须存在（编译校验 cwd 在 workspace 内）。
  mkdirSync(join(dir, "ws"), { recursive: true })
  const execd = createExecd({
    sockPath,
    statePath: join(dir, "execd.db"),
    workspaceHostRoot: join(dir, "ws"),
    approval: fixedApprovalTokenProvider([GATES_TOKEN]),
  })
  await execd.start()
  return { execd, sockPath, dir }
}

async function waitState(execd: Execd, cellId: string, timeoutMs = 8000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const cell = execd.state.getCell(cellId)
    if (cell && ["CLEANED", "CANCELLED", "START_FAILED", "REJECTED_POLICY", "LOST"].includes(cell.currentState)) return cell.currentState
    if (Date.now() > deadline) throw new Error(`not terminal: ${execd.state.getCell(cellId)?.currentState}`)
    await new Promise(r => setTimeout(r, 50))
  }
}

describe("LR2-1 Gates (L1-H)", () => {
  test("CLIENT_CRASH_LOSES_CELL = 0: cell survives client disconnect", async () => {
    const { execd, sockPath, dir } = await setup()
    try {
      const c = connect(sockPath)
      c.send(req("SubmitCell", { capabilityId: "run_process", executable: "/bin/true", args: [], workloadKind: "build", readonly: false }))
      const cellId = (await c.next() as { result: { cellId: string } }).result.cellId
      c.socket.destroy() // 客户端崩溃
      expect(await waitState(execd, cellId)).toBe("CLEANED") // Cell 完成不受影响
    } finally {
      await execd.stop(); rmSync(dir, { recursive: true, force: true })
    }
  })

  test("DUPLICATE_SUBMIT_STARTS_SECOND_CELL = 0: same idempotency key → one cell", async () => {
    const { execd, sockPath, dir } = await setup()
    try {
      const c = connect(sockPath)
      const ik = `ik-${Date.now().toString(36)}`
      c.send(req("SubmitCell", { capabilityId: "run_process", executable: "/bin/true", args: [], workloadKind: "build", readonly: false }, ik))
      const first = (await c.next() as { result: { cellId: string; idempotent: boolean } }).result
      c.send(req("SubmitCell", { capabilityId: "run_process", executable: "/bin/true", args: [], workloadKind: "build", readonly: false }, ik))
      const second = (await c.next() as { result: { cellId: string; idempotent: boolean } }).result
      expect(second.idempotent).toBe(true)
      expect(second.cellId).toBe(first.cellId)
      // 只落库一个 cell（同 cellId 的 receipts 唯一）
      const cells = execd.state.db.query("SELECT cell_id FROM cells WHERE cell_id = ?").all(first.cellId)
      expect(cells).toHaveLength(1)
      c.socket.destroy()
    } finally {
      await execd.stop(); rmSync(dir, { recursive: true, force: true })
    }
  })

  test("UNAUTHENTICATED_LOCAL_CLIENT = 0: foreign uid is rejected before any request", async () => {
    const dir = mkdtempSync(join(tmpdir(), "execd-gates-"))
    const sockPath = join(dir, "execd.sock")
    const state = new StateStore(join(dir, "execd.db"))
    const foreign: ExecdServerDepsStub = { sockPath }
    const server = new ExecdServer(
      { sockPath, state, submitCell: async () => ({ cellId: "x", runId: "r", idempotent: false }), getCell: () => undefined, cancelCell: async () => {}, cancelAgent: async () => {}, cancelRun: async () => {}, cleanupRun: async () => ({ removed: 0 }), acquireLease: async (r, t) => ({ leaseId: "L", expiresAt: t }), renewLease: async () => ({ expiresAt: 0 }), releaseLease: async () => {}, listRecoverableRuns: () => [], attachLogs: () => ({ cellId: "", kind: "stdout", data: "", totalBytes: 0, eof: true }) },
      undefined, undefined,
      fixedApprovalTokenProvider(["test-token"]),
      () => ({ pid: 1, uid: 65534, gid: 65534 }), // nobody —— 异 uid
    )
    try {
      await server.start()
      const c = connect(sockPath)
      const closed = new Promise<void>(resolve => c.socket.on("close", () => resolve()))
      c.send(req("Hello"))
      const resp = await c.next()
      expect((resp as { error: { code: string } }).error.code).toBe("EXECD_UNAUTHENTICATED")
      await closed
    } finally {
      await server.stop(); state.close(); rmSync(dir, { recursive: true, force: true })
    }
  })

  test("EVENT_SEQUENCE_GAP_UNDETECTED = 0: resume from sequence replays all events", async () => {
    const { execd, sockPath, dir } = await setup()
    try {
      const c = connect(sockPath)
      c.send(req("SubmitCell", { capabilityId: "run_process", executable: "/bin/true", args: [], workloadKind: "build", readonly: false }))
      const cellId = (await c.next() as { result: { cellId: string } }).result.cellId
      await waitState(execd, cellId)
      // 断线后重连：从 0 续读 → 事件序号必须连续无缺口
      const c2 = connect(sockPath)
      c2.send(req("WatchCell", { cellId, sinceSequence: 0 }))
      await c2.next() // ok
      const seen: number[] = []
      const deadline = Date.now() + 3000
      while (Date.now() < deadline) {
        const item = await c2.next()
        if ((item as { type: string }).type === "event") seen.push((item as { eventSequence: number }).eventSequence)
        if (seen.length >= 7) break // ACCEPTED→POLICY_COMPILED→RUNNING→EXIT_OBSERVED→RECEIPT_COMMITTED→EVIDENCE_BOUND→CLEANED
      }
      // 无缺口：序号连续且单调
      for (let i = 1; i < seen.length; i++) {
        expect(seen[i]!).toBe(seen[i - 1]! + 1)
      }
      expect(seen.length).toBeGreaterThanOrEqual(7)
      c.socket.destroy(); c2.socket.destroy()
    } finally {
      await execd.stop(); rmSync(dir, { recursive: true, force: true })
    }
  })

  test("NONTERMINAL_CELL_LOST_AFTER_RESTART = 0: restart converges all residues", async () => {
    const dir = mkdtempSync(join(tmpdir(), "execd-gates-"))
    const sockPath = join(dir, "execd.sock")
    const statePath = join(dir, "execd.db")
    try {
      const execd1 = createExecd({ sockPath, statePath, workspaceHostRoot: join(dir, "ws"), approval: fixedApprovalTokenProvider([GATES_TOKEN]) })
      await execd1.start()
      // 模拟崩溃：直接注入 RUNNING 残留（绕过优雅关闭 —— 优雅关闭会
      // 取消在途 cell，注入的残留不在跟踪集合内）。
      execd1.state.upsertCell({
        cellId: "crash-cell", runId: "crash-run", nodeRunId: "crash-run:n", attempt: 1,
        capabilityId: "run_process", executable: "/bin/true", argsJson: "[]",
        currentState: "RUNNING", createdAt: Date.now(), updatedAt: Date.now(),
      })
      await execd1.stop()

      // 重启：Recovery 收敛残留 → LOST；无任何非终态残留。
      const execd2 = createExecd({ sockPath, statePath, workspaceHostRoot: join(dir, "ws"), approval: fixedApprovalTokenProvider([GATES_TOKEN]) })
      await execd2.start()
      try {
        expect(execd2.state.getCell("crash-cell")!.currentState).toBe("LOST")
        expect(execd2.state.listNonTerminalCells()).toHaveLength(0)
      } finally {
        await execd2.stop()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("SAME_BOOT_CRASH_UNRECOVERED = 0: recovery runs on every startup", async () => {
    const dir = mkdtempSync(join(tmpdir(), "execd-gates-"))
    const state = new StateStore(join(dir, "execd.db"))
    try {
      // 第一次启动残留（RUNNING × 2）→ 一次恢复全部收敛
      for (const id of ["c1", "c2"]) {
        state.upsertCell({ cellId: id, runId: "r", nodeRunId: "r:n", attempt: 1, capabilityId: "c", executable: "/bin/true", argsJson: "[]", currentState: "RUNNING", createdAt: 1, updatedAt: 2 })
      }
      const rec1 = new Recovery({ state, publish: () => {} })
      rec1.run()
      expect(state.listNonTerminalCells()).toHaveLength(0)
      expect(state.getCell("c1")!.currentState).toBe("LOST")
      expect(state.getCell("c2")!.currentState).toBe("LOST")
      // 同 boot 内第二次崩溃又留下新残留 → 下次启动的恢复同样收敛
      state.upsertCell({ cellId: "c3", runId: "r", nodeRunId: "r:n", attempt: 1, capabilityId: "c", executable: "/bin/true", argsJson: "[]", currentState: "RUNNING", createdAt: 3, updatedAt: 4 })
      const rec2 = new Recovery({ state, publish: () => {} })
      rec2.run()
      expect(state.listNonTerminalCells()).toHaveLength(0)
      expect(state.getCell("c3")!.currentState).toBe("LOST")
    } finally {
      state.close(); rmSync(dir, { recursive: true, force: true })
    }
  })

  test("UNKNOWN_SIDE_EFFECT_BLIND_RETRY = 0: side-effect-unknown cells are never re-executed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "execd-gates-"))
    const state = new StateStore(join(dir, "execd.db"))
    try {
      state.upsertCell({ cellId: "se", runId: "r", nodeRunId: "r:n", attempt: 1, capabilityId: "c", executable: "/bin/true", argsJson: "[]", currentState: "SIDE_EFFECT_UNKNOWN", createdAt: 1, updatedAt: 2 })
      const recovery = new Recovery({ state, publish: () => {} })
      const report = recovery.run()
      // 终态不触碰（无盲跑）；状态不变
      expect(report.scanned).toBe(0)
      expect(state.getCell("se")!.currentState).toBe("SIDE_EFFECT_UNKNOWN")
    } finally {
      state.close(); rmSync(dir, { recursive: true, force: true })
    }
  })
})

// 测试桩类型（避免重复声明完整 deps）
type ExecdServerDepsStub = { sockPath: string }
