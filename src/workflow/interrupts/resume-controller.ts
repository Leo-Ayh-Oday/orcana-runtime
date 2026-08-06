/** MACP-M4: resume controller — validate a resume attempt, re-check
 *  freshness, and produce the answer injection for the scheduler.
 *
 *  Validations (task 7): token parses; record exists and is `waiting`;
 *  spec digest matches the current graph (task: graph version); the
 *  interrupt has not expired (task 11); the response passes the recorded
 *  response schema; the workspace hash still matches (task 10 — a changed
 *  workspace must trigger re-verification, which fails the resume until a
 *  fresh run). The token is consumed atomically (waiting → resuming) at
 *  acceptance and resolved when the resumed run completes — a token can
 *  never be replayed (DOUBLE_RESUME: 0).
 */
import type { InterruptStore } from "./interrupt-store"
import { parseResumeToken, createResumeToken, newInterruptId } from "./resume-token"
import type { WorkflowInterruptRecord } from "./types"
import { computeWorkspaceHash } from "../../harness/persistence/workspace-hash"
import { validateJsonSchema } from "../../harness/interrupts/response-validator"
import type { JsonSchema } from "../../harness/contracts/schema"
import { createHash } from "node:crypto"
import type { WorkflowSpec } from "../types"

/** Deterministic graph digest: canonical JSON over sorted nodes → sha256.
 *  Any structural change to the spec invalidates outstanding tokens
 *  (STALE_RESUME_ACCEPTED: 0). */
export function computeSpecDigest(spec: WorkflowSpec): string {
  const canonical = spec.nodes
    .map(n => ({
      id: n.id,
      handler: n.handler,
      input: n.input,
      dependsOn: [...n.dependsOn],
      assignment: n.assignment,
      execution: n.execution,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : 1))
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 16)
}

export interface ResumeAttempt {
  ok: boolean
  reason?: string
  record?: WorkflowInterruptRecord
  /** Answer to inject into the interrupted human node. */
  answer?: unknown
}

export class ResumeController {
  constructor(private readonly store: InterruptStore, private readonly projectRoot: string) {}

  /** Create + persist a fresh waiting record (called by the scheduler when a
   *  human node pauses). Returns the record and its resume token. */
  openInterrupt(input: {
    runId: string
    specId: string
    specDigest: string
    nodeId: string
    nodeRunId: string
    kind: WorkflowInterruptRecord["kind"]
    prompt: string
    responseSchema: unknown
    expiresInMs?: number
  }): { record: WorkflowInterruptRecord; resumeToken: string } {
    const createdAt = Date.now()
    const expiresAt = input.expiresInMs ? createdAt + input.expiresInMs : undefined
    const record: WorkflowInterruptRecord = {
      interruptId: newInterruptId(),
      runId: input.runId,
      specId: input.specId,
      specDigest: input.specDigest,
      nodeId: input.nodeId,
      nodeRunId: input.nodeRunId,
      kind: input.kind,
      prompt: input.prompt,
      responseSchema: input.responseSchema,
      createdAt,
      expiresAt,
      workspaceHash: computeWorkspaceHash(this.projectRoot),
      status: "waiting",
    }
    this.store.put(record)
    return {
      record,
      resumeToken: createResumeToken({
        specDigest: record.specDigest,
        expiresAt: expiresAt ?? Number.MAX_SAFE_INTEGER,
        interruptId: record.interruptId,
      }),
    }
  }

  /** Validate a user reply against the token + stored record. */
  resume(token: string, currentSpecDigest: string, answer: unknown): ResumeAttempt {
    const parsed = parseResumeToken(token)
    if (!parsed) {
      return { ok: false, reason: "invalid resume token" }
    }
    if (parsed.expiresAt < Date.now()) {
      return { ok: false, reason: "resume token expired" }
    }
    const record = this.store.get(parsed.interruptId)
    if (!record) {
      return { ok: false, reason: `no interrupt record for ${parsed.interruptId}` }
    }
    if (parsed.specDigest !== record.specDigest || parsed.specDigest !== currentSpecDigest) {
      return { ok: false, reason: "workflow graph version changed — resume token stale" }
    }
    if (record.status !== "waiting") {
      return { ok: false, reason: `interrupt already ${record.status} (resume not repeatable)` }
    }
    if (record.expiresAt !== undefined && record.expiresAt < Date.now()) {
      return { ok: false, reason: "interrupt expired" }
    }
    if (record.workspaceHash !== computeWorkspaceHash(this.projectRoot)) {
      return { ok: false, reason: "workspace changed since interrupt — re-verification required" }
    }
    if (record.responseSchema) {
      const errors = validateJsonSchema(answer, record.responseSchema as JsonSchema)
      if (errors.length > 0) {
        return { ok: false, reason: `response schema rejected: ${errors.join("; ")}` }
      }
    }
    // M10: the final gate is the atomic consume — waiting → resuming. A
    // concurrent resume that already consumed the token loses the race and
    // fails here (DOUBLE_RESUME: 0); the record transitions immediately, so
    // a crash mid-resume leaves a clearly recoverable "resuming" state.
    const consumed = this.store.consume(record.interruptId)
    if (!consumed) {
      const latest = this.store.get(record.interruptId)
      return {
        ok: false,
        reason: latest
          ? `interrupt already ${latest.status} (resume not repeatable)`
          : `no interrupt record for ${record.interruptId}`,
      }
    }
    return { ok: true, record: consumed, answer }
  }

  /** Mark the interrupt resolved once the resumed run completes. */
  resolve(interruptId: string): void {
    this.store.update(interruptId, { status: "resolved" })
  }

  cancel(interruptId: string): void {
    this.store.update(interruptId, { status: "cancelled" })
  }
}
