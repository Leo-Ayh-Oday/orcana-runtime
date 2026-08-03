/**
 * Live eval runner for the real DeepSeek Code CLI.
 *
 * Safety rule: this file does not run every task by default. Use --task <id>,
 * --limit <n>, or --all after setting explicit token budgets.
 */
import { spawn, execSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { homedir } from "node:os"

const EVAL_DIR = join(homedir(), ".orcana", "live-evals")
mkdirSync(EVAL_DIR, { recursive: true })

interface Task {
  id: string
  name: string
  cwd: string
  prompt: string
  verify: string
  expectedFiles?: string[]
}

interface TraceMetrics {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheMissInputTokens: number
  cacheCreationInputTokens: number
  cacheHitRate?: number
  rounds: number
  traceFile?: string
}

interface TaskResult {
  taskId: string
  passed: boolean
  error: string
  rounds: number
  wallTimeMs: number
  tokensIn: number
  tokensOut: number
  cacheReadInputTokens: number
  cacheMissInputTokens: number
  cacheCreationInputTokens: number
  cacheHitRate?: number
  filesCreated: string[]
  output: string
  traceFile?: string
}

const SRC = resolve(import.meta.dir, "../src/index.ts")

function parseArgs(argv: string[]): { list: boolean; all: boolean; taskIds: string[]; limit?: number; timeoutMs: number } {
  const out = { list: false, all: false, taskIds: [] as string[], timeoutMs: 240_000 }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--list") out.list = true
    else if (arg === "--all") out.all = true
    else if (arg === "--task") {
      const id = argv[++i]
      if (id) out.taskIds.push(id)
    } else if (arg.startsWith("--task=")) {
      out.taskIds.push(arg.slice("--task=".length))
    } else if (arg === "--limit") {
      const n = Number(argv[++i])
      if (Number.isFinite(n) && n > 0) out.limit = Math.floor(n)
    } else if (arg.startsWith("--limit=")) {
      const n = Number(arg.slice("--limit=".length))
      if (Number.isFinite(n) && n > 0) out.limit = Math.floor(n)
    } else if (arg === "--timeout-ms") {
      const n = Number(argv[++i])
      if (Number.isFinite(n) && n > 0) out.timeoutMs = Math.floor(n)
    }
  }
  return out
}

function listTraceFiles(cwd: string): string[] {
  const dir = join(cwd, ".orcana", "runs")
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter(file => file.endsWith(".jsonl"))
    .map(file => join(dir, file))
}

function newestTraceAfter(cwd: string, startedAtMs: number): string | undefined {
  return listTraceFiles(cwd)
    .map(file => ({ file, mtime: statSync(file).mtimeMs }))
    .filter(item => item.mtime >= startedAtMs - 1000)
    .sort((a, b) => b.mtime - a.mtime)[0]?.file
}

function metricsFromTrace(traceFile: string | undefined): TraceMetrics {
  const metrics: TraceMetrics = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheMissInputTokens: 0,
    cacheCreationInputTokens: 0,
    rounds: 0,
    traceFile,
  }
  if (!traceFile || !existsSync(traceFile)) return metrics

  for (const line of readFileSync(traceFile, "utf-8").split(/\r?\n/)) {
    if (!line.trim()) continue
    let event: { type?: string; data?: Record<string, unknown> }
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (event.type === "round_started") metrics.rounds += 1
    if (event.type !== "token_usage" || !event.data) continue
    const data = event.data
    metrics.inputTokens = numberValue(data.inputTokens, metrics.inputTokens)
    metrics.outputTokens = numberValue(data.outputTokens, metrics.outputTokens)
    metrics.cacheReadInputTokens += numberValue(data.cacheReadInputTokens, 0)
    metrics.cacheMissInputTokens += numberValue(data.cacheMissInputTokens, 0)
    metrics.cacheCreationInputTokens += numberValue(data.cacheCreationInputTokens, 0)
    metrics.cacheHitRate = numberValue(data.cacheHitRate, metrics.cacheHitRate)
  }

  const cacheTotal = metrics.cacheReadInputTokens + metrics.cacheMissInputTokens
  if (cacheTotal > 0) metrics.cacheHitRate = Math.round((metrics.cacheReadInputTokens / cacheTotal) * 100)
  if (metrics.rounds === 0) metrics.rounds = 1
  return metrics
}

function numberValue(value: unknown, fallback: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : (fallback ?? 0)
}

