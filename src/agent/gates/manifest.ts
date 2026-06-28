/** Gate Manifest — Step 3 decision matrix applied to telemetry data.
 *
 *  Design constraints:
 *    - Pure function: telemetry in, manifest out
 *    - Decision rules are explicit and documented
 *    - Safety nets (0% intercept, 0% FP) get special "keep as safety net" status
 *    - Pass-through filters are classified separately from blocking gates
 *
 *  Usage:
 *    const manifest = generateManifest(telemetry)
 *    console.log(manifestReport(manifest))
 */

import type { GateTelemetry } from "./telemetry"

export type GateDecision = "keep" | "tune" | "observe" | "delete" | "merge" | "safety_net" | "pass_through"

export interface GateVerdict {
  gate: string
  triggers: number
  blocks: number
  interceptRate: number
  falsePositives: number
  falsePositiveRate: number
  missed: number
  decision: GateDecision
  action: string
}

export interface GateManifest {
  verdicts: GateVerdict[]
  generatedAt: string
  summary: { keep: number; tune: number; observe: number; delete: number; merge: number; safety_net: number; pass_through: number }
}

/** Pass-through gates — structurally never block, only narrow tool sets.
 *  PR-7.1: layer-prefixed names. */
const PASS_THROUGH = new Set(["policy:tool_disclosure", "policy:readonly_plan", "policy:ripple_tool_filter"])

/** Safety nets — keep regardless of intercept rate if FP rate is 0.
 *  PR-7.1: layer-prefixed names. */
const SAFETY_NETS = new Set(["policy:context_budget", "policy:rate_limit", "policy:permission"])

/** Apply the Step 3 decision matrix to a GateTelemetry instance. */
export function generateManifest(telemetry: GateTelemetry): GateManifest {
  const verdicts: GateVerdict[] = []
  const summary = { keep: 0, tune: 0, observe: 0, delete: 0, merge: 0, safety_net: 0, pass_through: 0 }

  for (const gate of telemetry.gateNames()) {
    const hit = telemetry.get(gate)!
    const interceptRate = hit.triggers > 0 ? hit.blocks / hit.triggers : 0
    const fpRate = hit.blocks > 0 ? hit.falsePositives / hit.blocks : 0

    let decision: GateDecision
    let action: string

    // ── Decision matrix (ordered by priority) ──

    if (PASS_THROUGH.has(gate)) {
      decision = "pass_through"
      action = "structurally never blocks — narrows tool sets via context mutation"
    } else if (hit.missed > 0) {
      decision = "keep"
      action = `有漏拦 (${hit.missed} missed) — 🆕 这是加新门或强化此门的时机`
    } else if (SAFETY_NETS.has(gate) && fpRate === 0) {
      decision = "safety_net"
      action = "keep as safety net — 0% FP, protects system integrity"
    } else if (interceptRate > 0.20 && fpRate < 0.10) {
      decision = "keep"
      action = `✅ verified — intercept ${(interceptRate * 100).toFixed(0)}%, FP ${(fpRate * 100).toFixed(0)}%`
    } else if (interceptRate > 0.20 && fpRate >= 0.10) {
      decision = "tune"
      action = `🔧 adjust thresholds — intercept ${(interceptRate * 100).toFixed(0)}% but FP ${(fpRate * 100).toFixed(0)}%`
    } else if (interceptRate >= 0.05 && interceptRate <= 0.20) {
      decision = "observe"
      action = `⚠️ keep but observe — intercept ${(interceptRate * 100).toFixed(0)}%, lower priority`
    } else if (interceptRate < 0.05 && fpRate > 0) {
      decision = "delete"
      action = `❌ delete or merge — intercept ${(interceptRate * 100).toFixed(0)}%, FP ${(fpRate * 100).toFixed(0)}%`
    } else if (interceptRate < 0.05) {
      // <5% intercept, 0% FP — likely synthetic data or truly unnecessary
      if (hit.triggers < 10) {
        decision = "observe"
        action = `⚠️ insufficient data (${hit.triggers} triggers) — need more samples`
      } else {
        decision = "delete"
        action = `❌ <5% intercept over ${hit.triggers} triggers — not earning its keep`
      }
    } else {
      decision = "observe"
      action = `⚠️ borderline — review manually`
    }

    summary[decision]++
    verdicts.push({
      gate,
      triggers: hit.triggers,
      blocks: hit.blocks,
      interceptRate,
      falsePositives: hit.falsePositives,
      falsePositiveRate: fpRate,
      missed: hit.missed,
      decision,
      action,
    })
  }

  // Sort: keep → safety_net → tune → observe → delete → pass_through → merge
  const order: GateDecision[] = ["keep", "safety_net", "tune", "observe", "delete", "pass_through", "merge"]
  verdicts.sort((a, b) => order.indexOf(a.decision) - order.indexOf(b.decision))

  return { verdicts, generatedAt: new Date().toISOString(), summary }
}

/** Format a GateManifest as a markdown report. */
export function manifestReport(manifest: GateManifest): string {
  const lines: string[] = [
    "# Gate Manifest v1",
    "",
    `Generated: ${manifest.generatedAt}`,
    "",
    "## Summary",
    "",
    `| Decision | Count |`,
    `|---|---|`,
    `| ✅ keep | ${manifest.summary.keep} |`,
    `| 🛡️ safety_net | ${manifest.summary.safety_net} |`,
    `| 🔧 tune | ${manifest.summary.tune} |`,
    `| ⚠️ observe | ${manifest.summary.observe} |`,
    `| ❌ delete | ${manifest.summary.delete} |`,
    `| 🔀 merge | ${manifest.summary.merge} |`,
    `| ⏩ pass_through | ${manifest.summary.pass_through} |`,
    "",
    "## Verdicts",
    "",
    "| Gate | Triggers | Blocks | Int% | FP% | Missed | Decision | Action |",
    "|---|---|---|---|---|---|---|---|",
  ]

  for (const v of manifest.verdicts) {
    const intPct = `${(v.interceptRate * 100).toFixed(0)}%`
    const fpPct = `${(v.falsePositiveRate * 100).toFixed(0)}%`
    const deco: Record<GateDecision, string> = {
      keep: "✅ keep",
      tune: "🔧 tune",
      observe: "⚠️ observe",
      delete: "❌ delete",
      merge: "🔀 merge",
      safety_net: "🛡️ safety_net",
      pass_through: "⏩ pass_through",
    }
    lines.push(`| ${v.gate} | ${v.triggers} | ${v.blocks} | ${intPct} | ${fpPct} | ${v.missed} | ${deco[v.decision]} | ${v.action} |`)
  }

  return lines.join("\n")
}
