/** scoreCommand — Slash 命令 fuzzy 匹配评分（PR-3）。
 *
 *  评分规则（越高越优先）：
 *    完全匹配       1000
 *    前缀匹配       500 + 比例加分
 *    子串匹配       300 + 比例加分
 *    Fuzzy 字符散列  按连续性加分（连续匹配 > 散乱匹配）
 *    不匹配         -1
 *
 *  设计原则：
 *    - 纯函数，无副作用
 *    - 大小写不敏感
 *    - 空 query 返回 100（全部命令等价匹配，由调用方稳定排序）
 */

import type { SlashCommandHint } from "../input"

/** Fuzzy 字符散列匹配：query 的字符按顺序出现在 text 中即匹配。
 *  连续匹配加分，散乱匹配扣分。 */
function fuzzyMatch(query: string, text: string): number {
  let qi = 0
  let score = 0
  let lastMatchPos = -1
  for (let ti = 0; ti < text.length && qi < query.length; ti++) {
    if (text[ti] === query[qi]) {
      score += lastMatchPos === ti - 1 ? 15 : 5
      lastMatchPos = ti
      qi++
    }
  }
  return qi === query.length ? score : -1
}

/** 对单个命令评分。返回 -1 表示不匹配。 */
export function scoreCommand(query: string, cmdName: string): number {
  if (!query) return 100
  const q = query.toLowerCase()
  const name = cmdName.toLowerCase()

  // 完全匹配
  if (name === q) return 1000

  // 前缀匹配
  if (name.startsWith(q)) {
    return 500 + Math.round((q.length / name.length) * 100)
  }

  // 子串匹配
  if (name.includes(q)) {
    return 300 + Math.round((q.length / name.length) * 50)
  }

  // Fuzzy 字符散列匹配
  return fuzzyMatch(q, name)
}

export interface ScoredCommand<T = unknown> {
  command: T
  score: number
}

/** 对命令列表做 fuzzy 匹配，返回评分降序的前 N 条。
 *  score === -1 的命令被过滤掉。
 *  同分命令按原始顺序稳定排序（不交换）。 */
export function matchCommands<T>(
  query: string,
  commands: ReadonlyArray<T>,
  getName: (cmd: T) => string,
  limit = 5,
): Array<ScoredCommand<T>> {
  const scored: Array<ScoredCommand<T> & { originalIndex: number }> = commands
    .map((command, originalIndex) => ({
      command,
      score: scoreCommand(query, getName(command)),
      originalIndex,
    }))
    .filter(s => s.score >= 0)

  // 稳定排序：score 降序，同分按 originalIndex 升序
  scored.sort((a, b) => b.score - a.score || a.originalIndex - b.originalIndex)

  return scored.slice(0, limit).map(({ command, score }) => ({ command, score }))
}

// ── PR-4: SlashCommandHint 专用评分（含 aliases + description + priority） ──

/** PR-4: 对 SlashCommandHint 评分，综合考虑 name / aliases / description / priority。
 *
 *  评分优先级（取最高分）：
 *    1. name 匹配（复用 scoreCommand 的 fuzzy 评分）
 *    2. aliases 匹配（复用 scoreCommand，取最高别名分）
 *    3. description 子串匹配（200+，低于 name/alias 的 300+）
 *    4. 空 query → cmd.priority ?? 0（计划规范）
 *
 *  禁用命令（enabled=false）仍参与评分，由 CommandShelf 负责显示禁用样式。
 *  这样用户能看到禁用命令并了解禁用原因。
 */
export function scoreSlashCommand(query: string, cmd: SlashCommandHint): number {
  // 空 query → priority（默认 0），按原顺序稳定排序
  if (!query) return cmd.priority ?? 0

  // 1. name 评分（fuzzy）
  const nameScore = scoreCommand(query, cmd.name)

  // 2. aliases 评分（取最高别名分）
  let aliasScore = -1
  if (cmd.aliases && cmd.aliases.length > 0) {
    for (const alias of cmd.aliases) {
      const s = scoreCommand(query, alias)
      if (s > aliasScore) aliasScore = s
    }
  }

  // 3. description 子串匹配（低优先级，200+）
  const q = query.toLowerCase()
  const desc = cmd.description.toLowerCase()
  let descScore = -1
  if (q.length > 0 && desc.includes(q)) {
    descScore = 200 + Math.round((q.length / Math.max(1, desc.length)) * 50)
  }

  return Math.max(nameScore, aliasScore, descScore)
}

/** PR-4: 对 SlashCommandHint 列表做 fuzzy 匹配，返回评分降序的前 N 条。
 *  与 matchCommands 行为一致，但用 scoreSlashCommand 评分（含 aliases/desc）。 */
export function matchSlashCommands(
  query: string,
  commands: ReadonlyArray<SlashCommandHint>,
  limit = 5,
): Array<ScoredCommand<SlashCommandHint>> {
  const scored: Array<ScoredCommand<SlashCommandHint> & { originalIndex: number }> = commands
    .map((command, originalIndex) => ({
      command,
      score: scoreSlashCommand(query, command),
      originalIndex,
    }))
    .filter(s => s.score >= 0)

  scored.sort((a, b) => b.score - a.score || a.originalIndex - b.originalIndex)

  return scored.slice(0, limit).map(({ command, score }) => ({ command, score }))
}
