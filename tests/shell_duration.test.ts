/** RC-16 G4: tool duration must be measured from the moment the tool starts
 *  (including queue/spawn wait), not from after execution completes. */

import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SHELL_TOOL } from "../src/tools/shell"
import { shellStream } from "../src/tools/shell"

let fakeBin: string
let originalPath: string | undefined

beforeAll(() => {
  fakeBin = mkdtempSync(join(tmpdir(), "rc16-duration-"))
  const fakeTsc = join(fakeBin, "tsc")
  writeFileSync(fakeTsc, "#!/bin/sh\nsleep 0.3\nexit 0\n", "utf-8")
  chmodSync(fakeTsc, 0o755)
  originalPath = process.env.PATH
  process.env.PATH = `${fakeBin}:${originalPath ?? ""}`
})

afterAll(() => {
  if (originalPath === undefined) delete process.env.PATH
  else process.env.PATH = originalPath
  rmSync(fakeBin, { recursive: true, force: true })
})

describe("shell duration from start (RC-16 G4)", () => {
  test("durationMs covers execution time, not just result assembly", async () => {
    const result = await SHELL_TOOL.execute({ command: "tsc --noEmit", timeout: 10, confirm: true })
    expect(result.success).toBe(true)
    const verification = (result as { metadata?: { verification?: { durationMs: number } } }).metadata?.verification
    expect(verification?.durationMs).toBeGreaterThanOrEqual(200)
  })

  test("shellStream durationMs covers execution time", async () => {
    let done: { data: { success?: boolean; metadata?: { verification?: { durationMs: number } } } } | undefined
    for await (const event of shellStream({ command: "tsc --noEmit", timeout: 10, confirm: true })) {
      if (event.type === "done") done = event
    }
    expect(done?.data.success).toBe(true)
    expect(done?.data.metadata?.verification?.durationMs).toBeGreaterThanOrEqual(200)
  })
})
