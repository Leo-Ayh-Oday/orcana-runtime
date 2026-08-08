/** LR2-1（L1-C）：execd Server 验收 —— 认证（SO_PEERCRED uid）/
 *  帧路由 / Hello / GetCell / WatchCell 事件流（断点续读）。 */

import { describe, expect, test } from "bun:test"
import net from "node:net"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ExecdServer, type ExecdServerDeps } from "../../src/execd/server"
import { StateStore } from "../../src/execd/state/store"
import { FrameCodec, encodeFrame } from "../../src/execd/protocol/frame"
import { PROTOCOL_VERSION } from "../../src/execd/protocol/messages"

function testDeps(state: StateStore, overrides: Partial<ExecdServerDeps> = {}): ExecdServerDeps {
  return {
    sockPath: "",
    state,
    submitCell: async payload => ({ cellId: "cell-1", runId: "run-1", idempotent: false }),
    getCell: cellId => state.getCell(cellId),
    cancelCell: async () => {},
    cancelAgent: async () => {},
    cancelRun: async () => {},
    cleanupRun: async () => ({ removed: 1 }),
    acquireLease: async (runId, ttlMs) => ({ leaseId: "L1", expiresAt: Date.now() + ttlMs }),
    renewLease: async leaseId => ({ expiresAt: Date.now() + 1000 }),
    releaseLease: async () => {},
    listRecoverableRuns: () => [],
    ...overrides,
  }
}

/** 最小客户端：连接 + 请求/响应/事件收发。 */
function client(sockPath: string) {
  const codec = new FrameCodec()
  const queue: Array<{ type: "response" | "event"; data: unknown }> = []
  const waiters: Array<(item: { type: "response" | "event"; data: unknown }) => void> = []
  const socket = net.createConnection(sockPath)
  socket.on("data", chunk => {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk
    for (const frame of codec.feed(buf)) {
      const data = JSON.parse(frame.payload)
      const item = { type: frame.kind === "event" ? "event" as const : "response" as const, data }
      const w = waiters.shift()
      if (w) w(item)
      else queue.push(item)
    }
  })
  return {
    socket,
    send(message: unknown): void {
      socket.write(encodeFrame(JSON.stringify(message)))
    },
    async next(): Promise<{ type: "response" | "event"; data: unknown }> {
      if (queue.length > 0) return queue.shift()!
      return new Promise(resolve => waiters.push(resolve))
    },
    close(): void {
      socket.destroy()
    },
  }
}

function baseReq(method: string, payload?: unknown): Record<string, unknown> {
  return {
    protocolVersion: PROTOCOL_VERSION,
    requestId: `req-${Math.random().toString(36).slice(2, 8)}`,
    idempotencyKey: `ik-${Math.random().toString(36).slice(2, 8)}`,
    sessionId: "s-test",
    sequence: 1,
    method,
    ...(payload !== undefined ? { payload } : {}),
  }
}

