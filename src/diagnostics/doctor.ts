/** PR-10.4 — `orcana doctor`: local environment self-check.
 *
 *  Checks: version consistency, runtime, config integrity, model/auth
 *  configuration, provider reachability (static/local probes — never a
 *  billed model request), sandbox capability matrix, and MCP server status.
 *
 *  `--json` emits the structured DoctorReport; default is human-readable.
 */

import { existsSync } from "node:fs"
import { platform } from "node:os"
import { join } from "node:path"
import { homedir } from "node:os"
import { VERSION } from "../version"
import { loadConfig, readGlobalConfig, listProviderIds } from "../config/config-loader"
import { globalConfigPath } from "../config/paths"
import { diagnoseModelConfiguration } from "../config/diagnostics"
import { detectCapabilities } from "../sandbox/capability"
import { probeLinuxCapabilities, capabilitiesDigest } from "../runtime/linux/capability-probe"
import { loadMCPConfig, getEnabledServers, validateServerConfig } from "../mcp/config"
import type { ProviderConfig } from "../config/config-schema"

export type CheckStatus = "ok" | "warn" | "fail"

export interface DoctorCheck {
  id: string
  label: string
  status: CheckStatus
  detail: string
}

export interface DoctorReport {
  version: string
  checks: DoctorCheck[]
  /** 0 = all ok; >0 warn/fail counts for exit-code mapping. */
  warnCount: number
  failCount: number
}

// ── Probes ──

const LOCAL_PROVIDER_PORTS: Record<string, number> = {
  ollama: 11434,
  lmstudio: 1234,
}

async function probeUrl(url: string, timeoutMs = 4000): Promise<"reachable" | "unreachable" | "skipped"> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      // Any HTTP response (even 401/403/500) proves the endpoint is alive —
      // only a connection failure means unreachable.
      await fetch(url, { method: "GET", signal: controller.signal, headers: { "accept": "application/json" } })
      return "reachable"
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return "unreachable"
  }
}

// ── Checks ──

async function checkVersionConsistency(): Promise<DoctorCheck> {
  // VERSION is read from the installed package.json at runtime.
  const label = `v${VERSION}`
  return {
    id: "version",
    label: "版本一致性",
    status: "ok",
    detail: `orcana-runtime ${label} (runtime resolved)`,
  }
}

function checkRuntime(): DoctorCheck {
  const nodeMajor = Number(process.versions.node.split(".")[0] ?? 0)
  const nodeOk = nodeMajor >= 20
  const bun = typeof process.versions.bun === "string"
  const sessionStore = bun ? "SQLite/FTS available" : "JSON fallback (SQLite/FTS needs Bun)"
  return {
    id: "runtime",
    label: "运行时",
    status: nodeOk ? "ok" : "fail",
    detail: `Node.js ${process.versions.node}${nodeOk ? "" : " (需要 >=20)"} | Bun ${process.versions.bun ?? "未安装"} | ${sessionStore}`,
  }
}

function checkConfigIntegrity(): DoctorCheck {
  const path = globalConfigPath()
  if (!existsSync(path)) {
    return { id: "config", label: "配置文件", status: "warn", detail: `未找到全局配置 ${path}（将使用默认值）` }
  }
  try {
    const parsed = readGlobalConfig(path)
    if (!parsed) {
      return { id: "config", label: "配置文件", status: "fail", detail: `${path} 存在但解析失败（JSONC 无效）` }
    }
    return { id: "config", label: "配置文件", status: "ok", detail: `${path} 解析正常` }
  } catch (error) {
    return { id: "config", label: "配置文件", status: "fail", detail: `${path} 读取失败: ${error instanceof Error ? error.message : String(error)}` }
  }
}

async function checkModelAuth(): Promise<DoctorCheck> {
  try {
    const model = await diagnoseModelConfiguration()
    const status: CheckStatus = model.auth === "missing" ? "warn" : "ok"
    const authLabel = model.auth === "auth-store" ? "auth.json" : model.auth === "environment" ? "环境变量" : model.auth === "local" ? "本地服务（无需 key）" : "缺失"
    return { id: "model", label: "模型 / 凭据", status, detail: `模型 ${model.providerId}/${model.modelId} | 凭据来源: ${authLabel}` }
  } catch (error) {
    return { id: "model", label: "模型 / 凭据", status: "fail", detail: `诊断失败: ${error instanceof Error ? error.message : String(error)}` }
  }
}

async function checkProviderReachability(): Promise<DoctorCheck> {
  const config = loadConfig({ applyEnv: false })
  const providers = listProviderIds(config)
  if (providers.length === 0) {
    return { id: "provider", label: "Provider 连通性", status: "warn", detail: "未配置 provider" }
  }
  // Probes run concurrently (worst case = one timeout, not n × timeout).
  const probed = await Promise.all(
    providers.map(async id => {
      const provider: ProviderConfig | undefined = config.providers?.[id]
      const type = provider?.type ?? "deepseek"
      const baseUrl = provider?.baseUrl
      if (type === "ollama" || type === "lmstudio") {
        const port = LOCAL_PROVIDER_PORTS[type]
        const reachable = (await probeUrl(`http://127.0.0.1:${port}`)) === "reachable"
        return { id, text: reachable ? `${id}: 本地服务可达` : `${id}: 本地服务不可达 (127.0.0.1:${port})`, failed: !reachable }
      }
      if (!baseUrl) return { id, text: `${id}: 未配置 baseUrl`, failed: false }
      const reachable = (await probeUrl(baseUrl)) === "reachable"
      return { id, text: reachable ? `${id}: 端点可达 (${baseUrl})` : `${id}: 端点不可达 (${baseUrl})`, failed: !reachable }
    }),
  )
  const failed = probed.filter(p => p.failed).length
  return {
    id: "provider",
    label: "Provider 连通性",
    status: failed === 0 ? "ok" : "warn",
    detail: probed.map(p => p.text).join(" | "),
  }
}

