/** Gate overflow processor — tracks cumulative block counts per gate,
 *  injects strategy-switch advice at count=3, and hard-BLOCKs the session at count>=5.
 *  Pure function — returns effects to be applied by the caller (loop.ts). */

export interface GateOverflowInput {
  round: number
  rippleBlockActive: boolean
  pendingRippleObligationsLength: number
  postToolPlanningPrompt: string | null
  postToolRequiredFilesPrompt: string | null
  gateBlockCounts: Map<string, { count: number; lastSeen: number }>
}

export interface GateOverflowOutput {
  statusEvents: string[]
  deferredMessages: string[]
  /** When true, the caller must transition to BLOCKED, dispose sandbox, and return. */
  blocked: boolean
  blockedGate?: string
  blockedCount?: number
}

export function processGateOverflow(input: GateOverflowInput): GateOverflowOutput {
  const output: GateOverflowOutput = { statusEvents: [], deferredMessages: [], blocked: false }
  const { round, rippleBlockActive, pendingRippleObligationsLength, postToolPlanningPrompt, postToolRequiredFilesPrompt, gateBlockCounts } = input

  // Build block list
  const blockedGates: string[] = []
  if (rippleBlockActive) blockedGates.push("policy:ripple")
  if (pendingRippleObligationsLength > 0) blockedGates.push("semantic:ripple_obligations")
  if (postToolPlanningPrompt || postToolRequiredFilesPrompt) {
    if (postToolPlanningPrompt) blockedGates.push("semantic:planning")
    if (postToolRequiredFilesPrompt) blockedGates.push("semantic:required_files")
  }

  // Increment counters
  for (const gate of blockedGates) {
    const entry = gateBlockCounts.get(gate) ?? { count: 0, lastSeen: 0 }
    entry.count++
    entry.lastSeen = round
    gateBlockCounts.set(gate, entry)
  }

  // Clean stale entries
  for (const [gate, entry] of gateBlockCounts) {
    if (!blockedGates.includes(gate) && round - entry.lastSeen >= 2) {
      gateBlockCounts.delete(gate)
    }
  }

  // Process each gate's block count
  for (const [gate, entry] of gateBlockCounts) {
    if (entry.count === 3) {
      output.deferredMessages.push([
        "<system-reminder>",
        `[Gate overflow] ${gate} 已拦截 3 次。不要继续走同一条路径。`,
        gate === "policy:ripple" ? "→ 停止逐文件编辑，立即用 multi_edit 级联修复所有调用方。" : "",
        gate === "semantic:ripple_obligations" ? "→ 读取被影响的调用方文件并级联修复，不要再次触发写盘。" : "",
        gate === "semantic:planning" ? "→ 缩小任务范围，列出最小可交付单元，不要追求完美方案。" : "",
        gate === "semantic:completion" ? "→ 检查是否缺少外部验证证据（typecheck/test/build）。不要声称完成但不验证。" : "",
        gate === "semantic:required_files" ? "→ 立即创建缺失的必需文件，停止分析已经存在的文件。" : "",
        "</system-reminder>",
      ].filter(Boolean).join("\n"))
      output.statusEvents.push(`gate-overflow: ${gate} blocked 3 times`)
    }
    if (entry.count >= 5) {
      output.blocked = true
      output.blockedGate = gate
      output.blockedCount = entry.count
      break
    }
  }

  return output
}
