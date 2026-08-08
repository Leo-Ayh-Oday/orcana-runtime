/** MCP client — JSON-RPC lifecycle. Ported from orcana/core/mcp_client.py */

import type { ChildProcess } from "../runtime/legacy-process"
import { createServiceCell } from "../runtime/linux/service-cell"
import type { ServiceLeaseStore } from "../runtime/linux/recovery/state-store"
import { setServiceLeaseStore } from "./service"
import type { ToolDef, ToolResult } from "./registry"
import { Result } from "./registry"

interface ServerState {
  proc: ChildProcess
  /** LNXF-GATE-02：release 幂等句柄（停进程 + 删 durable 记录）。 */
  release: () => void
  tools: Array<Record<string, unknown>>
  resources: Array<Record<string, unknown>>
  buffer: string
  pending: Map<number, (value: Record<string, unknown>) => void>
  connected: boolean
}

// LNXF-GATE-02：MCP 的 durable lease 存储与 service 共用同一 store（测试可
// 注入内存版；默认不持久化 —— legacy 直调语义不变）。
let mcpLeaseStoreOverride: ServiceLeaseStore | undefined
export function setMcpLeaseStore(store: ServiceLeaseStore | undefined): void {
  mcpLeaseStoreOverride = store
  // 与 service 层共享同一 store 来源（run-end 清理与 janitor 恢复一致）。
  setServiceLeaseStore(store)
}
function mcpLeaseStore(): ServiceLeaseStore | undefined {
  return mcpLeaseStoreOverride
}

export class MCPClientV2 {
  private servers: Map<string, ServerState> = new Map()
  private reqId = 0

  connect(name: string, command: string, args: string[] = [], env?: Record<string, string>): Promise<boolean> {
    return new Promise(resolve => {
      try {
        // LNXF-GATE-02 (B12+B13)：spawnLegacy → ServiceCell（kind: mcp）——
        // explicit env（minimalHostEnv 白名单 + 拒绝集过滤）+ durable lease
        // + owner(pid+starttime)；ready 以 MCP initialize 响应为准。
        const cell = createServiceCell({
          kind: "mcp",
          command,
          args,
          cwd: process.cwd(),
          cleanupPolicy: "run-end",
          logPath: "",
          env,
          stdio: ["pipe", "pipe", "pipe"],
          detached: false,
          store: mcpLeaseStore(),
        })
        const proc = cell.proc
        const state: ServerState = {
          proc,
          release: () => cell.release(),
          tools: [],
          resources: [],
          buffer: "",
          pending: new Map(),
          connected: false,
        }
        this.servers.set(name, state)

        proc.stdout?.on("data", (chunk: Buffer) => {
          state.buffer += chunk.toString("utf-8")
          this._tryParseResponse(state)
        })

        proc.on("error", () => {
          state.connected = false
          this.rejectAllPending(state, "MCP server failed")
          resolve(false)
        })

        proc.on("exit", () => {
          state.connected = false
          this.rejectAllPending(state, "MCP server exited")
        })

        this._send(name, "initialize", {
          protocolVersion: "0.1.0",
          capabilities: {},
          clientInfo: { name: "orcana", version: "0.1.0" },
        }).then(r => {
          const ok = !("error" in r)
          state.connected = ok
          if (ok) cell.markReady()
          else cell.markFailed()
          resolve(ok)
        }).catch(() => {
          state.connected = false
          cell.markFailed()
          resolve(false)
        })
      } catch { resolve(false) }
    })
  }

  isConnected(name: string): boolean {
    return this.servers.get(name)?.connected ?? false
  }

  private rejectAllPending(state: ServerState, reason: string) {
    for (const resolve of state.pending.values()) resolve({ error: reason })
    state.pending.clear()
  }

  private _tryParseResponse(state: ServerState) {
    const headerMatch = state.buffer.match(/^Content-Length: (\d+)\r?\n\r?\n/)
    if (!headerMatch) return
    const length = parseInt(headerMatch[1]!)
    const headerEnd = headerMatch[0]!.length
    if (state.buffer.length < headerEnd + length) return

    const body = state.buffer.slice(headerEnd, headerEnd + length)
    state.buffer = state.buffer.slice(headerEnd + length)
    try {
      const data = JSON.parse(body) as Record<string, unknown>
      const id = typeof data.id === "number" ? data.id : -1
      const resolve = state.pending.get(id)
      if (resolve) {
        state.pending.delete(id)
        resolve(data)
      }
    } catch { /* */ }
    this._tryParseResponse(state)
  }

