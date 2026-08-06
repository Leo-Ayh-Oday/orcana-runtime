/** RC-16 G4: tool duration must be measured from the moment the tool starts
 *  (including queue/spawn wait), not from after execution completes. */

import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SHELL_TOOL } from "../src/tools/shell"
import { shellStream } from "../src/tools/shell"
import {
  createRuntimeExecutionContext,
  runWithRuntimeExecutionContext,
  setExecutionAuthority,
} from "../src/runtime/execution-context"
import type { TrustedExecutionAuthority } from "../src/runtime/linux/contracts"

let fakeBin: string
let originalPath: string | undefined

/** Shell tools run through the managed Linux executor — fail-closed without
 *  a trusted execution authority. */
function withTestAuthority<T>(fn: () => T | Promise<T>): Promise<T> {
  const context = createRuntimeExecutionContext()
  return runWithRuntimeExecutionContext(context, async () => {
    const authority: TrustedExecutionAuthority = {
      identity: { runId: "g4-test", nodeRunId: "g4-test-0", attempt: 1 },
      workspace: {
        workspaceId: "g4-ws",
        projectId: "g4-proj",
        hostRoot: process.cwd(),
        kind: "main",
        access: "readwrite",
        ownerFiles: [],
      },
    }
    setExecutionAuthority(authority)
    return await fn()
  })
}

beforeAll(() => {
  // Inside the workspace root — the managed executor's sandbox only exposes
  // the authorized workspace, so a /tmp fake bin would be invisible.
  fakeBin = mkdtempSync(join(process.cwd(), ".g4-duration-"))
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
    const result = await withTestAuthority(() => SHELL_TOOL.execute({ command: "tsc --noEmit", timeout: 10, confirm: true }))
    expect(result.success).toBe(true)
    const verification = (result as { metadata?: { verification?: { durationMs: number } } }).metadata?.verification
    expect(verification?.durationMs).toBeGreaterThanOrEqual(200)
  })

  test("shellStream durationMs covers execution time", async () => {
    let done: { data: { success?: boolean; metadata?: { verification?: { durationMs: number } } } } | undefined
    await withTestAuthority(async () => {
      for await (const event of shellStream({ command: "tsc --noEmit", timeout: 10, confirm: true })) {
        if (event.type === "done") done = event
      }
    })
    expect(done?.data.success).toBe(true)
    expect(done?.data.metadata?.verification?.durationMs).toBeGreaterThanOrEqual(200)
  })
})
