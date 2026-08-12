/**
 * ContextDebt（IC05 P2/P6）。
 *
 * ContextReadiness 由 hard write gate 降级为 obligation 债务：
 *  - readiness blockers → ContextDebt[]
 *  - 写工具保持可用（WRITE_ALLOWED_WITH_CONTEXT_DEBT=1）
 *  - DONE 前必须偿还（DONE_ALLOWED_WITH_OPEN_CONTEXT_DEBT=0）
 *
 * 债务只能由 observable evidence 改变：
 *  - locate_result:         成功的 find_symbol / find_references / project_structure
 *  - source_understanding:  成功的 read_file / read_definition
 *  - project_constitution:  ContextMap 客观证明不存在 → unavailable；否则自动
 *                           ContextMap / 真实 read evidence 满足
 *  - verification_plan:     TaskTracker.requiredVerificationKinds.length > 0
 *                           （Runtime-owned evidence）或真实 verification action
 *  - confidence:            >= 2 个 distinct successful context-acquisition evidence
 *
 * 模型文本自报（"我已经理解了"）永远不 resolve debt。
 */

export type ContextDebtKind =
  | "locate_result"
  | "source_understanding"
  | "project_constitution"
  | "verification_plan"
  | "confidence"

export type ContextDebtStatus = "open" | "resolved" | "unavailable"

export interface ContextDebt {
  /** stable id：`${kind}:${index}` 或按输入顺序派生。 */
  id: string
  kind: ContextDebtKind
  reason: string
  source: "context_readiness"
  status: ContextDebtStatus
  /** 偿还所需的具体动作（人/模型可见，但不构成 model prose authority）。 */
  requiredAction: string
  /** objective evidence 记录（tool fingerprint / probe 结果）。 */
  evidence: string[]
}

/** 客观 context-acquisition evidence（用于 confidence / source_understanding）。 */
export interface ContextAcquisitionEvidence {
  kind: ContextDebtKind
  tool: string
  /** path / fingerprint 等客观事实。 */
  target?: string
}

/** readiness → debt 的确定性映射（与 evaluateContextReadiness 的 blockers 同源）。 */
export interface ContextDebtInput {
  hasLocateResult: boolean
  hasSourceUnderstanding: boolean
  hasProjectConstitution: boolean
  hasVerificationPlan: boolean
  /** high_risk 且 < 0.75 时产生 confidence debt（只对 high_risk 任务）。 */
  confidence: number
  highRisk: boolean
  /** project_constitution 的客观探针结果：已证明 repo 不存在 constitution 文件。 */
  constitutionProbeFoundNone?: boolean
  /** Runtime-owned verification plan evidence（TaskTracker.requiredVerificationKinds）。 */
  hasRuntimeVerificationPlan?: boolean
}

export const CONTEXT_DEBT_ACQUISITION_TOOLS: Record<ContextDebtKind, readonly string[]> = {
  locate_result: ["find_symbol", "find_references", "project_structure"],
  source_understanding: ["read_file", "read_definition"],
  project_constitution: [],
  verification_plan: [],
  confidence: [],
}

const CONFIDENCE_EVIDENCE_THRESHOLD = 2

export function contextDebtRequiredAction(kind: ContextDebtKind): string {
  switch (kind) {
    case "locate_result":
      return "使用 find_symbol / find_references / project_structure 获取符号与引用结果"
    case "source_understanding":
      return "使用 read_file / read_definition 读取目标源码"
    case "project_constitution":
      return "读取项目 constitution 文件（如存在）"
    case "verification_plan":
      return "建立验证计划（类型检查 / 测试 / 构建）"
    case "confidence":
      return "获取至少两个不同的成功上下文证据（locate + read 等）"
  }
}

export function contextDebtReason(kind: ContextDebtKind): string {
  switch (kind) {
    case "locate_result": return "LocateResult is required for medium and larger tasks."
    case "source_understanding": return "SourceUnderstanding is required for medium and larger tasks."
    case "project_constitution": return "ProjectConstitution is required for long tasks."
    case "verification_plan": return "Verification plan is required for long tasks."
    case "confidence": return "High-risk task confidence below 0.75."
  }
}

