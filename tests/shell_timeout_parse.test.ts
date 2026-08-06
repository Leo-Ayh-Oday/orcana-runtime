/** RC-16 G12: timeout parsing must be guarded — invalid input falls back to
 *  the default instead of producing NaN/negative timeouts that kill or hang. */

import { describe, expect, test } from "bun:test"
import { SHELL_TOOL, parseTimeoutSec } from "../src/tools/shell"

describe("shell timeout parse guard (RC-16 G12)", () => {
  test("parseTimeoutSec falls back to the default for invalid input", () => {
    expect(parseTimeoutSec("abc", 120)).toBe(120)
    expect(parseTimeoutSec(NaN, 120)).toBe(120)
    expect(parseTimeoutSec(0, 120)).toBe(120)
    expect(parseTimeoutSec(-5, 120)).toBe(120)
    expect(parseTimeoutSec(undefined, 120)).toBe(120)
    expect(parseTimeoutSec("30", 120)).toBe(30)
    expect(parseTimeoutSec(30, 120)).toBe(30)
  })

  test("shell tool runs with a non-numeric timeout instead of timing out instantly", async () => {
    const result = await SHELL_TOOL.execute({ command: "echo hello", timeout: "not-a-number", confirm: true })
    expect(result.success).toBe(true)
    expect(result.content).toContain("hello")
  })
})
