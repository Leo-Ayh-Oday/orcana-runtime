/** LR2-1（L1-A）：ExecProtocol 契约验收 —— 帧编解码 / 流式解析 /
 *  消息契约 / SO_PEERCRED。 */

import { describe, expect, test } from "bun:test"
import net from "node:net"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { encodeFrame, FrameCodec, MAX_FRAME_BYTES } from "../../src/execd/protocol/frame"
import { peerCredentialsOf } from "../../src/execd/protocol/peercred"
import { PROTOCOL_VERSION } from "../../src/execd/protocol/messages"

describe("frame codec", () => {
  test("encodes and decodes a single frame", () => {
    const codec = new FrameCodec()
    const payload = JSON.stringify({ method: "Hello", requestId: "r1" })
    const frames = codec.feed(encodeFrame(payload))
    expect(frames).toHaveLength(1)
    expect(frames[0]!.kind).toBe("request")
    expect(frames[0]!.payload).toBe(payload)
    expect(codec.pendingBytes).toBe(0)
  })

  test("streaming: arbitrary chunk splits reassemble frames", () => {
    const codec = new FrameCodec()
    const a = JSON.stringify({ method: "Hello", requestId: "a" })
    const b = JSON.stringify({ method: "GetCell", requestId: "b", payload: { cellId: "c1" } })
    const wire = Buffer.concat([encodeFrame(a), encodeFrame(b)])
    // 1 字节一块喂入
    const frames = []
    for (const byte of wire) frames.push(...codec.feed(Buffer.from([byte])))
    expect(frames.map(f => JSON.parse(f.payload).requestId)).toEqual(["a", "b"])
  })

  test("oversized header is rejected", () => {
    const codec = new FrameCodec()
    const header = Buffer.alloc(4)
    header.writeUInt32BE(MAX_FRAME_BYTES + 1, 0)
    expect(() => codec.feed(header)).toThrow(RangeError)
  })

  test("encode rejects oversized payload", () => {
    expect(() => encodeFrame("x".repeat(MAX_FRAME_BYTES + 1))).toThrow(RangeError)
  })

  test("frame kind routing (request/event/response)", () => {
    const codec = new FrameCodec()
    const event = codec.feed(encodeFrame(JSON.stringify({ type: "event", eventSequence: 1 })))
    expect(event[0]!.kind).toBe("event")
    const resp = codec.feed(encodeFrame(JSON.stringify({ type: "ok", requestId: "r" })))
    expect(resp[0]!.kind).toBe("response")
  })
})

describe("message contract", () => {
  test("protocol version is stable", () => {
    expect(PROTOCOL_VERSION).toBe(1)
  })
})

describe("SO_PEERCRED (L1-A)", () => {
  test("unix socket peer credentials match the connecting process", async () => {
    if (process.platform !== "linux") return
    const dir = mkdtempSync(join(tmpdir(), "peercred-"))
    const sockPath = join(dir, "s.sock")
    try {
      await new Promise<void>(resolve => {
        const server = net.createServer(sock => {
          const creds = peerCredentialsOf(sock)
          expect(creds).toBeDefined()
          if (creds) {
            expect(creds.uid).toBe(process.getuid?.() ?? -1)
            expect(creds.pid).toBeGreaterThan(0)
          }
          sock.end("ok")
          server.close()
          resolve()
        })
        server.listen(sockPath, () => {
          const client = net.createConnection(sockPath)
          client.on("data", () => client.end())
        })
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
