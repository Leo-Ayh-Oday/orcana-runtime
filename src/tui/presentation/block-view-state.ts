/** block-view-state — Transcript 视图状态 reducer（Depthline P4）。
 *
 *  折叠/选中状态独立持久化（评审修正 #4）：
 *    - 流式 delta 到达时派生结果重算，但用户展开的块不恢复默认
 *    - block.id 稳定（不用数组下标），prune 清理已删除块的显示状态
 */

import type { TranscriptViewState, BlockDisplayMode } from "./block-model"

export type TranscriptViewAction =
  | { type: "block.select"; blockId: string | null }
  | { type: "block.toggle"; blockId: string }
  | { type: "block.expand"; blockId: string }
  | { type: "block.collapse"; blockId: string }
  | { type: "block.prune"; liveIds: ReadonlySet<string> }

export function createInitialTranscriptViewState(): TranscriptViewState {
  return { selectedBlockId: null, displayModes: new Map() }
}

function nextMode(current: BlockDisplayMode | undefined): BlockDisplayMode {
  if (current === "collapsed") return "expanded"
  if (current === "expanded") return "collapsed"
  if (current === "truncated") return "expanded"
  return "expanded"
}

export function reduceTranscriptViewState(
  state: TranscriptViewState,
  action: TranscriptViewAction,
): TranscriptViewState {
  switch (action.type) {
    case "block.select":
      return { ...state, selectedBlockId: action.blockId }
    case "block.toggle": {
      const displayModes = new Map(state.displayModes)
      displayModes.set(action.blockId, nextMode(displayModes.get(action.blockId)))
      return { ...state, displayModes }
    }
    case "block.expand": {
      const displayModes = new Map(state.displayModes)
      displayModes.set(action.blockId, "expanded")
      return { ...state, displayModes }
    }
    case "block.collapse": {
      const displayModes = new Map(state.displayModes)
      displayModes.set(action.blockId, "collapsed")
      return { ...state, displayModes }
    }
    case "block.prune": {
      const displayModes = new Map(state.displayModes)
      let pruned = false
      for (const id of displayModes.keys()) {
        if (!action.liveIds.has(id)) {
          displayModes.delete(id)
          pruned = true
        }
      }
      const selected = state.selectedBlockId !== null && action.liveIds.has(state.selectedBlockId)
        ? state.selectedBlockId
        : null
      const selectedChanged = state.selectedBlockId !== selected
      if (!pruned && !selectedChanged) return state
      return { ...state, selectedBlockId: selected, displayModes }
    }
  }
}
