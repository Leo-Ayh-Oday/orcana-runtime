/** format — TUI 文本格式化与截断工具。
 *
 *  Phase 3 重构:
 *    - trimForViewport 反转：保留头部，尾部指示 hidden below
 *    - assistant 双端截断：头 60% + 尾 30%，中间提示 hidden middle
 *    - 新增 4 方向截断 API (truncateToWidth/truncateStartToWidth/truncatePathMiddle/truncateSingleLine)
 *    - viewport 隐藏 ("earlier/newer") 与 message 截断 ("chars hidden above/below/middle") 文案分离
 *    - 所有基于 stringWidth，CJK/emoji 安全 */

import stringWidth from "string-width"

export interface DisplayLine {
  text: string
  color?: string
}

// ── 截断 API（4 方向，基于 stringWidth）──

/** 尾部截断：保留头部，末尾加 "…"。CJK/emoji 安全。 */
export function truncateToWidth(str: string, maxWidth: number): string {
  if (stringWidth(str) <= maxWidth) return str
  const suffix = "…"
  const avail = Math.max(1, maxWidth - stringWidth(suffix))
  let out = ""
  for (const ch of str) {
    if (stringWidth(out + ch) > avail) break
    out += ch
  }
  return out + suffix
}

/** 头部截断：保留尾部，开头加 "…"。 */
export function truncateStartToWidth(str: string, maxWidth: number): string {
  if (stringWidth(str) <= maxWidth) return str
  const prefix = "…"
  const avail = Math.max(1, maxWidth - stringWidth(prefix))
  const chars = Array.from(str)
  // 从尾部倒序构建，直到宽度超限
  const kept: string[] = []
  for (let i = chars.length - 1; i >= 0; i--) {
    const ch = chars[i]!
    const candidate = ch + kept.join("")
    if (stringWidth(candidate) > avail) break
    kept.unshift(ch)
  }
  return prefix + kept.join("")
}

/** 中间截断：保留路径的头尾，中间 "…"。保留最后一段（文件名）。 */
export function truncatePathMiddle(path: string, maxWidth: number): string {
  if (stringWidth(path) <= maxWidth) return path
  const ellipsis = "…"
  const halfAvail = Math.floor((maxWidth - stringWidth(ellipsis)) / 2)
  if (halfAvail <= 2) return truncateToWidth(path, maxWidth)

  // 找最后一个路径分隔符
  const lastSep = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"))
  let filename = ""
  let dirPart = path
  if (lastSep >= 0) {
    filename = path.slice(lastSep)
    dirPart = path.slice(0, lastSep)
  }

  // 从头部取 halfAvail 宽，从尾部（含文件名）取剩余
  const head = truncateToWidth(dirPart, halfAvail)
  const tailAvail = maxWidth - stringWidth(head) - stringWidth(ellipsis)
  const tail = tailAvail > 0 ? truncateStartToWidth(filename, tailAvail) : ""

  return head + ellipsis + tail
}

/** 单行截断：首个 \n 处截断，末尾加 "…"。 */
export function truncateSingleLine(str: string, maxWidth: number): string {
  const nl = str.indexOf("\n")
  const firstLine = nl >= 0 ? str.slice(0, nl) : str
  return truncateToWidth(firstLine, maxWidth)
}

// ── viewport trim（render 层截断，不修改真实 message.text）──

/** render 层截断：反转策略（Phase 3）。
 *  - 保留头部（用户更关心开头）
 *  - 尾部用指示器替代
 *  - 文案与 viewport 隐藏区分 */
export function trimForViewport(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const hidden = text.length - maxChars
  return `${text.slice(0, maxChars)}\n⋯ ${hidden} chars hidden below (scroll down for full content)`
}

/** assistant 双端截断：保留头 60% + 尾 30%，中间提示 hidden middle。
 *  对含 code fence 的长输出保留首尾代码可见性；纯对话文本退化为单端保留头部。 */
