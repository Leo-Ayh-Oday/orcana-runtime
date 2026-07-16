/** LSP tools — diagnostics, hover, and definition lookup.
 *
 *  All tools connect to the singleton LSPClient (src/lsp/client.ts).
 *  If the LSP server is not running, tools return a graceful unavailable message.
 *
 *  These tools supplement — not replace — tsc --noEmit. The quality gate
 *  still treats tsc as ground truth. LSP tools give the agent faster feedback
 *  and deeper code understanding.
 */

import type { ToolDef, ToolResult } from "./registry"
import { Result } from "./registry"
import { getLSPClient } from "../lsp/client"

// ── lsp_diagnostics ──

export const LSP_DIAGNOSTICS: ToolDef = {
  name: "lsp_diagnostics",
  description:
    "获取指定文件的 TypeScript LSP 诊断信息（错误、警告、提示）。" +
    "比全量 tsc 更快，适合单文件快速检查。不传参数则获取所有已跟踪文件的诊断汇总。",
  isReadonly: true,
  isConcurrencySafe: true,
  category: "safe",
  contract: {
    provenance: "local",
    stateUpdates: ["evidence"],
  },
  inputSchema: {
    type: "object",
    properties: {
      file: {
        type: "string",
        description: "要检查的文件路径（相对或绝对）。不传则返回所有文件的汇总。",
      },
    },
  },
  execute: async (params: Record<string, unknown>): Promise<ToolResult> => {
    const client = getLSPClient()

    if (!client.isAvailable) {
      const content = "LSP server 未就绪。使用 tsc 进行类型检查。启动 LSP 需要 typescript-language-server 已安装。"
      return Result.ok(content, { available: false, verification: null })
    }

    const file = typeof params.file === "string" ? params.file : undefined

    if (file) {
      const diags = client.getDiagnostics(file)
      const counts = client.getSeverityCounts(file)
      if (diags.length === 0) {
        return Result.ok(`✅ ${file}: 无诊断问题 (LSP)`, {
          available: true,
          verification: {
            kind: "typecheck",
            command: "lsp_diagnostics",
            passed: true,
            issues: 0,
            durationMs: 0,
            summary: `LSP: ${file} — 无诊断`,
          },
        })
      }

      return Result.ok(formatDiagnostics(file, diags, counts), {
        available: true,
        verification: {
          kind: "typecheck",
          command: "lsp_diagnostics",
          passed: counts.errors === 0,
          issues: counts.errors,
          durationMs: 0,
          summary: diags.slice(0, 5).map(d => `${d.severity}: ${d.message}`).join("\n"),
        },
      })
    }

    // All files summary
    const allDiags = client.getAllDiagnostics()
    const totalErrors = client.totalErrors
    if (allDiags.size === 0) {
      return Result.ok("✅ 所有已跟踪文件无诊断问题 (LSP)", {
        available: true,
        verification: { kind: "typecheck", command: "lsp_diagnostics", passed: true, issues: 0, durationMs: 0, summary: "LSP: 全局无诊断" },
      })
    }

    const parts: string[] = [`LSP 诊断汇总 — ${allDiags.size} 文件有诊断，共 ${totalErrors} 错误\n`]
    for (const [file, diags] of allDiags) {
      if (diags.length === 0) continue
      const errors = diags.filter(d => d.severity === "error").length
      const warnings = diags.filter(d => d.severity === "warning").length
      parts.push(`\n${file}: ${errors > 0 ? `❌ ${errors} 错误` : ""}${errors > 0 && warnings > 0 ? " " : ""}${warnings > 0 ? `⚠️ ${warnings} 警告` : ""}`)
      for (const d of diags.filter(d => d.severity === "error").slice(0, 5)) {
        parts.push(`  ${d.range.start.line + 1}:${d.range.start.character + 1} — ${d.message}`)
      }
    }

    const raw = parts.join("\n")
    const maxLen = 4000
    const text = raw.length <= maxLen ? raw
      : raw.slice(0, maxLen) + `\n\n… [LSP 诊断输出被截断：${raw.length} 字符，仅显示前 ${maxLen}]`
    return Result.ok(text, {
      available: true,
      verification: {
        kind: "typecheck",
        command: "lsp_diagnostics",
        passed: totalErrors === 0,
        issues: totalErrors,
        durationMs: 0,
        summary: `LSP: ${totalErrors} errors across ${allDiags.size} files`,
      },
    })
  },
}

// ── lsp_hover ──

