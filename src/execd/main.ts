#!/usr/bin/env bun
/** LR2-1（L1-G）：orcana-execd daemon 入口（systemd ExecStart）。
 *
 *  配置：
 *  - ORCANA_EXECD_SOCK       socket 路径（默认 $XDG_RUNTIME_DIR/orcana/execd.sock）
 *  - ORCANA_EXECD_STATE      SQLite 路径（默认 ~/.orcana/runtime/execd/execd.db）
 *  - ORCANA_EXECD_WORKSPACE  workspace 根（默认 process.cwd()）
 *
 *  systemd user service 属性（packaging/orcana-execd.service）：
 *  Delegate=cpu memory pids io / NoNewPrivileges=yes / UMask=0077。
 */

import { homedir } from "node:os"
import { join } from "node:path"
import { createExecd } from "./execd"

function configFromEnv(): { sockPath: string; statePath: string; workspaceHostRoot: string } {
  const runtimeDir = process.env.XDG_RUNTIME_DIR ?? join(homedir(), ".cache")
  return {
    sockPath: process.env.ORCANA_EXECD_SOCK ?? join(runtimeDir, "orcana", "execd.sock"),
    statePath: process.env.ORCANA_EXECD_STATE ?? join(homedir(), ".orcana", "runtime", "execd", "execd.db"),
    workspaceHostRoot: process.env.ORCANA_EXECD_WORKSPACE ?? process.cwd(),
  }
}

async function main(): Promise<void> {
  const config = configFromEnv()
  const execd = createExecd(config)
  await execd.start()
  console.log(`[execd] listening on ${config.sockPath} (state: ${config.statePath})`)

  // 优雅关闭：SIGTERM（systemd stop）/ SIGINT。
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[execd] ${signal} received, shutting down`)
    await execd.stop()
    process.exit(0)
  }
  process.on("SIGTERM", () => void shutdown("SIGTERM"))
  process.on("SIGINT", () => void shutdown("SIGINT"))
}

main().catch(error => {
  console.error(`[execd] fatal: ${error instanceof Error ? error.stack : String(error)}`)
  process.exit(1)
})
