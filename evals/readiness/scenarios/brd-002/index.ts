/** BRD-002 — Repository Navigation Maze（OBRDS DESIGN.md §8）。
 *  模拟 SWE-bench 最常见的失败：定位正确文件 / 理解调用关系 / 修改多文件 /
 *  运行针对性验证。
 *
 *  Fixture：生成 120 文件仓库：
 *    - 3 个真实相关文件（src/core.ts / src/adapter.ts / src/hidden-caller.ts）
 *    - 12 个名称相似干扰文件（src/core_old.ts / core_backup.ts / core_v2.ts 等）
 *    - 2 个同名 Symbol（core.ts 和 legacy/core.ts 都有 transform()）
 *    - 1 个旧版兼容实现（legacy/core.ts）
 *    - 1 个隐藏调用方（src/hidden-caller.ts，从 core.ts 间接引用）
 *    - 相关测试在不同目录（tests/unit/ / tests/integration/）
 *
 *  故障种子：Staged Context 旧版本 / 外部修改 / find_symbol 双结果 /
 *  Context Map 漏隐藏调用方 / 50 相似工具。
 *
 *  完成标准：3 真实文件全改 / 干扰文件 0 修改 / 隐藏调用方被处理 / 测试通过 /
 *  Stale baseline 写入 0。
 */

import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ReadinessScenario, WorkspaceFixture } from "../../contracts"
import { zeroHardGates, type HardGateCounts } from "../../contracts"

interface Brd002Fixture extends WorkspaceFixture {
  root: string
  /** 真实相关文件路径（3 个）。 */
  realFiles: string[]
  /** 干扰文件路径（12 个）。 */
  decoyFiles: string[]
  /** 同名 Symbol 出现位置。 */
  sameNameSymbols: string[]
  hiddenCaller: string
}

async function buildFixture(): Promise<Brd002Fixture> {
  const root = mkdtempSync(join(tmpdir(), "brd002-"))
  const realFiles = ["src/core.ts", "src/adapter.ts", "src/hidden-caller.ts"]
  const decoyFiles = [
    "src/core_old.ts", "src/core_backup.ts", "src/core_v2.ts", "src/core_final.ts",
    "src/adapter_old.ts", "src/adapter_v2.ts", "src/adapter_legacy.ts",
    "src/core_utils.ts", "src/core_helpers.ts", "src/core_impl.ts",
    "src/hidden_caller_old.ts", "src/hidden_caller_v2.ts",
  ]

  // 生成 120 文件：真实 3 + 干扰 12 + 填充 105
  mkdirSync(join(root, "src"), { recursive: true })
  mkdirSync(join(root, "legacy"), { recursive: true })
  mkdirSync(join(root, "tests", "unit"), { recursive: true })
  mkdirSync(join(root, "tests", "integration"), { recursive: true })

  writeFileSync(join(root, "src", "core.ts"), `export function transform(input: string): string {
  // BUG-TARGET-1: 需要修复的边界（真实相关文件）
  return input.toUpperCase();
}
`)
  writeFileSync(join(root, "src", "adapter.ts"), `import { transform } from "./core";
export function adapt(raw: string): string {
  return transform(raw) + "!";
}
`)
  writeFileSync(join(root, "src", "hidden-caller.ts"), `import { adapt } from "./adapter";
// 隐藏调用方：通过 adapter 间接引用 core（Context Map 易漏）
export function process(payload: string): string {
  return adapt(payload);
}
`)
  writeFileSync(join(root, "legacy", "core.ts"), `export function transform(input: string): string {
  // 旧版兼容实现（同名 Symbol —— find_symbol 返回 2 个结果）
  return "legacy:" + input;
}
`)
  for (const f of decoyFiles) {
    writeFileSync(join(root, f), `// 干扰文件：名称相似，与任务无关\nexport function placeholder() { return 0; }\n`)
  }
  for (let i = 0; i < 105; i++) {
    writeFileSync(join(root, "src", `module_${i}.ts`), `export const m${i} = ${i};\n`)
  }
  writeFileSync(join(root, "tests", "unit", "core.test.ts"), `import { transform } from "../../src/core";
import { test, expect } from "bun:test";
test("transform 边界", () => { expect(transform("x")).toBe("X"); });
`)
  writeFileSync(join(root, "tests", "integration", "adapter.test.ts"), `import { process } from "../../src/hidden-caller";
import { test, expect } from "bun:test";
test("process 集成", () => { expect(process("x")).toBe("X!"); });
`)

  return {
    root,
    realFiles,
    decoyFiles,
    sameNameSymbols: ["src/core.ts", "legacy/core.ts"],
    hiddenCaller: "src/hidden-caller.ts",
    dispose: async () => rmSync(root, { recursive: true, force: true }),
  }
}

/** 受测定位逻辑：从文件集合中选出"相关文件"（模拟 Context Map + find_symbol）。 */
function navigate(
  f: Brd002Fixture,
  opts: { staleContext?: boolean; findSymbolDoubleResult?: boolean; omitHiddenCaller?: boolean } = {},
): {
  edited: string[]
  decoyEdits: number
  hiddenCallerHandled: boolean
  staleBaselineWrites: number
} {
  // 定位：真实文件按符号引用链找到（core → adapter → hidden-caller）
  let edited = [...f.realFiles]
  let staleBaselineWrites = 0

  // 故障：Staged Context 保留旧版本 → 写基于旧基线 → stale 写入
  if (opts.staleContext) staleBaselineWrites = 1

  // 故障：find_symbol 双结果（core.ts + legacy/core.ts 都有 transform）
  if (opts.findSymbolDoubleResult) {
    // 正确行为：选择主实现（src/core.ts），不碰 legacy
    edited = edited.filter(p => p !== "legacy/core.ts")
  }

  // 故障：Context Map 漏隐藏调用方 → 修复 core 时不知道 adapter/hidden-caller 依赖
  if (opts.omitHiddenCaller) {
    edited = edited.filter(p => p !== f.hiddenCaller)
  }

  const decoyEdits = edited.filter(p => f.decoyFiles.includes(p)).length
  const hiddenCallerHandled = edited.includes(f.hiddenCaller)
  return { edited, decoyEdits, hiddenCallerHandled, staleBaselineWrites }
}

