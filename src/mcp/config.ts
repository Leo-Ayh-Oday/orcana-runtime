/** MCP configuration — reads/writes ~/.orcana/mcp.json.
 *
 *  Format:
 *  {
 *    "servers": {
 *      "codegraph": {
 *        "command": "codegraph",
 *        "args": ["serve"],
 *        "env": { "HOME": "/home/user" }
 *      },
 *      "context7": {
 *        "command": "npx",
 *        "args": ["-y", "@upstash/context7-mcp"],
 *        "enabled": false
 *      }
 *    }
 *  }
 *
 *  - "command": executable (required)
 *  - "args": arguments array (default [])
 *  - "env": extra environment variables (default {})
 *  - "enabled": whether to auto-start (default true)
 *  - "timeout": connection timeout in ms (default 30000)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

export interface MCPServerConfig {
  command: string
  args: string[]
  env?: Record<string, string>
  enabled?: boolean
  timeout?: number
}

export interface MCPConfig {
  servers: Record<string, MCPServerConfig>
}

const DEFAULT_CONFIG: MCPConfig = {
  servers: {},
}

function configPath(): string {
  const dir = join(homedir(), ".orcana")
  mkdirSync(dir, { recursive: true })
  return join(dir, "mcp.json")
}

/** Load MCP configuration from disk. Returns default if file doesn't exist. */
export function loadMCPConfig(): MCPConfig {
  const path = configPath()
  if (!existsSync(path)) return { ...DEFAULT_CONFIG }

  try {
    const raw = readFileSync(path, "utf-8")
    const parsed = JSON.parse(raw) as Partial<MCPConfig>
    return {
      servers: parsed.servers ?? {},
    }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

/** Save MCP configuration to disk (atomic: write to temp, rename). */
export function saveMCPConfig(config: MCPConfig): void {
  const path = configPath()
  const temp = path + ".tmp"
  writeFileSync(temp, JSON.stringify(config, null, 2), "utf-8")
  const { renameSync, unlinkSync } = require("node:fs") as typeof import("node:fs")
  try { unlinkSync(path) } catch { /* may not exist */ }
  renameSync(temp, path)
}

/** Get enabled server configs only. */
export function getEnabledServers(config: MCPConfig): Array<{ name: string; server: MCPServerConfig }> {
  return Object.entries(config.servers)
    .filter(([, server]) => server.enabled !== false)
    .map(([name, server]) => ({ name, server }))
}

/** Expand environment variables in a string value. Supports $VAR and ${VAR} syntax. */
export function expandEnv(value: string): string {
  return value.replace(/\$\{?(\w+)\}?/g, (_, name: string) => process.env[name] ?? "")
}

/** Build the full environment for a server process. */
export function buildServerEnv(server: MCPServerConfig): Record<string, string> {
  return { ...process.env as Record<string, string>, ...server.env }
}

/** Validate a server config. Returns error string or null if valid. */
export function validateServerConfig(server: MCPServerConfig): string | null {
  if (!server.command || typeof server.command !== "string") {
    return "server.command 必须是字符串"
  }
  if (server.args && !Array.isArray(server.args)) {
    return "server.args 必须是数组"
  }
  if (server.timeout && (typeof server.timeout !== "number" || server.timeout < 1000)) {
    return "server.timeout 必须 ≥ 1000ms"
  }
  return null
}