export function trimAssistantForViewport(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text

  // 有 code fence → 双端截断（看 import 和 return）
  const hasCodeFence = text.includes("```")
  if (!hasCodeFence) {
    // 纯对话 → 单端保留头部
    return trimForViewport(text, maxChars)
  }

  const headSize = Math.floor(maxChars * 0.6)
  const tailSize = Math.floor(maxChars * 0.3)
  const middleHidden = text.length - headSize - tailSize
  if (middleHidden <= 0) {
    // double-end not useful, fall back to head-only
    return trimForViewport(text, maxChars)
  }

  const head = text.slice(0, headSize)
  const tail = text.slice(-tailSize)
  return `${head}\n⋯ ${middleHidden} chars hidden middle\n${tail}`
}

// ── 文本清理 ──

export function cleanDisplayText(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
}

// ── 终端宽度适配 ──

export function fitTerminalText(text: string, width: number): string {
  const safeWidth = Math.max(1, width)
  if (stringWidth(text) <= safeWidth) return text

  let out = ""
  for (const char of text) {
    if (stringWidth(out + char) > Math.max(1, safeWidth - 1)) break
    out += char
  }
  return safeWidth > 3 ? `${out}...` : out
}

// ── 行包装 ──

export function wrapTerminalLine(line: string, width: number): string[] {
  const safeWidth = Math.max(8, width)
  if (stringWidth(line) <= safeWidth) return [line]

  const chunks: string[] = []
  let current = ""
  for (const char of line) {
    if (current && stringWidth(current + char) > safeWidth) {
      chunks.push(current)
      current = char
    } else {
      current += char
    }
  }
  if (current) chunks.push(current)
  return chunks.length ? chunks : [""]
}

// ── 显示格式化 ──

export function formatDisplayText(text: string, width: number): string[] {
  const cleaned = cleanDisplayText(text)
  const rawLines = cleaned.split("\n")
  const out: string[] = []

  for (let index = 0; index < rawLines.length; index++) {
    const line = rawLines[index] ?? ""
    if (!isTableRow(line)) {
      out.push(...wrapTerminalLine(line, width))
      continue
    }

    const table: string[] = []
    while (index < rawLines.length && isTableRow(rawLines[index] ?? "")) {
      table.push(rawLines[index] ?? "")
      index += 1
    }
    index -= 1
    out.push(...formatMarkdownTable(table, width))
  }

  return out
}

// ── Markdown 表格 ──

function isTableRow(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return false
  return trimmed.split("|").length >= 4
}

function isSeparatorRow(line: string): boolean {
  const cells = splitTableRow(line)
  return cells.length > 0 && cells.every(cell => /^:?-{3,}:?$/.test(cell.trim()))
}

function splitTableRow(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(cell => cell.trim())
}

function padCell(text: string, width: number): string {
  const clipped = fitTerminalText(text, Math.max(1, width))
  return clipped + " ".repeat(Math.max(0, width - stringWidth(clipped)))
}

function separator(widths: number[]): string {
  return `| ${widths.map(width => "-".repeat(Math.max(3, width))).join(" | ")} |`
}

function formatMarkdownTable(rows: string[], width: number): string[] {
  const dataRows = rows.filter(row => !isSeparatorRow(row)).map(splitTableRow)
  if (dataRows.length === 0) return rows

  const columns = Math.max(...dataRows.map(row => row.length))
  const maxContentWidth = Math.max(8, Math.floor((Math.max(24, width) - columns * 3 - 1) / columns))
  const widths = Array.from({ length: columns }, (_, column) => {
    const natural = Math.max(...dataRows.map(row => stringWidth(row[column] ?? "")), 3)
    return Math.min(maxContentWidth, natural)
  })

  const formatted: string[] = []
  for (let rowIndex = 0; rowIndex < dataRows.length; rowIndex++) {
    const row = dataRows[rowIndex]!
    const wrappedCells = widths.map((cellWidth, column) => wrapTerminalLine(row[column] ?? "", cellWidth))
    const rowHeight = Math.max(...wrappedCells.map(lines => lines.length), 1)
    for (let lineIndex = 0; lineIndex < rowHeight; lineIndex++) {
      formatted.push(`| ${widths.map((cellWidth, column) => padCell(wrappedCells[column]?.[lineIndex] ?? "", cellWidth)).join(" | ")} |`)
    }
    if (rowIndex === 0 && dataRows.length >= 2) formatted.push(separator(widths))
  }

  return formatted.flatMap(line => wrapTerminalLine(line, width))
}
