export type VerificationKind = "typecheck" | "test" | "build" | "lint" | "smoke" | "unknown"

/** Constant-size identity of the run's committed PatchTransaction history when verification ran. */
export interface TransactionEvidenceBinding {
  /** 128-bit rolling SHA-256 state identifier derived from authoritative commit IDs. */
  stateId: string
  transactionCount: number
  /** Retained for diagnostics without weakening hard-gate state matching. */
  latestTransactionId: string
}

export interface VerificationResult {
  kind: VerificationKind
  command: string
  passed: boolean
  exitCode?: number
  issues: number
  durationMs: number
  summary: string
  generation?: number
  transaction?: TransactionEvidenceBinding
}

const VERIFICATION_KINDS = new Set<VerificationKind>(["typecheck", "test", "build", "lint", "smoke", "unknown"])
const NON_EXECUTING_VERIFIER_ARGS = new Set([
  "--help",
  "-h",
  "--version",
  "--showconfig",
  "--init",
  "--print-config",
  "--listtests",
  "--list-tests",
  "--list",
  "--listfilesonly",
  "--collect-only",
  "--no-run",
  "--if-present",
])

/** Parse untrusted tool metadata into the core verification shape; runtime stamps are never accepted here. */
export function parseVerificationResult(value: unknown): VerificationResult | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const candidate = value as Record<string, unknown>
  if (
    typeof candidate.kind !== "string"
    || !VERIFICATION_KINDS.has(candidate.kind as VerificationKind)
    || typeof candidate.command !== "string"
    || candidate.command.trim().length === 0
    || typeof candidate.passed !== "boolean"
    || typeof candidate.issues !== "number"
    || !Number.isInteger(candidate.issues)
    || candidate.issues < 0
    || typeof candidate.durationMs !== "number"
    || !Number.isFinite(candidate.durationMs)
    || candidate.durationMs < 0
    || typeof candidate.summary !== "string"
    || (candidate.exitCode !== undefined && (typeof candidate.exitCode !== "number" || !Number.isInteger(candidate.exitCode)))
  ) {
    return undefined
  }

  const result: VerificationResult = {
    kind: candidate.kind as VerificationKind,
    command: candidate.command,
    passed: candidate.passed,
    issues: candidate.issues,
    durationMs: candidate.durationMs,
    summary: candidate.summary,
  }
  if (typeof candidate.exitCode === "number") result.exitCode = candidate.exitCode
  return result
}

function executableAndArgs(segment: string): { executable: string; args: string[] } | undefined {
  const normalized = segment.trim().replace(/^&\s+/, "")
  const match = normalized.match(/^(?:"([^"]+)"|'([^']+)'|([^\s]+))(?:\s+([\s\S]*))?$/)
  if (!match) return undefined
  const rawExecutable = match[1] ?? match[2] ?? match[3] ?? ""
  const executable = rawExecutable
    .split(/[\\/]/)
    .pop()!
    .toLowerCase()
    .replace(/\.(?:cmd|exe|ps1)$/, "")
  const args = (match[4] ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(arg => arg.replace(/^['"]|['"]$/g, "").toLowerCase())
  return { executable, args }
}

function scriptVerificationKind(script: string | undefined): VerificationKind {
  if (!script) return "unknown"
  if (/^(?:typecheck|check:types|types)(?::|$)/.test(script)) return "typecheck"
  if (/^lint(?::|$)/.test(script)) return "lint"
  if (/^test(?::|$)/.test(script)) return "test"
  if (/^build(?::|$)/.test(script)) return "build"
  return "unknown"
}

function isNonExecutingVerifierInvocation(executable: string, args: string[]): boolean {
  const normalizedArgs = args.map(arg => arg.split("=", 1)[0]!)
  if (normalizedArgs.some(arg => NON_EXECUTING_VERIFIER_ARGS.has(arg))) return true
  if (executable === "tsc" && normalizedArgs.includes("-v")) return true
  if (executable === "pytest" && normalizedArgs.includes("--co")) return true
  if (executable === "go" && args[0] === "test" && normalizedArgs.includes("-list")) return true
  return false
}

function detectVerificationSegment(segment: string): VerificationKind {
  const parsed = executableAndArgs(segment)
  if (!parsed) return "unknown"
  const { executable, args } = parsed
  if (isNonExecutingVerifierInvocation(executable, args)) return "unknown"

  if (["bun", "npm", "pnpm", "yarn"].includes(executable)) {
    if (executable === "bun" && args[0] === "test") return "test"
    if (["npm", "pnpm", "yarn"].includes(executable) && args[0] === "test") return "test"
    if (args[0] === "run") return scriptVerificationKind(args[1])
    if (["exec", "x", "dlx"].includes(args[0] ?? "")) {
      return detectVerificationSegment(args.slice(1).join(" "))
    }
    return scriptVerificationKind(args[0])
  }

  if (["bunx", "npx"].includes(executable)) {
    return detectVerificationSegment(args.join(" "))
  }

  if (executable === "tsc") return "typecheck"
  if (executable === "eslint") return "lint"
  if (["vitest", "jest", "pytest"].includes(executable)) return "test"
  if (executable === "cargo" && args[0] === "test") return "test"
  if (executable === "go" && args[0] === "test") return "test"
  if (["vite", "next"].includes(executable) && args[0] === "build") return "build"
  if (["tsup", "rollup"].includes(executable)) return "build"
  if (["curl", "wget", "invoke-webrequest"].includes(executable)) {
    const target = args.join(" ")
    if (/\blocalhost\b|127\.0\.0\.1/.test(target)) return "smoke"
  }
  return "unknown"
}

export function detectVerificationKind(command: string): VerificationKind {
  // The shell adapter only observes the final exit code. Reject constructs that
  // can mask a failed verifier (pipes, sequential commands, backgrounding).
  if (/[;|\r\n]/.test(command) || /(^|[^&])&([^&]|$)/.test(command)) return "unknown"
  for (const segment of command.split(/&&|\|\||[;\r\n]+/)) {
    const kind = detectVerificationSegment(segment)
    if (kind !== "unknown") return kind
  }
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

