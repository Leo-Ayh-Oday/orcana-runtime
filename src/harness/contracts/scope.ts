/**
 * H3: Run-scoped store contracts.
 *
 * Every tool, gate or node reads run state only from AgentRunScope (contracts/
 * run.ts). These are the real, typed owners for the state categories that H0
 * left as `unknown` placeholders. H3 wires the harness-owned instances;
 * complete implementations land in later stages (RunCancellation → H4,
 * TraceWriter → H5, RippleSession snapshot → H5).
 */

import type { ModeName } from "../../agent/mode-contract"

/** Unique owner of the run's active mode contract (plan §3.1). */
export interface ModeStore {
  mode: ModeName
}

/** Unique owner of the run's active patch transaction context. */
export type PatchContextStore = {
  scope: string[]
  verification: string[]
  nodeId: string
} | null

/** Unique owner of ripple obligations + pending cascade files for the run. */
export interface RippleSession {
  /** Ripple obligation snapshot (full type lands with the H5 typed trace). */
  obligations: unknown[]
  cascadeFiles: string[]
}

/** Run-scoped cancellation handle (plan §10.1; full policy lands in H4). */
export interface RunCancellation {
  signal: AbortSignal
  cancelled: boolean
  reason?: string

  cancel(reason: string): void
  throwIfCancelled(): void
}

/** Run-scoped trace writer (plan §12.3; typed envelope lands in H5). */
export interface TraceWriter {
  append<T>(event: { type: string; payload: T; sequence: number }): Promise<void>
  flush(): Promise<void>
  close(): Promise<void>
}
