/** LR2-1（L1-A）：RPC 帧协议 —— 4-byte big-endian length + UTF-8 JSON。
 *
 *  - 单帧上限 16 MiB（超限连接即断，防恶意大帧）；
 *  - FrameCodec 流式解析：feed(chunk) 累积跨帧缓冲，产出完整帧；
 *  - 每个帧是一条 JSON 消息（Request/Response/ServerEvent，见 messages/events）。
 */

export const MAX_FRAME_BYTES = 16 * 1024 * 1024
const HEADER_BYTES = 4

export interface Frame {
  /** 消息类型标记（帧级粗校验：后续 JSON 解析精细校验）。 */
  kind: "request" | "response" | "event"
  /** JSON 消息体。 */
  payload: string
}

export function encodeFrame(payload: string): Buffer {
  const body = Buffer.from(payload, "utf8")
  if (body.length > MAX_FRAME_BYTES) {
    throw new RangeError(`frame too large: ${body.length} > ${MAX_FRAME_BYTES}`)
  }
  const header = Buffer.alloc(HEADER_BYTES)
  header.writeUInt32BE(body.length, 0)
  return Buffer.concat([header, body])
}

/** 帧类型标记（与 payload JSON 首字段对应，用于路由与测试）。 */
export function frameKindOf(payload: string): Frame["kind"] {
  try {
    const obj = JSON.parse(payload) as { type?: string; method?: string }
    if (obj.type === "event") return "event"
    if (obj.method) return "request"
    return "response"
  } catch {
    return "response"
  }
}

/** 流式帧解析器：任意分块的 socket 数据 → 完整帧队列。 */
export class FrameCodec {
  private buffer = Buffer.alloc(0)

  /** feed 一段 socket 数据，返回其中解析出的完整帧（可能 0 到多个）。 */
  feed(chunk: Buffer): Frame[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    const frames: Frame[] = []
    for (;;) {
      if (this.buffer.length < HEADER_BYTES) break
      const length = this.buffer.readUInt32BE(0)
      if (length > MAX_FRAME_BYTES) {
        throw new RangeError(`frame header length ${length} exceeds ${MAX_FRAME_BYTES}`)
      }
      if (this.buffer.length < HEADER_BYTES + length) break // 帧未完整
      const payload = this.buffer.subarray(HEADER_BYTES, HEADER_BYTES + length).toString("utf8")
      this.buffer = this.buffer.subarray(HEADER_BYTES + length)
      frames.push({ kind: frameKindOf(payload), payload })
    }
    return frames
  }

  /** 未解析完的残余字节数（调试/测试）。 */
  get pendingBytes(): number {
    return this.buffer.length
  }
}
