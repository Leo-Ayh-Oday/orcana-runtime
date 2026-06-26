import stringWidth from "string-width"

export interface DisplayLine {
  text: string
  color?: string
}

export function cleanDisplayText(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
}

export function trimForViewport(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `...\n${text.slice(-maxChars)}`
}

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

  const formatted = dataRows.map(row =>
    `| ${widths.map((cellWidth, column) => padCell(row[column] ?? "", cellWidth)).join(" | ")} |`,
  )

  if (formatted.length >= 2) {
    formatted.splice(1, 0, separator(widths))
  }

  return formatted.flatMap(line => wrapTerminalLine(line, width))
}
