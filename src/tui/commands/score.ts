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
