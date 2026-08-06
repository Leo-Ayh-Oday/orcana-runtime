/** Reliability fail-closed 验证入口（RC-00）。
 *
 *  运行所有可靠性故障测试文件；任何 fail-closed 不变量被违反时退出码非零。
 *  与 gate-matrix.md 的 P0 Gate 一一对应。
 */
import { spawnSync } from "node:child_process"

const FILES = [
  "tests/tools/typescript_rc01.test.ts",
  "tests/completion_rc02.test.ts",
  "tests/contextguard_rc025.test.ts",
  "tests/permission_rc04a.test.ts",
  "tests/permission_rc04b.test.ts",
  "tests/gates_rc05.test.ts",
  "tests/runtime/linux/backend-facts.test.ts",
]

let failed = 0
for (const file of FILES) {
  const r = spawnSync("bun", ["test", file], { stdio: "inherit", encoding: "utf-8" })
  if (r.status !== 0) {
    failed++
    console.error(`[reliability] FAIL: ${file}`)
  } else {
    console.error(`[reliability] OK: ${file}`)
  }
}

if (failed > 0) {
  console.error(`[reliability] ${failed} file(s) failed — fail-closed invariants violated`)
  process.exit(1)
}
console.error("[reliability] all fail-closed invariants hold")
