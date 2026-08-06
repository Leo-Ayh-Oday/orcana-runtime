/** RC-16 G7: service log tail reads must be bounded — never load the whole log
 *  into memory; large logs are read as a tail window with an explicit marker. */

import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readLogTail } from "../../src/tools/service"

let tempDir: string

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "rc16-logtail-"))
})

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

describe("readLogTail bounded reads (RC-16 G7)", () => {
  test("returns the last N lines of a small log without a truncation marker", () => {
    const log = join(tempDir, "small.log")
    writeFileSync(log, ["line-1", "line-2", "line-3", "line-4", "line-5"].join("\n"), "utf-8")

    const { text, truncated } = readLogTail(log, 2)
    expect(truncated).toBe(true)
    expect(text.split("\n")).toEqual(["line-4", "line-5"])

    const full = readLogTail(log, 10)
    expect(full.truncated).toBe(false)
    expect(full.text).toContain("line-1")
  })

  test("reads a large log as a bounded tail window with a marker instead of loading it fully", () => {
    const log = join(tempDir, "big.log")
    const lines: string[] = []
    for (let i = 0; i < 20_000; i++) lines.push(`big-log-line-${i}-${"x".repeat(30)}`)
    writeFileSync(log, lines.join("\n"), "utf-8")

    const { text, truncated } = readLogTail(log, 50)
    expect(truncated).toBe(true)
    expect(text.startsWith("(log truncated to last")).toBe(true)
    expect(text.length).toBeLessThan(100_000)
    expect(text).toContain("big-log-line-19999")
  })

  test("reports a missing log file without throwing", () => {
    const { text, truncated } = readLogTail(join(tempDir, "nope.log"), 100)
    expect(truncated).toBe(false)
    expect(text).toBe("(no log file yet)")
  })
})
