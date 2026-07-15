export type VerificationKind = "typecheck" | "test" | "build" | "lint" | "smoke" | "unknown"

export interface VerificationResult {
  kind: VerificationKind
  command: string
  passed: boolean
  exitCode?: number
  issues: number
  durationMs: number
  summary: string
  generation?: number
}

export function detectVerificationKind(command: string): VerificationKind {
  const normalized = command.toLowerCase()
  if (/\b(?:eslint|lint)\b/.test(normalized)) return "lint"
  if (/\b(?:tsc|typecheck)\b/.test(normalized)) return "typecheck"
  if (/\b(?:test|vitest|jest|pytest|cargo test|go test|bun test|npm test)\b/.test(normalized)) return "test"
  if (/\b(?:build|vite build|next build|tsup|rollup)\b/.test(normalized)) return "build"
  if (/\b(?:curl|invoke-webrequest|wget)\b/.test(normalized) && /\blocalhost\b|127\.0\.0\.1/.test(normalized)) return "smoke"
  return "unknown"
}

export function isFiniteVerificationCommand(command: string): boolean {
  return detectVerificationKind(command) !== "unknown"
}

export function buildVerificationResult(input: {
  command: string
  passed: boolean
  exitCode?: number
  durationMs: number
  output: string
}): VerificationResult | undefined {
  const kind = detectVerificationKind(input.command)
  if (kind === "unknown") return undefined
  const result: VerificationResult = {
    kind,
    command: input.command,
    passed: input.passed,
    issues: input.passed ? 0 : countIssues(input.output, kind),
    durationMs: input.durationMs,
    summary: summarizeVerificationOutput(input.output, input.passed),
  }
  if (input.exitCode !== undefined) result.exitCode = input.exitCode
  return result
}

export function hasServiceTestFailure(output: string): boolean {
  return /ECONNREFUSED|fetch failed|connection refused|localhost|127\.0\.0\.1|server.*not.*running|failed to connect/i.test(output)
}

export function formatServiceTestGuidance(): string {
  return [
    "## 服务型测试修复要求",
    "当前验证像是在依赖一个外部常驻 API 服务。不要启动 dev/start/server 常驻命令来绕过测试。",
    "请修改测试或服务入口，让测试进程自己启动服务并在结束时关闭，例如暴露 createServer()/server.stop()，或使用有限时 smoke test。",
    "修复后重新运行有限时验证命令，例如 bun test、bun run build、bun run typecheck。",
  ].join("\n")
}

function countIssues(output: string, kind: VerificationKind): number {
  if (!output.trim()) return 1
  if (kind === "typecheck") {
    const matches = output.match(/\berror TS\d+/g)
    return matches?.length || 1
  }
  if (kind === "test") {
    const matches = output.match(/\((?:fail|failed)\)|\b(?:fail|failed)\b|not ok|✗/gi)
    return matches?.length || 1
  }
  const errorLines = output.split("\n").filter(line => /\berror\b|\bfailed\b|\bfail\b/i.test(line))
  return Math.max(1, errorLines.length)
}

function summarizeVerificationOutput(output: string, passed: boolean): string {
  const trimmed = output.trim()
  if (!trimmed) return passed ? "验证通过，无输出" : "验证失败，无输出"
  const lines = trimmed.split("\n").map(line => line.trim()).filter(Boolean)
  const interesting = lines.filter(line => /\berror\b|\bfailed\b|\bfail\b|\bpass\b|\bpassed\b|TS\d+|Ran \d+|tests?/i.test(line))
  const selected = (interesting.length ? interesting : lines).slice(0, 6)
  return selected.join("\n").slice(0, 1000)
}