describe("execd server (L1-C)", () => {
  async function setup() {
    const dir = mkdtempSync(join(tmpdir(), "execd-srv-"))
    const state = new StateStore(join(dir, "execd.db"))
    const server = new ExecdServer(testDeps(state))
    const sockPath = join(dir, "execd.sock")
    // testDeps 的 sockPath 为空 —— 直接改 server 的 deps
    ;(server as unknown as { deps: ExecdServerDeps }).deps = { ...testDeps(state), sockPath }
    await server.start()
    return { dir, state, server, sockPath, cleanup: async () => { await server.stop(); state.close(); rmSync(dir, { recursive: true, force: true }) } }
  }

  test("Hello establishes a session and echoes peer uid", async () => {
    const { sockPath, cleanup } = await setup()
    try {
      const c = client(sockPath)
      c.send(baseReq("Hello"))
      const resp = await c.next()
      expect(resp.type).toBe("response")
      const ok = resp.data as { type: string; result: { sessionId: string; peerUid: number | null } }
      expect(ok.type).toBe("ok")
      expect(ok.result.sessionId).toBeTruthy()
      expect(ok.result.peerUid).toBe(process.getuid?.() ?? null)
      c.close()
    } finally {
      await cleanup()
    }
  })

  test("protocol version mismatch is rejected", async () => {
    const { sockPath, cleanup } = await setup()
    try {
      const c = client(sockPath)
      c.send({ ...baseReq("Hello"), protocolVersion: 999 })
      const resp = await c.next()
      expect((resp.data as { error: { code: string } }).error.code).toBe("EXECD_PROTOCOL_VERSION_MISMATCH")
      c.close()
    } finally {
      await cleanup()
    }
  })

  test("unknown method is rejected", async () => {
    const { sockPath, cleanup } = await setup()
    try {
      const c = client(sockPath)
      c.send(baseReq("Frobnicate"))
      const resp = await c.next()
      expect((resp.data as { error: { code: string } }).error.code).toBe("EXECD_UNKNOWN_METHOD")
      c.close()
    } finally {
      await cleanup()
    }
  })

  test("GetCell returns stored cell or UNKNOWN_CELL", async () => {
    const { sockPath, state, cleanup } = await setup()
    try {
      state.upsertCell({
        cellId: "c1", runId: "r1", nodeRunId: "r1:n1", attempt: 1,
        capabilityId: "run_process", executable: "/bin/true", argsJson: "[]",
        currentState: "RUNNING", createdAt: 1, updatedAt: 2,
      })
      const c = client(sockPath)
      c.send(baseReq("GetCell", { cellId: "c1" }))
      const ok = await c.next()
      expect((ok.data as { result: { cellId: string; currentState: string } }).result).toMatchObject({ cellId: "c1", currentState: "RUNNING" })
      c.send(baseReq("GetCell", { cellId: "nope" }))
      const err = await c.next()
      expect((err.data as { error: { code: string } }).error.code).toBe("EXECD_UNKNOWN_CELL")
      c.close()
    } finally {
      await cleanup()
    }
  })

  test("WatchCell replays persisted events then live pushes", async () => {
    const { sockPath, state, server, cleanup } = await setup()
    try {
      state.upsertCell({
        cellId: "c1", runId: "r1", nodeRunId: "r1:n1", attempt: 1,
        capabilityId: "run_process", executable: "/bin/true", argsJson: "[]",
        currentState: "ACCEPTED", createdAt: 1, updatedAt: 2,
      })
      const seq1 = state.transition("c1", "att-1", "POLICY_COMPILED", { from: "ACCEPTED", reasonCode: "compile" })
      const c = client(sockPath)
      c.send(baseReq("WatchCell", { cellId: "c1" }))
      const resp = await c.next()
      expect((resp.data as { result: { resumedFrom: number } }).result.resumedFrom).toBe(seq1)
      // 实时推送（状态事件落库 + 广播）
      // 历史回放事件（seq1）先到
      const hist = await c.next()
      expect(hist.type).toBe("event")
      expect((hist.data as { eventSequence: number }).eventSequence).toBe(seq1)
      // 实时推送（状态事件落库 + 广播）→ seq2
      const seq2 = state.transition("c1", "att-1", "RUNNING", { from: "POLICY_COMPILED", reasonCode: "start" })
      server.publishEvent({ kind: "cell.status", cellId: "c1", payload: { state: "RUNNING" } }, seq2)
      const ev = await c.next()
      expect(ev.type).toBe("event")
      expect((ev.data as { eventSequence: number; cellId: string }).cellId).toBe("c1")
      expect((ev.data as { eventSequence: number }).eventSequence).toBe(seq2)
      c.close()
    } finally {
      await cleanup()
    }
  })

  test("resume from sequence fills the gap (EVENT_SEQUENCE_GAP)", async () => {
    const { sockPath, state, cleanup } = await setup()
    try {
      state.upsertCell({
        cellId: "c1", runId: "r1", nodeRunId: "r1:n1", attempt: 1,
        capabilityId: "run_process", executable: "/bin/true", argsJson: "[]",
        currentState: "ACCEPTED", createdAt: 1, updatedAt: 2,
      })
      state.transition("c1", "att-1", "POLICY_COMPILED", { from: "ACCEPTED" })
      state.transition("c1", "att-1", "RUNNING", { from: "POLICY_COMPILED" })
      const c1 = client(sockPath)
      c1.send(baseReq("WatchCell", { cellId: "c1" }))
      await c1.next() // ok 响应（resumedFrom=2）
      const ev1 = await c1.next()
      expect((ev1.data as { eventSequence: number }).eventSequence).toBe(1)
      const ev2 = await c1.next()
      expect((ev2.data as { eventSequence: number }).eventSequence).toBe(2)
      c1.close()
      // 模拟断线后重连：只从序号 1 之后续读 → 只收到 2
      const c2 = client(sockPath)
      c2.send(baseReq("WatchCell", { cellId: "c1", sinceSequence: 1 }))
      const resp = await c2.next()
      expect((resp.data as { result: { resumedFrom: number } }).result.resumedFrom).toBe(2)
      const ev3 = await c2.next()
      expect((ev3.data as { eventSequence: number }).eventSequence).toBe(2)
      c2.close()
    } finally {
      await cleanup()
    }
  })

  test("peer uid mismatch rejects the connection (UNAUTHENTICATED)", async () => {
    // 注入伪造 peercred（返回异 uid）→ 任何请求在认证层被拒并断连。
    const dir = mkdtempSync(join(tmpdir(), "execd-srv-"))
    const state = new StateStore(join(dir, "execd.db"))
    const sockPath = join(dir, "execd.sock")
    const server = new ExecdServer(
      { ...testDeps(state), sockPath },
      undefined,
      undefined,
      () => ({ pid: 12345, uid: (process.getuid?.() ?? 0) + 1, gid: -1 }), // 异 uid
    )
    try {
      await server.start()
      const c = client(sockPath)
      // 连接建立后首个请求即触发认证拒绝（错误帧 + 断连）。
      const closed = new Promise<void>(resolve => c.socket.on("close", () => resolve()))
      c.send(baseReq("Hello"))
      const resp = await c.next()
      expect((resp.data as { error: { code: string } }).error.code).toBe("EXECD_UNAUTHENTICATED")
      await closed
    } finally {
      await server.stop()
      state.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
