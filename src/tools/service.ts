/** Service supervisor (RT-11): run-bound ServiceLease registry.
 *
 *  Splits the old monolithic start_service into four tools:
 *    service_start / service_status / service_logs / service_stop.
 *
 *  Every started service is tracked as a ServiceLease bound to an optional
 *  runId with a cleanupPolicy. Leases with cleanupPolicy "run-end" are
 *  stopped automatically when the owning run is removed from the harness
 *  RunRegistry (TL-014). Logs are streamed to ~/.orcana/services/<id>.log so
 *  they can be inspected after the fact.
 *
 *  The legacy start_service tool is kept as a compatibility forwarder.
 */

import { spawnLegacy, type ChildProcess } from "../runtime/legacy-process"
const spawn = spawnLegacy
import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync } from "node:fs"
import { request as httpRequest } from "node:http"
import { request as httpsRequest } from "node:https"
import { resolve } from "node:path"
import { homedir } from "node:os"
import type { ToolDef, ToolResult } from "./registry"
import { Result, isNonInteractive } from "./registry"

async function sleep(ms: number) {
  await new Promise(resolve => setTimeout(resolve, ms))
}

// ── ServiceLease ──

export type ServiceCleanupPolicy = "manual" | "run-end"
export type ServiceStatus = "starting" | "ready" | "stopped" | "failed"

export interface ServiceLease {
  id: string
  runId?: string
  pid: number | undefined
  url: string
  command: string
  cwd: string
  startedAt: number
  status: ServiceStatus
  cleanupPolicy: ServiceCleanupPolicy
  logPath: string
  stoppedAt?: number
}

interface LiveLease extends ServiceLease {
  proc: ChildProcess
}

const serviceLeases = new Map<string, LiveLease>()
let idCounter = 0

function serviceLogDir(): string {
  const dir = resolve(homedir(), ".orcana", "services")
  mkdirSync(dir, { recursive: true })
  return dir
}

function nextServiceId(): string {
  idCounter++
  return `svc-${Date.now().toString(36)}-${idCounter.toString(36)}`
}

interface ReadinessExpectation {
  expectStatus?: number
  expectContentType?: string
  expectBodyIncludes?: string
}

/** Direct GET — readiness probes must not be routed through HTTP proxies
 *  (a proxy 502/error would be mistaken for the service being down). */
