import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import type { ToolDef } from "./registry"
import { Result, isNonInteractive } from "./registry"

async function sleep(ms: number) {
  await new Promise(resolve => setTimeout(resolve, ms))
}

interface ReadinessExpectation {
  expectStatus?: number
  expectContentType?: string
  expectBodyIncludes?: string
}

async function waitForHttp(
  url: string,
  timeoutMs: number,
  expectation: ReadinessExpectation = {},
): Promise<{ ok: boolean; error?: string }> {
  const deadline = Date.now() + timeoutMs
  let lastError = ""
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { method: "GET" })
      const expectedStatus = expectation.expectStatus ?? 200
      if (response.status !== expectedStatus) {
        lastError = `HTTP ${response.status}, expected ${expectedStatus}`
        await sleep(500)
        continue
      }

      const contentType = response.headers.get("content-type") ?? ""
      if (expectation.expectContentType && !contentType.toLowerCase().includes(expectation.expectContentType.toLowerCase())) {
        lastError = `content-type ${contentType || "(empty)"}, expected ${expectation.expectContentType}`
        await sleep(500)
        continue
      }

      if (expectation.expectBodyIncludes) {
        const body = await response.text()
        if (!body.includes(expectation.expectBodyIncludes)) {
          lastError = `response body did not include ${JSON.stringify(expectation.expectBodyIncludes)}`
          await sleep(500)
          continue
        }
      }

      return { ok: true }
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e)
    }
    await sleep(500)
  }
  return { ok: false, error: lastError || "service did not become ready" }
}

function stopProcessTree(pid: number) {
  if (process.platform === "win32") {
    spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).unref()
    return
  }
  try {
    process.kill(-pid, "SIGTERM")
  } catch {
    try { process.kill(pid, "SIGTERM") } catch { /* ignore */ }
  }
}

async function startService(params: Record<string, unknown>) {
  if (params.confirm !== true && !isNonInteractive()) return Result.blocked("start_service requires confirmation - set confirm: true")

  const command = String(params.command ?? "").trim()
  const cwd = String(params.cwd ?? process.cwd())
  const url = String(params.url ?? "")
  const timeoutSec = Number(params.timeout ?? 30)
  const stopAfterReady = params.stopAfterReady === true
  const expectation = buildReadinessExpectation(url, params)

  if (!command) return Result.fail("command is required")
  if (!url || !/^https?:\/\//i.test(url)) return Result.fail("url must be an http(s) URL to wait for")

  const resolvedCwd = resolve(process.cwd(), cwd)
  if (!existsSync(resolvedCwd)) return Result.fail(`cwd not found: ${cwd}`)

  const proc = spawn(command, {
    cwd: resolvedCwd,
    shell: true,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  })
  proc.unref()

  const ready = await waitForHttp(url, Math.max(1, timeoutSec) * 1000, expectation)
  if (!ready.ok) {
    if (proc.pid) stopProcessTree(proc.pid)
    return Result.fail(`Service did not become ready at ${url}: ${ready.error}`)
  }

  if (stopAfterReady && proc.pid) stopProcessTree(proc.pid)

  return Result.ok(
    stopAfterReady
      ? `Service smoke passed at ${url}; process stopped.`
      : `Service started and responded at ${url}. PID: ${proc.pid}.`,
    {
      pid: proc.pid,
      url,
      cwd: resolvedCwd,
      command,
      service: true,
      stopped: stopAfterReady,
      readiness: expectation,
    },
  )
}

function buildReadinessExpectation(url: string, params: Record<string, unknown>): ReadinessExpectation {
  const expectation: ReadinessExpectation = {}
  const status = Number(params.expectStatus ?? 200)
  if (Number.isFinite(status)) expectation.expectStatus = status
  if (typeof params.expectContentType === "string" && params.expectContentType.trim()) {
    expectation.expectContentType = params.expectContentType.trim()
  } else if (/\/api(?:\/|$)|[?&]format=json\b/i.test(url)) {
    expectation.expectContentType = "application/json"
  }
  if (typeof params.expectBodyIncludes === "string" && params.expectBodyIncludes.length > 0) {
    expectation.expectBodyIncludes = params.expectBodyIncludes
  }
  return expectation
}

export const START_SERVICE_TOOL: ToolDef = {
  name: "start_service",
  description: "Start a long-running local dev service in the background, wait until its HTTP URL responds with the expected status/content, then return the URL. Use this instead of shell for bun/npm run dev/start/serve. For API smoke checks, pass expectContentType or expectBodyIncludes so an unrelated localhost service cannot be mistaken for readiness.",
  isReadonly: false,
  category: "shell" as const,
  requiresConfirmation: true,
  userFacingName: "Start service",
  contract: {
    sideEffects: ["shell", "external_process", "network"],
    stateUpdates: ["runtime_state"],
  },
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "Command to start, for example: bun run dev --hostname 127.0.0.1 --port 3000" },
      cwd: { type: "string", description: "Working directory for the service command" },
      url: { type: "string", description: "HTTP URL that must respond before success is returned" },
      timeout: { type: "number", description: "Seconds to wait for readiness" },
      stopAfterReady: { type: "boolean", description: "For smoke tests only: stop the process after the URL responds" },
      expectStatus: { type: "number", description: "Expected HTTP status for readiness, defaults to 200" },
      expectContentType: { type: "string", description: "Expected response content-type substring, for example application/json" },
      expectBodyIncludes: { type: "string", description: "Required response body substring for readiness" },
    },
    required: ["command", "cwd", "url"],
  },
  execute: startService,
}
