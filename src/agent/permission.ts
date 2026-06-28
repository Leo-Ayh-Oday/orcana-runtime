/** Permission Gate — tool access control with deny/ask/allow three-value logic.
 *
 *  Design invariants:
 *    - Deny always overrides Allow (security-first)
 *    - Per-session state: permissions reset on new session
 *    - Tool categories drive default permissions: safe→allow, file→ask, network→ask, shell→ask, git→allow
 *    - Ask mode: tool is blocked with explanation; agent can re-request with justification
 *
 *  This is an MVP, not the Claude Code 7-layer system. Three values are sufficient
 *  for safe external use. Additional layers (sandbox, ML classifier) are P2 items.
 */

import type { ToolDescriptor } from "../tools/registry"
import type { PermissionRule } from "./permission-config"
import { matchFirstRule } from "./permission-config"

// ── Types ──

export type PermissionLevel = "allow" | "ask" | "deny"
export type ToolCategory = "safe" | "file" | "network" | "shell" | "git"

export interface PermissionResult {
  allowed: boolean
  level: PermissionLevel
  reason: string
}

// ── Category → default permission ──

const CATEGORY_DEFAULTS: Record<ToolCategory, PermissionLevel> = {
  safe:    "allow",
  file:    "ask",
  network: "ask",
  shell:   "ask",
  git:     "allow",
}

/** Human-readable labels for blocked-tool messages */
function categoryLabel(cat: ToolCategory): string {
  switch (cat) {
    case "safe": return "安全操作"
    case "file": return "文件写入"
    case "network": return "网络请求"
    case "shell": return "Shell 命令"
    case "git": return "Git 操作"
  }
}

export function inferToolCategory(toolName: string, tool?: ToolDescriptor): ToolCategory {
  if (tool?.defn.category) return tool.defn.category
  if (["read_file", "find_symbol", "find_references", "project_structure", "lsp_diagnostics", "lsp_hover", "lsp_definition", "lsp_references", "typescript_no_emit"].includes(toolName)) return "safe"
  if (["write_file", "edit_file", "multi_edit", "edit_fim", "rollback_transaction"].includes(toolName)) return "file"
  if (["git_status", "git_diff", "git_log", "git_blame"].includes(toolName)) return "git"
  if (["web_search", "web_fetch"].includes(toolName)) return "network"
  if (["shell", "start_service"].includes(toolName)) return "shell"
  return tool?.defn.isReadonly ? "safe" : "shell"
}

// ── Deny list — never allow these operations ──

interface DenyRule {
  toolName: string
  /** If set, only deny when param value matches this regex */
  paramKey?: string
  paramPattern?: RegExp
  reason: string
}

const GLOBAL_DENY_RULES: DenyRule[] = [
  {
    toolName: "shell",
    paramKey: "command",
    paramPattern: /rm\s+-rf\s+\/|:\s+(){ :\|:&\s*};:|mkfs\.|dd\s+if=/i,
    reason: "高危命令被全局禁止（fork bomb / 磁盘擦除 / rm -rf /）",
  },
  {
    toolName: "shell",
    paramKey: "command",
    paramPattern: /curl.*\|\s*(ba)?sh|wget.*\|\s*(ba)?sh/i,
    reason: "禁止管道执行远程脚本（curl|sh / wget|sh）",
  },
  {
    toolName: "write_file",
    paramKey: "file_path",
    paramPattern: /\.env$|\.env\.local$|credentials\.json$|\.pem$/i,
    reason: "禁止覆盖敏感配置文件（.env / credentials / .pem）",
  },
]

// ── Permission Gate ──

export class PermissionGate {
  /** Per-session overrides: user can promote (ask→allow) or demote (allow→deny) */
  private overrides = new Map<string, PermissionLevel>()

  /** Config-sourced rules (user-level + project-level, separated for priority) */
  private userDenyRules: PermissionRule[] = []
  private userAllowRules: PermissionRule[] = []
  private projectDenyRules: PermissionRule[] = []
  private projectAllowRules: PermissionRule[] = []

  /** Reset session state (call on new session) */
  reset() {
    this.overrides.clear()
  }

  /** Promote a tool to allow for the rest of the session */
  allow(toolName: string) {
    this.overrides.set(toolName, "allow")
  }

  /** Demote a tool to deny for the rest of the session */
  deny(toolName: string, _reason?: string) {
    this.overrides.set(toolName, "deny")
  }

  /** Load config-sourced rules. Clear then load user → project for correct priority. */
  loadRules(userRules: PermissionRule[], projectRules: PermissionRule[]) {
    this.userDenyRules = userRules.filter(r => r.level === "deny")
    this.userAllowRules = userRules.filter(r => r.level === "allow")
    this.projectDenyRules = projectRules.filter(r => r.level === "deny")
    this.projectAllowRules = projectRules.filter(r => r.level === "allow")
  }

  /** Unload all config-sourced rules (back to built-in only). */
  unloadRules() {
    this.userDenyRules.length = 0
    this.userAllowRules.length = 0
    this.projectDenyRules.length = 0
    this.projectAllowRules.length = 0
  }

