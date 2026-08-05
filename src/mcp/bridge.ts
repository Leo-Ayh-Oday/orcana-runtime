/** MCP bridge — connects MCP servers at CLI startup and registers their tools.
 *
 *  The bridge sits between the MCP config file and the CLI tool registry.
 *  It:
 *    - Reads mcp.json config on startup
 *    - Connects to each enabled server (with timeout)
 *    - Discovers tools + resources from each server
 *    - Applies each server's MCPTrustPolicy (RT-11): unknown tools default to
 *      non-readonly high risk with first-execution confirmation; annotations
 *      are hints only; deny/allow patterns filter the exposed surface
 *    - Converts MCP tools to ToolDef[] for CLI registration
 *    - Handles lifecycle: start all on boot, shutdown all on exit (single
 *      shared client — shutdown actually stops the servers it connected)
 *
 *  Design invariants:
 *    - Each server is an independent child process — crash of one doesn't
 *      affect others or the main loop
 *    - Connection timeout: 30s per server, skipped silently on failure
 *    - Tools are registered as mcp_<serverName>__<toolName> to avoid collisions
 *    - Trust is decided locally per server policy — MCP annotations never
 *      directly determine read-only-ness or risk (fail-closed)
 *    - Does not touch loop.ts gate logic
 */

import { MCPClientV2 } from "../tools/mcp"
import type { ToolDef, ToolResult } from "../tools/registry"
import { Result } from "../tools/registry"
import { loadMCPConfig, getEnabledServers, buildServerEnv, validateServerConfig } from "./config"
import type { MCPServerConfig } from "./config"
import { evaluateToolTrust, normalizeTrustPolicy, type MCPToolHints } from "./trust-policy"

export interface MCPBridgeResult {
  /** Total servers configured (enabled only). */
  totalServers: number
  /** Successfully connected. */
  connected: number
  /** Failed to connect or timed out. */
  failed: string[]
  /** Total tools discovered across all servers. */
  toolsDiscovered: number
  /** Tools filtered out by server trust policy (deny/allowlist). */
  toolsFiltered: number
  /** The generated ToolDef[] ready for buildTools(). */
  tools: ToolDef[]
}

/** Single shared client so bootstrapMCP and shutdownMCP manage one lifecycle. */
let sharedClient: MCPClientV2 | null = null

function client(): MCPClientV2 {
  if (!sharedClient) sharedClient = new MCPClientV2()
  return sharedClient
}

function toolHintsFromAnnotations(tool: Record<string, unknown>): MCPToolHints {
  const annotations = tool.annotations as Record<string, unknown> | undefined
  if (!annotations || typeof annotations !== "object") return {}
  return {
    readOnlyHint: annotations.readOnlyHint === true ? true : undefined,
    destructiveHint: annotations.destructiveHint === true ? true : undefined,
    idempotentHint: annotations.idempotentHint === true ? true : undefined,
    openWorldHint: annotations.openWorldHint === true ? true : undefined,
  }
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
    return { totalServers: 0, connected: 0, failed: [], toolsDiscovered: 0, toolsFiltered: 0, tools: [] }
  }

  const status = options.onStatus ?? (() => {})
  const clientInstance = client()
  const allTools: ToolDef[] = []
  const failed: string[] = []
  let connected = 0
  let toolsFiltered = 0

  for (const { name, server } of enabled) {
    const validateErr = validateServerConfig(server)
    if (validateErr) {
      failed.push(`${name}: ${validateErr}`)
      continue
    }

    const trust = normalizeTrustPolicy(server.trust)

    // Resolve command (allow env var expansion)
    const command = server.command
    const args = server.args?.map(a => a) ?? []
    const env = buildServerEnv(server)

    status(`MCP: connecting ${name} (trust=${trust.trust})...`)

    try {
      const ok = await withTimeout(
        clientInstance.connect(name, command, args, server.env),
        server.timeout ?? timeout,
      )
      if (!ok) {
        failed.push(`${name}: connection failed`)
        continue
      }

      connected++

      // Discover tools
      const mcpTools = await clientInstance.discoverTools(name)
      for (const mt of mcpTools) {
        const toolName = (mt.name as string | undefined) ?? "unknown"
        const fullName = `mcp__${name}__${toolName}`

        const decision = evaluateToolTrust(trust, toolName, toolHintsFromAnnotations(mt))
        if (!decision.allowed) {
          toolsFiltered++
          status(`MCP: ${name} tool ${toolName} filtered (${decision.reason})`)
          continue
        }

        const callTimeoutMs = server.timeout ?? 30000
        allTools.push({
          name: fullName,
          description: `[MCP:${name}] ${(mt.description as string) ?? toolName}`.slice(0, 300),
          isReadonly: decision.readOnly,
          isConcurrencySafe: decision.readOnly,
          requiresConfirmation: decision.requiresConfirmation,
          category: decision.readOnly ? ("safe" as const) : ("shell" as const),
          contract: {
            provenance: "mcp",
            sideEffects: decision.readOnly ? [] : ["network", "external_process"],
            resultBudget: { maxChars: 30_000, maxLines: 400, overflow: "clip" },
          },
          inputSchema: (mt.inputSchema ?? mt.input_schema ?? { type: "object", properties: {} }) as Record<string, unknown>,
          execute: async (params: Record<string, unknown>): Promise<ToolResult> => {
            try {
              const result = await withTimeout(
                clientInstance.callTool(name, toolName, params),
                callTimeoutMs,
              )
              return Result.ok(result)
            } catch (e) {
              return Result.fail(e instanceof Error ? e.message : String(e))
            }
          },
        })
      }

      status(`MCP: ${name} connected (${mcpTools.length} tools, ${trust.trust})`)
    } catch (e) {
      failed.push(`${name}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return {
    totalServers: enabled.length,
    connected,
    failed,
    toolsDiscovered: allTools.length + toolsFiltered,
    toolsFiltered,
    tools: allTools,
  }
}

/** Shutdown all MCP servers on CLI exit. */
export async function shutdownMCP(): Promise<void> {
  if (sharedClient) {
    sharedClient.shutdownAll()
    sharedClient = null
  }
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
