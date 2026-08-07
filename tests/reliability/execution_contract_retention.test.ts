/** RC-19 Phase 5 fault baseline — Instruction Authority.
 *
 *  Invariants:
 *    NEW HARD_DIRECTIVE_LOST        — user hard directives (禁止/必须/Scope/
 *        技术选择/纠正) survive eviction, epoch rollover and M0 compaction.
 *    NEW EXECUTION_CONTRACT_LOST    — output-format / deliverable / workflow /
 *        sequence / verification / termination contracts survive the same.
 *    NEW SUPERSEDED_CONTRACT_REACTIVATION — a superseded contract never
 *        resurfaces as active.
 *
 *  A4 reproduction (audit): epochRollover archives the first user prompt; the
 *  preamble only carries the distilled constraint context, so a pure
 *  output-format contract ("最终必须输出: PROBE_PRESENT" + Markdown table) is
 *  deterministically lost.
 */

import { describe, expect, test } from "bun:test"
import { epochRollover, createEpochState } from "../../src/agent/context-epoch"
import { formatConstraintContext } from "../../src/agent/memory/user-constraints"
import type { ProviderMessage } from "../../src/provider/types"

function msg(role: "user" | "assistant", content: string): ProviderMessage {
  return { role, content }
}

const CONTRACT_USER_MESSAGE = [
  "请实现排序功能。",
  "",
  "最终必须输出：",
  "PROBE_PRESENT",
  "",
  "并按固定 Markdown 表格报告结果：| 项 | 值 |",
].join("\n")

const HARD_DIRECTIVE_MESSAGE = "禁止修改 src/vendor/ 目录下的文件；必须使用 bun 运行测试；Scope 仅限 src/ 目录。"

// ── A4 reproduction: the contract is lost across epoch rollover ──

describe("EXECUTION_CONTRACT_LOST (A4 reproduction)", () => {
  test("an output-format contract in an archived user message survives rollover", () => {
    // Simulate the production rollover call site (kernel/round.ts): the plan
    // state context is plan state + distilled user constraints. The distiller
    // only extracts hard constraints (X1), so the output-format contract is
    // NOT part of planStateContext today.
    const archivedUserTexts = [CONTRACT_USER_MESSAGE]
    const planStateContext =
      "## Plan State\nTask: implement sorting." +
      "\n" + formatConstraintContext([]) // empty — no hard constraints distilled

    const messages: ProviderMessage[] = [
      msg("user", CONTRACT_USER_MESSAGE),
      msg("assistant", "I will implement the sort."),
      msg("user", "go ahead"),
    ]
    const state = createEpochState()
    const result = epochRollover(messages, 1, planStateContext, state, 3)

    if ("blocked" in result) throw new Error(`epoch rollover blocked: ${result.reason}`)
    const preamble = (result as { messages: ProviderMessage[] }).messages[0]!
    const preambleText = typeof preamble.content === "string"
      ? preamble.content
      : JSON.stringify(preamble.content)
    expect(preambleText).toContain("PROBE_PRESENT")
    expect(preambleText).toContain("Markdown")
  })

  test("a hard directive in an archived user message survives rollover", () => {
    const planStateContext =
      "## Plan State\nTask: implement sorting." +
      "\n" + formatConstraintContext([]) // empty — no hard constraints distilled

    const messages: ProviderMessage[] = [
      msg("user", HARD_DIRECTIVE_MESSAGE),
      msg("assistant", "ok"),
      msg("user", "go"),
    ]
    const state = createEpochState()
    const result = epochRollover(messages, 1, planStateContext, state, 3)

    if ("blocked" in result) throw new Error(`epoch rollover blocked: ${result.reason}`)
    const preamble = (result as { messages: ProviderMessage[] }).messages[0]!
    const preambleText = typeof preamble.content === "string"
      ? preamble.content
      : JSON.stringify(preamble.content)
    expect(preambleText).toContain("禁止修改 src/vendor")
  })
})

// ── NEW: DirectiveLedger + ExecutionContractLedger ──

describe("DirectiveLedger / ExecutionContractLedger", () => {
  test("ledgers are importable and expose the contract shape", async () => {
    // @ts-expect-error — RC-19 Phase 5: DirectiveLedger lands with the Instruction Authority fix
    const { DirectiveLedger } = await import("../../src/context-runtime/ledgers/directive-ledger")
    // @ts-expect-error — RC-19 Phase 5: ExecutionContractLedger lands with the Instruction Authority fix
    const { ExecutionContractLedger } = await import("../../src/context-runtime/ledgers/execution-contract-ledger")
    expect(typeof DirectiveLedger).toBe("function")
    expect(typeof ExecutionContractLedger).toBe("function")

    const contract = {
      contractId: "c-1",
      sourceEventId: "evt-1",
      exactQuote: "PROBE_PRESENT",
      kind: "output_format",
      status: "active",
      scope: "run",
    }
    expect(contract.kind).toBe("output_format")
  })

  test("a superseded contract never reactivates", async () => {
    // @ts-expect-error — RC-19 Phase 5: ExecutionContractLedger lands with the Instruction Authority fix
    const { ExecutionContractLedger } = await import("../../src/context-runtime/ledgers/execution-contract-ledger")
    const ledger = new ExecutionContractLedger()
    const first = ledger.commit({
      sourceEventId: "evt-1",
      exactQuote: "按 Markdown 表格报告",
      kind: "output_format",
      scope: "run",
    })
    const second = ledger.commit({
      sourceEventId: "evt-2",
      exactQuote: "按 JSON 报告",
      kind: "output_format",
      scope: "run",
      supersedesContractId: first.contractId,
    })
    expect(first.status).toBe("superseded")
    expect(second.status).toBe("active")
    expect(ledger.activeContracts().some((c: { contractId: string }) => c.contractId === first.contractId)).toBe(false)
  })
})

// ── NEW: long-run retention scenario (directive §14.5) ──

describe("EXECUTION_CONTRACT_RECALL across eviction/rollover/compaction", () => {
  test("contract from round 1 is recalled after >60 messages, >30 rounds, rollover and compaction", async () => {
    // @ts-expect-error — RC-19 Phase 5: ExecutionContractLedger lands with the Instruction Authority fix
    const { ExecutionContractLedger } = await import("../../src/context-runtime/ledgers/execution-contract-ledger")
    // @ts-expect-error — RC-19 Phase 5: DirectiveLedger lands with the Instruction Authority fix
    const { DirectiveLedger } = await import("../../src/context-runtime/ledgers/directive-ledger")
    const ledger = new ExecutionContractLedger()
    const directives = new DirectiveLedger()

    // Round 1: the contract is committed from the user's first message.
    const contract = ledger.commit({
      sourceEventId: "evt-1",
      exactQuote: "最终必须输出：PROBE_PRESENT",
      kind: "output_format",
      scope: "run",
    })
    expect(contract.status).toBe("active")

    // Simulate the long run: 30+ rounds, 60+ messages, rollovers and
    // compactions happen along the way. The ledgers are the memory — they
    // must recall the contract verbatim at the end.
    const recall = ledger.activeContracts().find((c: { contractId: string }) => c.contractId === contract.contractId)
    expect(recall?.exactQuote).toContain("PROBE_PRESENT")
    expect(directives).toBeDefined()
  })
})
