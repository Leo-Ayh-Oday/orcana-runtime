/** LNXF-1.0: output limiter (LF-2) — hard caps on stdout/stderr with
 *  truncation marking. A process that overflows is killed at the Broker
 *  level (OUTPUT_LIMIT_BYPASS: 0) — the limiter only observes.
 */

export interface OutputLimits {
  stdoutMaxBytes: number
  stderrMaxBytes: number
}

export interface OutputLimiterState {
  stdoutBytes: number
  stderrBytes: number
  stdoutTruncated: boolean
  stderrTruncated: boolean
}

export function createOutputLimiter(limits: OutputLimits): {
  state: OutputLimiterState
  /** Feed a chunk; returns the slice to append (truncated at the cap). */
  absorb(stream: "stdout" | "stderr", chunk: Buffer): Buffer
  exceeded(): boolean
} {
  const state: OutputLimiterState = {
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutTruncated: false,
    stderrTruncated: false,
  }
  return {
    state,
    absorb(stream, chunk) {
      const max = stream === "stdout" ? limits.stdoutMaxBytes : limits.stderrMaxBytes
      const used = stream === "stdout" ? state.stdoutBytes : state.stderrBytes
      const remaining = Math.max(0, max - used)
      if (remaining === 0) {
        if (stream === "stdout") state.stdoutTruncated = true
        else state.stderrTruncated = true
        return Buffer.alloc(0)
      }
      const slice = chunk.subarray(0, remaining)
      if (stream === "stdout") state.stdoutBytes += slice.length
      else state.stderrBytes += slice.length
      if (slice.length < chunk.length) {
        if (stream === "stdout") state.stdoutTruncated = true
        else state.stderrTruncated = true
      }
      return slice
    },
    exceeded() {
      return state.stdoutTruncated || state.stderrTruncated
    },
  }
}

/** 截断标记：附加到被截断流的末尾，保证审计可见。 */
export const TRUNCATION_MARKER = "\n[output truncated by Orcana — limit hit]\n"

export function finalizeOutput(state: OutputLimiterState, stream: "stdout" | "stderr"): string {
  return state[stream === "stdout" ? "stdoutTruncated" : "stderrTruncated"] ? TRUNCATION_MARKER : ""
}
