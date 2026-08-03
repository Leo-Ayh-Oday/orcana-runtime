/** Web search — Exa semantic search (free tier: 1,000/month).
 *
 *  Architecture:
 *  1. Exa REST API (api.exa.ai/search) — semantic search, 10 results
 *  2. Exa MCP endpoint (mcp.exa.ai/mcp) — fallback when no API key
 *
 *  Exa returns AI-relevant results by meaning, not keywords.
 *  No Docker, no external CLI. Pure HTTP.
 */

import type { ToolDef, ToolResult } from "./registry"
import { Result } from "./registry"

const EXA_API_URL = "https://api.exa.ai/search"
const EXA_MCP_URL = "https://mcp.exa.ai/mcp"

function exaApiKey(): string {
  return process.env.EXA_API_KEY ?? ""
}

function timeoutFromEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name])
  if (!Number.isFinite(raw) || raw <= 0) return fallback
  return Math.max(1, Math.round(raw))
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const upstream = init.signal
  const onAbort = () => controller.abort()
  if (upstream) {
    if (upstream.aborted) controller.abort()
    else upstream.addEventListener("abort", onAbort, { once: true })
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      fetch(url, { ...init, signal: controller.signal }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new Error(`search request timed out after ${timeoutMs}ms`))
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
    if (upstream) upstream.removeEventListener("abort", onAbort)
  }
}

interface ExaResult {
  title: string
  url: string
  text?: string
}

async function searchViaRest(query: string, apiKey: string, timeoutMs: number): Promise<ExaResult[]> {
  const resp = await fetchWithTimeout(EXA_API_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query,
      type: "auto",
      numResults: 10,
      contents: { text: { maxCharacters: 500 } },
    }),
  }, timeoutMs)

  if (!resp.ok) {
    const body = await resp.text().catch(() => "")
    throw new Error(`Exa HTTP ${resp.status}: ${body.slice(0, 200)}`)
  }

  const data = await resp.json() as { results?: Array<{ title: string; url: string; text?: string }> }
  return (data.results ?? []).map(r => ({
    title: r.title ?? "",
    url: r.url ?? "",
    text: r.text?.slice(0, 500),
  }))
}

/** Exa MCP — works without API key (lower rate limit). Uses the MCP tool `exa_web_search_exa`. */
async function searchViaMcp(query: string, timeoutMs: number): Promise<ExaResult[]> {
  // MCP JSON-RPC call: list tools, then invoke exa_web_search_exa
  const resp = await fetchWithTimeout(EXA_MCP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "exa_web_search_exa",
        arguments: { query, numResults: 10 },
      },
    }),
  }, timeoutMs)

  if (!resp.ok) {
    const body = await resp.text().catch(() => "")
    throw new Error(`Exa MCP HTTP ${resp.status}: ${body.slice(0, 200)}`)
  }

  const data = await resp.json() as { result?: { content?: Array<{ text?: string }> } }
  const text = data.result?.content?.[0]?.text ?? ""
  if (!text) throw new Error("Exa MCP returned empty response")

  // Parse MCP text output — Exa MCP returns results as structured text
  const results: ExaResult[] = []
  const lines = text.split("\n")
  let current: Partial<ExaResult> = {}
  for (const line of lines) {
    const titleMatch = line.match(/^\d+\.\s+\*\*(.+?)\*\*/)
    const urlMatch = line.match(/\(?(https?:\/\/[^\s)]+)\)?/)
    if (titleMatch) {
      if (current.title) { results.push({ title: current.title, url: current.url ?? "" }); current = {} }
      current.title = titleMatch[1]!
    }
    if (urlMatch && !current.url) current.url = urlMatch[1]!
    if (current.title && current.url && !results.includes(current as ExaResult)) {
      results.push({ title: current.title, url: current.url })
      current = {}
    }
  }
  if (current.title) results.push({ title: current.title, url: current.url ?? "", text: current.text })

  return results.slice(0, 10)
}

async function web_search(params: Record<string, unknown>): Promise<ToolResult> {
  const query = String(params.query ?? "").trim()
  if (!query) return Result.fail("web_search requires a non-empty query.")

  const apiKey = exaApiKey()
  const timeoutMs = timeoutFromEnv("ORCANA_SEARCH_TIMEOUT_MS", 8000)
  const errors: string[] = []

  // Try Exa REST API first (requires API key)
  if (apiKey) {
    try {
      const results = await searchViaRest(query, apiKey, timeoutMs)
      if (results.length > 0) {
        return formatResults(query, results, "Exa")
      }
    } catch (e) {
      errors.push(`Exa REST: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // Fallback: Exa MCP (works without key, lower rate limit)
  try {
    const results = await searchViaMcp(query, timeoutMs)
    if (results.length > 0) {
      return formatResults(query, results, "Exa MCP")
    }
  } catch (e) {
    errors.push(`Exa MCP: ${e instanceof Error ? e.message : String(e)}`)
  }

  // Last resort: search URL directly as instruction
  if (apiKey) {
    const diag = errors.map(e => `  ✗ ${e}`).join("\n")
    return Result.fail(
      `All search backends failed for: ${query}\n${diag}\n\nTip: get a free Exa API key at https://exa.ai or try different keywords.`,
    )
  }

  return Result.fail(
    `Search unavailable for: ${query}\n\n` +
    `Exa API key not configured. Get a free key at https://exa.ai (1,000 searches/month) and set EXA_API_KEY env var.\n` +
    `Alternatively, provide a URL directly with web_fetch.`,
  )
}

function formatResults(query: string, results: ExaResult[], engine: string): ToolResult {
  const lines = [`[${engine}] Search results for: ${query}\n`]
  results.forEach((r, i) => {
    lines.push(`${i + 1}. ${r.title}`)
    lines.push(`   ${r.url}`)
    if (r.text) lines.push(`   ${r.text.slice(0, 300)}`)
    lines.push("")
  })
  return Result.ok(lines.join("\n"), { count: results.length, engine })
}

export const WEB_SEARCH: ToolDef = {
  name: "web_search",
  description: "Semantic web search via Exa — understands meaning, not just keywords. Returns relevant results with URLs. Get a free API key at https://exa.ai and set EXA_API_KEY env var. Works without key via Exa MCP (lower rate limit).",
  isReadonly: true,
  category: "network" as const,
  isConcurrencySafe: true,
  userFacingName: "Exa 搜索",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query (natural language, not keywords)" },
    },
    required: ["query"],
  },
  execute: web_search,
}
