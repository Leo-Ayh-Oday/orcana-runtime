#!/usr/bin/env bun
/** DeepSeek Code — TS entry point. */

import { startCLI } from "./ui/cli"
import { startInkTUI } from "./tui/main"
import { SessionManager } from "./session"
import { VERSION_LABEL } from "./version"

// ── Health server ──────────────────────────────────────────────
export function startHealthServer(port?: number): { url: string; stop: () => void } {
  const server = Bun.serve({
    port: port ?? 0,
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === "/health") {
        if (req.method !== "GET") {
          return new Response(JSON.stringify({ error: "method not allowed" }), {
            status: 405,
            headers: { "content-type": "application/json" },
          })
        }
        return new Response(JSON.stringify({ status: "ok" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      return new Response(JSON.stringify({ error: "not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      })
    },
  })
  const hostname = server.hostname === "0.0.0.0" ? "127.0.0.1" : server.hostname
  return { url: `http://${hostname}:${server.port}`, stop: () => server.stop() }
}

// ── Env loader ─────────────────────────────────────────────────
const scriptDir = import.meta.dir
const envPath = `${scriptDir}/../.env`
try {
  const envFile = await Bun.file(envPath).text()
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

async function main() {
  if (arg === "--version" || arg === "-v" || arg === "version") {
    console.log(`deepseek-orcana ${VERSION_LABEL}`)
    return
  }

  if (arg === "tui" || arg === "--tui") {
    const prompt = process.argv.slice(3).join(" ") || undefined
    await startInkTUI(prompt)
    return
  }

  if (arg === "cli" || arg === "--cli") {
    const prompt = process.argv.slice(3).join(" ") || undefined
    await startCLI(prompt)
    if (prompt) process.exit(0)
    return
  }

  if (arg === "list") {
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
    const sessions = new SessionManager()
    const list = sessions.listSessions()
    if (list.length === 0) {
      console.log("没有保存的会话，创建新会话")
    } else {
      await startCLI(undefined, list[0]!.id)
      return
    }
  }

  // 8-char hex → resume by id
  if (/^[a-f0-9]{8,12}$/i.test(arg)) {
    await startCLI(undefined, arg)
    return
  }

  const prompt = process.argv.slice(2).join(" ") || undefined
  await startInkTUI(prompt)
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err)
  const stack = err instanceof Error && err.stack ? `\n${err.stack}` : ""
  console.error(`[deepseek-code] fatal: ${message}${stack}`)
  process.exit(1)
})
