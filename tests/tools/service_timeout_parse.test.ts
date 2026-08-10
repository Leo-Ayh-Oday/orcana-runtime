/** RC-16 G12: service_start timeout parsing must be guarded — invalid input
 *  falls back to the default readiness window instead of NaN. */

import { describe, expect, test } from "bun:test"
import { startServiceInternal } from "../../src/tools/service"

describe("service_start timeout parse guard (RC-16 G12)", () => {
  test("invalid timeout falls back to the default readiness window", async () => {
    let capturedTimeoutMs: number | undefined
    const result = await startServiceInternal(
      { command: "echo hi", cwd: process.cwd(), url: "http://127.0.0.1:1", timeout: "not-a-number" },
      {
        waitForHttp: async (_url, timeoutMs) => {
          capturedTimeoutMs = timeoutMs
          return { ok: true }
        },
      },
    )
    expect(result.success).toBe(true)
    expect(capturedTimeoutMs).toBe(30_000)
  })

  test("valid timeout is passed through in seconds", async () => {
    let capturedTimeoutMs: number | undefined
    const result = await startServiceInternal(
      { command: "echo hi", cwd: process.cwd(), url: "http://127.0.0.1:1", timeout: 5 },
      {
        waitForHttp: async (_url, timeoutMs) => {
          capturedTimeoutMs = timeoutMs
          return { ok: true }
        },
      },
    )
    expect(result.success).toBe(true)
    expect(capturedTimeoutMs).toBe(5_000)
  })
})
