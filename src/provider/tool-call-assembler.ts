/** TB2-1: streaming tool-call assembly state machine (OpenAI-compatible relays).
 *
 *  Compatible relays disagree on how tool-call arguments stream:
 *    - true incremental deltas   (each chunk appends a fragment);
 *    - cumulative snapshots      (each chunk repeats the full arguments so far);
 *    - repeated tool IDs         (every chunk carries the same tool id/index);
 *    - overlapping fragments     (chunk boundaries repeat a few chars);
 *    - interleaved multi-tool    (multiple indexes in one stream);
 *    - no trailing newline on the final data line;
 *    - length/max_tokens cut     (arguments may end mid-JSON).
 *
 *  The assembler merges fragments with the longest prefix/suffix overlap (so
 *  overlapping deltas never get concatenated into corrupted JSON) and keeps a
 *  per-index state machine. The provider layer remains fail-closed: an
 *  incompletely-assembled call is never emitted, and one broken call poisons
 *  the whole batch (no partial side-effect execution).
 */

import { createHash } from "node:crypto"

export type ToolProtocolFailureKind =
  | "tool_protocol_invalid_json"
  | "tool_protocol_incomplete"
  | "malformed_sse"
  | "transport_interrupted"
  | "auth_failure"
  | "quota_failure"

/** 脱敏诊断：不记录原始参数、Prompt 或 credential。 */
export interface ToolProtocolDiagnostic {
  requestId: string
  toolName: string
  fragmentCount: number
  argumentBytes: number
  argumentSha256: string
  finishReason: string | null
  parseFailureKind: ToolProtocolFailureKind
}

export interface StreamedToolCallState {
  id: string
  name: string
  arguments: string
  /** 收到该 tool call 的参数片段数（含重复快照）。 */
  fragmentCount: number
}

/** 合并重叠增量：先验证前缀/后缀/包含，再找最长前后缀重叠，最后纯拼接。 */
export function mergeStreamedField(current: string, incoming: string): string {
  if (!incoming) return current
  if (!current) return incoming
  if (incoming === current) return current
  // 累积快照模式：新片段是完整参数的重复/超集 → 取更长者。
  if (current.endsWith(incoming)) return current
  if (incoming.startsWith(current)) return incoming
  // 增长型快照：新快照以旧快照去掉尾括号为前缀（尾括号让位给后续键）。
  // 例：{"path":"a.ts"} → {"path":"a.ts","mode":"r"}。
  if (current.endsWith("}") && incoming.startsWith(current.slice(0, -1))) return incoming
  if (incoming.endsWith("}") && current.startsWith(incoming.slice(0, -1))) return current
  // 真增量模式：找最长重叠（current 后缀 ∩ incoming 前缀，或反向）。
  const maxLen = Math.min(current.length, incoming.length, 256)
  for (let len = maxLen; len >= 1; len--) {
    if (current.endsWith(incoming.slice(0, len))) {
      return current + incoming.slice(len)
    }
    if (incoming.endsWith(current.slice(0, len))) {
      return incoming + current.slice(len)
    }
  }
  return current + incoming
}

export interface ToolCallAssembler {
  /** 追加一个流式片段（按 choice index 归组）。 */
  feed(
    index: number,
    delta: { id?: string; name?: string; arguments?: string },
  ): void
  /** 流结束后输出全部组装结果（保持出现顺序，忽略空条目）。 */
  finish(): Array<StreamedToolCallState>
  /** 所有片段总数（诊断用）。 */
  totalFragments(): number
}

export function createToolCallAssembler(): ToolCallAssembler {
  const tools = new Map<number, StreamedToolCallState>()
  const order: number[] = []
  let totalFragments = 0

  const ensureIndex = (index: number): StreamedToolCallState => {
    let state = tools.get(index)
    if (!state) {
      state = { id: "", name: "", arguments: "", fragmentCount: 0 }
      tools.set(index, state)
      order.push(index)
    }
    return state
  }

  return {
    feed(index, delta) {
      const state = ensureIndex(index)
      // 同一 index 出现新 id（与已有不同）→ 视为新调用，重置该 index 槽
      //（保留本片段自带的 name/arguments）。
      if (delta.id && state.id && delta.id !== state.id) {
        const fresh: StreamedToolCallState = {
          id: delta.id,
          name: delta.name ?? "",
          arguments: delta.arguments ?? "",
          fragmentCount: delta.arguments ? 1 : 0,
        }
        tools.set(index, fresh)
        return
      }
      if (delta.id) state.id = delta.id
      if (delta.name) state.name = delta.name
      if (delta.arguments) {
        state.arguments = mergeStreamedField(state.arguments, delta.arguments)
        state.fragmentCount++
        totalFragments++
      }
    },
    finish() {
      return order
        .map(index => tools.get(index)!)
        .filter(tc => tc.id || tc.name || tc.arguments)
    },
    totalFragments() {
      return totalFragments
    },
  }
}

/** 轻量 schema 校验（fail-closed）：仅检查 object 级 required 字段。 */
export function validateToolCallInput(
  tools: Array<Record<string, unknown>> | undefined,
  name: string,
  input: Record<string, unknown>,
): { ok: boolean; missing: string[] } {
  if (!tools || tools.length === 0) return { ok: true, missing: [] }
  const toolDef = tools.find(t =>
    String((t as { function?: { name?: unknown } }).function?.name ?? (t as { name?: unknown }).name ?? "") === name,
  )
  if (!toolDef) return { ok: true, missing: [] }
  const functionDef = (toolDef as { function?: { parameters?: unknown } }).function
  const parameters = functionDef?.parameters as { required?: unknown; properties?: unknown } | undefined
  const required = Array.isArray(parameters?.required) ? parameters.required.filter((r): r is string => typeof r === "string") : []
  if (required.length === 0) return { ok: true, missing: [] }
  const missing = required.filter(field => !(field in input))
  return { ok: missing.length === 0, missing }
}

/** 脱敏诊断构造：只含 hash/计数，绝不包含参数原文。 */
export function buildToolProtocolDiagnostic(input: {
  requestId: string
  toolName: string
  arguments: string
  fragmentCount: number
  finishReason: string | null
  parseFailureKind: ToolProtocolFailureKind
}): ToolProtocolDiagnostic {
  return {
    requestId: input.requestId,
    toolName: input.toolName,
    fragmentCount: input.fragmentCount,
    argumentBytes: input.arguments.length,
    argumentSha256: createHash("sha256").update(input.arguments).digest("hex").slice(0, 16),
    finishReason: input.finishReason,
    parseFailureKind: input.parseFailureKind,
  }
}

export function formatToolProtocolDiagnostic(d: ToolProtocolDiagnostic): string {
  return [
    `tool-protocol: ${d.parseFailureKind}`,
    `requestId=${d.requestId || "?"}`,
    `tool=${d.toolName || "?"}`,
    `fragments=${d.fragmentCount}`,
    `argBytes=${d.argumentBytes}`,
    `argSha256=${d.argumentSha256}`,
    `finishReason=${d.finishReason ?? "none"}`,
  ].join(" ")
}
