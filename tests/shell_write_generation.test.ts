import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { canClaimDone, createEvidenceLedger, addEvidence } from "../src/agent/evidence-ledger"
import type { TaskTracker } from "../src/agent/task-tracker"
import { getWriteGeneration, resetRuntimeFileStateLedger } from "../src/file-state"
import { SandboxManager } from "../src/sandbox/sandbox"
import { setShellSandbox, SHELL_TOOL } from "../src/tools/shell"
import {
  createRuntimeExecutionContext,
  runWithRuntimeExecutionContext,
  setExecutionAuthority,
} from "../src/runtime/execution-context"
import type { TrustedExecutionAuthority } from "../src/runtime/linux/contracts"

const tempDirs: string[] = []

afterEach(() => {
  setShellSandbox(null)
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  resetRuntimeFileStateLedger()
})

/** Shell tools run through the managed Linux executor — fail-closed without
 *  a trusted execution authority (R2 PR-9). */
function withTestAuthority<T>(fn: () => T | Promise<T>): Promise<T> {
  const context = createRuntimeExecutionContext()
  return runWithRuntimeExecutionContext(context, async () => {
    const authority: TrustedExecutionAuthority = {
      identity: { runId: "shell-write-test", nodeRunId: "shell-write-test-0", attempt: 1 },
      workspace: {
        workspaceId: "shell-write-ws",
        projectId: "shell-write-proj",
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

    await withTestAuthority(async () => {
      setShellSandbox(sandbox)
      for await (const _event of SHELL_TOOL.executeStream!({ command, confirm: true })) {
        // Drain the public streaming interface.
      }
    })
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
    const script = `require("node:fs").writeFileSync(${JSON.stringify(target)}, "export const value = 2\\n")`
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`
    let success = false
    await withTestAuthority(async () => {
      setShellSandbox(sandbox)
      for await (const event of SHELL_TOOL.executeStream!({ command, confirm: true })) {
        if (event.type === "done") success = event.data.success
      }
    })
    sandbox.dispose()

    expect(success).toBe(true)
    expect(getWriteGeneration()).toBeGreaterThan(0)
    expect(canClaimDone({ tracker: tracker(), evidence: ledger, currentGeneration: getWriteGeneration() }).canClaim).toBe(false)
  })
})
