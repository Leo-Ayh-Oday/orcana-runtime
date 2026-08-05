/** MCP client — JSON-RPC lifecycle. Ported from orcana/core/mcp_client.py */

import { spawnLegacy, ChildProcess } from "../runtime/legacy-process"
const spawn = spawnLegacy
import type { ToolDef, ToolResult } from "./registry"
import { Result } from "./registry"

interface ServerState {
  proc: ChildProcess
  tools: Array<Record<string, unknown>>
  resources: Array<Record<string, unknown>>
  buffer: string
  pendingResolve: ((value: Record<string, unknown>) => void) | null
  connected: boolean
}

export class MCPClientV2 {
  private servers: Map<string, ServerState> = new Map()
  private reqId = 0

  connect(name: string, command: string, args: string[] = [], env?: Record<string, string>): Promise<boolean> {
    return new Promise(resolve => {
      try {
        const proc = spawn(command, args, {
          stdio: ["pipe", "pipe", "pipe"],
          env: env ? { ...process.env, ...env } : process.env,
        })
        const state: ServerState = { proc, tools: [], resources: [], buffer: "", pendingResolve: null, connected: false }
        this.servers.set(name, state)

        proc.stdout?.on("data", (chunk: Buffer) => {
          state.buffer += chunk.toString("utf-8")
          this._tryParseResponse(state)
        })

        proc.on("error", () => {
          state.connected = false
          resolve(false)
        })

        proc.on("exit", () => {
          state.connected = false
        })

        this._send(name, "initialize", {
          protocolVersion: "0.1.0",
          capabilities: {},
          clientInfo: { name: "orcana", version: "0.1.0" },
        }).then(r => {
          const ok = !("error" in r)
          state.connected = ok
          resolve(ok)
        }).catch(() => {
          state.connected = false
          resolve(false)
        })
      } catch { resolve(false) }
    })
  }

  isConnected(name: string): boolean {
    return this.servers.get(name)?.connected ?? false
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
      const data = JSON.parse(body)
      if (state.pendingResolve) {
        state.pendingResolve(data)
        state.pendingResolve = null
      }
    } catch { /* */ }
    this._tryParseResponse(state)
  }

  private _send(name: string, method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return new Promise(resolve => {
      const srv = this.servers.get(name)
      if (!srv) { resolve({ error: `MCP server '${name}' not connected` }); return }

      const req = JSON.stringify({ jsonrpc: "2.0", id: ++this.reqId, method, params })
      const header = `Content-Length: ${Buffer.byteLength(req)}\r\n\r\n`
      srv.pendingResolve = resolve
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
        defs.push({
          name: `mcp_${toolName}`,
          description: `[MCP:${serverName}] ${(t.description as string) ?? ""}`.slice(0, 300),
          isReadonly: true,
          isConcurrencySafe: true,
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
    if (srv) { srv.proc.kill(); this.servers.delete(name) }
  }

  shutdownAll() { for (const name of this.servers.keys()) this.shutdown(name) }
}
