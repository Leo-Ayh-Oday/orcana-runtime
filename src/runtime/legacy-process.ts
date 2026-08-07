/** R1.2 遗留进程入口 —— 唯一允许的 sync/长期 spawn 审计面。
 *
 *  ⚠️ 状态：pending migration。本模块是 LINUX 单一进程入口闭环的暂存区：
 *  所有尚未异步化的调用方（git worktree、验证收集器、journal、astgrep、
 *  服务、MCP、LSP）必须通过这里，禁止在 src/ 其他位置直接导入
 *  node:child_process。AST 静态门禁强制此约束（旁路 = 0）。
 *
 *  迁移目标（按序）：
 *  1. worktree/collector/journal/astgrep → ProcessExecutor（短时命令）
 *  2. service/mcp/lsp → Service Cell（长期进程 + PortLease + 恢复）
 *
 *  本模块不做任何宿主环境净化（与 Executor 不同）——这正是待迁移原因。
 */

import { spawn as nodeSpawn, spawnSync as nodeSpawnSync, execSync as nodeExecSync } from "node:child_process"
import type { ChildProcess, SpawnSyncOptions, SpawnOptions, ExecSyncOptions } from "node:child_process"
import { hostKeyDenied } from "./linux/environment"
export type { ChildProcess }

/** LNXF-R2 E1：暂存区最小宿主环境 —— 白名单键 + 显式 extra（extra 中命中
 *  默认拒绝集的键被过滤）。service/MCP/LSP 等长期进程必须用它启动，
 *  禁止 `{...process.env}`（宿主 API key/代理/SSH 凭据零泄露）。
 *  完全净化在迁移 Executor/Service Cell 后由编译层接管。 */
const LEGACY_ALLOWED_HOST_KEYS = [
  "PATH", "HOME", "TMPDIR", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE",
  "TERM", "USER", "LOGNAME", "CI", "EDITOR", "VISUAL", "SHELL",
]

export function minimalHostEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of LEGACY_ALLOWED_HOST_KEYS) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (hostKeyDenied(key)) continue
      env[key] = value
    }
  }
  return env
}

/** sync spawn（git worktree / 验证收集器 / journal 回放）。 */
export function spawnSyncLegacy(
  executable: string,
  args: string[],
  options: SpawnSyncOptions = {},
): ReturnType<typeof nodeSpawnSync> {
  return nodeSpawnSync(executable, args, options)
}

/** 长期进程 spawn（服务 / MCP / LSP）。 */
export function spawnLegacy(
  command: string,
  args: string[],
  options: SpawnOptions = {},
): ChildProcess {
  return nodeSpawn(command, args, options)
}

/** shell 字符串执行（astgrep `sg scan` 等尚需 shell 拼接的调用）。 */
export function execShellLegacy(command: string, options: ExecSyncOptions = {}): string {
  const out = nodeExecSync(command, options)
  return Buffer.isBuffer(out) ? out.toString("utf-8") : String(out)
}
