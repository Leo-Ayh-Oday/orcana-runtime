/** Workflow templates (G2): static read-only node sequences.
 *
 *  Template = a deterministic WorkflowSpec generator parameterized by
 *  inputs. Templates are validated against the read-only whitelist at
 *  registration; a template that would emit a write handler fails fast.
 */

import { stableHash } from "../results/result-hash"
import type { WorkflowSpec, WorkflowNodeSpec } from "../types"
import { normalizeSpec } from "../compiler/graph-normalizer"

export interface TemplateInput {
  path?: string
  query?: string
  /** Number of read_file fan-out nodes for audit-style templates. */
  fileCount?: number
  /** Static file paths to read (overrides fileCount). */
  files?: string[]
}

export interface Template {
  id: string
  description: string
  build: (input: TemplateInput) => WorkflowNodeSpec[]
}

const MAX_FANOUT = 8

function readNode(id: string, input: TemplateInput): WorkflowNodeSpec {
  return {
    id,
    handler: "tool.read_file",
    input: { path: input.path ?? "" },
    dependsOn: [],
  }
}

export const TEMPLATES: Template[] = [
  {
    id: "code_explain",
    description: "explain a symbol: find it, find its references, read the file",
    build: (input) => {
      const nodes: WorkflowNodeSpec[] = [
        { id: "t:find", handler: "tool.find_symbol", input: { query: input.query ?? "", path: input.path }, dependsOn: [] },
        { id: "t:refs", handler: "tool.find_references", input: { query: input.query ?? "", path: input.path }, dependsOn: ["t:find"] },
        { id: "t:read", handler: "tool.read_file", input: { path: input.path ?? "" }, dependsOn: ["t:find", "t:refs"] },
      ]
      return nodes
    },
  },
  {
    id: "security_audit",
    description: "structure overview + read files + merge diagnostics",
    build: (input) => {
      const nodes: WorkflowNodeSpec[] = [
        { id: "t:struct", handler: "tool.project_structure", input: { path: input.path ?? "" }, dependsOn: [] },
      ]
      const files = input.files?.slice(0, MAX_FANOUT) ?? []
      if (files.length === 0) {
        for (let i = 0; i < Math.min(input.fileCount ?? 3, MAX_FANOUT); i++) {
          nodes.push({ id: `t:read${i}`, handler: "tool.read_file", input: { path: "" }, dependsOn: ["t:struct"] })
        }
      } else {
        for (const file of files) {
          nodes.push({ id: `t:read:${stableHash(file).slice(0, 8)}`, handler: "tool.read_file", input: { path: file }, dependsOn: ["t:struct"] })
        }
      }
      nodes.push({ id: "t:merge", handler: "reduce.merge_diagnostics", input: { groups: [] }, dependsOn: ["t:struct"] })
      return nodes
    },
  },
  {
    id: "research_report",
    description: "repo state + diff + symbol + file reads",
    build: (input) => {
      const nodes: WorkflowNodeSpec[] = [
        { id: "t:status", handler: "tool.git_status", input: { path: input.path ?? "" }, dependsOn: [] },
        { id: "t:diff", handler: "tool.git_diff", input: { path: input.path ?? "" }, dependsOn: ["t:status"] },
      ]
      if (input.query) {
        nodes.push({ id: "t:sym", handler: "tool.find_symbol", input: { query: input.query, path: input.path }, dependsOn: [] })
      }
      const files = input.files?.slice(0, MAX_FANOUT) ?? []
      for (const file of files) {
        nodes.push({ id: `t:read:${stableHash(file).slice(0, 8)}`, handler: "tool.read_file", input: { path: file }, dependsOn: ["t:diff"] })
      }
      return nodes
    },
  },
]

export function buildTemplate(templateId: string, input: TemplateInput): WorkflowSpec {
  const template = TEMPLATES.find(t => t.id === templateId)
  if (!template) {
    throw new Error(`workflow: unknown template "${templateId}" (known: ${TEMPLATES.map(t => t.id).join(", ")})`)
  }
  const spec: WorkflowSpec = {
    schemaVersion: "0.1",
    specId: `template-${templateId}-${stableHash(input).slice(0, 8)}`,
    nodes: template.build(input),
  }
  return normalizeSpec(spec)
}