  /** Check whether a tool call is permitted.
   *
   *  Priority chain:
   *    1. GLOBAL_DENY_RULES           (physics — cannot be overridden)
   *    2. User Deny                   (~/.deepseek-code/permissions.json)
   *    3. Project Deny                (<root>/.deepseek-code/permissions.json)
   *    4. Session Deny Override       (gate.deny())
   *    5. Session Allow Override      (gate.allow()) — blocked for Risk 4-5
   *    6. Project Allow               (<root>/.deepseek-code/permissions.json)
   *    7. User Allow                  (~/.deepseek-code/permissions.json)
   *    8. Tool declared permission    (tool.defn.permission)
   *    9. Category default            (safe/git→allow, file/network/shell→ask)
   *
   *  @param opts.riskLevel — If provided and >= 4, session allow overrides
   *    (step 5) are ignored. Risk 4-5 tools require per-invocation confirmation.
   */
  check(toolName: string, params: Record<string, unknown>, tool?: ToolDescriptor, opts?: { riskLevel?: number }): PermissionResult {
    // 1. Global deny rules (highest priority — physics)
    for (const rule of GLOBAL_DENY_RULES) {
      if (rule.toolName !== toolName) continue
      if (rule.paramKey && rule.paramPattern) {
        const value = String(params[rule.paramKey] ?? "")
        if (rule.paramPattern.test(value)) {
          return { allowed: false, level: "deny", reason: rule.reason }
        }
      }
    }

    // 2. User Deny (config)
    const userDeny = matchFirstRule(this.userDenyRules, toolName, params)
    if (userDeny) return { allowed: false, level: "deny", reason: userDeny.reason }

    // 3. Project Deny (config)
    const projectDeny = matchFirstRule(this.projectDenyRules, toolName, params)
    if (projectDeny) return { allowed: false, level: "deny", reason: projectDeny.reason }

    // 4. Session Deny Override
    const override = this.overrides.get(toolName)
    if (override === "deny") {
      return { allowed: false, level: "deny", reason: `用户已明确禁止 ${toolName}` }
    }

    // 5. Session Allow Override — Risk 4-5 tools cannot be session-allowed
    if (override === "allow") {
      if (opts?.riskLevel !== undefined && opts.riskLevel >= 4) {
        return {
          allowed: false,
          level: "ask",
          reason: `高风险工具 ${toolName} (Risk-${opts.riskLevel}) 不允许会话级自动批准，每次调用均需用户确认`,
        }
      }
      return { allowed: true, level: "allow", reason: "用户已授权" }
    }

    // 6. Project Allow (config) — project knows its own needs
    const projectAllow = matchFirstRule(this.projectAllowRules, toolName, params)
    if (projectAllow) return { allowed: true, level: "allow", reason: projectAllow.reason }

    // 7. User Allow (config)
    const userAllow = matchFirstRule(this.userAllowRules, toolName, params)
    if (userAllow) return { allowed: true, level: "allow", reason: userAllow.reason }

    // 8. Tool's declared permission (set by tool author)
    if (tool?.defn.permission) {
      if (tool.defn.permission === "deny") {
        return { allowed: false, level: "deny", reason: `${toolName} 被工具声明为禁止` }
      }
      if (tool.defn.permission === "allow") {
        return { allowed: true, level: "allow", reason: "工具声明为安全" }
      }
    }

    // 9. Category default
    const cat = inferToolCategory(toolName, tool)
    const defaultPerm = CATEGORY_DEFAULTS[cat]
    if (defaultPerm === "deny") {
      return { allowed: false, level: "deny", reason: `${categoryLabel(cat)}被默认禁止: ${toolName}` }
    }
    if (defaultPerm === "allow") {
      return { allowed: true, level: "allow", reason: `${categoryLabel(cat)}默认允许` }
    }

    // defaultPerm === "ask"
    return {
      allowed: false,
      level: "ask",
      reason: `${categoryLabel(cat)}操作需要确认: ${toolName}`,
    }
  }

  /** Build a prompt injection explaining why a tool was blocked. */
  static formatBlockedMessage(toolName: string, result: PermissionResult, params: Record<string, unknown>): string {
    if (result.level === "deny") {
      return [
        `<system-reminder>`,
        `[权限阻止] ${result.reason}`,
        `工具: ${toolName}`,
        `参数: ${JSON.stringify(params).slice(0, 200)}`,
        "",
        `此操作被永久拒绝。不要重试。寻找替代方案或向用户报告阻碍。`,
        `</system-reminder>`,
      ].join("\n")
    }

    // ask level
    return [
      `<system-reminder>`,
      `[权限询问] ${result.reason}`,
      `工具: ${toolName}`,
      `参数: ${JSON.stringify(params).slice(0, 200)}`,
      "",
      `如果你认为此操作是必要的，在回复中解释为什么需要执行此操作。`,
      `用户可以批准或拒绝。如果用户批准，后续同类操作将自动通过。`,
      `</system-reminder>`,
    ].join("\n")
  }

  /** Get current overrides for debugging */
  get sessionState(): ReadonlyMap<string, PermissionLevel> { return this.overrides }
}
