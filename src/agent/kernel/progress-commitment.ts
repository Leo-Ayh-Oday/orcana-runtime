/** GS-P4 Action Commitment —— 承诺检测 + 偿付判定。
 *
 *  Owner 定稿语义：动作类型匹配为主，显式目标兼容为辅。
 *  Action Commitment 只回答"承诺之后是否真的动手了"，不回答"是否做成功了"：
 *    - 偿付 = 后续工具调用的 actionClass 匹配承诺类 ∧（承诺含显式目标时）目标兼容
 *      ∧ 工具真实 dispatch（不查结果成败——失败转交 Failure/Retry/Obligation 系统）；
 *    - readonly/无关工具不得偿付 write/verify 等动作承诺；
 *    - 连续 2 轮未偿付 → ACTION_REQUIRED；后续仍未偿付且无其他 EffectiveProgress → STALLED。
 *  明确拒绝："任何工具调用即清偿"（read_file 可无限刷债务）与
 *  "精确目标匹配为默认"（自然语言目标不精确会误杀）。
 */

import type { RoundToolCall } from "../run/types"

export type ActionClass = "inspect" | "write" | "verify" | "execute" | "delete" | "service" | "external"

export interface ActionTarget {
  kind: "file" | "command" | "test-suite" | "service" | "workspace"
  /** 仅在正则明确捕获到具体 token 时填写；自然语言不精确时不填（避免误杀）。 */
  value?: string
}

export interface ActionCommitment {
  actionClass: ActionClass
  target?: ActionTarget
  createdRound: number
  fingerprint: string
  /** 承诺原文（审计/STALLED 报告用）。 */
  text: string
}

// ── 承诺检测（确定性正则，仅无工具调用轮调用） ──

const ZH_PATTERN =
  /(?:将|把|我会|我接下来|下一步|接下来|然后|稍后|先)[^。；\n]{0,40}?(?:写入|落盘|保存|创建|新建|修复|修改|添加|补充|删除|移除|运行|执行|验证|测试|重跑|查看|调查|搜索|访问)[^。；\n]{0,24}/

const EN_PATTERN =
  /\b(?:i'?ll|i will|next|then|plan(?:ning)? to|now|let'?s)\b[^.\n]{0,80}?\b(?:write|save|create|fix|update|add|remove|delete|run|execute|verify|test|typecheck|investigate|inspect|search)\b/i

/** 反例锁定：这些表述不构成可执行承诺（继续分析/总结/阐述不是动作承诺）。 */
const NEGATIVE_PATTERNS = [
  /继续分析/,
  /继续(?:深入|观察|跟踪|梳理)/,
  /总结(?:一下|一下结论)?/,
  /阐述(?:完毕|完成)/,
  /以上(?:思路|方案|分析)/,
  /wait(?:ing)? for user/i,
]

// 顺序即优先级：更具体的类（verify）先于宽泛类（execute/run）匹配——
// "运行测试"必须判 verify 而非 execute。
const ZH_VERB_TO_CLASS: Array<[RegExp, ActionClass]> = [
  [/写入|落盘|保存|创建|新建|修复|修改|添加|补充|补齐|重建/, "write"],
  [/删除|移除/, "delete"],
  [/验证|测试|重跑|typecheck/, "verify"],
  [/运行|执行|跑/, "execute"],
  [/查看|调查|搜索|检查|排查/, "inspect"],
  [/访问|调用/, "external"],
]

const EN_VERB_TO_CLASS: Array<[RegExp, ActionClass]> = [
  [/\b(?:write|save|create|fix|update|add|rebuild)\b/i, "write"],
  [/\b(?:remove|delete)\b/i, "delete"],
  [/\b(?:verify|tests?|typecheck|re-?run)\b/i, "verify"],
  [/\b(?:run|execute)\b/i, "execute"],
  [/\b(?:investigate|inspect|search|check)\b/i, "inspect"],
]

