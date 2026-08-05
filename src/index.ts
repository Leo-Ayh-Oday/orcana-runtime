#!/usr/bin/env node
/** Orcana — TS entry point. */

// MUST be the first import: mirrors legacy DEEPSEEK_* env vars to ORCANA_*
// before any module reads them at load time.
import "./config/env-compat"
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
    "Orcana Runtime — model-agnostic agent runtime for evidence-gated recursive self-evolution",
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
    "Model configuration:",
    "  Run /models in the TUI to select a model and save its key globally.",
    "  Environment keys are used only when runtime.allowEnvKeys is enabled.",
    "",
    "Docs: https://github.com/Leo-Ayh-Oday/orcana-runtime",
  ].join("\n"))
}

async function printDoctor() {
  const { doctorCli } = await import("./diagnostics/doctor")
  const exit = await doctorCli()
  if (exit !== 0) process.exitCode = exit
}

async function main() {
  // R4: Linux 启动 Janitor —— 清理旧 boot 遗留 run 状态（崩溃恢复闭环）。
  if (process.platform === "linux") {
    try {
      const { RuntimeStateStore, startupJanitor, readBootId } = await import("./runtime/linux/recovery/state-store")
      const store = new RuntimeStateStore()
      await startupJanitor({ store, currentBootId: readBootId() })
    } catch {
      // best-effort：Janitor 失败不阻断启动。
    }
  }

  if (arg === "--version" || arg === "-v" || arg === "version") {
    console.log(`orcana ${VERSION_LABEL}`)
    return
  }

  if (arg === "--help" || arg === "-h" || arg === "help") {
    printHelp()
    return
  }

  if (arg === "doctor") {
    await printDoctor()
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
  console.error(`[orcana] fatal: ${message}${stack}`)
  process.exit(1)
})
