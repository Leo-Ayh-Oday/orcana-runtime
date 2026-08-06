/** RC-14 G9: FIM requests must carry a timeout — a hung upstream must abort
 *  the request instead of blocking the tool indefinitely. */

import { describe, expect, test } from "bun:test"
import { FimEditor } from "../src/provider/fim"

describe("FimEditor timeout (RC-14 G9)", () => {
  test("aborts the request when the upstream hangs", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal
      await new Promise<void>((resolve, reject) => {
        if (!signal) {
          reject(new Error("no abort signal attached"))
          return
        }
        signal.addEventListener("abort", () => reject(signal.reason), { once: true })
      })
      throw new Error("fetch should have been aborted")
    }) as typeof fetch

    try {
      const editor = new FimEditor("test-key", "https://example.test/beta", "test-model", 60)
      const started = Date.now()
      const result = await editor.edit({ prefix: "a", suffix: "b", instruction: "change" })
      const elapsed = Date.now() - started

      expect(result.success).toBe(false)
      expect(result.error).toContain("timed out")
      expect(elapsed).toBeLessThan(5_000)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("still completes normally with a responsive upstream", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) => {
      return new Response(JSON.stringify({
        choices: [{ text: "replacement" }],
      }), { status: 200 })
    }) as typeof fetch

    try {
      const editor = new FimEditor("test-key", "https://example.test/beta", "test-model", 5_000)
      const result = await editor.edit({ prefix: "a", suffix: "b", instruction: "change" })
      expect(result.success).toBe(true)
      expect(result.newText).toBe("replacement")
      expect(result.fullNewFile).toBe("areplacementb")
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