const TARGET_FILE_PATTERN = /(?:[\w./\-\\]+\.(?:ts|tsx|js|jsx|json|md|cjs|mjs|py|go|rs|sh|css|html|yaml|yml|toml|txt|c|h|java|kt|rb))/
const TARGET_COMMAND_PATTERN = /\b(?:bun test|npm test|npx tsc|tsc|typecheck|pytest|go test|jest)[^。；\n]{0,30}?/

/** 从自然语言提取 ActionCommitment；无法置信时返回 null（宁漏勿误杀）。 */
export function detectCommitment(finalText: string, round: number): ActionCommitment | null {
  if (!finalText || finalText.trim().length === 0) return null
  if (NEGATIVE_PATTERNS.some(p => p.test(finalText))) return null

  let match: RegExpMatchArray | null = null
  let isZh = false
  const zh = finalText.match(ZH_PATTERN)
  if (zh) {
    match = zh
    isZh = true
  } else {
    const en = finalText.match(EN_PATTERN)
    if (en) match = en
  }
  if (!match) return null

  const text = match[0]
  // 类匹配在"承诺句 + 其后 100 字符"窗口上进行（window ⊇ match[0]；
  // EN "I'll run the tests" 的 verify 动词组在匹配文本之外）。
  // 规则序即优先级（write/verify 具体类先于 execute 宽泛类），
  // 后续无关动词不会污染主承诺的类判定。
  const window = match.index !== undefined
    ? finalText.slice(match.index, match.index + match[0].length + 100)
    : text
  const classRules = isZh ? ZH_VERB_TO_CLASS : EN_VERB_TO_CLASS
  let actionClass: ActionClass | null = null
  for (const [re, cls] of classRules) {
    if (re.test(window)) {
      actionClass = cls
      break
    }
  }
  if (!actionClass) return null
  let target: ActionTarget | undefined
  const file = window.match(TARGET_FILE_PATTERN)
  if (file) {
    target = { kind: "file", value: file[0] }
  } else {
    const cmd = window.match(TARGET_COMMAND_PATTERN)
    if (cmd) {
      target = { kind: cmd[0].startsWith("bun test") || cmd[0].startsWith("npm test") || cmd[0].startsWith("pytest") || cmd[0].startsWith("go test") || cmd[0].startsWith("jest") ? "test-suite" : "command", value: cmd[0] }
    }
  }

  return {
    actionClass,
    target,
    createdRound: round,
    fingerprint: `commit:${round}:${actionClass}:${target?.value ?? "(unspecified)"}`,
    text,
  }
}

// ── 工具 → Capability Class（偿付匹配） ──

const INSPECT_TOOLS = new Set([
  "read_file", "read_definition", "find_symbol", "find_references", "project_structure",
  "glob", "grep", "search", "web_search", "git_status", "git_diff", "git_log", "git_blame",
  "read_related_files", "list_dir",
])
const WRITE_TOOLS = new Set([
  "write_file", "edit_file", "edit_fim", "apply_patch", "multi_edit", "create_file",
])
const DELETE_TOOLS = new Set(["delete_file", "remove_file", "delete", "rm"])
const SERVICE_TOOLS = new Set(["service_start", "service_stop", "service_restart", "service", "start_service"])
const EXTERNAL_TOOLS = new Set(["webfetch", "web_fetch", "fetch_url"])
const SHELL_TOOLS = new Set(["terminal", "shell", "executeProcess", "run_command", "run_process", "bash", "sh"])
const VERIFY_KEYWORDS = /(?:bun test|npm test|npx tsc|tsc|typecheck|pytest|go test|jest|vitest|bun run build|npm run build)/

/** 工具调用 → 动作类（验证命令从 execute 中细分出 verify）。 */
export function toolActionClass(name: string, inputText: string): ActionClass {
  if (INSPECT_TOOLS.has(name)) return "inspect"
  if (WRITE_TOOLS.has(name)) return "write"
  if (DELETE_TOOLS.has(name)) return "delete"
  if (SERVICE_TOOLS.has(name)) return "service"
  if (EXTERNAL_TOOLS.has(name)) return "external"
  if (SHELL_TOOLS.has(name)) return VERIFY_KEYWORDS.test(inputText) ? "verify" : "execute"
  return "execute"
}

