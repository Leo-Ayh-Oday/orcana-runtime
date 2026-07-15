import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { canClaimDone, createEvidenceLedger, addEvidence } from "../src/agent/evidence-ledger"
import type { TaskTracker } from "../src/agent/task-tracker"
import { getWriteGeneration, resetRuntimeFileStateLedger } from "../src/file-state"
import { SandboxManager } from "../src/sandbox/sandbox"
import { setShellSandbox, SHELL_TOOL } from "../src/tools/shell"

const tempDirs: string[] = []

afterEach(() => {
  setShellSandbox(null)
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  resetRuntimeFileStateLedger()
})

function tracker(): TaskTracker {
  return {
    goal: "edit source",
    intent: "narrow_edit",
    phase: "building",
    requiredFiles: [],
    requiredVerificationKinds: ["typecheck"],
    verificationEvidence: {},
    verification: [],
    steps: [{ id: "edit", title: "edit source", status: "done" }],
  }
}

describe("shell workspace write observation", () => {
  test("a read-only streamed shell command does not invalidate evidence", async () => {
    resetRuntimeFileStateLedger()
    const dir = mkdtempSync(join(tmpdir(), "orcana-shell-generation-"))
    tempDirs.push(dir)
    const sandbox = new SandboxManager({ projectRoot: dir, maxRuntimeSec: 10 })
    setShellSandbox(sandbox)
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("process.stdout.write('ok')")}`

    for await (const _event of SHELL_TOOL.executeStream!({ command, confirm: true })) {
      // Drain the public streaming interface.
    }
    sandbox.dispose()

    expect(getWriteGeneration()).toBe(0)
  })

  test("a streamed shell file mutation invalidates evidence collected before it", async () => {
    resetRuntimeFileStateLedger()
    const dir = mkdtempSync(join(tmpdir(), "orcana-shell-generation-"))
    tempDirs.push(dir)
    const target = join(dir, "source.ts")
    writeFileSync(target, "export const value = 1\n")

    const ledger = createEvidenceLedger()
    addEvidence(ledger, {
      id: "before-shell-write",
      kind: "typecheck",
      command: "bun run typecheck",
      output: "ok",
      passed: true,
      timestamp: Date.now(),
      generation: getWriteGeneration(),
    })

    const sandbox = new SandboxManager({ projectRoot: dir, maxRuntimeSec: 10 })
    setShellSandbox(sandbox)
    const script = `require("node:fs").writeFileSync(${JSON.stringify(target)}, "export const value = 2\\n")`
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`
    let success = false
    for await (const event of SHELL_TOOL.executeStream!({ command, confirm: true })) {
      if (event.type === "done") success = event.data.success
    }
    sandbox.dispose()

    expect(success).toBe(true)
    expect(getWriteGeneration()).toBeGreaterThan(0)
    expect(canClaimDone({ tracker: tracker(), evidence: ledger, currentGeneration: getWriteGeneration() }).canClaim).toBe(false)
  })
})
