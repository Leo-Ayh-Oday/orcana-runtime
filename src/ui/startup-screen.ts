import { bold, cyan, dim, green, yellow } from "./render"

interface StartupScreenOptions {
  version: string
  toolsCount: number
  thinkingEffort: string
  modelName: string
  columns?: number
}

const WIDE_MARK = [
  "██████╗ ███████╗███████╗██████╗ ███████╗███████╗███████╗██╗  ██╗",
  "██╔══██╗██╔════╝██╔════╝██╔══██╗██╔════╝██╔════╝██╔════╝██║ ██╔╝",
  "██║  ██║█████╗  █████╗  ██████╔╝███████╗█████╗  █████╗  █████╔╝ ",
  "██║  ██║██╔══╝  ██╔══╝  ██╔═══╝ ╚════██║██╔══╝  ██╔══╝  ██╔═██╗ ",
  "██████╔╝███████╗███████╗██║     ███████║███████╗███████╗██║  ██╗",
  "╚═════╝ ╚══════╝╚══════╝╚═╝     ╚══════╝╚══════╝╚══════╝╚═╝  ╚═╝",
]

const COMPACT_MARK = [
  "Orcana",
  "sonar first / verify always",
]

function visibleLength(line: string): number {
  return line.replace(/\x1b\[[0-9;]*m/g, "").length
}

function fit(line: string, columns: number): string {
  const width = visibleLength(line)
  if (columns <= 0 || width <= columns) return line
  const plain = line.replace(/\x1b\[[0-9;]*m/g, "")
  if (columns <= 3) return plain.slice(0, columns)
  return `${plain.slice(0, columns - 3)}...`
}

function padRight(line: string, width: number): string {
  const padding = Math.max(0, width - visibleLength(line))
  return line + " ".repeat(padding)
}

function rule(width: number): string {
  return dim("-".repeat(Math.max(24, Math.min(width, 72))))
}

function chip(label: string, value: string, color: (s: string) => string): string {
  return `${dim("[")}${color(label)} ${bold(value)}${dim("]")}`
}

export function renderStartupScreen(options: StartupScreenOptions): string {
  const columns = options.columns ?? process.stdout.columns ?? 80
  const width = Math.max(32, Math.min(columns - 2, 84))
  const wide = columns >= 86
  const mark = wide ? WIDE_MARK : COMPACT_MARK
  const artWidth = wide ? 72 : 34
  const lines: string[] = []

  lines.push("")
  for (const line of mark) {
    lines.push(cyan(fit(`  ${padRight(line, artWidth)}`, width)))
  }

  lines.push("")
  lines.push(fit(`  ${bold("Orcana")} ${dim(`v${options.version}`)} ${dim("/")} ${cyan("Hraness runtime")}`, width))
  lines.push(fit(`  ${dim("Sonar first. Ripple before writes. Evidence before done.")}`, width))
  lines.push("")
  lines.push(`  ${chip("model", options.modelName, cyan)} ${chip("fim", "on", green)} ${chip("tools", String(options.toolsCount), yellow)} ${chip("thinking", options.thinkingEffort, cyan)}`)
  lines.push(`  ${rule(width - 2)}`)
  lines.push(fit(`  ${dim("/help")} commands  ${dim("/sessions")} history  ${dim("/compact")} memory  ${dim("/stats")} telemetry`, width))
  lines.push("")

  return lines.join("\n")
}

export async function playStartupScreen(options: StartupScreenOptions): Promise<void> {
  process.stdout.write(renderStartupScreen(options) + "\n")
}
