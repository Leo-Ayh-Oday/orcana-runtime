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
export type { ChildProcess }

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
