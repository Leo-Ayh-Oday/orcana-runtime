/** ToolRiskTaxonomy — Risk 0-5 classification for every tool invocation.
 *
 *  PR-5.1: Defines the risk taxonomy, maps tools to risk levels, and provides
 *  the gate logic that prevents Risk 4-5 tools from being auto-allowed via
 *  session-level permission overrides.
 *
 *  Risk levels:
 *   0 — Safe readonly: pure information retrieval, zero side effects
 *   1 — Read with context: reveals system/project state (git reads)
 *   2 — File write: modifies project files under version control
 *   3 — Network: external communication (web_search, web_fetch)
 *   4 — Shell execution / git mutation: side effects outside project scope
 *   5 — Destructive: irreversible damage possible (global deny)
 *
 *  Key invariant:
 *   Risk 4-5 tools MUST NEVER be session-allowed. Each invocation requires
 *   individual user confirmation. The permission gate's session allow()
 *   override is ignored for these tools.
 */

import type { ToolDescriptor } from "../tools/registry"
import type { ToolCategory } from "./permission"

// ── Risk level ──

export type RiskLevel = 0 | 1 | 2 | 3 | 4 | 5

export interface RiskProfile {
  level: RiskLevel
  category: ToolCategory
  /** True when the tool requires per-invocation user confirmation. */
  requiresConfirmation: boolean
  /** True when the tool can be session-allowed (false for Risk 4-5). */
  sessionAllowable: boolean
  /** Human-readable risk description. */
  description: string
}

// ── High-risk threshold ──

const HIGH_RISK_THRESHOLD: RiskLevel = 4

export function isHighRisk(level: RiskLevel): boolean {
  return level >= HIGH_RISK_THRESHOLD
}

// ── Per-tool risk profiles ──

/** Risk profiles keyed by tool name. Tools NOT listed here default to
 *  category-based inference via inferDefaultRisk(). */