/**
 * 从 readiness 事实确定性生成 open debts（无模型 prose authority）。
 * 每 kind 至多一个 debt，id 稳定（kind 序）。
 */
export function createContextDebts(input: ContextDebtInput): ContextDebt[] {
  const debts: ContextDebt[] = []
  const push = (kind: ContextDebtKind): void => {
    debts.push({
      id: `context-debt:${kind}`,
      kind,
      reason: contextDebtReason(kind),
      source: "context_readiness",
      status: "open",
      requiredAction: contextDebtRequiredAction(kind),
      evidence: [],
    })
  }

  if (!input.hasLocateResult) push("locate_result")
  if (!input.hasSourceUnderstanding) push("source_understanding")
  if (!input.hasProjectConstitution) {
    if (input.constitutionProbeFoundNone) {
      debts.push({
        id: "context-debt:project_constitution",
        kind: "project_constitution",
        reason: "ProjectConstitution is required for long tasks.",
        source: "context_readiness",
        status: "unavailable",
        requiredAction: "无",
        evidence: ["bounded constitution probe found none"],
      })
    } else {
      push("project_constitution")
    }
  }
  if (!input.hasVerificationPlan) {
    if (input.hasRuntimeVerificationPlan) {
      debts.push({
        id: "context-debt:verification_plan",
        kind: "verification_plan",
        reason: "Verification plan is required for long tasks.",
        source: "context_readiness",
        status: "resolved",
        requiredAction: "无",
        evidence: ["runtime-owned verification plan (TaskTracker.requiredVerificationKinds)"],
      })
    } else {
      push("verification_plan")
    }
  }
  if (input.highRisk && input.confidence < 0.75) push("confidence")

  return debts
}

/**
 * 客观 evidence 结算：成功的 context-acquisition 工具调用 → resolve 对应债务。
 * 返回是否有任何债务状态变化。
 */
export function resolveContextDebts(
  debts: ContextDebt[],
  evidence: ContextAcquisitionEvidence[],
): boolean {
  let changed = false
  // confidence：跨 kind 累计 distinct acquisition evidence（find_symbol +
  // read_file 等任意两个不同成功上下文获取）。
  const distinctAcquisition = new Set<string>()
  for (const item of evidence) {
    if (!debtKindForTool(item.tool)) continue
    distinctAcquisition.add(item.target ?? item.tool)
  }

  for (const item of evidence) {
    const kind = debtKindForTool(item.tool)
    if (!kind) continue
    const debt = debts.find(d => d.kind === kind && d.status === "open")
    if (!debt) continue
    if (!debt.evidence.includes(item.target ?? item.tool)) debt.evidence.push(item.target ?? item.tool)
    debt.status = "resolved"
    changed = true
  }

  const confidence = debts.find(d => d.kind === "confidence" && d.status === "open")
  if (confidence) {
    for (const item of distinctAcquisition) {
      if (!confidence.evidence.includes(item)) confidence.evidence.push(item)
    }
    if (confidence.evidence.length >= CONFIDENCE_EVIDENCE_THRESHOLD) {
      confidence.status = "resolved"
      changed = true
    }
  }
  return changed
}

function debtKindForTool(tool: string): ContextDebtKind | undefined {
  for (const [kind, tools] of Object.entries(CONTEXT_DEBT_ACQUISITION_TOOLS)) {
    if (tools.includes(tool)) return kind as ContextDebtKind
  }
  return undefined
}

/** 当前 open 债务数。 */
export function openContextDebtCount(debts: ContextDebt[]): number {
  return debts.filter(d => d.status === "open").length
}

/** open 债务的可审计摘要（用于 completion 注入与 report）。 */
export function openContextDebts(debts: ContextDebt[]): Array<{ id: string; kind: ContextDebtKind; requiredAction: string }> {
  return debts
    .filter(d => d.status === "open")
    .map(d => ({ id: d.id, kind: d.kind, requiredAction: d.requiredAction }))
}
