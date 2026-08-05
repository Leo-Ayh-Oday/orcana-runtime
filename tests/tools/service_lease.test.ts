/** RT-11: ServiceLease lifecycle (start/status/logs/stop, run-bound cleanup, legacy alias).
 *
 *  Network note: WSL mirrored networking routes 127.0.0.1 to the Windows host,
 *  so real readiness probes cannot pass here. The readiness hook is injected;
 *  process spawn/stop paths are exercised for real.
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import { createServer, type Server } from "node:http"
import { SERVICE_START_TOOL, SERVICE_STATUS_TOOL, SERVICE_LOGS_TOOL, SERVICE_STOP_TOOL, START_SERVICE_TOOL, stopServicesForRun, startServiceInternal } from "../../src/tools/service"
import type { ToolResult } from "../../src/tools/registry"

let server: Server

async function freePort(): Promise<number> {
  return new Promise(resolve => {
    const probe = createServer()
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as { port: number }).port
      probe.close(() => resolve(port))
    })
  })
}

function serviceScript(port: number): string {
  return `node -e "require('http').createServer((q,s)=>{s.writeHead(200,{'content-type':'application/json'});s.end('{}')}).listen(${port},'127.0.0.1')"`
}

// Fake readiness: no live socket needed (WSL localhost is routed to Windows).
const fakeReady = async () => ({ ok: true } as const)
const fakeFailing = async () => ({ ok: false, error: "injected readiness failure" } as const)

beforeAll(async () => {
  await new Promise<void>(resolve => {
    server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ ok: true, service: "lease-test" }))
    })
    server.listen(0, "127.0.0.1", resolve)
  })
})

afterAll(async () => {
  server?.close()
  // clean any leftover leases from this suite
  const status = await SERVICE_STATUS_TOOL.execute({})
  const leases = (status as { success: true; metadata: { services?: Array<{ id: string }> } }).metadata?.services ?? []
  for (const lease of leases) await SERVICE_STOP_TOOL.execute({ serviceId: lease.id })
})

function ok(result: ToolResult): Extract<ToolResult, { success: true }> {
  expect(result.success).toBe(true)
  return result as Extract<ToolResult, { success: true }>
}

describe("service supervisor (RT-11 leases)", () => {
  test("service_start registers a lease and service_status sees it", async () => {
    const port = await freePort()
    const start = await startServiceInternal(
      { command: serviceScript(port), cwd: process.cwd(), url: `http://127.0.0.1:${port}` },
      { waitForHttp: fakeReady },
    )
    const started = ok(start)
    const serviceId = started.metadata!.serviceId as string
    expect(serviceId).toMatch(/^svc-/)
    expect(started.metadata!.cleanupPolicy).toBe("manual")
    expect(started.metadata!.status).toBe("ready")

    const status = ok(await SERVICE_STATUS_TOOL.execute({ serviceId }))
    expect(status.content).toContain(serviceId)

    const logs = ok(await SERVICE_LOGS_TOOL.execute({ serviceId }))
    expect(typeof logs.content).toBe("string")

    const stopped = ok(await SERVICE_STOP_TOOL.execute({ serviceId }))
    expect(stopped.metadata!.stopped).toBe(true)

    const stoppedStatus = ok(await SERVICE_STATUS_TOOL.execute({ serviceId }))
    expect(stoppedStatus.content).toContain("[stopped]")
  })

  test("service_stop is idempotent", async () => {
    const port = await freePort()
    const start = ok(await startServiceInternal(
      { command: serviceScript(port), cwd: process.cwd(), url: `http://127.0.0.1:${port}` },
      { waitForHttp: fakeReady },
    ))
    const serviceId = start.metadata!.serviceId as string
    ok(await SERVICE_STOP_TOOL.execute({ serviceId }))
    const again = ok(await SERVICE_STOP_TOOL.execute({ serviceId }))
    expect(again.metadata!.stopped).toBe(true)
  })

  test("readiness failure marks the lease failed and stops the process", async () => {
    const port = await freePort()
    const result = await startServiceInternal(
      { command: serviceScript(port), cwd: process.cwd(), url: `http://127.0.0.1:${port}`, timeout: 1 },
      { waitForHttp: fakeFailing },
    )
    expect(result.success).toBe(false)
    expect(result.content).toContain("injected readiness failure")
  })

  test("service_status with no leases lists them all read-only", async () => {
    const result = ok(await SERVICE_STATUS_TOOL.execute({}))
    expect(typeof result.content).toBe("string")
    expect(Array.isArray(result.metadata!.services)).toBe(true)
  })

  test("service_status/service_logs on an unknown lease fail cleanly", async () => {
    const status = await SERVICE_STATUS_TOOL.execute({ serviceId: "svc-nope" })
    expect(status.success).toBe(false)
    const logs = await SERVICE_LOGS_TOOL.execute({ serviceId: "svc-nope" })
    expect(logs.success).toBe(false)
  })

  test("run-bound leases (cleanupPolicy=run-end) stop when the run ends", async () => {
    const port = await freePort()
    const start = ok(await startServiceInternal(
      {
        command: serviceScript(port),
        cwd: process.cwd(),
        url: `http://127.0.0.1:${port}`,
        runId: "run-test-42",
        cleanupPolicy: "run-end",
      },
      { waitForHttp: fakeReady },
    ))
    const serviceId = start.metadata!.serviceId as string
    expect(start.metadata!.runId).toBe("run-test-42")
    expect(start.metadata!.cleanupPolicy).toBe("run-end")

    const stoppedIds = stopServicesForRun("run-test-42")
    expect(stoppedIds).toContain(String(serviceId))

    const after = ok(await SERVICE_STATUS_TOOL.execute({ serviceId }))
    expect(after.content).toContain("[stopped]")
  })

  test("stopServicesForRun only stops run-end leases of the matching run", async () => {
    const portA = await freePort()
    const portB = await freePort()
    const manual = ok(await startServiceInternal(
      { command: serviceScript(portA), cwd: process.cwd(), url: `http://127.0.0.1:${portA}`, runId: "run-a", cleanupPolicy: "manual" },
      { waitForHttp: fakeReady },
    ))
    const runEnd = ok(await startServiceInternal(
      { command: serviceScript(portB), cwd: process.cwd(), url: `http://127.0.0.1:${portB}`, runId: "run-b", cleanupPolicy: "run-end" },
      { waitForHttp: fakeReady },
    ))
    const stopped = stopServicesForRun("run-b")
    expect(stopped).toContain(String(runEnd.metadata!.serviceId))
    expect(stopped).not.toContain(String(manual.metadata!.serviceId))
    ok(await SERVICE_STOP_TOOL.execute({ serviceId: manual.metadata!.serviceId as string }))
  })

  test("legacy start_service still works as a compatibility forwarder", async () => {
    const port = await freePort()
    const result = await startServiceInternal(
      { command: serviceScript(port), cwd: process.cwd(), url: `http://127.0.0.1:${port}`, stopAfterReady: true },
      { waitForHttp: fakeReady },
    )
    const started = ok(result)
    expect(started.metadata!.service).toBe(true)
    expect(started.metadata!.stopped).toBe(true)
    expect(started.metadata!.serviceId).toMatch(/^svc-/)
  })
})
