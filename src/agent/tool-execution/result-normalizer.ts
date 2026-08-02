/**
 * L4: tool result normalization — smart head+tail truncation.
 * Extracted from loop.ts. Pure function, no state coupling.
 */

/**
 * Head+tail truncation with error-aware allocation.
 *
 * Keeps tool output bounded for the provider context while retaining error
 * markers in the tail so downstream typecheck / verification parsing and the
 * "errors detected in tail" marker both keep working.
 *
 * Behavior-frozen from the original inline logic in loop.ts.
 */
export function normalizeToolResultContent(content: string, success: boolean): string {
  if (!success || content.length <= 1400) return content
  const lines = content.split("\n")
  const totalBytes = Buffer.byteLength(content, "utf-8")
  const MAX_LINES = 60
  const MAX_BYTES = 12000
  if (lines.length <= MAX_LINES && totalBytes <= MAX_BYTES) return content

  const tailScan = content.slice(-2048)
  const hasErrors = /error|exception|failed|fatal|traceback|panic|exit code|Error|FAIL/i.test(tailScan)
  const headPct = hasErrors ? 0.7 : 0.85
  const headMaxLines = Math.floor(MAX_LINES * headPct)
  const tailMaxLines = MAX_LINES - headMaxLines
  const head = lines.slice(0, headMaxLines)
  const tail = lines.slice(-tailMaxLines)
  const omitted = lines.length - head.length - tail.length
  const marker = hasErrors
    ? `\n... [${omitted} lines trimmed — errors detected in tail] ...\n`
    : `\n... [${omitted} lines trimmed] ...\n`
  return head.join("\n") + marker + tail.join("\n")
}