function checkSandbox(): DoctorCheck {
  const cap = detectCapabilities()
  const summary = cap.features.map(f => `${f.name}:${f.tier}`).join(" | ")
  const status: CheckStatus = cap.overallRating >= 6 ? "ok" : cap.overallRating >= 3 ? "warn" : "fail"
  return {
    id: "sandbox",
    label: "沙箱能力",
    status,
    detail: `${cap.osName} (${cap.platform}/${cap.arch}) 评分 ${cap.overallRating}/10 — ${summary}`,
  }
}

function checkMcp(): DoctorCheck {
  const config = loadMCPConfig()
  const servers = getEnabledServers(config)
  const all = Object.entries(config.servers ?? {})
  if (all.length === 0) {
    return { id: "mcp", label: "MCP 状态", status: "ok", detail: "未配置 MCP 服务器" }
  }
  const parts: string[] = []
  let failed = 0
  for (const [name, server] of all) {
    const validation = validateServerConfig(server)
    const enabled = server.enabled !== false
    if (validation) { parts.push(`${name}: 配置无效 (${validation})`); failed++ }
    else if (!enabled) parts.push(`${name}: 已禁用`)
    else if (servers.some(s => s.name === name)) parts.push(`${name}: 启用`)
    else { parts.push(`${name}: 启用但不在启动列表`); failed++ }
  }
  return {
    id: "mcp",
    label: "MCP 状态",
    status: failed === 0 ? "ok" : "warn",
    detail: parts.join(" | "),
  }
}

function checkPaths(): DoctorCheck {
  const dirs = [
    { name: "配置目录", path: join(homedir(), ".orcana") },
    { name: "会话目录", path: join(homedir(), ".orcana", "sessions") },
    { name: "工作流目录", path: join(homedir(), ".orcana", "workflow") },
  ]
  const missing = dirs.filter(d => !existsSync(d.path))
  return {
    id: "paths",
    label: "目录结构",
    status: missing.length === 0 ? "ok" : "warn",
    detail: missing.length === 0
      ? dirs.map(d => d.name).join(" / ") + " 就绪"
      : `缺失: ${missing.map(d => d.name).join(", ")}（首次运行将自动创建）`,
  }
}

// ── Linux Foundation check (LNXF LF-1) ──

function checkLinuxFoundation(): DoctorCheck {
  if (platform() !== "linux") {
    return { id: "linux-foundation", label: "Linux 执行底座", status: "warn", detail: "非 Linux 平台 —— 底座未启用（Windows 沿用既有路径）" }
  }
  const caps = probeLinuxCapabilities()
  const parts: string[] = []
  parts.push(`cgroup v2 ${caps.cgroup.version === 2 ? "✓" : "✗"}${caps.cgroup.delegated ? "（已委托）" : "（未委托）"}`)
  parts.push(`bubblewrap ${caps.bubblewrap.available ? (caps.bubblewrap.unprivilegedUsable ? "✓" : "✗ 无用户命名空间") : "✗"}`)
  parts.push(`podman ${caps.podman.available ? (caps.podman.rootlessReady ? "✓" : "✗ rootless 未就绪") : "✗"}`)
  parts.push(`Landlock ${caps.landlock.available ? `✓ ABI ${caps.landlock.abi}` : "✗"}`)
  parts.push(`seccomp ${caps.seccomp.available ? "✓" : "✗"}`)
  parts.push(`capability digest ${capabilitiesDigest(caps)}`)
  const degraded = caps.degradationReasons.length > 0
  return {
    id: "linux-foundation",
    label: "Linux 执行底座能力",
    status: degraded ? "warn" : "ok",
    detail: parts.join("；") + (degraded ? `；降级原因：${caps.degradationReasons.join("；")}` : ""),
  }
}

// ── Entry ──

export async function runDoctor(options: { json?: boolean } = {}): Promise<DoctorReport> {
  const checks = await Promise.all([
    Promise.resolve(checkVersionConsistency()),
    Promise.resolve(checkRuntime()),
    Promise.resolve(checkConfigIntegrity()),
    checkModelAuth(),
    checkProviderReachability(),
    Promise.resolve(checkSandbox()),
    Promise.resolve(checkMcp()),
    Promise.resolve(checkPaths()),
    Promise.resolve(checkLinuxFoundation()),
  ])
  const warnCount = checks.filter(c => c.status === "warn").length
  const failCount = checks.filter(c => c.status === "fail").length
  const report: DoctorReport = { version: `v${VERSION}`, checks, warnCount, failCount }

  if (options.json) {
    console.log(JSON.stringify(report, null, 2))
    return report
  }

  console.log(`Orcana doctor — orcana-runtime ${report.version}`)
  console.log("─".repeat(48))
  for (const check of report.checks) {
    const mark = check.status === "ok" ? "ok" : check.status === "warn" ? "!" : "x"
    console.log(` [${mark}] ${check.label}`)
    console.log(`       ${check.detail}`)
  }
  console.log("─".repeat(48))
  console.log(`${report.failCount} fail, ${report.warnCount} warn${report.failCount + report.warnCount === 0 ? " — 环境就绪" : ""}`)
  return report
}

// ── CLI (kept out of the TUI/CLI entry so it can be called from src/index.ts) ──

export function isDoctorCli(): boolean {
  return process.argv.includes("doctor")
}

export async function doctorCli(): Promise<number> {
  const json = process.argv.includes("--json")
  const report = await runDoctor({ json })
  return report.failCount > 0 ? 1 : 0
}

void platform
