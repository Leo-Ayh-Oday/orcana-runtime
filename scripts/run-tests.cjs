/**
 * GATE-TEST-01（Formal Gate Test Matrix）：官方测试 runner。
 *
 *  - 聚合模式：不 fail-fast —— 跑完全部文件，最后汇总失败清单与耗时，
 *    有失败才 exit 1（单个 flaky 不再让门禁信息丢失在第一个失败点）。
 *  - 状态标注（合同：不能"为不 FAIL 直接排除"、不能"没 key = FAIL"）：
 *      QUARANTINED —— live/heavy 测试显式隔离（报告可见，带原因），
 *      不静默排除；结果仍归入汇总统计。
 *      ENV_BLOCKED —— 环境缺失（非 Linux 等）时显式报 blocked。
 *  - 每文件 wall-time 记录（OTS/EVAL 预算观测基础）。
 */

const { existsSync, readdirSync, statSync } = require("node:fs")
const { join, relative, sep } = require("node:path")
const { spawnSync } = require("node:child_process")

const root = process.cwd()
const extraArgs = process.argv.slice(2)

// GATE-TEST-01：显式隔离（QUARANTINED）—— 不静默排除；每项带原因，
// 报告中逐条可见。迁移回正式门禁需先过 isolated lane。
const QUARANTINED = new Map([
  ["tests/code_as_action.test.ts", "live lane: 需要 provider 环境"],
  ["tests/e2e_fullstack_flow.test.ts", "live lane: 端到端 provider + 网络"],
  ["tests/e2e_user_flow.test.ts", "live lane: 端到端 provider + 网络"],
  ["tests/fullstack_depth.test.ts", "live lane: 深度端到端"],
  ["tests/knowledge_pipeline.test.ts", "live lane: 知识库外部依赖"],
  ["tests/thinking_depth.test.ts", "live lane: provider 深度测试"],
  ["tests/thinking_quality.test.ts", "live lane: provider 质量测试"],
])

const excludedDirs = [
  "tests/tmp",
  "src/skills/builtin/examples",
]

function toRepoPath(fullPath) {
  return relative(root, fullPath).split(sep).join("/")
}

function isExcludedDir(fullPath) {
  const rel = toRepoPath(fullPath)
  return excludedDirs.some(dir => rel === dir || rel.startsWith(`${dir}/`))
}

function walk(dir, out = []) {
  if (isExcludedDir(dir)) return out

  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      if (isExcludedDir(full)) continue
      walk(full, out)
    } else if (entry.endsWith(".test.ts") || entry.endsWith(".test.tsx")) {
      const rel = toRepoPath(full)
      if (!QUARANTINED.has(rel)) out.push(rel)
    }
  }
  return out
}

const files = [...walk(join(root, "tests")), ...walk(join(root, "src"))].sort()

function resolveBun() {
  if (process.platform !== "win32") return { command: "bun", shell: false }
  const candidates = [
    process.env.BUN_EXE,
    process.env.BUN_INSTALL ? join(process.env.BUN_INSTALL, "bin", "bun.exe") : undefined,
    process.env.APPDATA ? join(process.env.APPDATA, "npm", "node_modules", "bun", "bin", "bun.exe") : undefined,
  ].filter(Boolean)
  const found = candidates.find(p => existsSync(p))
  return found ? { command: found, shell: false } : { command: "bun", shell: true }
}

// ENV_BLOCKED：Linux runtime 测试在非 Linux 平台显式 blocked（不 FAIL）。
const isLinux = process.platform === "linux"
const LINUX_RUNTIME_PREFIX = "tests/runtime/linux/"

const bun = resolveBun()
const results = [] // { file, status, durationMs, error? }
const startedAt = Date.now()

for (const file of files) {
  const fileStart = Date.now()
  console.log(`\n[run-tests] ${file}`)
  let result
  if (!isLinux && file.startsWith(LINUX_RUNTIME_PREFIX)) {
    console.log(`  [ENV_BLOCKED] linux runtime test on non-linux platform`)
    results.push({ file, status: "ENV_BLOCKED", durationMs: 0 })
    continue
  }
  const nativeFile = `.${sep}${file.split("/").join(sep)}`
  result = spawnSync(bun.command, ["test", nativeFile, ...extraArgs], {
    stdio: "inherit",
    shell: bun.shell,
  })
  const durationMs = Date.now() - fileStart
  if (result.error) {
    results.push({ file, status: "ERROR", durationMs, error: result.error.message })
  } else if (result.status === 0) {
    results.push({ file, status: "PASS", durationMs })
  } else {
    results.push({ file, status: "FAIL", durationMs, exitCode: result.status })
  }
}

// ── 汇总报告（聚合失败，不 fail-fast） ──

const totalMs = Date.now() - startedAt
const pass = results.filter(r => r.status === "PASS").length
const fail = results.filter(r => r.status === "FAIL").length
const blocked = results.filter(r => r.status === "ENV_BLOCKED").length
const errored = results.filter(r => r.status === "ERROR").length

console.log(`\n========================================`)
console.log(`GATE-TEST-01 aggregate report`)
console.log(`  total      : ${results.length} files`)
console.log(`  pass       : ${pass}`)
console.log(`  FAIL       : ${fail}`)
console.log(`  ENV_BLOCKED: ${blocked}`)
console.log(`  ERROR      : ${errored}`)
console.log(`  total time : ${(totalMs / 1000).toFixed(1)}s`)

if (fail > 0 || errored > 0) {
  console.log(`\n  failed files (aggregated):`)
  for (const r of results) {
    if (r.status === "FAIL" || r.status === "ERROR") {
      console.log(`    ✗ ${r.file}  (${(r.durationMs / 1000).toFixed(1)}s${r.exitCode !== undefined ? `, exit ${r.exitCode}` : ""}${r.error ? `, ${r.error}` : ""})`)
    }
  }
}

console.log(`\n  QUARANTINED (${QUARANTINED.size}, not run — reasons visible):`)
for (const [file, reason] of QUARANTINED) {
  console.log(`    ⚠ ${file} — ${reason}`)
}

console.log(`  slowest files:`)
const sorted = [...results].sort((a, b) => b.durationMs - a.durationMs).slice(0, 5)
for (const r of sorted) {
  console.log(`    ${(r.durationMs / 1000).toFixed(1)}s  ${r.file}  [${r.status}]`)
}
console.log(`========================================\n`)

if (fail > 0 || errored > 0) {
  process.exit(1)
}
