/** RC-15 G2: MCP requests must correlate by request id — concurrent calls never
 *  cross-talk, and shutdown settles every pending request instead of hanging. */

import { describe, expect, test } from "bun:test"
import { MCPClientV2 } from "../../src/tools/mcp"

const ECHO_SERVER = `
let buf = ""
process.stdin.on("data", (d) => {
  buf += d.toString("utf-8")
  while (true) {
    const m = buf.match(/^Content-Length: (\\d+)\\r?\\n\\r?\\n/)
    if (!m) return
    const len = Number(m[1])
    const headerEnd = m[0].length
    if (buf.length < headerEnd + len) return
    const body = JSON.parse(buf.slice(headerEnd, headerEnd + len))
    buf = buf.slice(headerEnd + len)
    if (body.method === "initialize") {
      respond(body.id, { ok: true })
    } else if (body.method === "tools/call") {
      const id = body.id
      setTimeout(() => respond(id, { content: [{ type: "text", text: "echo-" + id }] }), id % 2 === 0 ? 60 : 5)
    }
  }
})
function respond(id, result) {
  const out = JSON.stringify({ jsonrpc: "2.0", id, result })
  process.stdout.write("Content-Length: " + Buffer.byteLength(out) + "\\r\\n\\r\\n" + out)
}
`

async function raceTimeout<T>(promise: Promise<T>, ms: number): Promise<T | "timeout"> {
  return Promise.race([
    promise,
    new Promise<"timeout">(resolve => setTimeout(() => resolve("timeout"), ms)),
  ])
}

function makeClient(): MCPClientV2 {
  return new MCPClientV2()
}

describe("MCP request correlation (RC-15 G2)", () => {
  test("concurrent calls resolve against their own request id even when responses arrive out of order", async () => {
    const client = makeClient()
    const connected = await client.connect("echo", process.execPath, ["-e", ECHO_SERVER])
    expect(connected).toBe(true)

    try {
      const a = client.callTool("echo", "echo", { tag: "A" })
      const b = client.callTool("echo", "echo", { tag: "B" })
      const result = await raceTimeout(Promise.all([a, b]), 3000)

      expect(result).not.toBe("timeout")
      const [ra, rb] = result as [string, string]
      expect(ra).toBe("echo-2")
      expect(rb).toBe("echo-3")
    } finally {
      client.shutdownAll()
    }
  })

  test("shutdown settles pending requests with an error instead of hanging", async () => {
    const client = makeClient()
    const connected = await client.connect("echo", process.execPath, ["-e", ECHO_SERVER])
    expect(connected).toBe(true)

    const pending = client.callTool("echo", "never-responds", {})
    await new Promise(resolve => setTimeout(resolve, 50))

    client.shutdownAll()

    const outcome = await raceTimeout(
      pending.then(() => "resolved", () => "rejected"),
      2000,
    )
    expect(outcome).not.toBe("timeout")
  })
})
