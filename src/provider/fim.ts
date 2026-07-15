/** FIM (Fill-in-the-Middle) editor — DeepSeek V4 /beta/completions endpoint.
 *  Ported from deepseek-code/core/fim_editor.py */

import { existsSync } from "node:fs"
import { readFile as readFileProm } from "node:fs/promises"

export interface FimEdit {
  prefix: string
  suffix: string
  instruction: string
  filePath?: string
}

export interface FimResult {
  success: boolean
  newText: string
  error: string
  fullNewFile: string
}

export class FimEditor {
  private apiKey: string
  private baseUrl: string
  private model: string

  constructor(apiKey?: string, baseUrl?: string, model = "deepseek-v4-pro") {
    this.apiKey = apiKey ?? process.env.DEEPSEEK_API_KEY ?? ""
    this.baseUrl = baseUrl ?? process.env.DEEPSEEK_BETA_BASE_URL ?? "https://api.deepseek.com/beta"
    this.model = model
  }

  async edit(edit: FimEdit, maxTokens = 2048): Promise<FimResult> {
    if (!this.apiKey) return { success: false, newText: "", error: "DEEPSEEK_API_KEY not set", fullNewFile: "" }

    const instructionBlock = `// FIM: ${edit.instruction}\n`
    const prompt = instructionBlock + edit.prefix

    try {
      const resp = await fetch(`${this.baseUrl}/completions`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          prompt,
          suffix: edit.suffix,
          max_tokens: maxTokens,
          temperature: 0.3,
        }),
      })
      if (!resp.ok) {
        const body = await resp.text().catch(() => "")
        return { success: false, newText: "", error: `HTTP ${resp.status}: ${body.slice(0, 200)}`, fullNewFile: "" }
      }
      const data = await resp.json() as { choices: Array<{ text: string }> }
      const newText = data.choices[0]?.text ?? ""
      return { success: true, newText, error: "", fullNewFile: edit.prefix + newText + edit.suffix }
    } catch (e) {
      return { success: false, newText: "", error: e instanceof Error ? e.message : String(e), fullNewFile: "" }
    }
  }

  async editFileRegion(filePath: string, instruction: string, startLine: number, endLine: number): Promise<FimResult> {
    if (!existsSync(filePath)) return { success: false, newText: "", error: `File not found: ${filePath}`, fullNewFile: "" }

    const content = await readFileProm(filePath, "utf-8")
    return this.editFileContentRegion(filePath, content, instruction, startLine, endLine)
  }

  async editFileContentRegion(
    filePath: string,
    content: string,
    instruction: string,
    startLine: number,
    endLine: number,
  ): Promise<FimResult> {
    const lines = content.split("\n")
    if (startLine < 1) startLine = 1
    if (endLine > lines.length) endLine = lines.length
    if (startLine > endLine) return { success: false, newText: "", error: "start_line > end_line", fullNewFile: "" }

    const prefix = lines.slice(0, startLine - 1).join("\n") + (startLine > 1 ? "\n" : "")
    const suffix = (endLine < lines.length ? "\n" : "") + lines.slice(endLine).join("\n")

    return this.edit({ prefix, suffix, instruction, filePath })
  }

  async editFunction(filePath: string, instruction: string, functionName: string): Promise<FimResult> {
    if (!existsSync(filePath)) return { success: false, newText: "", error: `File not found: ${filePath}`, fullNewFile: "" }

    const content = await readFileProm(filePath, "utf-8")
    return this.editFunctionContent(filePath, content, instruction, functionName)
  }

  async editFunctionContent(
    filePath: string,
    content: string,
    instruction: string,
    functionName: string,
  ): Promise<FimResult> {
    const lines = content.split("\n")
    let start = -1
    let end = -1
    let inFunction = false
    let baseIndent = 0

    for (let i = 0; i < lines.length; i++) {
      const stripped = lines[i]!.trim()
      if (!inFunction && (stripped.startsWith("def ") || stripped.startsWith("async def ") || stripped.startsWith("function ") || stripped.startsWith("export function "))) {
        if (stripped.includes(functionName)) {
          start = i
          inFunction = true
          baseIndent = lines[i]!.length - lines[i]!.trimStart().length
        }
        continue
      }
      if (inFunction && stripped) {
        const indent = lines[i]!.length - lines[i]!.trimStart().length
        if (indent <= baseIndent) { end = i; break }
      }
    }
    if (start < 0) return { success: false, newText: "", error: `Function '${functionName}' not found`, fullNewFile: "" }
    if (end < 0) end = lines.length

    const prefix = lines.slice(0, start).join("\n") + (start > 0 ? "\n" : "")
    const suffix = (end < lines.length ? "\n" : "") + lines.slice(end).join("\n")

    return this.edit({ prefix, suffix, instruction, filePath })
  }
}