const TOOL_RISK_MAP: Record<string, RiskProfile> = {
  // ── Risk 0: Safe readonly ──
  read_file:             { level: 0, category: "safe",    requiresConfirmation: false, sessionAllowable: true, description: "读取文件内容，无副作用" },
  find_symbol:           { level: 0, category: "safe",    requiresConfirmation: false, sessionAllowable: true, description: "LSP 符号搜索，无副作用" },
  find_references:       { level: 0, category: "safe",    requiresConfirmation: false, sessionAllowable: true, description: "LSP 引用搜索，无副作用" },
  project_structure:     { level: 0, category: "safe",    requiresConfirmation: false, sessionAllowable: true, description: "项目结构查询，无副作用" },
  lsp_diagnostics:       { level: 0, category: "safe",    requiresConfirmation: false, sessionAllowable: true, description: "LSP 诊断信息，无副作用" },
  lsp_hover:             { level: 0, category: "safe",    requiresConfirmation: false, sessionAllowable: true, description: "LSP 悬停信息，无副作用" },
  lsp_definition:        { level: 0, category: "safe",    requiresConfirmation: false, sessionAllowable: true, description: "LSP 定义跳转，无副作用" },
  lsp_references:        { level: 0, category: "safe",    requiresConfirmation: false, sessionAllowable: true, description: "LSP 引用跳转，无副作用" },
  typescript_no_emit:    { level: 0, category: "safe",    requiresConfirmation: false, sessionAllowable: true, description: "TypeScript 类型检查，无副作用" },
  codegraph_search:      { level: 0, category: "safe",    requiresConfirmation: false, sessionAllowable: true, description: "代码图搜索，无副作用" },

  // ── Risk 1: Read with context ──
  git_status:            { level: 1, category: "git",     requiresConfirmation: false, sessionAllowable: true, description: "Git 状态查询" },
  git_diff:              { level: 1, category: "git",     requiresConfirmation: false, sessionAllowable: true, description: "Git 差异查询" },
  git_log:               { level: 1, category: "git",     requiresConfirmation: false, sessionAllowable: true, description: "Git 日志查询" },
  git_blame:             { level: 1, category: "git",     requiresConfirmation: false, sessionAllowable: true, description: "Git blame 查询" },
  task:                  { level: 1, category: "safe",    requiresConfirmation: false, sessionAllowable: true, description: "任务管理操作" },

  // ── Risk 2: File write ──
  write_file:            { level: 2, category: "file",    requiresConfirmation: false, sessionAllowable: true, description: "写入/覆盖文件" },
  edit_file:             { level: 2, category: "file",    requiresConfirmation: false, sessionAllowable: true, description: "编辑文件内容" },
  multi_edit:            { level: 2, category: "file",    requiresConfirmation: false, sessionAllowable: true, description: "多处文件编辑" },
  edit_fim:              { level: 2, category: "file",    requiresConfirmation: false, sessionAllowable: true, description: "FIM 编辑器" },
  rollback_transaction:  { level: 2, category: "file",    requiresConfirmation: false, sessionAllowable: true, description: "回滚事务" },

  // ── Risk 3: Network ──
  web_search:            { level: 3, category: "network", requiresConfirmation: false, sessionAllowable: true, description: "网络搜索" },
  web_fetch:             { level: 3, category: "network", requiresConfirmation: false, sessionAllowable: true, description: "网页抓取" },

  // ── Risk 4: Shell execution / Git mutation ──
  shell:                 { level: 4, category: "shell",   requiresConfirmation: true,  sessionAllowable: false, description: "Shell 命令执行，可能产生外部副作用" },
  start_service:         { level: 4, category: "shell",   requiresConfirmation: true,  sessionAllowable: false, description: "启动后台服务" },
  git_commit:            { level: 4, category: "git",     requiresConfirmation: true,  sessionAllowable: false, description: "Git 提交" },
  git_push:              { level: 4, category: "git",     requiresConfirmation: true,  sessionAllowable: false, description: "Git 推送" },
  git_branch:            { level: 4, category: "git",     requiresConfirmation: true,  sessionAllowable: false, description: "Git 分支操作" },
  git_merge:             { level: 4, category: "git",     requiresConfirmation: true,  sessionAllowable: false, description: "Git 合并操作" },
  git_rebase:            { level: 4, category: "git",     requiresConfirmation: true,  sessionAllowable: false, description: "Git 变基操作" },
  git_reset:             { level: 4, category: "git",     requiresConfirmation: true,  sessionAllowable: false, description: "Git 重置操作" },
  git_stash:             { level: 4, category: "git",     requiresConfirmation: true,  sessionAllowable: false, description: "Git 暂存操作" },
  git_tag:               { level: 4, category: "git",     requiresConfirmation: true,  sessionAllowable: false, description: "Git 标签操作" },
}

/** Map of param-based Risk-5 patterns. These override the tool's base risk
 *  when a destructive pattern is detected in the parameters. */
const RISK_5_PARAM_PATTERNS: Array<{
  toolName: string
  paramKey: string
  pattern: RegExp
  description: string
}> = [
  {
    toolName: "shell",
    paramKey: "command",
    pattern: /rm\s+-rf\s+\/|:\(\)\s*\{\s*:\|:&\s*\};:|mkfs\.|dd\s+if=\/dev\/zero/i,
    description: "高危破坏性命令 (rm -rf / / fork bomb / 磁盘擦除)",
  },
  {
    toolName: "shell",
    paramKey: "command",
    pattern: /curl.*\|\s*(ba)?sh|wget.*\|\s*(ba)?sh/i,
    description: "管道执行远程脚本 (curl|sh)",
  },
  {
    toolName: "shell",
    paramKey: "command",
    pattern: />\s*\/dev\/sda|>\s*\/dev\/nvme/i,
    description: "直接写入块设备",
  },
  {
    toolName: "write_file",
    paramKey: "file_path",
    pattern: /\.env$|\.env\.local$|credentials\.json$|\.pem$|id_rsa$|id_ecdsa$|id_ed25519$/i,
    description: "覆盖敏感配置文件/密钥",
  },
  {
    toolName: "shell",
    paramKey: "command",
    pattern: /chmod\s+777\s+\/|chown\s+-R\s+\//i,
    description: "危险权限修改",
  },
]

