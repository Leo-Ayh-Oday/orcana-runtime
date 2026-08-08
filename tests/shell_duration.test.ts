/** RC-16 G4: tool duration must be measured from the moment the tool starts
 *  (including queue/spawn wait), not from after execution completes.
 *
 *  GATE（GS-14）：宿主 PATH 不再进入 Cell —— 旧机制靠"宿主 PATH 注入假
 *  tsc"制造可控时长，已失效且正是被堵的洞。改用真实 sleep 命令测时长。 */

import { describe, expect, test } from "bun:test"
import { SHELL_TOOL } from "../src/tools/shell"
import { shellStream } from "../src/tools/shell"
import {
  createRuntimeExecutionContext,
  runWithRuntimeExecutionContext,
  setExecutionAuthority,
} from "../src/runtime/execution-context"
import type { TrustedExecutionAuthority } from "../src/runtime/linux/contracts"

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
        physicalWorkspaceKey: "wp_test",
        ownerFiles: [],
      },
    }
    setExecutionAuthority(authority)
    return await fn()
  })
}

describe("shell duration from start (RC-16 G4)", () => {
  test("durationMs covers execution time, not just result assembly", async () => {
    const result = await withTestAuthority(() => SHELL_TOOL.execute({ command: "sleep 0.3", timeout: 10, confirm: true }))
    expect(result.success).toBe(true)
    const metadata = (result as { metadata?: { durationMs?: number } }).metadata
    expect(metadata?.durationMs).toBeGreaterThanOrEqual(200)
  })

  test("shellStream durationMs covers execution time", async () => {
    let done: { data: { success?: boolean; metadata?: { durationMs?: number } } } | undefined
    await withTestAuthority(async () => {
      for await (const event of shellStream({ command: "sleep 0.3", timeout: 10, confirm: true })) {
        if (event.type === "done") done = event
      }
    })
    expect(done?.data.success).toBe(true)
    expect(done?.data.metadata?.durationMs).toBeGreaterThanOrEqual(200)
  })
})
