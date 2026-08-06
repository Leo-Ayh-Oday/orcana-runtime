/** RC-16 G12: process tool timeout parsing must be guarded — negative or
 *  non-finite values fall back to the default instead of killing instantly. */

import { describe, expect, test } from "bun:test"
import { RUN_PROCESS_TOOL } from "../../src/tools/process"

describe("run_process timeout parse guard (RC-16 G12)", () => {
  test("negative timeoutMs falls back to the default instead of killing instantly", async () => {
    const result = await RUN_PROCESS_TOOL.execute({
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
      timeoutMs: -5000,
    })
    expect(result.success).toBe(true)
  })

  test("NaN timeoutMs falls back to the default", async () => {
    const result = await RUN_PROCESS_TOOL.execute({
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
      timeoutMs: Number.NaN,
    })
    expect(result.success).toBe(true)
  })
})
