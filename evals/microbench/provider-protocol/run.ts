/** ORMB-PP 入口 —— mock（确定性）+ live（真实 V4-Flash）套件。
 *
 *  P0 最小执行集（计划 §9）：10 mock + 5 live，Hard Gate 全 0。
 *  用法：
 *    bun run evals/microbench/provider-protocol/run.ts            # 全量（mock + live）
 *    bun run evals/microbench/provider-protocol/run.ts --mock-only # 只跑 mock（无网络）
 *    bun run evals/microbench/provider-protocol/run.ts --save      # 同时存档 JSON 到 reports/
 */

import { runMockSuite, printMockReport } from "./run-mock"

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const mockOnly = args.includes("--mock-only") || args.includes("-m")
  const save = args.includes("--save") || args.includes("-s")

  const mockReport = await runMockSuite()
  printMockReport(mockReport)

  if (mockOnly) {
    console.log("\n[run] mock-only 模式，跳过 live 套件")
    if (save) {
      const { saveReport } = await import("../reports")
      console.log(`[run] 报告已存档: ${saveReport(mockReport)}`)
    }
    process.exit(mockReport.summary.failed > 0 ? 1 : 0)
    return
  }

  const { runLiveSuite, printLiveReport } = await import("./run-live")
  const liveReport = await runLiveSuite()
  printLiveReport(liveReport)

  if (save) {
    const { saveReport } = await import("../reports")
    const p1 = saveReport(mockReport)
    const p2 = saveReport(liveReport)
    console.log(`\n[run] 报告已存档:\n   ${p1}\n   ${p2}`)
  }

  const failed = mockReport.summary.failed + liveReport.summary.failed
  const hardGatesFail = Object.entries(liveReport.hardGates).some(([, n]) => (n ?? 0) > 0)
  process.exit(failed > 0 || hardGatesFail ? 1 : 0)
}

main().catch((err) => {
  console.error(`[run] fatal: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
