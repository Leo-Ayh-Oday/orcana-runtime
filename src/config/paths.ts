/** 配置文件路径解析。
 *
 *  目录约定（与现有 mcp.json / permissions.json 保持一致）：
 *    ~/.deepseek-code/orcana.jsonc  — 全局 provider/runtime 配置
 *    ~/.deepseek-code/auth.json     — API key 安全存储（0600）
 *    ~/.deepseek-code/tui.jsonc     — TUI 外观/行为配置
 *    ./orcana.jsonc                 — 项目级配置覆盖
 *    ./tui.jsonc                    — 项目级 TUI 配置覆盖
 *
 *  环境变量覆盖：
 *    ORCANA_CONFIG_DIR  — 替换全局配置目录
 *    ORCANA_CONFIG      — 替换全局配置文件路径
 *    ORCANA_TUI_CONFIG  — 替换全局 TUI 配置文件路径
 */

import { join } from "node:path"
import { homedir } from "node:os"

/** 全局配置根目录（可被 ORCANA_CONFIG_DIR 覆盖）。 */
export function globalConfigDir(): string {
  return process.env.ORCANA_CONFIG_DIR ?? join(homedir(), ".deepseek-code")
}

/** 全局 provider/runtime 配置文件路径。 */
export function globalConfigPath(): string {
  return process.env.ORCANA_CONFIG ?? join(globalConfigDir(), "orcana.jsonc")
}

/** 全局 TUI 配置文件路径。 */
export function globalTuiConfigPath(): string {
  return process.env.ORCANA_TUI_CONFIG ?? join(globalConfigDir(), "tui.jsonc")
}

/** 认证存储文件路径（API key，权限 0600）。 */
export function authStorePath(): string {
  return join(globalConfigDir(), "auth.json")
}

/** 项目级配置文件路径（当前工作目录下的 orcana.jsonc）。 */
export function projectConfigPath(cwd: string = process.cwd()): string {
  return join(cwd, "orcana.jsonc")
}

/** 项目级 TUI 配置文件路径。 */
export function projectTuiConfigPath(cwd: string = process.cwd()): string {
  return join(cwd, "tui.jsonc")
}