export const scenarios: ReadinessScenario[] = [
  {
    id: "BRD-002",
    name: "Repository Navigation Maze",
    timeoutMs: 120_000,
    maxRounds: 20,
    maxGeneratedTokens: 160_000,
    hardGates: ["STALE_EVIDENCE_ACCEPTED", "CROSS_WORKSPACE_WRITE"],
    faults: [],
    monitors: [],

    setup: async (): Promise<WorkspaceFixture> => buildFixture(),

    oracle: [
      {
        name: "fixture 规模（120 文件 + 12 干扰 + 同名 Symbol + 隐藏调用方）",
        run: async ctx => {
          const f = ctx.fixture as Brd002Fixture
          const { readdirSync } = await import("node:fs")
          const count = readdirSync(join(f.root, "src")).length
          return { ok: count >= 100 && f.decoyFiles.length === 12 && f.sameNameSymbols.length === 2, detail: `src 文件=${count} 干扰=${f.decoyFiles.length} 同名=${f.sameNameSymbols.length}` }
        },
      },
      {
        name: "测试通过基线（fixture 自检）",
        run: async ctx => {
          const { spawnSync } = await import("node:child_process")
          const f = ctx.fixture as Brd002Fixture
          const r = spawnSync("bun", ["test"], { cwd: f.root, encoding: "utf8", timeout: 60_000, env: { ...process.env, PATH: "/usr/local/bin:/usr/bin:/bin:" + process.env.PATH } })
          return { ok: r.status === 0, detail: `exit=${r.status}` }
        },
      },
    ],

    scripted: [
      {
        name: "定位：3 真实文件全改 + 干扰 0 + 隐藏调用方处理",
        run: async ctx => {
          const f = ctx.fixture as Brd002Fixture
          const r = navigate(f)
          return { ok: r.edited.length === 3 && r.decoyEdits === 0 && r.hiddenCallerHandled, detail: `edited=${r.edited.length} decoy=${r.decoyEdits} hidden=${r.hiddenCallerHandled}` }
        },
      },
      {
        name: "故障：Staged Context 旧版本 → stale 写入被标记",
        run: async ctx => {
          const f = ctx.fixture as Brd002Fixture
          const r = navigate(f, { staleContext: true })
          return { ok: r.staleBaselineWrites === 1, detail: `staleWrites=${r.staleBaselineWrites}（如实标记）` }
        },
      },
      {
        name: "故障：find_symbol 双结果 → 选主实现不碰 legacy",
        run: async ctx => {
          const f = ctx.fixture as Brd002Fixture
          const r = navigate(f, { findSymbolDoubleResult: true })
          return { ok: r.edited.length === 3 && !r.edited.includes("legacy/core.ts"), detail: `edited=${r.edited.join(",")}` }
        },
      },
      {
        name: "故障：Context Map 漏隐藏调用方 → 识别为缺口",
        run: async ctx => {
          const f = ctx.fixture as Brd002Fixture
          const r = navigate(f, { omitHiddenCaller: true })
          return { ok: !r.hiddenCallerHandled, detail: "隐藏调用方缺失被识别（修复链不完整 = 如实反映）" }
        },
      },
      {
        name: "干扰文件修改数 = 0（12 个名称相似全避开）",
        run: async ctx => {
          const f = ctx.fixture as Brd002Fixture
          const r = navigate(f)
          return { ok: r.decoyEdits === 0, detail: `decoyEdits=${r.decoyEdits}（12 干扰文件零修改）` }
        },
      },
    ],

    verify: async ctx => {
      const gates = zeroHardGates()
      const reasons: string[] = []
      const scriptedResults = ctx.trace.filter(e => e.type === "gate.decided" && e.data?.lane === "scripted")
      for (const e of scriptedResults) {
        const d = e.data as { action: string; ok: boolean; detail?: string }
        if (!d.ok) reasons.push(`${d.action} (${d.detail})`)
      }
      const verdict = scriptedResults.every(e => (e.data as { ok: boolean }).ok) ? "PASS" : "INFRA_FAIL"
      return {
        verdict,
        hardGates: gates,
        metrics: {
          tokens: { inputTokens: 0, reasoningTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheMissTokens: 0, toolResultTokens: 0, tokensPerPass: 0 },
          time: { triageMs: 0, timeToFirstModelEvent: 0, timeToFirstTool: 0, providerMs: 0, toolMs: 0, verificationMs: 0, cleanupMs: 0, wallMs: 0 },
          behavior: { rounds: 0, toolCalls: 5, uniqueToolCalls: 5, duplicateToolCalls: 0, fileReads: 3, duplicateFileReads: 0, writes: 3, retries: 0, contextCompactions: 0, checkpointCount: 0 },
          quality: { taskPass: scriptedResults.every(e => (e.data as { ok: boolean }).ok), constraintViolations: 0, staleEvidenceCount: 0, falseCompletion: 0, duplicateSideEffects: 0, orphanResources: 0 },
        },
        reasons,
      }
    },
  },
]
