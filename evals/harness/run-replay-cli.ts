/**
 * H12 run replay CLI (PR-level CI command).
 *
 *   bun run evals/harness/run-replay-cli.ts [--list] [--filter <id>] [--report]
 *
 * Runs the HR scenario suite through the scripted replay executor, writes
 * per-case results to ~/.orcana/evals/replay-history/<caseId>.json and exits
 * 1 when any case fails.
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { runReplaySuite } from "./run-replay"
import { loadHrScenarios } from "./scenarios"

const HISTORY_DIR = join(homedir(), ".orcana", "evals", "replay-history")

async function main(): Promise<number> {
  const args = process.argv.slice(2)
  const listOnly = args.includes("--list")
  const filterIndex = args.indexOf("--filter")
  const filter = filterIndex >= 0 ? args[filterIndex + 1] : undefined
  const withReport = args.includes("--report")

  const all = loadHrScenarios()
  const cases = filter ? all.filter((c) => c.caseId.includes(filter)) : all

  if (listOnly) {
    for (const c of cases) {
      console.log(`${c.caseId}\t${c.title ?? ""}`)
    }
    return 0
  }

  const { results, passed, failed } = await runReplaySuite(cases, { keepWorkspaceOnFailure: true })
  mkdirSync(HISTORY_DIR, { recursive: true })
  for (const result of results) {
    writeFileSync(join(HISTORY_DIR, `${result.caseId}.json`), JSON.stringify(result, null, 2))
    console.log(`${result.passed ? "PASS" : "FAIL"} ${result.caseId} (${result.durationMs}ms)`)
    if (!result.passed) {
      for (const failure of result.failures) console.log(`  ✗ ${failure}`)
    }
  }
  if (withReport) {
    console.log(`\n${passed}/${results.length} passed`)
  }
  return failed === 0 ? 0 : 1
}

main().then((code) => process.exit(code))
