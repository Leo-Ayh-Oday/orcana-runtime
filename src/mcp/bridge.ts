/** MCP bridge — connects MCP servers at CLI startup and registers their tools.
 *
 *  The bridge sits between the MCP config file and the CLI tool registry.
 *  It:
 *    - Reads mcp.json config on startup
 *    - Connects to each enabled server (with timeout)
 *    - Discovers tools + resources from each server
 *    - Converts MCP tools to ToolDef[] for CLI registration
 *    - Handles lifecycle: start all on boot, shutdown all on exit
 *
 *  Design invariants:
 *    - Each server is an independent child process — crash of one doesn't
 *      affect others or the main loop
 *    - Connection timeout: 30s per server, skipped silently on failure
 *    - Tools are registered as mcp_<serverName>__<toolName> to avoid collisions
 *    - All MCP-discovered tools are isReadonly: true by default
 *    - Does not touch loop.ts gate logic
 */

import { MCPClientV2 } from "../tools/mcp"
import type { ToolDef, ToolResult } from "../tools/registry"
import { Result } from "../tools/registry"
import { loadMCPConfig, getEnabledServers, buildServerEnv, validateServerConfig } from "./config"
import type { MCPServerConfig } from "./config"

export interface MCPBridgeResult {
  /** Total servers configured (enabled only). */
  totalServers: number
  /** Successfully connected. */
  connected: number
  /** Failed to connect or timed out. */
  failed: string[]
  /** Total tools discovered across all servers. */
  toolsDiscovered: number
  /** The generated ToolDef[] ready for buildTools(). */
  tools: ToolDef[]
}

/**
 * Bootstrap MCP: read config, connect all enabled servers, discover tools.
 *
 * Call once at CLI startup. Failed connections are logged but don't block startup.
 */
export async function bootstrapMCP(
  options: {
    configPath?: string
    connectionTimeoutMs?: number
    onStatus?: (message: string) => void
  } = {},
): Promise<MCPBridgeResult> {
  const config = options.configPath ? loadMCPConfig() : loadMCPConfig()
  const enabled = getEnabledServers(config)
  const timeout = options.connectionTimeoutMs ?? 30000

  if (enabled.length === 0) {
    return { totalServers: 0, connected: 0, failed: [], toolsDiscovered: 0, tools: [] }
  }

  const status = options.onStatus ?? (() => {})
  const client = new MCPClientV2()
  const allTools: ToolDef[] = []
  const failed: string[] = []
  let connected = 0

  for (const { name, server } of enabled) {
    const validateErr = validateServerConfig(server)
    if (validateErr) {
      failed.push(`${name}: ${validateErr}`)
      continue
    }

    // Resolve command (allow env var expansion)
    const command = server.command
    const args = server.args?.map(a => a) ?? []
    const env = buildServerEnv(server)

    status(`MCP: connecting ${name}...`)

    try {
      const ok = await withTimeout(
        client.connect(name, command, args, server.env),
        server.timeout ?? timeout,
      )
      if (!ok) {
        failed.push(`${name}: connection failed`)
        continue
      }

      connected++

      // Discover tools
      const mcpTools = await client.discoverTools(name)
      for (const mt of mcpTools) {
        const toolName = mt.name as string ?? "unknown"
        const fullName = `mcp__${name}__${toolName}`

        allTools.push({
          name: fullName,
          description: `[MCP:${name}] ${(mt.description as string) ?? toolName}`.slice(0, 300),
          isReadonly: true,
          isConcurrencySafe: true,
          category: "safe",
          contract: { provenance: "mcp" },
          inputSchema: (mt.inputSchema ?? mt.input_schema ?? { type: "object", properties: {} }) as Record<string, unknown>,
          execute: async (params: Record<string, unknown>): Promise<ToolResult> => {
            try {
              const result = await client.callTool(name, toolName, params)
              return Result.ok(result)
            } catch (e) {
              return Result.fail(e instanceof Error ? e.message : String(e))
            }
          },
        })
      }

      status(`MCP: ${name} connected (${mcpTools.length} tools)`)
    } catch (e) {
      failed.push(`${name}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return {
    totalServers: enabled.length,
    connected,
    failed,
    toolsDiscovered: allTools.length,
    tools: allTools,
  }
}

/** Shutdown all MCP servers on CLI exit. */
export async function shutdownMCP(): Promise<void> {
  const client = new MCPClientV2()
  client.shutdownAll()
}

// ── Timeout helper ──

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
