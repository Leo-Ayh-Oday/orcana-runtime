/**
 * PR-4.4: TUI Rewind Interface Stubs
 *
 * These types and placeholder functions define the contract for the TUI
 * rewind UX (checkpoint list view, rewind confirmation, restore progress).
 *
 * Actual TUI rendering will be implemented in Phase 9 (PR-9.4).
 */

import type { RewindMode } from "../agent/rewind"

/** A checkpoint entry for display in the TUI rewind list. */
export interface TuiRewindEntry {
  checkpointId: string
  round: number
  timestamp: number
  summary: string
  fileCount: number
  changedCount: number
  conversationTokens: number
}

/** State for the rewind list view. */
export interface TuiRewindListState {
  entries: TuiRewindEntry[]
  selectedIndex: number
  visible: boolean
}

/** State for the rewind confirmation dialog. */
export interface TuiRewindConfirmState {
  visible: boolean
  targetRound: number
  mode: RewindMode
  previewFiles: string[]
}

/** State for rewind progress (shown during restore). */
export interface TuiRewindProgressState {
  visible: boolean
  mode: RewindMode
  targetRound: number
  restoredFiles: string[]
  totalFiles: number
  done: boolean
}

/** Create an empty rewind list state. */
export function createRewindListState(): TuiRewindListState {
  return { entries: [], selectedIndex: 0, visible: false }
}

/** Create an empty rewind confirm state. */
export function createRewindConfirmState(): TuiRewindConfirmState {
  return { visible: false, targetRound: 0, mode: "code", previewFiles: [] }
}

/** Create an empty rewind progress state. */
export function createRewindProgressState(): TuiRewindProgressState {
  return { visible: false, mode: "code", targetRound: 0, restoredFiles: [], totalFiles: 0, done: false }
}

/**
 * Format a rewind entry for TUI display (single-line).
 * Returns a string suitable for ink <Text> rendering.
 */
export function formatTuiRewindEntry(entry: TuiRewindEntry): string {
  const date = new Date(entry.timestamp).toLocaleString("zh-CN")
  const files = entry.fileCount > 0 ? `${entry.fileCount}f` : "0f"
  const tokens = Math.round(entry.conversationTokens / 1000)
  return `R${entry.round}  ${date}  ${files}  ${tokens}K  ${entry.summary.slice(0, 60)}`
}

/**
 * Rewind action types for TUI keybindings.
 * These will be dispatched from the TUI input handler in Phase 9.
 */
export type TuiRewindAction =
  | { type: "OPEN_REWIND_LIST" }
  | { type: "CLOSE_REWIND_LIST" }
  | { type: "SELECT_REWIND_ENTRY"; index: number }
  | { type: "CONFIRM_REWIND"; mode: RewindMode }
  | { type: "CANCEL_REWIND" }
  | { type: "REWIND_PROGRESS"; restoredFiles: string[]; totalFiles: number; done: boolean }
