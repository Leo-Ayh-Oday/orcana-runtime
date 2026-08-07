import { describe, expect, test } from "bun:test"
import { shellStream } from "../src/tools/shell"
import {
  createRuntimeExecutionContext,
  runWithRuntimeExecutionContext,
  setExecutionAuthority,
} from "../src/runtime/execution-context"
import type { TrustedExecutionAuthority } from "../src/runtime/linux/contracts"

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

/** Shell tools run through the managed Linux executor — fail-closed without
 *  a trusted execution authority (R2 PR-9). */
type ShellEvent = { type?: string; data?: { success?: boolean; content?: string; error?: string; metadata?: Record<string, unknown> }; [k: string]: unknown }
async function collectShell(params: Record<string, unknown>) {
  const events: ShellEvent[] = []
  await runWithRuntimeExecutionContext(createRuntimeExecutionContext(), async () => {
    const authority: TrustedExecutionAuthority = {
      identity: { runId: "shell-stream-test", nodeRunId: "shell-stream-test-0", attempt: 1 },
      workspace: {
        workspaceId: "shell-ws",
        projectId: "shell-proj",
        hostRoot: process.cwd(),
        kind: "main",
        access: "readwrite",
        physicalWorkspaceKey: "wp_test",
        ownerFiles: [],
      },
    }
    setExecutionAuthority(authority)
    for await (const event of shellStream(params)) {
      events.push(event as ShellEvent)
    }
  })
  return events
}

describe("shellStream", () => {
  test("requires explicit confirmation", async () => {
    const old = process.env.ORCANA_INTERACTIVE
    process.env.ORCANA_INTERACTIVE = "1"
    try {
      const events = await collectShell({ command: "echo hello" })
      const done = events.at(-1)

      expect(done?.type).toBe("done")
      if (done?.type === "done" && done.data) {
        expect(done.data.success).toBe(false)
        expect(done.data.content).toContain("confirmation")
      }
    } finally {
      restoreEnv("ORCANA_INTERACTIVE", old)
    }
  })

  test("times out instead of hanging forever", async () => {
    const command = process.platform === "win32"
      ? "powershell -NoProfile -Command Start-Sleep -Seconds 3"
      : "sleep 3"
    const started = Date.now()
    const events = await collectShell({ command, timeout: 1, confirm: true })
    const elapsed = Date.now() - started
    const done = events.at(-1)

    expect(done?.type).toBe("done")
    if (done?.type === "done" && done.data) {
      expect(done.data.success).toBe(false)
      expect(done.data.content).toContain("timed out")
    }
    expect(elapsed).toBeLessThan(4000)
  })

  test("treats non-zero exit code as failure", async () => {
    const command = process.platform === "win32"
      ? "powershell -NoProfile -Command exit 7"
      : "sh -c 'exit 7'"
    const events = await collectShell({ command, timeout: 5, confirm: true })
    const done = events.at(-1)

    expect(done?.type).toBe("done")
    if (done?.type === "done" && done.data) {
      expect(done.data.success).toBe(false)
      if (!done.data.success && done.data.error) expect(done.data.error).toContain("code 7")
    }
  })

  test("run cancellation terminates the active shell process", async () => {
    const controller = new AbortController()
    await runWithRuntimeExecutionContext(createRuntimeExecutionContext(), async () => {
      setExecutionAuthority({
        identity: { runId: "shell-cancel-test", nodeRunId: "shell-cancel-test-0", attempt: 1 },
        workspace: { workspaceId: "shell-ws", projectId: "shell-proj", hostRoot: process.cwd(), kind: "main", access: "readwrite", physicalWorkspaceKey: "wp_test", ownerFiles: [] },
      })
      const iterator = shellStream({
        command: `node -e "console.log('ready'); setTimeout(() => {}, 2000)"`,
        timeout: 30,
        confirm: true,
      }, { abortSignal: controller.signal, projectRoot: process.cwd() })

      const first = await iterator.next()
      expect(first.done).toBe(false)
      controller.abort("cancel shell")
      const started = Date.now()
      const done = await iterator.next()
      // abort → cell.exit(aborted) → shellStream yield {type:"done"}（该事件本身
      // 尚未结束 generator；下一次 next() 才 doneFlag=true）。
      expect((done.value as { type?: string })?.type).toBe("done")
      if ((done.value as { type?: string })?.type === "done") {
        expect((done.value as { data?: { success?: boolean; content?: string } }).data?.success).toBe(false)
        expect((done.value as { data?: { content?: string } }).data?.content).toContain("aborted")
      }
      expect(Date.now() - started).toBeLessThan(2000)
      const final = await iterator.next()
      expect(final.done).toBe(true)
    })
  })

  test("blocks long-running dev server commands", async () => {
    const events = await collectShell({ command: "bun run dev", timeout: 5, confirm: true })
    const done = events.at(-1)

    expect(done?.type).toBe("done")
    if (done?.type === "done" && done.data) {
      expect(done.data.success).toBe(false)
      expect(done.data.content).toContain("常驻服务")
      expect(done.data.content).toContain("bun test")
    }
  })

  test("blocks direct server entrypoint execution", async () => {
    const events = await collectShell({ command: "bun run server/index.ts", timeout: 5, confirm: true })
    const done = events.at(-1)

    expect(done?.type).toBe("done")
    if (done?.type === "done" && done.data) {
      expect(done.data.success).toBe(false)
      expect(done.data.content).toContain("后端服务入口")
    }
  })
})
