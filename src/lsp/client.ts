/** LSP client — spawns typescript-language-server, collects diagnostics.
 *
 *  JSON-RPC 2.0 over stdio. The client:
 *    - Starts the server on first need (lazy init)
 *    - Sends textDocument/didOpen on file read, didChange on file write
 *    - Caches publishDiagnostics notifications per file
 *    - Auto-reconnects on crash (with backoff)
 *
 *  Design invariants:
 *    - Zero LLM dependency (pure JSON-RPC + filesystem)
 *    - Non-blocking diagnostics collection (no await on tool calls)
 *    - tsc --noEmit is ALWAYS the ground truth — LSP is an accelerator, not a replacement
 *    - Does not touch loop.ts gate logic — diagnostics flow through existing VerificationResult path
 */

import { spawnLegacy, minimalHostEnv, ChildProcess } from "../runtime/legacy-process"
const spawn = spawnLegacy
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { URI } from "./uri"

// ── Types ──

export interface LSPDiagnostic {
  file: string
  range: {
    start: { line: number; character: number }
    end: { line: number; character: number }
  }
  severity: "error" | "warning" | "information" | "hint"
  message: string
  code?: string | number
  source?: string
}

export interface LSPHoverResult {
  contents: string
  range?: { start: { line: number; character: number }; end: { line: number; character: number } }
}

export interface LSPDefinitionResult {
  uri: string
  range: { start: { line: number; character: number }; end: { line: number; character: number } }
}

export type LSPSeverityCount = { errors: number; warnings: number; hints: number }

// ── Server discovery ──

function findTSLanguageServer(cwd: string): string | null {
  const names = process.platform === "win32"
    ? ["typescript-language-server.cmd", "typescript-language-server.ps1"]
    : ["typescript-language-server"]

  // Check local node_modules first
  for (const name of names) {
    const local = resolve(cwd, "node_modules", ".bin", name)
    if (existsSync(local)) return local
  }

  // Check global
  for (const name of names) {
    const globalPath = resolve(
      process.env.APPDATA ?? resolve(process.env.HOME ?? "/", "AppData", "Roaming"),
      "npm",
      name,
    )
    if (existsSync(globalPath)) return globalPath
  }

  // PATH fallback
  return "typescript-language-server"
}

// ── JSON-RPC framing ──

function encodeMessage(msg: Record<string, unknown>): string {
  const body = JSON.stringify(msg)
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
}

// ── Main client ──

