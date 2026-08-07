/** BRD-000 — Harness Calibration（OBRDS DESIGN.md §6）。
 *  任何测试前必须运行：fixture 自校准（baseline FAIL / gold PASS / no-op FAIL /
 *  gold 3/3 可重复）。任一不满足 → HARNESS_FAIL（不得归因 Orcana）。
 *
 *  Lane A Oracle：确定性脚本跑测试命令。BRD-000 本身即 Harness 校准，
 *  Lane B 无独立内容（fixture 校验即是全部）。
 */

import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import type { ReadinessScenario, WorkspaceFixture } from "../../contracts"
import { zeroHardGates } from "../../contracts"

const CALIBRATION_SRC = {
  buggy: `export function add(a: number, b: number): number {
  return a + b + 1; // BUG: off-by-one
}
`,
  fixed: `export function add(a: number, b: number): number {
  return a + b;
}
`,
}

const TEST_SRC = `import { add } from "../src/calculate";
import { test, expect } from "bun:test";

test("add(1,2) === 3", () => {
  expect(add(1, 2)).toBe(3);
});
`

interface CalibrationFixture extends WorkspaceFixture {
  root: string
  variants: Record<string, () => void>
}

async function buildFixture(): Promise<CalibrationFixture> {
  const root = mkdtempSync(join(tmpdir(), "brd000-"))
  const apply = (calculateSrc: string) => {
    mkdirSync(join(root, "src"), { recursive: true })
    mkdirSync(join(root, "tests"), { recursive: true })
    writeFileSync(join(root, "src", "calculate.ts"), calculateSrc)
    writeFileSync(join(root, "tests", "calculate.test.ts"), TEST_SRC)
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "brd000", private: true, type: "module" }, null, 2))
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, outDir: "dist" }, include: ["src", "tests"] }, null, 2))
  }
  return {
    root,
    variants: {
      baseline: () => apply(CALIBRATION_SRC.buggy),
      gold: () => apply(CALIBRATION_SRC.fixed),
      noop: () => apply(CALIBRATION_SRC.buggy), // no-op：不修改任何内容（= baseline 状态）
    },
    dispose: async () => rmSync(root, { recursive: true, force: true }),
  }
}

function runTests(root: string): { exit: number; out: string } {
  const r = spawnSync("bun", ["test"], { cwd: root, encoding: "utf8", timeout: 60_000, env: { ...process.env, PATH: "/usr/local/bin:/usr/bin:/bin:" + process.env.PATH } })
  return { exit: r.status ?? -1, out: (r.stdout ?? "") + (r.stderr ?? "") }
}

export const scenarios: ReadinessScenario[] = [
  {
    id: "BRD-000",
    name: "Harness Calibration",
    timeoutMs: 300_000,
    maxRounds: 1,
    maxGeneratedTokens: 0,
    hardGates: [],
    faults: [],
    monitors: [],

    setup: async (): Promise<WorkspaceFixture> => buildFixture(),

    oracle: [
      {
        name: "baseline 必须 FAIL",
        run: async ctx => {
          const f = ctx.fixture as CalibrationFixture
          f.variants.baseline()
          const r = runTests(f.root)
          return { ok: r.exit !== 0, detail: `exit=${r.exit}` }
        },
      },
      {
        name: "gold 必须 PASS",
        run: async ctx => {
          const f = ctx.fixture as CalibrationFixture
          f.variants.gold()
          const r = runTests(f.root)
          return { ok: r.exit === 0, detail: `exit=${r.exit}` }
        },
      },
      {
        name: "no-op 必须 FAIL",
        run: async ctx => {
          const f = ctx.fixture as CalibrationFixture
          f.variants.noop()
          const r = runTests(f.root)
          return { ok: r.exit !== 0, detail: `exit=${r.exit}` }
        },
      },
      {
        name: "gold 可重复 3/3",
        run: async ctx => {
          const f = ctx.fixture as CalibrationFixture
          const results: number[] = []
          for (let i = 0; i < 3; i++) {
            f.variants.gold()
            results.push(runTests(f.root).exit)
          }
          return { ok: results.every(e => e === 0), detail: `exits=${results.join(",")}` }
        },
      },
    ],

    scripted: [],

    verify: async ctx => {
      const oracleResults = ctx.trace
        .filter(e => e.type === "gate.decided" && e.data?.lane === "oracle")
        .map(e => e.data as { action: string; ok: boolean; detail?: string })
      const allOk = oracleResults.length === 4 && oracleResults.every(r => r.ok)
      return {
        verdict: allOk ? "PASS" : "HARNESS_FAIL",
        hardGates: zeroHardGates(),
        reasons: allOk ? [] : [`fixture 校准失败: ${oracleResults.filter(r => !r.ok).map(r => r.action).join(", ")}`],
        metrics: {
          tokens: { inputTokens: 0, reasoningTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheMissTokens: 0, toolResultTokens: 0, tokensPerPass: 0 },
          time: { triageMs: 0, timeToFirstModelEvent: 0, timeToFirstTool: 0, providerMs: 0, toolMs: 0, verificationMs: 0, cleanupMs: 0, wallMs: 0 },
          behavior: { rounds: 0, toolCalls: 0, uniqueToolCalls: 0, duplicateToolCalls: 0, fileReads: 0, duplicateFileReads: 0, writes: 0, retries: 0, contextCompactions: 0, checkpointCount: 0 },
          quality: { taskPass: true, constraintViolations: 0, staleEvidenceCount: 0, falseCompletion: 0, duplicateSideEffects: 0, orphanResources: 0 },
        },
      }
    },
  },
]
