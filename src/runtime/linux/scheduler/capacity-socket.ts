/** IC06: CapacityClient 的 Unix socket 传输（external runtime → execd）。
 *
 *  capacity.* 是 Hard Authority 通道：server 端对 capacity.* 消息强制
 *  SO_PEERCRED 可用（FAIL CLOSED / UNAUTHENTICATED），不允许降级为
 *  仅文件权限。ownerToken 明文只经本通道传输（进程内内存，不落盘）。
 *
 *  P0-11：connect deadline + request deadline（CAPACITY_RPC_WAIT_UNBOUNDED=0；
 *  server 不回应 → 有界超时 → fail closed）。
 */

import net from "node:net"
import { FrameCodec, encodeFrame } from "../../../execd/protocol/frame"
import { PROTOCOL_VERSION } from "../../../execd/protocol/messages"
import type { CapacityRpcTransport } from "./host-capacity"

export const CAPACITY_CONNECT_TIMEOUT_MS = 5_000
export const CAPACITY_REQUEST_TIMEOUT_MS = 5_000

export async function connectCapacitySocket(sockPath: string): Promise<CapacityRpcTransport> {
  const socket = net.createConnection(sockPath)
  const codec = new FrameCodec()
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  const sessionId = `cap-${process.pid}-${Date.now().toString(36)}`
  let nextSequence = 0

  await new Promise<void>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      socket.destroy()
      reject(new Error("CAPACITY_CONNECT_TIMEOUT"))
    }, CAPACITY_CONNECT_TIMEOUT_MS)
    const onError = (e: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(e)
    }
    socket.once("error", onError)
    socket.once("connect", () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.off("error", onError)
      resolve()
    })
  })

  socket.on("data", (chunk: Buffer) => {
    for (const frame of codec.feed(chunk)) {
      let msg: { type: string; requestId?: string; result?: unknown; error?: { code: string; message: string } }
      try {
        msg = JSON.parse(frame.payload) as typeof msg
      } catch {
        continue
      }
      if (msg.type === "error" && msg.requestId && pending.has(msg.requestId)) {
        const p = pending.get(msg.requestId)!
        pending.delete(msg.requestId)
        p.reject(new Error(`${msg.error?.code}: ${msg.error?.message}`))
      } else if (msg.type === "ok" && msg.requestId && pending.has(msg.requestId)) {
        const p = pending.get(msg.requestId)!
        pending.delete(msg.requestId)
        p.resolve(msg.result)
      }
    }
  })
  socket.on("error", () => {
    for (const [, p] of pending) p.reject(new Error("CAPACITY_TRANSPORT_CLOSED"))
    pending.clear()
  })
  socket.on("close", () => {
    for (const [, p] of pending) p.reject(new Error("CAPACITY_TRANSPORT_CLOSED"))
    pending.clear()
  })

  return {
    request(method: string, payload: unknown, idempotencyKey: string): Promise<unknown> {
      const requestId = `r${nextSequence++}`
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId)
          reject(new Error("CAPACITY_REQUEST_TIMEOUT"))
        }, CAPACITY_REQUEST_TIMEOUT_MS)
        pending.set(requestId, {
          resolve: (v) => { clearTimeout(timer); resolve(v) },
          reject: (e) => { clearTimeout(timer); reject(e) },
        })
        socket.write(encodeFrame(JSON.stringify({
          protocolVersion: PROTOCOL_VERSION,
          requestId,
          idempotencyKey,
          sessionId,
          sequence: nextSequence,
          method,
          payload,
        })))
      })
    },
    async close(): Promise<void> {
      socket.destroy()
    },
  }
}