export class LSPClient {
  private proc: ChildProcess | null = null
  private buffer = ""
  private diagnostics = new Map<string, LSPDiagnostic[]>()
  private reqId = 0
  private pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (e: Error) => void }>()
  private cwd: string
  private serverPath: string | null
  private initialized = false
  private openFiles = new Set<string>()
  private reconnectAttempts = 0
  private maxReconnectAttempts = 3
  private reconnectDelay = 1000
  private diagnosticsCallback: ((file: string, diags: LSPDiagnostic[]) => void) | null = null

  constructor(cwd = process.cwd()) {
    this.cwd = cwd
    this.serverPath = findTSLanguageServer(cwd)
  }

  // ── Server lifecycle ──

  get isRunning(): boolean {
    return this.proc !== null && this.proc.exitCode === null
  }

  get isAvailable(): boolean {
    return this.initialized && this.isRunning
  }

  /** Start the LSP server. Idempotent — no-op if already running. */
  async start(): Promise<boolean> {
    if (this.isRunning) return true
    if (!this.serverPath) return false

    return new Promise(resolve => {
      try {
        this.proc = spawn(this.serverPath!, ["--stdio"], {
          cwd: this.cwd,
          stdio: ["pipe", "pipe", "pipe"],
          // E1.4：最小宿主环境 —— LSP server 不读取宿主密钥/代理配置。
          env: minimalHostEnv(),
        })

        this.proc.stdout?.on("data", (chunk: Buffer) => {
          this.buffer += chunk.toString("utf-8")
          this.parseMessages()
        })

        this.proc.stderr?.on("data", (chunk: Buffer) => {
          // LSP servers write logs to stderr — ignore for now
        })

        this.proc.on("error", () => {
          this.cleanup()
          resolve(false)
        })

        this.proc.on("exit", (code) => {
          this.cleanup()
          // Auto-reconnect if not explicitly shut down
          if (code !== 0 && this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++
            setTimeout(() => this.start(), this.reconnectDelay * this.reconnectAttempts)
          }
        })

        // Initialize
        this.send("initialize", {
          processId: process.pid,
          rootUri: URI.file(this.cwd),
          capabilities: {
            textDocument: {
              publishDiagnostics: { relatedInformation: true },
              hover: { contentFormat: ["markdown", "plaintext"] },
              definition: { linkSupport: true },
              references: { dynamicRegistration: true },
            },
          },
        }).then(response => {
          if ("error" in response) {
            this.cleanup()
            resolve(false)
            return
          }
          this.send("initialized", {})
          this.initialized = true
          this.reconnectAttempts = 0
          resolve(true)
        }).catch(() => {
          this.cleanup()
          resolve(false)
        })
      } catch {
        resolve(false)
      }
    })
  }

  /** Graceful shutdown. */
  shutdown(): void {
    if (this.proc) {
      this.send("shutdown", {}).catch(() => {})
      this.send("exit", {}).catch(() => {})
      setTimeout(() => this.cleanup(), 500)
    }
  }

  private cleanup(): void {
    this.proc = null
    this.initialized = false
    this.openFiles.clear()
    // Reject all pending calls
    for (const [, p] of this.pending) {
      p.reject(new Error("LSP server disconnected"))
    }
    this.pending.clear()
  }

  // ── File tracking ──

  /** Notify the server that a file has been opened/read. */
  async trackFile(filePath: string): Promise<void> {
    if (!this.isAvailable) return
    const uri = URI.file(resolve(this.cwd, filePath))
    if (this.openFiles.has(uri)) return

    try {
      const content = require("node:fs").readFileSync(resolve(this.cwd, filePath), "utf-8")
      await this.send("textDocument/didOpen", {
        textDocument: {
          uri,
          languageId: this.languageId(filePath),
          version: 1,
          text: content,
        },
      })
      this.openFiles.add(uri)
    } catch { /* file not found — skip */ }
  }

  /** Notify the server that a file has been written. */
  async notifyChange(filePath: string): Promise<void> {
    if (!this.isAvailable) return
    const uri = URI.file(resolve(this.cwd, filePath))

    try {
      const content = require("node:fs").readFileSync(resolve(this.cwd, filePath), "utf-8")
      await this.send("textDocument/didChange", {
        textDocument: {
          uri,
          version: Date.now(),
        },
        contentChanges: [{ text: content }],
      })
    } catch { /* file gone — skip */ }
  }

  // ── Diagnostics ──

  /** Get cached diagnostics for a file. */
  getDiagnostics(filePath: string): LSPDiagnostic[] {
    const abs = resolve(this.cwd, filePath)
    return this.diagnostics.get(abs) ?? []
  }

  /** Get severity counts for a file. */
  getSeverityCounts(filePath: string): LSPSeverityCount {
    const diags = this.getDiagnostics(filePath)
    return {
      errors: diags.filter(d => d.severity === "error").length,
      warnings: diags.filter(d => d.severity === "warning").length,
      hints: diags.filter(d => d.severity === "information" || d.severity === "hint").length,
    }
  }

  /** Get diagnostics summary matching VerificationResult format for quality gate. */
  getVerificationResult(filePath?: string): {
    passed: boolean
    issues: number
    summary: string
  } | null {
    if (!this.isAvailable) return null

    let diags: LSPDiagnostic[]
    if (filePath) {
      diags = this.getDiagnostics(filePath)
    } else {
      diags = [...this.diagnostics.values()].flat()
    }

    const errors = diags.filter(d => d.severity === "error")
    if (filePath && diags.length === 0) {
      // No diagnostics at all for this file — might not be tracked yet
      return null
    }

    return {
      passed: errors.length === 0,
      issues: errors.length,
      summary: diags.length > 0
        ? diags.slice(0, 10).map(d =>
            `${d.severity === "error" ? "❌" : d.severity === "warning" ? "⚠️" : "ℹ️"} ${d.file}:${d.range.start.line + 1}: ${d.message}`
          ).join("\n")
        : "LSP: 无诊断",
    }
  }

  /** Set a diagnostic change callback. */
  onDiagnostics(cb: (file: string, diags: LSPDiagnostic[]) => void): void {
    this.diagnosticsCallback = cb
  }

  /** Regenerate diagnostics for all open files (called after server restart). */
  async refreshDiagnostics(): Promise<void> {
    if (!this.isAvailable) return
    for (const uri of this.openFiles) {
      try {
        const filePath = URI.toPath(uri)
        const content = require("node:fs").readFileSync(filePath, "utf-8")
        await this.send("textDocument/didChange", {
          textDocument: { uri, version: Date.now() },
          contentChanges: [{ text: content }],
        })
      } catch { /* skip */ }
    }
  }

  // ── Hover ──

  /** Get hover info at a position. */
  async hover(filePath: string, line: number, character: number): Promise<LSPHoverResult | null> {
    if (!this.isAvailable) return null

    try {
      const result = await this.send("textDocument/hover", {
        textDocument: { uri: URI.file(resolve(this.cwd, filePath)) },
        position: { line: line - 1, character: character - 1 },  // 1-based → 0-based
      })

      if ("error" in result || !result.result) return null
      const contents = (result.result as Record<string, unknown>).contents
      if (!contents) return null

      if (typeof contents === "string") return { contents }
      if (Array.isArray(contents)) {
        return { contents: contents.map(c => typeof c === "string" ? c : (c as Record<string, unknown>).value ?? "").join("\n") }
      }
      if (typeof contents === "object" && "value" in (contents as Record<string, unknown>)) {
        return { contents: String((contents as Record<string, unknown>).value) }
      }
      return null
    } catch {
      return null
    }
  }

  /** Get definition location. */
  async definition(filePath: string, line: number, character: number): Promise<LSPDefinitionResult | null> {
    if (!this.isAvailable) return null

    try {
      const result = await this.send("textDocument/definition", {
        textDocument: { uri: URI.file(resolve(this.cwd, filePath)) },
        position: { line: line - 1, character: character - 1 },
      })

      if ("error" in result || !result.result) return null
      const locations = result.result as Array<Record<string, unknown>>
      if (!Array.isArray(locations) || locations.length === 0) return null

      const loc = locations[0]!
      const range = loc.range as { start: { line: number; character: number }; end: { line: number; character: number } }
      return {
        uri: URI.toPath(String(loc.uri ?? "")),
        range: {
          start: { line: (range?.start?.line ?? 0) + 1, character: (range?.start?.character ?? 0) + 1 },
          end: { line: (range?.end?.line ?? 0) + 1, character: (range?.end?.character ?? 0) + 1 },
        },
      }
    } catch {
      return null
    }
  }

  /** Find all references to a symbol at the given position. */
  async references(filePath: string, line: number, character: number): Promise<Array<{ uri: string; line: number; character: number }> | null> {
    if (!this.isAvailable) return null

    try {
      const result = await this.send("textDocument/references", {
        textDocument: { uri: URI.file(resolve(this.cwd, filePath)) },
        position: { line: line - 1, character: character - 1 },
        context: { includeDeclaration: false },
      })

      if ("error" in result || !result.result) return null
      const locations = result.result as Array<Record<string, unknown>>
      if (!Array.isArray(locations)) return null

      return locations.map(loc => {
        const range = (loc.range ?? { start: { line: 0, character: 0 } }) as { start: { line: number; character: number } }
        return {
          uri: URI.toPath(String(loc.uri ?? "")),
          line: (range.start.line ?? 0) + 1,
          character: (range.start.character ?? 0) + 1,
        }
      })
    } catch {
      return null
    }
  }

  // ── Diagnostics (batch, all files) ──

  /** Get consolidated diagnostics for all tracked files. */
  getAllDiagnostics(): Map<string, LSPDiagnostic[]> {
    return new Map(this.diagnostics)
  }

  /** Total error count across all files. */
  get totalErrors(): number {
    let count = 0
    for (const diags of this.diagnostics.values()) {
      count += diags.filter(d => d.severity === "error").length
    }
    return count
  }

  // ── JSON-RPC internals ──

  private async send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (!this.proc || !this.proc.stdin) {
      throw new Error("LSP server not running")
    }

    const id = ++this.reqId
    const msg = encodeMessage({ jsonrpc: "2.0", id, method, params })

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`LSP request ${method} timed out`))
      }, 15000)

      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value) },
        reject: (e) => { clearTimeout(timer); reject(e) },
      })

      this.proc!.stdin!.write(msg)
    })
  }

  private sendNotification(method: string, params: Record<string, unknown> = {}): void {
    if (!this.proc?.stdin) return
    const msg = encodeMessage({ jsonrpc: "2.0", method, params })
    this.proc.stdin.write(msg)
  }

  private parseMessages(): void {
    while (true) {
      const headerMatch = this.buffer.match(/^Content-Length: (\d+)\r?\n\r?\n/)
      if (!headerMatch) break

      const length = parseInt(headerMatch[1]!, 10)
      const headerEnd = headerMatch[0]!.length
      if (this.buffer.length < headerEnd + length) break

      const body = this.buffer.slice(headerEnd, headerEnd + length)
      this.buffer = this.buffer.slice(headerEnd + length)

      try {
        const msg = JSON.parse(body) as Record<string, unknown>
        this.handleMessage(msg)
      } catch { /* skip malformed */ }
    }
  }

  private handleMessage(msg: Record<string, unknown>): void {
    // Response to a request
    if (typeof msg.id === "number") {
      const pending = this.pending.get(msg.id)
      if (pending) {
        this.pending.delete(msg.id)
        pending.resolve(msg)
      }
      return
    }

    // Notification
    const method = String(msg.method ?? "")

    if (method === "textDocument/publishDiagnostics") {
      const params = msg.params as Record<string, unknown>
      const uri = String(params?.uri ?? "")
      const filePath = URI.toPath(uri)
      const rawDiags = (params?.diagnostics as Array<Record<string, unknown>>) ?? []

      const diags: LSPDiagnostic[] = rawDiags.map(d => {
        const r = d.range as { start: { line: number; character: number }; end: { line: number; character: number } } | undefined
        return {
          file: filePath,
          range: {
            start: { line: r?.start?.line ?? 0, character: r?.start?.character ?? 0 },
            end: { line: r?.end?.line ?? 0, character: r?.end?.character ?? 0 },
          },
          severity: this.mapSeverity(Number(d.severity ?? 2)),
          message: String(d.message ?? ""),
          code: d.code as string | number | undefined,
          source: String(d.source ?? "typescript"),
        }
      })

      this.diagnostics.set(filePath, diags)
      this.diagnosticsCallback?.(filePath, diags)
    }
  }

  private mapSeverity(severity: number): LSPDiagnostic["severity"] {
    switch (severity) {
      case 1: return "error"
      case 2: return "warning"
      case 3: return "information"
      case 4: return "hint"
      default: return "warning"
    }
  }

  private languageId(filePath: string): string {
    if (filePath.endsWith(".tsx")) return "typescriptreact"
    if (filePath.endsWith(".ts")) return "typescript"
    if (filePath.endsWith(".jsx")) return "javascriptreact"
    if (filePath.endsWith(".js")) return "javascript"
    if (filePath.endsWith(".json")) return "json"
    return "typescript"
  }
}

/** Singleton: one LSP client per process. Created lazily. */
let _instance: LSPClient | null = null

export function getLSPClient(cwd?: string): LSPClient {
  if (!_instance) {
    _instance = new LSPClient(cwd)
  }
  return _instance
}

export function resetLSPClient(): void {
  _instance?.shutdown()
  _instance = null
}