/** 显式目标兼容：承诺目标 token（路径/命令分词）与被调工具 input token 交集 ≥1 显著 token。
 *  承诺"改 src/provider/deepseek.ts"写 docs/notes.md → 交集空 → 不偿付；
 *  写 deepseek.test.ts → 交集 {deepseek,ts} → 偿付。无显式目标时恒兼容（IF_EXPLICIT）。 */
export function targetCompatible(target: ActionTarget | undefined, toolCall: RoundToolCall): boolean {
  if (!target?.value) return true
  const targetTokens = tokenize(target.value)
  const inputTokens = tokenize(JSON.stringify(toolCall.input))
  for (const t of targetTokens) {
    if (inputTokens.has(t)) return true
  }
  return false
}

function tokenize(text: string): Set<string> {
  const tokens = new Set<string>()
  for (const raw of text.split(/[\\/._\- :"']+/)) {
    const t = raw.trim()
    if (t.length >= 2) tokens.add(t.toLowerCase())
  }
  return tokens
}

// ── CommitmentRegistry：债务计时（并行于 streak） ──

export const COMMITMENT_DEBT_DEFAULT = 2

export class CommitmentRegistry {
  private debt = 0
  private audit: ActionCommitment[] = []
  active: ActionCommitment | null = null

  constructor(readonly debtCap: number = COMMITMENT_DEBT_DEFAULT) {}

  /** 登记新承诺（替换 active；审计队列 ≤3，保留最近）。
   *  债务只被工具偿付清零 —— 新文本承诺**不重置 debt 时钟**
   *  （防"每 2 轮再承诺一次"的 Goodhart：反复重述承诺不是行动）。 */
  register(commitment: ActionCommitment): void {
    if (this.active) this.audit.push(this.active)
    if (this.audit.length > 3) this.audit.shift()
    this.active = commitment
  }

  get pendingDebt(): number {
    return this.debt
  }

  /** 每轮末端调用（无论该轮是否产生其他进展）。
   *  discharged=本轮有工具真实偿付；debtRemaining=未偿付轮数。
   *  返回状态："ok" | "action_required" | "stalled"。
   *  stalled 仅当债务达到 cap+1（连续 cap+1 轮未偿付）；上层还需叠加
   *  "无其他 EffectiveProgress" 条件才真正 STALLED（GS-P4 第 8 条）。 */
  tickRound(roundToolCalls: RoundToolCall[]): { discharged: boolean; debtRemaining: number; status: "ok" | "action_required" | "stalled" } {
    if (!this.active) return { discharged: false, debtRemaining: 0, status: "ok" }
    if (roundToolCalls.some(tc => this.discharges(this.active!, tc))) {
      this.audit.push(this.active)
      if (this.audit.length > 3) this.audit.shift()
      this.active = null
      this.debt = 0
      return { discharged: true, debtRemaining: 0, status: "ok" }
    }
    this.debt++
    if (this.debt > this.debtCap) return { discharged: false, debtRemaining: this.debt, status: "stalled" }
    if (this.debt >= this.debtCap) return { discharged: false, debtRemaining: this.debt, status: "action_required" }
    return { discharged: false, debtRemaining: this.debt, status: "ok" }
  }

  /** 偿付条件：actionClass 匹配 ∧ 显式目标兼容 ∧ 真实 dispatch（成功与否无关）。 */
  private discharges(commitment: ActionCommitment, tc: RoundToolCall): boolean {
    const cls = toolActionClass(tc.name, JSON.stringify(tc.input))
    if (cls !== commitment.actionClass) return false
    return targetCompatible(commitment.target, tc)
  }

  /** 审计队列（最近已完结承诺，报告用）。 */
  get recentAudit(): ActionCommitment[] {
    return [...this.audit]
  }
}