function runCli(cwd: string, prompt: string, timeoutMs: number): Promise<{ output: string; exitCode: number; traceFile?: string }> {
  const startedAtMs = Date.now()
  return new Promise((resolve) => {
    const proc = spawn("bun", ["run", SRC, prompt], {
      cwd,
      env: {
        ...process.env,
        DEEPSEEK_NON_INTERACTIVE: "1",
        FORCE_COLOR: "0",
        DEEPSEEK_AUTO_FINISH_DISABLED: "1",
        DEEPSEEK_MAX_ROUND_OUTPUT_TOKENS: process.env.DEEPSEEK_MAX_ROUND_OUTPUT_TOKENS ?? "4000",
        DEEPSEEK_MAX_RUN_OUTPUT_TOKENS: process.env.DEEPSEEK_MAX_RUN_OUTPUT_TOKENS ?? "12000",
        DEEPSEEK_MAX_ROUND_CACHE_MISS_TOKENS: process.env.DEEPSEEK_MAX_ROUND_CACHE_MISS_TOKENS ?? "50000",
        DEEPSEEK_MAX_RUN_CACHE_MISS_TOKENS: process.env.DEEPSEEK_MAX_RUN_CACHE_MISS_TOKENS ?? "120000",
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let out = ""
    let err = ""
    const finish = (exitCode: number, suffix = "") => {
      clearTimeout(t)
      resolve({
        output: out + (err ? `\n${err}` : "") + suffix,
        exitCode,
        traceFile: newestTraceAfter(cwd, startedAtMs),
      })
    }
    const t = setTimeout(() => {
      proc.kill()
      finish(-1, "\n[TIMEOUT]")
    }, timeoutMs)
    proc.stdout?.on("data", (d: Buffer) => { out += d.toString() })
    proc.stderr?.on("data", (d: Buffer) => { err += d.toString() })
    proc.on("close", code => finish(code ?? -1))
    proc.on("error", e => finish(-1, `\n[ERROR: ${e.message}]`))
  })
}

function parseFiles(out: string): string[] {
  const files = new Set<string>()
  for (const m of out.matchAll(/Changed files:\s*(.+)/gi)) {
    if (m[1]) for (const file of m[1].split(",").map(s => s.trim()).filter(Boolean)) files.add(file)
  }
  return [...files]
}

async function runTask(task: Task, timeoutMs: number): Promise<TaskResult> {
  const start = Date.now()
  console.log(`\n>>> ${task.id}: ${task.name}`)
  console.log(`    ${task.prompt.slice(0, 100)}...`)

  const { output, exitCode, traceFile } = await runCli(task.cwd, task.prompt, timeoutMs)
  const wallMs = Date.now() - start
  const metrics = metricsFromTrace(traceFile)

  let passed = false
  let error = ""
  if (exitCode !== 0) {
    error = `CLI exit ${exitCode}`
  } else {
    try {
      execSync(task.verify, { cwd: task.cwd, timeout: 60_000, stdio: "pipe" })
      passed = true
    } catch (e: any) {
      error = "verify: " + (e.stderr?.toString().slice(0, 200) ?? e.message ?? String(e))
    }
  }

  if (passed && task.expectedFiles) {
    for (const f of task.expectedFiles) {
      if (!existsSync(join(task.cwd, f))) { passed = false; error = `missing: ${f}`; break }
    }
  }

  const r: TaskResult = {
    taskId: task.id,
    passed,
    error,
    rounds: metrics.rounds,
    wallTimeMs: wallMs,
    tokensIn: metrics.inputTokens,
    tokensOut: metrics.outputTokens,
    cacheReadInputTokens: metrics.cacheReadInputTokens,
    cacheMissInputTokens: metrics.cacheMissInputTokens,
    cacheCreationInputTokens: metrics.cacheCreationInputTokens,
    cacheHitRate: metrics.cacheHitRate,
    filesCreated: parseFiles(output),
    output: output.slice(-2500),
    traceFile,
  }
  writeFileSync(join(EVAL_DIR, `${task.id}.json`), JSON.stringify(r, null, 2))
  const icon = passed ? "PASS" : "FAIL"
  console.log(`    ${icon} | ${r.rounds}r | ${(wallMs / 1000).toFixed(0)}s | out:${r.tokensOut.toLocaleString()} miss:${r.cacheMissInputTokens.toLocaleString()} hit:${r.cacheHitRate ?? 0}%${error ? " | " + error : ""}`)
  return r
}

const TASKS: Task[] = [
  {
    id: "t01-divide-by-zero",
    name: "Fix divide-by-zero + add test",
    cwd: resolve(import.meta.dir, "../test-projects/eval/task-01"),
    prompt: "The divide function in src/calc.ts crashes on divide(x,0). Fix: return Infinity. Add tests/calc.test.ts with bun test. Test normal, zero divisor, negative numbers. Do ALL work.",
    verify: "bun test",
    expectedFiles: ["src/calc.ts", "tests/calc.test.ts"],
  },
  {
    id: "t02-json-api",
    name: "Build GET /time JSON endpoint",
    cwd: resolve(import.meta.dir, "../test-projects/eval/task-02"),
    prompt: "Add GET /time to src/index.ts returning {now:ISO,unix:timestamp}. Use existing Hono. Write index.test.ts with bun test + app.fetch(). Test /time returns 200 + valid JSON. Do ALL work: code + test.",
    verify: "bun test",
    expectedFiles: ["src/index.ts", "index.test.ts"],
  },
  {
    id: "t03-write-tests",
    name: "Write tests + add greetAll function",
    cwd: resolve(import.meta.dir, "../test-projects/eval/task-03"),
    prompt: "Write greet.test.ts for src/greet.ts. Test: normal, empty, null, long name. Add greetAll(names:string[]) that joins greetings with newline. Test that too. Do ALL work.",
    verify: "bun test",
    expectedFiles: ["src/greet.ts", "greet.test.ts"],
  },
  {
    id: "t04-refactor-split",
    name: "Split math.ts into circle.ts + rectangle.ts",
    cwd: resolve(import.meta.dir, "../test-projects/eval/task-04"),
    prompt: "Split src/math.ts: src/circle.ts (PI,circleArea,circleCircum) and src/rectangle.ts (rectArea,rectPerim). Keep math.ts as barrel re-export. Write src/math.test.ts. Verify compiles + tests pass. Do ALL work.",
    verify: "bun test",
    expectedFiles: ["src/circle.ts", "src/rectangle.ts", "src/math.ts", "src/math.test.ts"],
  },
]

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.list || (!args.all && args.taskIds.length === 0 && !args.limit)) {
    console.log("DeepSeek Code Live Eval tasks:")
    for (const task of TASKS) console.log(`  ${task.id} - ${task.name}`)
    console.log("\nRun one cheap task: bun run evals/live-runner.ts --task t01-divide-by-zero")
    console.log("Run all tasks intentionally: bun run evals/live-runner.ts --all")
    return
  }

  let selected = TASKS
  if (!args.all && args.taskIds.length > 0) {
    const wanted = new Set(args.taskIds)
    selected = TASKS.filter(task => wanted.has(task.id))
  }
  if (typeof args.limit === "number") selected = selected.slice(0, args.limit)
  if (selected.length === 0) throw new Error("No matching eval tasks selected.")

  console.log(`DeepSeek Code Live Eval - ${selected.length}/${TASKS.length} tasks`)
  console.log("Budgets: round output <= " + (process.env.DEEPSEEK_MAX_ROUND_OUTPUT_TOKENS ?? "4000") +
    ", run output <= " + (process.env.DEEPSEEK_MAX_RUN_OUTPUT_TOKENS ?? "12000") +
    ", run cache miss <= " + (process.env.DEEPSEEK_MAX_RUN_CACHE_MISS_TOKENS ?? "120000"))

  const results: TaskResult[] = []
  let passed = 0
  let failed = 0
  let totalOutput = 0
  let totalCacheMiss = 0
  let totalCacheRead = 0
  let totalCacheCreate = 0
  let totalMs = 0
  let totalRounds = 0

  for (const task of selected) {
    try {
      const r = await runTask(task, args.timeoutMs)
      results.push(r)
      if (r.passed) passed += 1
      else failed += 1
      totalOutput += r.tokensOut
      totalCacheMiss += r.cacheMissInputTokens
      totalCacheRead += r.cacheReadInputTokens
      totalCacheCreate += r.cacheCreationInputTokens
      totalMs += r.wallTimeMs
      totalRounds += r.rounds
    } catch (e: any) {
      failed += 1
      console.log(`    CRASH: ${e.message}`)
    }
  }

  const total = results.length
  const cacheDenom = totalCacheRead + totalCacheMiss
  const cacheHitRate = cacheDenom > 0 ? Math.round((totalCacheRead / cacheDenom) * 100) : 0
  console.log(`\n${"=".repeat(60)}\nDEEPSEEK CODE LIVE EVAL RESULTS\n${"=".repeat(60)}`)
  console.log(`Pass: ${passed}/${total} (${total > 0 ? Math.round(passed / total * 100) : 0}%) | Fail: ${failed}`)
  console.log(`Output tokens: ${totalOutput.toLocaleString()} | Cache miss: ${totalCacheMiss.toLocaleString()} | Cache read: ${totalCacheRead.toLocaleString()} | Cache create: ${totalCacheCreate.toLocaleString()} | Hit: ${cacheHitRate}%`)
  console.log(`Time: ${(totalMs / 1000).toFixed(0)}s | Rounds: ${totalRounds}`)

  writeFileSync(join(EVAL_DIR, "summary.json"), JSON.stringify({
    timestamp: new Date().toISOString(),
    model: "deepseek-v4-pro",
    selectedTasks: selected.map(task => task.id),
    passed,
    failed,
    outputTokens: totalOutput,
    cacheMissInputTokens: totalCacheMiss,
    cacheReadInputTokens: totalCacheRead,
    cacheCreationInputTokens: totalCacheCreate,
    cacheHitRate,
    totalMs,
    totalRounds,
    passRate: total > 0 ? Math.round(passed / total * 100) : 0,
    results,
  }, null, 2))

  console.log(`\nSaved to: ${EVAL_DIR}/summary.json`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch(e => { console.error(e); process.exit(1) })
