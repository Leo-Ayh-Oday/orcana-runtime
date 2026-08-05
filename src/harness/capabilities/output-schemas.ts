/** Tool Runtime 2.0 (RT-4): target output schemas for the first migration
 *  batch (plan §5 RT-4). These are the STRUCTURED shapes the tools will
 *  produce once their handlers are migrated — today the executor validates
 *  the legacy Tool shape ({success, content}) for legacy-source capabilities;
 *  these schemas are the migration target and the eval/verification basis.
 */

import type { JsonSchema } from "../contracts/schema"

export const TYPECHECK_OUTPUT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    passed: { type: "boolean" },
    issues: { type: "number" },
    command: { type: "string" },
    outputRef: { type: "string", description: "Artifact ref of the full tsc output" },
    files: { type: "array", items: { type: "string" } },
  },
  required: ["passed", "issues", "command"],
}

export const GIT_STATUS_OUTPUT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    staged: { type: "array", items: { type: "string" } },
    unstaged: { type: "array", items: { type: "string" } },
    untracked: { type: "array", items: { type: "string" } },
    conflicts: { type: "array", items: { type: "string" } },
    branch: { type: "string" },
    dirty: { type: "boolean" },
  },
  required: ["staged", "unstaged", "untracked", "conflicts", "branch", "dirty"],
}

export const GIT_DIFF_OUTPUT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    files: { type: "array", items: { type: "string" } },
    stat: { type: "array", items: { type: "object", properties: { path: { type: "string" }, additions: { type: "number" }, deletions: { type: "number" } } } },
    patchRef: { type: "string", description: "Artifact ref of the full diff" },
    truncated: { type: "boolean" },
  },
  required: ["files", "stat"],
}

export const LSP_DIAGNOSTICS_OUTPUT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    diagnostics: {
      type: "array",
      items: {
        type: "object",
        properties: {
          file: { type: "string" },
          severity: { type: "string" },
          message: { type: "string" },
          line: { type: "number" },
          column: { type: "number" },
        },
        required: ["file", "severity", "message"],
      },
    },
    passed: { type: "boolean" },
  },
  required: ["diagnostics", "passed"],
}

export const WEB_SEARCH_OUTPUT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    query: { type: "string" },
    provider: { type: "string" },
    retrievedAt: { type: "string" },
    sources: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          url: { type: "string" },
          domain: { type: "string" },
          snippet: { type: "string" },
          sourceType: { type: "string", enum: ["official", "paper", "news", "community", "unknown"] },
        },
        required: ["title", "url", "domain", "snippet"],
      },
    },
  },
  required: ["query", "provider", "sources"],
}

/** The first migration batch (plan §5 RT-4) keyed by tool name. */
export const FIRST_BATCH_OUTPUT_SCHEMAS: Readonly<Record<string, JsonSchema>> = {
  typecheck: TYPECHECK_OUTPUT_SCHEMA,
  git_status: GIT_STATUS_OUTPUT_SCHEMA,
  git_diff: GIT_DIFF_OUTPUT_SCHEMA,
  lsp_diagnostics: LSP_DIAGNOSTICS_OUTPUT_SCHEMA,
  web_search: WEB_SEARCH_OUTPUT_SCHEMA,
}
