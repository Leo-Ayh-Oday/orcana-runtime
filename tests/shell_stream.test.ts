import { describe, expect, test } from "bun:test"
import { shellStream } from "../src/tools/shell"

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

async function collectShell(params: Record<string, unknown>) {
  const events = []
  for await (const event of shellStream(params)) {
    events.push(event)
  }
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
      if (done?.type === "done") {
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
    if (done?.type === "done") {
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
    if (done?.type === "done") {
      expect(done.data.success).toBe(false)
      if (!done.data.success) expect(done.data.error).toContain("code 7")
    }
  })

  test("run cancellation terminates the active shell process", async () => {
    const controller = new AbortController()
    const iterator = shellStream({
      command: `node -e "console.log('ready'); setTimeout(() => {}, 2000)"`,
      timeout: 5,
      confirm: true,
    }, { abortSignal: controller.signal })

    const first = await iterator.next()
    expect(first.done).toBe(false)
    controller.abort("cancel shell")
    const started = Date.now()
    const done = await iterator.next()

    expect(Date.now() - started).toBeLessThan(1000)
    expect(done.value?.type).toBe("done")
    if (done.value?.type === "done") {
      expect(done.value.data.success).toBe(false)
      expect(done.value.data.content).toContain("aborted")
    }
  })

  test("blocks long-running dev server commands", async () => {
    const events = await collectShell({ command: "bun run dev", timeout: 5, confirm: true })
    const done = events.at(-1)

    expect(done?.type).toBe("done")
    if (done?.type === "done") {
      expect(done.data.success).toBe(false)
      expect(done.data.content).toContain("常驻服务")
      expect(done.data.content).toContain("bun test")
    }
  })

  test("blocks direct server entrypoint execution", async () => {
    const events = await collectShell({ command: "bun run server/index.ts", timeout: 5, confirm: true })
    const done = events.at(-1)

    expect(done?.type).toBe("done")
    if (done?.type === "done") {
      expect(done.data.success).toBe(false)
      expect(done.data.content).toContain("后端服务入口")
    }
  })
})