function directGet(url: string): Promise<{ status: number; contentType: string; body: string }> {
  return new Promise((resolve, reject) => {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch (e) {
      reject(e)
      return
    }
    const isHttps = parsed.protocol === "https:"
    const client = isHttps ? httpsRequest : httpRequest
    const req = client(
      {
        hostname: parsed.hostname,
        port: parsed.port ? Number(parsed.port) : undefined,
        path: `${parsed.pathname}${parsed.search}`,
        method: "GET",
        timeout: 2_000,
      },
      res => {
        const chunks: Buffer[] = []
        res.on("data", (chunk: Buffer) => chunks.push(chunk))
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            contentType: res.headers["content-type"] ?? "",
            body: Buffer.concat(chunks).toString("utf-8"),
          })
        })
      },
    )
    req.on("error", reject)
    req.on("timeout", () => req.destroy(new Error("timeout")))
    req.end()
  })
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
      const response = await directGet(url)
      const expectedStatus = expectation.expectStatus ?? 200
      if (response.status !== expectedStatus) {
        lastError = `HTTP ${response.status}, expected ${expectedStatus}`
        await sleep(500)
        continue
      }

      if (expectation.expectContentType && !response.contentType.toLowerCase().includes(expectation.expectContentType.toLowerCase())) {
        lastError = `content-type ${response.contentType || "(empty)"}, expected ${expectation.expectContentType}`
        await sleep(500)
        continue
      }

      if (expectation.expectBodyIncludes) {
        if (!response.body.includes(expectation.expectBodyIncludes)) {
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

function isProcessAlive(proc: ChildProcess): boolean {
  return proc.exitCode === null && proc.signalCode === null
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

// ── Tool implementations ──

interface StartServiceDeps {
  /** Readiness probe hook — tests inject a fake (WSL cannot reach localhost). */
  waitForHttp?: typeof waitForHttp
}

export async function startServiceInternal(params: Record<string, unknown>, deps: StartServiceDeps = {}): Promise<ToolResult> {
  if (params.confirm !== true && !isNonInteractive()) return Result.blocked("service_start requires confirmation - set confirm: true")

  const command = String(params.command ?? "").trim()
  const cwd = String(params.cwd ?? process.cwd())
  const url = String(params.url ?? "")
  const timeoutSec = Number(params.timeout ?? 30)
  const stopAfterReady = params.stopAfterReady === true
  const cleanupPolicy: ServiceCleanupPolicy = params.cleanupPolicy === "run-end" ? "run-end" : "manual"
  const runId = typeof params.runId === "string" && params.runId.trim() ? params.runId.trim() : undefined
  const expectation = buildReadinessExpectation(url, params)
  const probe = deps.waitForHttp ?? waitForHttp

  if (!command) return Result.fail("command is required")
  if (!url || !/^https?:\/\//i.test(url)) return Result.fail("url must be an http(s) URL to wait for")

  const resolvedCwd = resolve(process.cwd(), cwd)
  if (!existsSync(resolvedCwd)) return Result.fail(`cwd not found: ${cwd}`)

  const id = nextServiceId()
  const logPath = resolve(serviceLogDir(), `${id}.log`)
  const logStream = createWriteStream(logPath, { flags: "a" })

  // RT-7: parameterized spawn (shell:false) — explicit shell executable +
  // args, detached process group, no command-string injection surface.
  // bun's spawn does not accept stream/path stdio entries;
  // pipe stdout/stderr and forward them into the lease log file instead.
  const shellPath = process.platform === "win32" ? "cmd.exe" : "/bin/sh"
  const shellArgs = process.platform === "win32" ? ["/c", command] : ["-c", command]
  const proc = spawn(shellPath, shellArgs, {
    cwd: resolvedCwd,
    shell: false,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  })
  proc.stdout?.pipe(logStream)
  proc.stderr?.pipe(logStream)
  proc.unref()

  const lease: LiveLease = {
    id,
    runId,
    pid: proc.pid,
    url,
    command,
    cwd: resolvedCwd,
    startedAt: Date.now(),
    status: "starting",
    cleanupPolicy,
    logPath,
    proc,
  }
  serviceLeases.set(id, lease)

  const ready = await probe(url, Math.max(1, timeoutSec) * 1000, expectation)
  if (!ready.ok) {
    lease.status = "failed"
    if (proc.pid) stopProcessTree(proc.pid)
    return Result.fail(`Service did not become ready at ${url}: ${ready.error}`)
  }

  if (stopAfterReady && proc.pid) {
    stopProcessTree(proc.pid)
    lease.status = "stopped"
    lease.stoppedAt = Date.now()
  } else {
    lease.status = "ready"
  }

  const leaseView: ServiceLease = {
    id: lease.id,
    runId: lease.runId,
    pid: lease.pid,
    url: lease.url,
    command: lease.command,
    cwd: lease.cwd,
    startedAt: lease.startedAt,
    status: lease.status,
    cleanupPolicy: lease.cleanupPolicy,
    logPath: lease.logPath,
    stoppedAt: lease.stoppedAt,
  }

  return Result.ok(
    stopAfterReady
      ? `Service smoke passed at ${url}; process stopped. (lease ${id})`
      : `Service started and responded at ${url}. Lease: ${id}, PID: ${proc.pid}.`,
    {
      ...leaseView,
      serviceId: id,
      service: true,
      stopped: stopAfterReady,
      readiness: expectation,
    },
  )
}

function leaseViews(): ServiceLease[] {
  const views: ServiceLease[] = []
  for (const lease of serviceLeases.values()) {
    views.push({
      id: lease.id,
      runId: lease.runId,
      pid: lease.pid,
      url: lease.url,
      command: lease.command,
      cwd: lease.cwd,
      startedAt: lease.startedAt,
      status: isProcessAlive(lease.proc) ? lease.status : "stopped",
      cleanupPolicy: lease.cleanupPolicy,
      logPath: lease.logPath,
      stoppedAt: lease.stoppedAt,
    })
  }
  views.sort((a, b) => b.startedAt - a.startedAt)
  return views
}

function findLease(serviceId: string): LiveLease | undefined {
  return serviceLeases.get(serviceId)
}

async function statusService(params: Record<string, unknown>): Promise<ToolResult> {
  const serviceId = typeof params.serviceId === "string" ? params.serviceId.trim() : ""
  if (serviceId) {
    const lease = findLease(serviceId)
    if (!lease) return Result.fail(`Unknown service lease: ${serviceId}`)
    const view = leaseViews().find(v => v.id === serviceId)!
    return Result.ok(
      `[${view.status}] ${view.id} — ${view.url}\n` +
      `  pid: ${view.pid ?? "—"}  uptime: ${view.status === "stopped" ? "stopped" : `${Math.round((Date.now() - view.startedAt) / 1000)}s`}\n` +
      `  runId: ${view.runId ?? "—"}  cleanup: ${view.cleanupPolicy}\n` +
      `  log: ${view.logPath}`,
      { ...view, service: true },
    )
  }
  const views = leaseViews()
  if (views.length === 0) return Result.ok("No services running.")
  const lines = views.map(v =>
    `[${v.status}] ${v.id} — ${v.url} (pid ${v.pid ?? "—"}, runId ${v.runId ?? "—"}, cleanup ${v.cleanupPolicy}, uptime ${v.status === "stopped" ? "stopped" : `${Math.round((Date.now() - v.startedAt) / 1000)}s`})`,
  )
  return Result.ok(lines.join("\n"), { services: views, service: true })
}

const TAIL_BYTES = 64 * 1024
const MAX_LOG_BYTES = 2 * 1024 * 1024

function readLogTail(logPath: string, tailLines: number): { text: string; truncated: boolean } {
  if (!existsSync(logPath)) return { text: "(no log file yet)", truncated: false }
  const size = statSync(logPath).size
  if (size > MAX_LOG_BYTES) {
    const fd = readFileSync(logPath)
    const tail = fd.subarray(fd.length - TAIL_BYTES).toString("utf-8")
    return { text: `(log truncated to last ${TAIL_BYTES} bytes)\n${tail}`, truncated: true }
  }
  const text = readFileSync(logPath, "utf-8")
  const lines = text.split("\n").filter(Boolean)
  return { text: lines.slice(-tailLines).join("\n"), truncated: lines.length > tailLines }
}

async function logsService(params: Record<string, unknown>): Promise<ToolResult> {
  const serviceId = typeof params.serviceId === "string" ? params.serviceId.trim() : ""
  if (!serviceId) return Result.fail("serviceId is required")
  const lease = findLease(serviceId)
  if (!lease) return Result.fail(`Unknown service lease: ${serviceId}`)
  const tailLines = Number(params.tail ?? 100)
  const { text, truncated } = readLogTail(lease.logPath, Number.isFinite(tailLines) && tailLines > 0 ? tailLines : 100)
  return Result.ok(text, { serviceId, logPath: lease.logPath, truncated, service: true })
}

async function stopService(params: Record<string, unknown>): Promise<ToolResult> {
  if (params.confirm !== true && !isNonInteractive()) return Result.blocked("service_stop requires confirmation - set confirm: true")
  const serviceId = typeof params.serviceId === "string" ? params.serviceId.trim() : ""
  if (!serviceId) return Result.fail("serviceId is required")
  const lease = findLease(serviceId)
  if (!lease) return Result.fail(`Unknown service lease: ${serviceId}`)

  if (isProcessAlive(lease.proc) && lease.pid) {
    stopProcessTree(lease.pid)
  }
  lease.status = "stopped"
  lease.stoppedAt = Date.now()
  return Result.ok(`Service ${serviceId} stopped.`, { serviceId, stopped: true, service: true })
}

/** Stop every run-bound lease of a finished run (cleanupPolicy "run-end"). */
export function stopServicesForRun(runId: string): string[] {
  const stopped: string[] = []
  for (const lease of serviceLeases.values()) {
    if (lease.runId === runId && lease.cleanupPolicy === "run-end" && isProcessAlive(lease.proc)) {
      if (lease.pid) stopProcessTree(lease.pid)
      lease.status = "stopped"
      lease.stoppedAt = Date.now()
      stopped.push(lease.id)
    }
  }
  return stopped
}

// ── Tool definitions ──

const SERVICE_INPUT_SCHEMA = {
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
    runId: { type: "string", description: "Owning run id; with cleanupPolicy=run-end the service is stopped when the run ends" },
    cleanupPolicy: { type: "string", enum: ["manual", "run-end"], description: "When to clean the service up (default manual)" },
  },
  required: ["command", "cwd", "url"],
} as const

export const SERVICE_START_TOOL: ToolDef = {
  name: "service_start",
  description: "Start a long-running local dev service in the background and register a ServiceLease (runId-bound, optional cleanupPolicy=run-end auto-stop). Waits until its HTTP URL responds with the expected status/content, then returns a lease id for service_status/service_logs/service_stop. For API smoke checks, pass expectContentType or expectBodyIncludes so an unrelated localhost service cannot be mistaken for readiness.",
  isReadonly: false,
  category: "shell" as const,
  requiresConfirmation: true,
  userFacingName: "Start service",
  contract: {
    sideEffects: ["shell", "external_process", "network"],
    stateUpdates: ["runtime_state"],
  },
  inputSchema: SERVICE_INPUT_SCHEMA,
  execute: (params: Record<string, unknown>) => startServiceInternal(params),
}

export const SERVICE_STATUS_TOOL: ToolDef = {
  name: "service_status",
  description: "List running service leases or inspect one lease (pid, url, uptime, runId, cleanupPolicy, log path). Read-only.",
  isReadonly: true,
  category: "shell" as const,
  isConcurrencySafe: true,
  userFacingName: "Service status",
  inputSchema: {
    type: "object",
    properties: {
      serviceId: { type: "string", description: "Lease id to inspect; omit to list all services" },
    },
  },
  execute: statusService,
}

export const SERVICE_LOGS_TOOL: ToolDef = {
  name: "service_logs",
  description: "Read the tail of a service's stdout/stderr log (persisted at ~/.orcana/services/<id>.log). Read-only.",
  isReadonly: true,
  category: "shell" as const,
  isConcurrencySafe: true,
  userFacingName: "Service logs",
  inputSchema: {
    type: "object",
    properties: {
      serviceId: { type: "string", description: "Lease id to read logs for" },
      tail: { type: "number", description: "Number of lines to return from the end (default 100)" },
    },
    required: ["serviceId"],
  },
  execute: logsService,
}

export const SERVICE_STOP_TOOL: ToolDef = {
  name: "service_stop",
  description: "Stop a started service lease (kills the process tree). Idempotent: stopping an already-stopped lease reports success.",
  isReadonly: false,
  category: "shell" as const,
  requiresConfirmation: true,
  userFacingName: "Stop service",
  contract: {
    sideEffects: ["external_process"],
    stateUpdates: ["runtime_state"],
  },
  inputSchema: {
    type: "object",
    properties: {
      serviceId: { type: "string", description: "Lease id to stop" },
    },
    required: ["serviceId"],
  },
  execute: stopService,
}

export const SERVICE_TOOLS: ToolDef[] = [
  SERVICE_START_TOOL,
  SERVICE_STATUS_TOOL,
  SERVICE_LOGS_TOOL,
  SERVICE_STOP_TOOL,
]

/** Legacy start_service — kept as a compatibility forwarder to service_start. */
export const START_SERVICE_TOOL: ToolDef = {
  ...SERVICE_START_TOOL,
  name: "start_service",
  description: SERVICE_START_TOOL.description + " (deprecated alias of service_start)",
  execute: (params: Record<string, unknown>) => startServiceInternal(params),
}
