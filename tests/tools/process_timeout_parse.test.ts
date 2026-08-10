/** RC-16 G12: process tool timeout parsing must be guarded — negative or
 *  non-finite values fall back to the default instead of killing instantly. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { RUN_PROCESS_TOOL } from "../../src/tools/process"
import {
  createRuntimeExecutionContext,
  runWithRuntimeExecutionContext,
  setExecutionAuthority,
} from "../../src/runtime/execution-context"
import type { TrustedExecutionAuthority } from "../../src/runtime/linux/contracts"
import { installHostAuditProcessBroker, resetProcessBroker } from "../helpers/linux-process-test-broker"

beforeAll(installHostAuditProcessBroker)
afterAll(resetProcessBroker)

/** Linux execution is fail-closed without a trusted authority (R2 PR-9). */
async function withAuthority<T>(fn: () => T | Promise<T>): Promise<T> {
  return runWithRuntimeExecutionContext(createRuntimeExecutionContext(), async () => {
    const authority: TrustedExecutionAuthority = {
      identity: { runId: "rt-g12-test", nodeRunId: "rt-g12-test-0", attempt: 1 },
      workspace: {
        workspaceId: "rt-g12-ws",
        projectId: "rt-g12-proj",
        hostRoot: process.cwd(),
        kind: "main",
        access: "readwrite",
        physicalWorkspaceKey: "wp_test",
        ownerFiles: [],
      },
    }
    setExecutionAuthority(authority)
    return fn()
  })
}

describe("run_process timeout parse guard (RC-16 G12)", () => {
  test("negative timeoutMs falls back to the default instead of killing instantly", async () => {
    const result = await withAuthority(() => RUN_PROCESS_TOOL.execute({
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
      timeoutMs: -5000,
    }))
    expect(result.success).toBe(true)
  })

  test("NaN timeoutMs falls back to the default", async () => {
    const result = await withAuthority(() => RUN_PROCESS_TOOL.execute({
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
      timeoutMs: Number.NaN,
    }))
    expect(result.success).toBe(true)
  })
})