// ── Category → default risk ──

const CATEGORY_DEFAULT_RISK: Record<ToolCategory, RiskProfile> = {
  safe:    { level: 0, category: "safe",    requiresConfirmation: false, sessionAllowable: true,  description: "安全操作（默认）" },
  file:    { level: 2, category: "file",    requiresConfirmation: false, sessionAllowable: true,  description: "文件操作（默认）" },
  network: { level: 3, category: "network", requiresConfirmation: false, sessionAllowable: true,  description: "网络操作（默认）" },
  shell:   { level: 4, category: "shell",   requiresConfirmation: true,  sessionAllowable: false, description: "Shell 操作（默认）" },
  git:     { level: 1, category: "git",     requiresConfirmation: false, sessionAllowable: true,  description: "Git 操作（默认）" },
}

// ── Public API ──

/**
 * Get the risk profile for a tool call.
 *
 * Priority:
 *   1. Risk-5 param patterns (destructive → overrides everything)
 *   2. Explicit TOOL_RISK_MAP entry
 *   3. Tool descriptor's declared category → category default risk
 *   4. Fallback: readonly → Risk 0 / write → Risk 4
 */
export function getToolRisk(
  toolName: string,
  params: Record<string, unknown>,
  tool?: ToolDescriptor,
): RiskProfile {
  // 1. Check Risk-5 param patterns first (most dangerous)
  for (const rule of RISK_5_PARAM_PATTERNS) {
    if (rule.toolName !== toolName) continue
    const value = String(params[rule.paramKey] ?? "")
    if (rule.pattern.test(value)) {
      return {
        level: 5,
        category: "shell",
        requiresConfirmation: true,
        sessionAllowable: false,
        description: rule.description,
      }
    }
  }

  // 2. Explicit tool risk map
  if (TOOL_RISK_MAP[toolName]) {
    return TOOL_RISK_MAP[toolName]
  }

  // 3. Category-based default
  if (tool?.defn.category) {
    return CATEGORY_DEFAULT_RISK[tool.defn.category] ?? CATEGORY_DEFAULT_RISK.shell
  }

  // 4. Fallback: readonly → safe, write → shell risk
  if (tool?.defn.isReadonly) {
    return CATEGORY_DEFAULT_RISK.safe
  }

  // Unknown write tool — conservative: treat as Risk 4
  return {
    level: 4,
    category: "shell",
    requiresConfirmation: true,
    sessionAllowable: false,
    description: `未知写入工具 ${toolName}，保守按高风险处理`,
  }
}

/**
 * Check whether a tool with the given risk profile can be auto-allowed
 * in "full" permission mode. Risk 4-5 tools must always go through the
 * "ask" path regardless of session state.
 */
export function canAutoAllow(risk: RiskProfile): boolean {
  return risk.sessionAllowable
}

/**
 * Format a risk-blocked message for the agent context.
 */
export function formatRiskBlockMessage(
  toolName: string,
  risk: RiskProfile,
  params: Record<string, unknown>,
): string {
  if (risk.level === 5) {
    return [
      `<system-reminder>`,
      `[风险阻止 Risk-5] ${risk.description}`,
      `工具: ${toolName}`,
      `参数: ${JSON.stringify(params).slice(0, 200)}`,
      ``,
      `此操作属于最高风险级别，已被永久禁止。不要重试。`,
      `寻找不会造成不可逆损害的替代方案。`,
      `</system-reminder>`,
    ].join("\n")
  }

  return [
    `<system-reminder>`,
    `[风险确认 Risk-${risk.level}] ${risk.description}`,
    `工具: ${toolName}`,
    `参数: ${JSON.stringify(params).slice(0, 200)}`,
    ``,
    `此操作需要用户逐次确认（不允许会话级自动批准）。`,
    `在回复中解释为什么需要执行此操作，等待用户批准。`,
    `</system-reminder>`,
  ].join("\n")
}
