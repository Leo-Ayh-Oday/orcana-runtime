/** ORMB 报告存档 —— 把 MBEReport 落盘到 evals/microbench/reports/。
 *
 *  文件名: <suite>-<commit>-<yyyyMMdd-HHmmss>.json（suite 含 -live 后缀区分 mock/live）。
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { MBEReport } from "./contracts/result"

export function reportFilename(report: MBEReport): string {
  const d = new Date(report.generatedAt)
  const pad = (n: number) => String(n).padStart(2, "0")
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  return `${report.suite}-${report.header.orcanaCommit}-${stamp}.json`
}

export function saveReport(report: MBEReport, dir = "evals/microbench/reports"): string {
  const full = join(process.cwd(), dir)
  mkdirSync(full, { recursive: true })
  const path = join(full, reportFilename(report))
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`)
  return path
}
