#!/usr/bin/env node
/** DeepSeek Code — TS entry point. */

import { createServer } from "node:http"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { VERSION_LABEL } from "./version"

// ── Health server ──────────────────────────────────────────────
export function startHealthServer(port?: number): { url: string; stop: () => void } {
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json")
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    if (url.pathname !== "/health") {
      res.statusCode = 404
      res.end(JSON.stringify({ error: "not found" }))
      return
    }
    if (req.method !== "GET") {
      res.statusCode = 405
      res.end(JSON.stringify({ error: "method not allowed" }))
      return
    }
    res.statusCode = 200
    res.end(JSON.stringify({ status: "ok" }))
  })
  server.listen(port ?? 0, "127.0.0.1")
  const address = server.address()
  const actualPort = typeof address === "object" && address ? address.port : port ?? 0
  return { url: `http://127.0.0.1:${actualPort}`, stop: () => server.close() }
}

// ── Env loader ─────────────────────────────────────────────────
const scriptDir = dirname(fileURLToPath(import.meta.url))
const envPath = join(scriptDir, "..", ".env")
try {
  const envFile = readFileSync(envPath, "utf-8")
  for (const line of envFile.split("\n")) {
    const trimmed = line.trim()
    if (trimmed && !trimmed.startsWith("#") && trimmed.includes("=")) {
      const [k, ...rest] = trimmed.split("=")
      const v = rest.join("=")
      if (k && v && !process.env[k]) process.env[k] = v.trim()
    }
  }
} catch { /* .env optional */ }

const arg = process.argv[2] ?? ""

function printHelp() {
  console.log([
    "Orcana — DeepSeek-native terminal coding agent runtime",
    "",
    "Usage:",
    "  orcana [prompt]",
    "  orcana --cli [prompt]",
    "  orcana --tui",
    "  orcana doctor",
    "  orcana list",
    "  orcana last",
    "  orcana <session-id>",
    "  orcana --version",
    "  orcana --help",
    "",
    "Examples:",
    '  orcana "explain this codebase"',
    '  orcana "fix the failing test"',
    "  orcana --cli",
    "  orcana list",
    "",
    "Environment:",
    "  DEEPSEEK_API_KEY    DeepSeek API key (required for model calls)",
    "",
    "Docs: https://github.com/Leo-Ayh-Oday/deepseek-orcana",
  ].join("\n"))
}

function printDoctor() {
  const nodeOk = Number(process.versions.node.split(".")[0] ?? 0) >= 20
  const apiKeyOk = Boolean(process.env.DEEPSEEK_API_KEY)
  console.log([
    `Orcana ${VERSION_LABEL}`,
    `Node.js ${process.versions.node} ${nodeOk ? "ok" : "requires >=20"}`,
    `Bun ${process.versions.bun ?? "not required for npm users"}`,
    `DEEPSEEK_API_KEY ${apiKeyOk ? "set" : "missing"}`,
  ].join("\n"))
}

async function main() {
  if (arg === "--version" || arg === "-v" || arg === "version") {
    console.log(`deepseek-orcana ${VERSION_LABEL}`)
    return
  }

  if (arg === "--help" || arg === "-h" || arg === "help") {
    printHelp()
    return
  }

  if (arg === "doctor") {
    printDoctor()
    return
  }

  if (arg === "tui" || arg === "--tui") {
    const prompt = process.argv.slice(3).join(" ") || undefined
    const { startInkTUI } = await import("./tui/main")
    await startInkTUI(prompt)
    return
  }

  if (arg === "cli" || arg === "--cli") {
    const prompt = process.argv.slice(3).join(" ") || undefined
    const { startCLI } = await import("./ui/cli")
    await startCLI(prompt)
    if (prompt) process.exit(0)
    return
  }

  if (arg === "list") {
    const { SessionManager } = await import("./session")
    const sessions = new SessionManager()
    const list = sessions.listSessions()
    if (list.length === 0) {
      console.log("没有保存的会话")
    } else {
      for (const s of list.slice(0, 10)) {
        const date = new Date(s.createdAt).toLocaleString("zh-CN")
        console.log(`  ${s.id.slice(0, 8)}  ${date}  ${s.messageCount} 条`)
      }
      console.log(`\n恢复上次: deepseek last`)
      console.log(`恢复指定: deepseek <id>`)
    }
    return
  }

  if (arg === "last") {
    const { SessionManager } = await import("./session")
    const sessions = new SessionManager()
    const list = sessions.listSessions()
    if (list.length === 0) {
      console.log("没有保存的会话，创建新会话")
    } else {
      const { startCLI } = await import("./ui/cli")
      await startCLI(undefined, list[0]!.id)
      return
    }
  }

  // 8-char hex → resume by id
  if (/^[a-f0-9]{8,12}$/i.test(arg)) {
    const { startCLI } = await import("./ui/cli")
    await startCLI(undefined, arg)
    return
  }

  const prompt = process.argv.slice(2).join(" ") || undefined
  const { startInkTUI } = await import("./tui/main")
  await startInkTUI(prompt)
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err)
  const stack = err instanceof Error && err.stack ? `\n${err.stack}` : ""
  console.error(`[deepseek-code] fatal: ${message}${stack}`)
  process.exit(1)
})
