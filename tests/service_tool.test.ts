import { afterAll, describe, expect, test } from "bun:test"
import { tmpdir } from "node:os"
import { START_SERVICE_TOOL } from "../src/tools/service"

const startedServers: Array<ReturnType<typeof Bun.serve>> = []

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

afterAll(() => {
  for (const server of startedServers) server.stop(true)
})

describe("start_service tool", () => {
  test("requires confirmation", async () => {
    const old = process.env.ORCANA_INTERACTIVE
    process.env.ORCANA_INTERACTIVE = "1"
    try {
      const result = await START_SERVICE_TOOL.execute({
        command: "echo hello",
        cwd: process.cwd(),
        url: "http://127.0.0.1:9",
      })

      expect(result.success).toBe(false)
      expect(result.content).toContain("confirmation")
    } finally {
      restoreEnv("ORCANA_INTERACTIVE", old)
    }
  })

  test("rejects invalid readiness URL", async () => {
    const result = await START_SERVICE_TOOL.execute({
      command: "echo hello",
      cwd: tmpdir(),
      url: "localhost:3000",
      confirm: true,
    })

    expect(result.success).toBe(false)
    expect(result.content).toContain("url")
  })

  test("does not accept unrelated HTML response for API readiness", async () => {
    const existing = Bun.serve({
      port: 0,
      fetch() {
        return new Response("<!doctype html><title>Not the API</title>", {
          headers: { "Content-Type": "text/html" },
        })
      },
    })
    startedServers.push(existing)
    const url = new URL("/api/posts", existing.url).href

    const result = await START_SERVICE_TOOL.execute({
      command: "echo no-op",
      cwd: tmpdir(),
      url,
      timeout: 1,
      confirm: true,
    })

    expect(result.success).toBe(false)
    expect(result.content).toContain("content-type")
    expect(result.content).toContain("application/json")
  })

  test("accepts API readiness when expected content matches", async () => {
    const existing = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({ posts: [{ id: 1, title: "ok" }] })
      },
    })
    startedServers.push(existing)
    const url = new URL("/api/posts", existing.url).href

    const result = await START_SERVICE_TOOL.execute({
      command: "echo no-op",
      cwd: tmpdir(),
      url,
      timeout: 1,
      expectContentType: "application/json",
      expectBodyIncludes: "\"posts\"",
      confirm: true,
    })

    expect(result.success).toBe(true)
    expect(result.content).toContain("Service started")
  })
})
