#!/usr/bin/env bun
/** LR2-1（L1-G）：orcana-execd 客户端 CLI（验收与调试用）。
 *
 *  用法：
 *    orcana-execd-cli hello
 *    orcana-execd-cli submit <executable> [args...] [--cwd <rel>] [--timeout <ms>]
 *    orcana-execd-cli get <cellId>
 *    orcana-execd-cli cancel <cellId>
 *    orcana-execd-cli cancel-run <runId>
 *    orcana-execd-cli clean <runId>
 *    orcana-execd-cli watch <cellId> [--since <seq>]
 *    orcana-execd-cli list
 *    orcana-execd-cli lease <runId> <ttlMs>
 */

import net from "node:net"
import { homedir } from "node:os"
import { join } from "node:path"
import { FrameCodec, encodeFrame } from "./protocol/frame"
import { PROTOCOL_VERSION } from "./protocol/messages"

function defaultSockPath(): string {
  const runtimeDir = process.env.XDG_RUNTIME_DIR ?? join(homedir(), ".cache")
  return process.env.ORCANA_EXECD_SOCK ?? join(runtimeDir, "orcana", "execd.sock")
}

interface CliConnection {
  socket: net.Socket
  codec: FrameCodec
  queue: Array<unknown>
  waiters: Array<(item: unknown) => void>
}

function connect(sockPath: string): Promise<CliConnection> {
  return new Promise((resolve, reject) => {
    const conn: CliConnection = { socket: net.createConnection(sockPath), codec: new FrameCodec(), queue: [], waiters: [] }
    conn.socket.on("connect", () => resolve(conn))
    conn.socket.on("error", reject)
    conn.socket.on("data", chunk => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk
      for (const frame of conn.codec.feed(buf)) {
        const data = JSON.parse(frame.payload)
        const w = conn.waiters.shift()
        if (w) w(data)
        else conn.queue.push(data)
      }
    })
  })
}

function request(conn: CliConnection, method: string, payload?: unknown, idempotencyKey = "cli"): Promise<unknown> {
  conn.socket.write(encodeFrame(JSON.stringify({
    protocolVersion: PROTOCOL_VERSION,
    requestId: `cli-${Date.now().toString(36)}`,
    idempotencyKey,
    sessionId: "cli",
    sequence: 1,
    method,
    ...(payload !== undefined ? { payload } : {}),
  })))
  if (conn.queue.length > 0) return Promise.resolve(conn.queue.shift())
  return new Promise(resolve => conn.waiters.push(resolve))
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2)
  const sockPath = defaultSockPath()
  const conn = await connect(sockPath)
  const out = await request(conn, "Hello")
  console.log(JSON.stringify(out, null, 2))

  switch (command) {
    case "hello":
      // Hello 已在连接时发送并打印。
      break
    case "submit": {
      const executable = rest[0]!
      const args = rest.slice(1).filter(a => !a.startsWith("--"))
      const cwdIdx = rest.indexOf("--cwd")
      const timeoutIdx = rest.indexOf("--timeout")
      const result = await request(conn, "SubmitCell", {
        capabilityId: "run_process",
        executable,
        args,
        cwdRef: cwdIdx >= 0 ? rest[cwdIdx + 1] : undefined,
        timeoutMs: timeoutIdx >= 0 ? Number(rest[timeoutIdx + 1]) : undefined,
        workloadKind: "build",
        readonly: false,
      }, `cli-submit-${Date.now().toString(36)}`)
      console.log(JSON.stringify(result, null, 2))
      break
    }
    case "get": {
      const cellId = rest[0]!
      console.log(JSON.stringify(await request(conn, "GetCell", { cellId }), null, 2))
      break
    }
    case "cancel": {
      const cellId = rest[0]!
      console.log(JSON.stringify(await request(conn, "CancelCell", { cellId }), null, 2))
      break
    }
    case "cancel-run": {
      const runId = rest[0]!
      console.log(JSON.stringify(await request(conn, "CancelRun", { runId }), null, 2))
      break
    }
    case "clean": {
      const runId = rest[0]!
      console.log(JSON.stringify(await request(conn, "CleanupRun", { runId }), null, 2))
      break
    }
    case "list": {
      console.log(JSON.stringify(await request(conn, "ListRecoverableRuns", {}), null, 2))
      break
    }
    case "lease": {
      const runId = rest[0]!
      const ttlMs = Number(rest[1] ?? 60000)
      console.log(JSON.stringify(await request(conn, "AcquireLease", { runId, ttlMs }), null, 2))
      break
    }
    case "watch": {
      const cellId = rest[0]!
      const sinceIdx = rest.indexOf("--since")
      const response = await request(conn, "WatchCell", { cellId, sinceSequence: sinceIdx >= 0 ? Number(rest[sinceIdx + 1]) : undefined })
      console.log(JSON.stringify(response, null, 2))
      // 事件流：读 3 秒后退出。
      const deadline = Date.now() + 3000
      for (;;) {
        if (conn.queue.length > 0) {
          console.log(JSON.stringify(conn.queue.shift()))
          continue
        }
        if (Date.now() > deadline) break
        await new Promise(r => setTimeout(r, 100))
      }
      break
    }
    default:
      console.error(`unknown command: ${command ?? "(none)"}`)
      process.exit(1)
  }
  conn.socket.destroy()
}

main().catch(error => {
  console.error(`[cli] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
