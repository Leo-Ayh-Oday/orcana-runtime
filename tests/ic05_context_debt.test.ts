/** IC05 —— ContextDebt 合同测试（P2/P6 语义先行）。 */

import { describe, expect, test } from "bun:test"
import {
  createContextDebts,
  openContextDebtCount,
  openContextDebts,
  resolveContextDebts,
  type ContextDebt,
  type ContextDebtInput,
} from "../src/context/context-debt"
import {
  GATE_AUTHORITY_CLASSIFICATION,
  authorityClassOf,
  isAdvisory,
  isHardGate,
  isObligation,
} from "../src/agent/gates/authority"

function input(over: Partial<ContextDebtInput> = {}): ContextDebtInput {
  return {
    hasLocateResult: false,
    hasSourceUnderstanding: false,
    hasProjectConstitution: false,
    hasVerificationPlan: false,
    confidence: 0.5,
    highRisk: true,
    ...over,
  }
}

describe("IC05 ContextDebt: creation (D1)", () => {
  test("LocateResult + SourceUnderstanding missing → 两个稳定 open debt（id 稳定、确定性排序）", () => {
    const debts = createContextDebts(input({ hasProjectConstitution: true, hasVerificationPlan: true, highRisk: false }))
    expect(debts.map(d => d.kind)).toEqual(["locate_result", "source_understanding"])
    expect(debts[0]!.id).toBe("context-debt:locate_result")
    expect(debts[1]!.id).toBe("context-debt:source_understanding")
    expect(debts.every(d => d.status === "open" && d.source === "context_readiness")).toBe(true)
  })
})

describe("IC05 ContextDebt: objective resolution (D3/D4/D5)", () => {
  test("成功 find_symbol → locate_result resolved；read_file → source_understanding resolved", () => {
    const debts: ContextDebt[] = createContextDebts(input({ hasProjectConstitution: true, hasVerificationPlan: true, highRisk: false }))
    const changed = resolveContextDebts(debts, [
      { kind: "locate_result", tool: "find_symbol", target: "utils.ts:doThing" },
      { kind: "source_understanding", tool: "read_file", target: "src/utils.ts" },
    ])
    expect(changed).toBe(true)
    expect(debts.every(d => d.status === "resolved")).toBe(true)
    expect(debts[0]!.evidence).toContain("utils.ts:doThing")
  })

  test("仅模型输出文本（无工具 evidence）→ debt 不变（D4: no model prose authority）", () => {
    const debts: ContextDebt[] = createContextDebts(input({ hasProjectConstitution: true, hasVerificationPlan: true, highRisk: false }))
    const changed = resolveContextDebts(debts, [])
    expect(changed).toBe(false)
    expect(openContextDebtCount(debts)).toBe(2)
  })

  test("project_constitution 客观不存在 → unavailable（无 impossible forever debt，D5）", () => {
    const debts = createContextDebts(input({ hasVerificationPlan: true, constitutionProbeFoundNone: true }))
    const constitution = debts.find(d => d.kind === "project_constitution")!
    expect(constitution.status).toBe("unavailable")
    expect(constitution.evidence).toEqual(["bounded constitution probe found none"])
  })

  test("verification_plan: Runtime-owned evidence（TaskTracker kinds）→ resolved", () => {
    const debts = createContextDebts(input({ hasProjectConstitution: true, hasRuntimeVerificationPlan: true }))
    const verification = debts.find(d => d.kind === "verification_plan")
    expect(verification?.status).toBe("resolved")
  })

  test("confidence: 需要 ≥2 distinct context-acquisition evidence", () => {
    const debts: ContextDebt[] = createContextDebts(input({ hasProjectConstitution: true, hasVerificationPlan: true }))
    const confidence = debts.find(d => d.kind === "confidence")!
    expect(confidence.status).toBe("open")
    // 1 个 evidence 不够。
    resolveContextDebts(debts, [{ kind: "confidence", tool: "find_symbol" }])
    expect(confidence.status).toBe("open")
    // 2 个 distinct evidence 足够。
    resolveContextDebts(debts, [{ kind: "confidence", tool: "read_file" }])
    expect(confidence.status).toBe("resolved")
  })

  test("D6: open debt 在 completion 的摘要可注入；全部 resolved 后无 open", () => {
    const debts: ContextDebt[] = createContextDebts(input({ hasProjectConstitution: true, hasVerificationPlan: true, highRisk: false }))
    const summary = openContextDebts(debts)
    expect(summary.map(s => s.kind)).toEqual(["locate_result", "source_understanding"])
    resolveContextDebts(debts, [
      { kind: "locate_result", tool: "find_symbol" },
      { kind: "source_understanding", tool: "read_file" },
    ])
    expect(openContextDebtCount(debts)).toBe(0)
  })
})

describe("IC05 Gate Authority taxonomy (P1)", () => {
  test("hard gates 分类正确", () => {
    for (const gate of ["permission", "path", "secret_authority", "freshness_stale_baseline", "context_budget", "resource_budget", "lifecycle_cancellation", "readonly_user_intent", "destructive_risk", "completion_evidence"]) {
      expect(isHardGate(gate), gate).toBe(true)
      expect(authorityClassOf(gate)).toBe("hard")
    }
  })

  test("advisory gates 分类正确", () => {
    for (const gate of ["context_readiness", "planning_quality", "tool_disclosure", "heuristic_ripple", "quality_reasoning"]) {
      expect(isAdvisory(gate), gate).toBe(true)
    }
  })

  test("obligation gates 分类正确", () => {
    for (const gate of ["context_debt", "ripple_obligation", "required_verification"]) {
      expect(isObligation(gate), gate).toBe(true)
    }
  })

  test("advisory/obligation 不属于 hard", () => {
    for (const gate of ["context_readiness", "planning_quality", "heuristic_ripple", "context_debt", "ripple_obligation"]) {
      expect(isHardGate(gate), gate).toBe(false)
    }
  })

  test("registry 与行为一致（静态断言点）", () => {
    expect(GATE_AUTHORITY_CLASSIFICATION.permission).toBe("hard")
    expect(GATE_AUTHORITY_CLASSIFICATION.context_readiness).toBe("advisory")
    expect(GATE_AUTHORITY_CLASSIFICATION.context_debt).toBe("obligation")
  })
})