export const LSP_HOVER: ToolDef = {
  name: "lsp_hover",
  description:
    "获取指定文件中某一行某个符号的类型信息、文档等（hover 信息）。" +
    "用于理解 API 类型签名、函数参数、变量类型等。",
  isReadonly: true,
  isConcurrencySafe: true,
  category: "safe",
  inputSchema: {
    type: "object",
    properties: {
      file: {
        type: "string",
        description: "文件路径",
      },
      line: {
        type: "number",
        description: "行号（1-based，和编辑器一致）",
      },
      character: {
        type: "number",
        description: "列号（1-based，和编辑器一致）",
      },
    },
    required: ["file", "line", "character"],
  },
  execute: async (params: Record<string, unknown>): Promise<ToolResult> => {
    const client = getLSPClient()

    if (!client.isAvailable) {
      return Result.fail("LSP server 未就绪。安装 typescript-language-server 后可用。")
    }

    const file = String(params.file ?? "")
    const line = Number(params.line ?? 0)
    const character = Number(params.character ?? 0)

    if (!file || !line || !character) {
      return Result.fail("需要 file、line、character 参数")
    }

    const result = await client.hover(file, line, character)
    if (!result) {
      return Result.ok(`(无类型信息) ${file}:${line}:${character}`, {
        hover: null,
      })
    }

    return Result.ok(result.contents.slice(0, 2000), {
      hover: result,
    })
  },
}

// ── lsp_definition ──

export const LSP_DEFINITION: ToolDef = {
  name: "lsp_definition",
  description:
    "跳转到指定文件中某一行某个符号的定义位置。返回定义所在的文件和行号。",
  isReadonly: true,
  isConcurrencySafe: true,
  category: "safe",
  inputSchema: {
    type: "object",
    properties: {
      file: {
        type: "string",
        description: "文件路径",
      },
      line: {
        type: "number",
        description: "行号（1-based）",
      },
      character: {
        type: "number",
        description: "列号（1-based）",
      },
    },
    required: ["file", "line", "character"],
  },
  execute: async (params: Record<string, unknown>): Promise<ToolResult> => {
    const client = getLSPClient()

    if (!client.isAvailable) {
      return Result.fail("LSP server 未就绪。安装 typescript-language-server 后可用。")
    }

    const file = String(params.file ?? "")
    const line = Number(params.line ?? 0)
    const character = Number(params.character ?? 0)

    if (!file || !line || !character) {
      return Result.fail("需要 file、line、character 参数")
    }

    const result = await client.definition(file, line, character)
    if (!result) {
      return Result.ok(`(未找到定义) ${file}:${line}:${character}`, {
        definition: null,
      })
    }

    return Result.ok(
      `${result.uri}:${result.range.start.line}:${result.range.start.character}`,
      { definition: result },
    )
  },
}

// ── lsp_references ──

export const LSP_REFERENCES: ToolDef = {
  name: "lsp_references",
  description:
    "查找指定文件中某个符号的所有类型级引用（通过 LSP textDocument/references）。" +
    "比基于文本的搜索（find_references）更精确——它通过 TypeScript 类型图解析，不会把同名异包的符号误判为引用。" +
    "用于理解修改一个符号会影响哪些文件。",
  isReadonly: true,
  isConcurrencySafe: true,
  category: "safe",
  inputSchema: {
    type: "object",
    properties: {
      file: {
        type: "string",
        description: "文件路径",
      },
      line: {
        type: "number",
        description: "符号所在行号（1-based）",
      },
      character: {
        type: "number",
        description: "符号起始列号（1-based）",
      },
    },
    required: ["file", "line", "character"],
  },
  execute: async (params: Record<string, unknown>): Promise<ToolResult> => {
    const client = getLSPClient()

    if (!client.isAvailable) {
      return Result.fail("LSP server 未就绪。安装 typescript-language-server 后可用。")
    }

    const file = String(params.file ?? "")
    const line = Number(params.line ?? 0)
    const character = Number(params.character ?? 0)

    if (!file || !line || !character) {
      return Result.fail("需要 file、line、character 参数")
    }

    const refs = await client.references(file, line, character)
    if (!refs || refs.length === 0) {
      return Result.ok(`(未找到引用) ${file}:${line}:${character}`, {
        references: [],
      })
    }

    const lines = refs.slice(0, 30).map(r =>
      `${r.uri}:${r.line}:${r.character}`
    )
    const summary = refs.length > 30
      ? [...lines, `... 还有 ${refs.length - 30} 个引用`].join("\n")
      : lines.join("\n")

    return Result.ok(summary, {
      references: refs,
      count: refs.length,
    })
  },
}

/** All LSP tools, ready for buildTools(). */
export const LSP_TOOLS: ToolDef[] = [LSP_DIAGNOSTICS, LSP_HOVER, LSP_DEFINITION, LSP_REFERENCES]

// ── Helper ──

function formatDiagnostics(file: string, diags: Array<{ severity: string; message: string; range: { start: { line: number; character: number }; end: { line: number; character: number } }; code?: string | number }>, counts: { errors: number; warnings: number; hints: number }): string {
  const lines: string[] = [
    `${file}: ❌ ${counts.errors} 错误 ⚠️ ${counts.warnings} 警告 ℹ️ ${counts.hints} 提示\n`,
  ]
  for (const d of diags.slice(0, 15)) {
    const icon = d.severity === "error" ? "❌" : d.severity === "warning" ? "⚠️" : "ℹ️"
    const code = d.code ? ` [${d.code}]` : ""
    lines.push(`${icon} ${d.range.start.line + 1}:${d.range.start.character + 1}${code} — ${d.message}`)
  }
  if (diags.length > 15) {
    lines.push(`... 还有 ${diags.length - 15} 条诊断`)
  }
  return lines.join("\n")
}