  private _send(name: string, method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return new Promise(resolve => {
      const srv = this.servers.get(name)
      if (!srv) { resolve({ error: `MCP server '${name}' not connected` }); return }

      const id = ++this.reqId
      const req = JSON.stringify({ jsonrpc: "2.0", id, method, params })
      const header = `Content-Length: ${Buffer.byteLength(req)}\r\n\r\n`
      srv.pending.set(id, resolve)
      srv.proc.stdin?.write(header + req)
    })
  }

  async discoverTools(name: string): Promise<Array<Record<string, unknown>>> {
    const resp = await this._send(name, "tools/list")
    if ("error" in resp) return []
    const tools = (resp.result as Record<string, unknown>)?.tools as Array<Record<string, unknown>> ?? []
    const srv = this.servers.get(name)
    if (srv) srv.tools = tools
    return tools
  }

  async callTool(name: string, toolName: string, args: Record<string, unknown>): Promise<string> {
    const resp = await this._send(name, "tools/call", { name: toolName, arguments: args })
    if ("error" in resp) return `Error: ${resp.error}`
    const content = (resp.result as Record<string, unknown>)?.content as Array<Record<string, unknown>> ?? []
    return content.map(c => (c.text as string) ?? JSON.stringify(c)).join("\n")
  }

  async discoverResources(name: string): Promise<Array<Record<string, unknown>>> {
    const resp = await this._send(name, "resources/list")
    if ("error" in resp) return []
    const resources = (resp.result as Record<string, unknown>)?.resources as Array<Record<string, unknown>> ?? []
    const srv = this.servers.get(name)
    if (srv) srv.resources = resources
    return resources
  }

  async readResource(name: string, uri: string): Promise<string> {
    const resp = await this._send(name, "resources/read", { uri })
    if ("error" in resp) return `Error: ${resp.error}`
    const contents = (resp.result as Record<string, unknown>)?.contents as Array<Record<string, unknown>> ?? []
    return contents.map(c => (c.text as string) ?? (c.uri as string) ?? JSON.stringify(c)).join("\n")
  }

  async buildMcpToolDefs(): Promise<ToolDef[]> {
    const defs: ToolDef[] = []
    for (const [serverName, srv] of this.servers) {
      const tools = await this.discoverTools(serverName)
      for (const t of tools) {
        const toolName = t.name as string ?? "unknown"
        // RC-05 B5: 未知能力默认不安全——isReadonly/isConcurrencySafe 默认 false。
        // MCP 服务端 manifest 声明 readonly/concurrency-safe 能力时才提升。
        const declaredReadonly = Boolean((t as Record<string, unknown>).readonly === true)
        const declaredConcurrencySafe = Boolean((t as Record<string, unknown>).concurrencySafe === true)
        defs.push({
          name: `mcp_${toolName}`,
          description: `[MCP:${serverName}] ${(t.description as string) ?? ""}`.slice(0, 300),
          isReadonly: declaredReadonly,
          isConcurrencySafe: declaredConcurrencySafe,
          contract: { provenance: "mcp" },
          inputSchema: (t.inputSchema ?? t.input_schema ?? { type: "object", properties: {} }) as Record<string, unknown>,
          execute: async (params: Record<string, unknown>): Promise<ToolResult> => {
            try {
              return Result.ok(await this.callTool(serverName, toolName, params))
            } catch (e) {
              return Result.fail(e instanceof Error ? e.message : String(e))
            }
          },
        })
      }
    }
    return defs
  }

  shutdown(name: string) {
    const srv = this.servers.get(name)
    if (srv) {
      this.rejectAllPending(srv, "MCP server shut down")
      srv.proc.kill()
      this.servers.delete(name)
    }
  }

  shutdownAll() { for (const name of this.servers.keys()) this.shutdown(name) }
}
