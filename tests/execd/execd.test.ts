/** LR2-1（L1-G）：execd 端到端验收 —— createExecd 组装 / 客户端提交 →
 *  事件流 → 终态 / 客户端崩溃后重连续读（CLIENT_CRASH_LOSES_CELL）。 */

import { describe, expect, test } from "bun:test"
import net from "node:net"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createExecd, type Execd } from "../../src/execd/execd"
import { FrameCodec, encodeFrame } from "../../src/execd/protocol/frame"
import { PROTOCOL_VERSION } from "../../src/execd/protocol/messages"

async function setupExecd(): Promise<{ execd: Execd; sockPath: string; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), "execd-e2e-"))
  const sockPath = join(dir, "execd.sock")
  const execd = createExecd({ sockPath, statePath: join(dir, "execd.db"), workspaceHostRoot: process.cwd() })
  await execd.start()
  return { execd, sockPath, dir }
}

function connect(sockPath: string): { socket: net.Socket; codec: FrameCodec; send: (m: unknown) => void; next: () => Promise<unknown> } {
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
    codec,
    send(m) { socket.write(encodeFrame(JSON.stringify(m))) },
    next() {
      if (queue.length > 0) return Promise.resolve(queue.shift())
      return new Promise(resolve => waiters.push(resolve))
    },
  }
}

function req(method: string, payload?: unknown): Record<string, unknown> {
  return {
    protocolVersion: PROTOCOL_VERSION,
    requestId: `e2e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    idempotencyKey: `e2e-ik-${Math.random().toString(36).slice(2, 8)}`,
    sessionId: "e2e",
    sequence: 1,
    method,
    ...(payload !== undefined ? { payload } : {}),
  }
}

async function waitState(execd: Execd, cellId: string, timeoutMs = 8000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const cell = execd.state.getCell(cellId)
    if (cell && ["CLEANED", "CANCELLED", "START_FAILED", "REJECTED_POLICY"].includes(cell.currentState)) return cell.currentState
    if (Date.now() > deadline) throw new Error(`not terminal: ${execd.state.getCell(cellId)?.currentState}`)
    await new Promise(r => setTimeout(r, 50))
  }
}

describe("execd end-to-end (L1-G)", () => {
  test("submit → watch → terminal CLEANED with receipt", async () => {
    const { execd, sockPath, dir } = await setupExecd()
    try {
      const c = connect(sockPath)
      c.send(req("SubmitCell", { capabilityId: "run_process", executable: "/bin/true", args: [], workloadKind: "build", readonly: false }))
      const submitResp = await c.next()
      const cellId = (submitResp as { result: { cellId: string } }).result.cellId
      // WatchCell：订阅后收完整事件流
      c.send(req("WatchCell", { cellId }))
      const watchResp = await c.next()
      expect((watchResp as { result: { resumedFrom: number } }).result.resumedFrom).toBeGreaterThanOrEqual(1)
      const kinds: string[] = []
      const deadline = Date.now() + 8000
      while (kinds[kinds.length - 1] !== "cell.status" || !String(JSON.stringify(kinds.at(-1))).includes("CLEANED")) {
        const item = await c.next()
        const ev = item as { type: string; kind: string }
        if (ev.type === "event") {
          kinds.push(`${ev.kind}:${JSON.stringify((item as { payload?: unknown }).payload ?? "")}`)
          if (JSON.stringify(ev).includes("CLEANED")) break
        }
        if (Date.now() > deadline) break
      }
      expect(JSON.stringify(kinds)).toContain("CLEANED")
      expect(await waitState(execd, cellId)).toBe("CLEANED")
      expect(execd.state.receiptForCell(cellId)).toBeDefined()
      c.socket.destroy()
    } finally {
      await execd.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("client crash does not lose the cell — new client resumes (CLIENT_CRASH_LOSES_CELL)", async () => {
    const { execd, sockPath, dir } = await setupExecd()
    try {
      // 客户端 1：提交后立即"崩溃"（不消费事件、直接断开）。
      const c1 = connect(sockPath)
      c1.send(req("SubmitCell", { capabilityId: "run_process", executable: "/bin/true", args: ["--version"], workloadKind: "build", readonly: false }))
      const submitResp = await c1.next()
      const cellId = (submitResp as { result: { cellId: string } }).result.cellId
      c1.socket.destroy() // 模拟 CLI 崩溃

      // 客户端 2：重连后从当前序号续读 —— Cell 仍在 execd 内运行/已完成。
      await waitState(execd, cellId) // Cell 不因客户端崩溃丢失
      expect(execd.state.getCell(cellId)!.currentState).toBe("CLEANED")
      const c2 = connect(sockPath)
      c2.send(req("WatchCell", { cellId }))
      const resp = await c2.next()
      const resumed = (resp as { result: { resumedFrom: number } }).result.resumedFrom
      expect(resumed).toBeGreaterThanOrEqual(1)
      // 事件流完整无缺口：从 1 到 resumedFrom 全部可读。
      const events = execd.state.eventsForCell(cellId)
      expect(events[events.length - 1]!.eventSequence).toBe(resumed)
      c2.socket.destroy()
    } finally {
      await execd.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("execd restart recovers residues and serves new clients", async () => {
    const dir = mkdtempSync(join(tmpdir(), "execd-e2e-"))
    const sockPath = join(dir, "execd.sock")
    const statePath = join(dir, "execd.db")
    try {
      // 第一次运行：提交一个慢任务后"崩溃"（stop 模拟）。
      const execd1 = createExecd({ sockPath, statePath, workspaceHostRoot: process.cwd() })
      await execd1.start()
      const c = connect(sockPath)
      c.send(req("SubmitCell", { capabilityId: "run_process", executable: "/bin/sh", args: ["-c", "sleep 20"], workloadKind: "build", readonly: false }))
      const resp = await c.next()
      const cellId = (resp as { result: { cellId: string } }).result.cellId
      // 不等完成就"崩溃"
      await execd1.stop()
      c.socket.destroy()

      // 第二次运行（同 boot 内）：Recovery 收敛 RUNNING 残留 → LOST。
      const execd2 = createExecd({ sockPath, statePath, workspaceHostRoot: process.cwd() })
      await execd2.start()
      try {
        expect(execd2.state.getCell(cellId)!.currentState).toBe("LOST")
        expect(execd2.state.listNonTerminalCells()).toHaveLength(0)
        // 新客户端可用
        const c2 = connect(sockPath)
        c2.send(req("Hello"))
        const hello = await c2.next()
        expect((hello as { type: string }).type).toBe("ok")
        c2.socket.destroy()
      } finally {
        await execd2.stop()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
