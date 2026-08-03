import { describe, expect, test } from "bun:test"
import { WEB_SEARCH } from "../src/tools/search"

function installHangingFetch() {
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = ((_, init?: RequestInit) => {
    calls += 1
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal
      if (signal?.aborted) {
        reject(new Error("aborted"))
        return
      }
      signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
    })
  }) as typeof fetch

  return {
    get calls() { return calls },
    restore() { globalThis.fetch = original },
  }
}

describe("web_search", () => {
  test("rejects empty queries without calling fetch", async () => {
    const original = globalThis.fetch
    let calls = 0
    globalThis.fetch = ((() => {
      calls += 1
      throw new Error("should not fetch")
    }) as unknown) as typeof fetch

    try {
      const result = await WEB_SEARCH.execute({ query: "   " })
      expect(result.success).toBe(false)
      expect(result.content).toContain("non-empty query")
      expect(calls).toBe(0)
    } finally {
      globalThis.fetch = original
    }
  })

  test("times out failed backends quickly without API key", async () => {
    const oldTimeout = process.env.ORCANA_SEARCH_TIMEOUT_MS
    process.env.ORCANA_SEARCH_TIMEOUT_MS = "1"
    // Ensure no Exa API key so it falls through to MCP
    const oldKey = process.env.EXA_API_KEY
    delete process.env.EXA_API_KEY
    const fetchMock = installHangingFetch()

    try {
      const started = Date.now()
      const result = await WEB_SEARCH.execute({ query: "hraness agent github" })
      const elapsed = Date.now() - started

      expect(result.success).toBe(false)
      expect(result.content).toContain("Search unavailable")
      expect(elapsed).toBeLessThan(500)
    } finally {
      fetchMock.restore()
      if (oldTimeout === undefined) delete process.env.ORCANA_SEARCH_TIMEOUT_MS
      else process.env.ORCANA_SEARCH_TIMEOUT_MS = oldTimeout
      if (oldKey === undefined) delete process.env.EXA_API_KEY
      else process.env.EXA_API_KEY = oldKey
    }
  })
})
