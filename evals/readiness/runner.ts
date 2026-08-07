#!/usr/bin/env bun
/** OBRDS v0.1 — Runner 骨架（§19/§20/§21）。
 *  bun run eval:readiness -- --scenario BRD-000 --lane all --seed 1 --strict
 *
 *  场景注册：scenarios/brd-0XX/index.ts 导出 ReadinessScenario[]。
 *  首批：BRD-000/001/005/006/007（§24 实施优先级第一批）。
 */

import { mkdirSync, writeFileSync, existsSync } from "node:fs"
import { join, resolve } from "node:path"
import type { DiagnosticVerdict, Lane, ReadinessScenario, VerificationContext } from "./contracts"
import { ExitCode, hardGatesViolated, zeroHardGates } from "./contracts"

interface RunOptions {
  scenario?: string
  suite?: "core" | "live" | "pilot"
  lanes: Lane[]
  seed: number
  repeats: number
  strict: boolean
  model?: string
}

function parseArgs(argv: string[]): RunOptions {
  const opts: RunOptions = { lanes: ["oracle", "scripted"], seed: 1, repeats: 1, strict: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    switch (a) {
      case "--scenario": opts.scenario = argv[++i]; break
      case "--suite": opts.suite = argv[++i] as RunOptions["suite"]; break
      case "--lane": {
        const raw = argv[++i]!
        opts.lanes = raw === "all" ? ["oracle", "scripted", "ceiling", "production"] : raw.split(",") as Lane[]
        break
      }
      case "--seed": opts.seed = Number(argv[++i]); break
      case "--repeats": opts.repeats = Number(argv[++i]); break
      case "--strict": opts.strict = true; break
      case "--model": opts.model = argv[++i]; break
      case "--thinking": argv[++i]; break
      case "--max-tokens": argv[++i]; break
      case "--run-token-cap": argv[++i]; break
      default: break
    }
  }
  return opts
}

/** 动态加载场景注册表（每个 brd-0XX/index.ts 导出 { scenarios }）。 */
async function loadScenarios(filter?: string): Promise<ReadinessScenario[]> {
  const base = resolve(import.meta.dir, "scenarios")
  const dirs = existsSync(base) ? (await import("node:fs").then(m => m.readdirSync(base))).filter(d => d.startsWith("brd-")) : []
  const all: ReadinessScenario[] = []
  for (const dir of dirs.sort()) {
    const entry = join(base, dir, "index.ts")
    if (!existsSync(entry)) continue
    try {
      const mod = (await import(entry)) as { scenarios?: ReadinessScenario[] }
      all.push(...(mod.scenarios ?? []))
    } catch (error) {
      console.error(`[runner] 场景加载失败 ${dir}: ${error instanceof Error ? error.message : error}`)
    }
  }
  return filter ? all.filter(s => s.id === filter || s.id.toLowerCase().includes(filter.toLowerCase())) : all
}

function writeRunArtifacts(runDir: string, ctx: VerificationContext, verdict: DiagnosticVerdict): void {
  mkdirSync(runDir, { recursive: true })
  writeFileSync(join(runDir, "verdict.json"), JSON.stringify({ verdict, at: Date.now() }, null, 2))
  writeFileSync(join(runDir, "trace.jsonl"), ctx.trace.map(e => JSON.stringify(e)).join("\n"))
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  const scenarios = await loadScenarios(opts.scenario)
  if (scenarios.length === 0) {
    console.error("[runner] 无匹配场景")
    process.exit(ExitCode.RunnerError)
  }
  console.log(`[runner] 场景: ${scenarios.map(s => s.id).join(", ")} | lanes: ${opts.lanes.join(",")} | seed=${opts.seed} repeats=${opts.repeats}`)

  let exit = ExitCode.AllHardGatesPass
  for (const scenario of scenarios) {
    for (let rep = 0; rep < opts.repeats; rep++) {
      const seed = opts.seed + rep
      const runId = `${scenario.id.toLowerCase()}-${seed}-${Date.now().toString(36)}`
      const runDir = join(".orcana", "evals", "readiness", runId)
      const ctx: VerificationContext = {
        fixture: await scenario.setup(seed),
        lane: opts.lanes[0] ?? "oracle",
        seed,
        trace: [{ runId, timestamp: new Date().toISOString(), type: "run.started" }],
        hardGates: zeroHardGates(),
        runDir,
      }
      console.log(`\n═══ ${scenario.id} ${scenario.name} (seed=${seed}, lane=${ctx.lane}) ═══`)
      try {
        for (const lane of opts.lanes) {
          ctx.lane = lane
          console.log(`── Lane ${lane.toUpperCase()} ──`)
          if (lane === "oracle") {
            for (const action of scenario.oracle) {
              const r = await action.run(ctx)
              ctx.trace.push({ runId, timestamp: new Date().toISOString(), type: "gate.decided", data: { lane, action: action.name, ok: r.ok, detail: r.detail } })
              console.log(`  [oracle] ${action.name}: ${r.ok ? "✓" : "✗"} ${r.detail ?? ""}`)
            }
          } else if (lane === "scripted") {
            for (const action of scenario.scripted) {
              const r = await action.run(ctx)
              ctx.trace.push({ runId, timestamp: new Date().toISOString(), type: "gate.decided", data: { lane, action: action.name, ok: r.ok, detail: r.detail } })
              console.log(`  [scripted] ${action.name}: ${r.ok ? "✓" : "✗"} ${r.detail ?? ""}`)
            }
          } else {
            console.log(`  [${lane}] 待接入 live agent（Lane C/D 需要模型连接）`)
          }
        }
        const result = await scenario.verify(ctx)
        const violated = hardGatesViolated(result.hardGates)
        console.log(`判定: ${result.verdict} | hard gates 违规: ${violated.length ? violated.join(",") : "无"} | 理由: ${result.reasons.join("; ")}`)
        ctx.trace.push({ runId, timestamp: new Date().toISOString(), type: "run.finished", data: { verdict: result.verdict } })
        writeRunArtifacts(runDir, ctx, result.verdict)
        // 退出码映射（§21）
        if (result.verdict === "PASS") continue
        if (result.verdict === "HARNESS_FAIL") exit = Math.max(exit, ExitCode.HarnessFixtureFail)
        else if (result.verdict === "INFRA_FAIL") exit = Math.max(exit, ExitCode.InfraIntegrityFail)
        else if (result.verdict === "ENV_BLOCKED") exit = Math.max(exit, ExitCode.EnvInsufficient)
        else if (result.verdict === "INCOMPLETE") exit = Math.max(exit, ExitCode.FunctionalFail)
        else exit = Math.max(exit, ExitCode.FunctionalFail)
      } catch (error) {
        console.error(`[runner] ${scenario.id} 执行异常: ${error instanceof Error ? error.stack ?? error.message : error}`)
        exit = Math.max(exit, ExitCode.RunnerError)
      } finally {
        await ctx.fixture.dispose()
      }
    }
  }
  process.exit(exit)
}

main().catch(e => { console.error(e); process.exit(ExitCode.RunnerError) })
