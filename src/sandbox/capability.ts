/** SandboxCapability — OS capability detection and startup banner.
 *
 *  PR-5.5: Detects the current OS and returns a capability matrix showing
 *  which sandbox features are available, degraded, or unavailable.
 *
 *  The capability banner is printed at startup so users know exactly what
 *  protection level they have. No false promises — every degradation is
 *  explicitly documented.
 *
 *  Capability tiers:
 *    - full:    fully available and active
 *    - partial: available with limitations
 *    - none:    not available on this platform
 */

import { platform, arch, cpus, totalmem } from "node:os"

// ── Types ──

export type CapabilityTier = "full" | "partial" | "none"

export interface SandboxFeature {
  name: string
  tier: CapabilityTier
  description: string
  /** Why the tier is what it is. */
  note?: string
}

export interface OSCapabilityMatrix {
  platform: NodeJS.Platform
  arch: string
  /** Human-readable OS name. */
  osName: string
  features: SandboxFeature[]
  /** Overall sandbox rating: 0-10. */
  overallRating: number
}

// ── Feature detection ──

function detectProcessIsolation(): SandboxFeature {
  switch (platform()) {
    case "win32":
      return {
        name: "进程隔离 (Job Object)",
        tier: "full",
        description: "Windows Job Object 提供进程树强杀保证，子进程不会逃逸",
      }
    case "linux":
      return {
        name: "进程隔离 (cgroups)",
        tier: "partial",
        description: "Linux cgroups 可限制资源，但需适当权限且未默认集成",
        note: "当前未启用 cgroups v2 集成，进程树通过 SIGKILL 清理",
      }
    case "darwin":
      return {
        name: "进程隔离",
        tier: "none",
        description: "macOS 无内核级 Job Object 等价物",
        note: "子进程通过 SIGKILL 尽力清理，但无法保证进程树完整性",
      }
    default:
      return {
        name: "进程隔离",
        tier: "none",
        description: `平台 ${platform()} 不支持进程隔离`,
      }
  }
}

function detectFileGuard(): SandboxFeature {
  // PathGuard works on all platforms (pure Node.js fs)
  return {
    name: "文件守护 (PathGuard)",
    tier: "full",
    description: "基于 Node.js fs 的执行前后文件快照对比，检测非预期文件变更",
    note: "事后检测，非实时拦截。可与 PatchTransaction 组合使用",
  }
}

function detectNetworkIsolation(): SandboxFeature {
  switch (platform()) {
    case "win32":
      return {
        name: "网络隔离",
        tier: "none",
        description: "Windows 网络隔离需管理员权限配置防火墙规则",
        note: "当前未集成 Windows Filtering Platform (WFP)。依赖工具级权限门控",
      }
    case "linux":
      return {
        name: "网络隔离 (network namespaces)",
        tier: "none",
        description: "Linux network namespace 需 root 或 CAP_NET_ADMIN",
        note: "当前未集成。依赖工具级权限门控",
      }
    case "darwin":
      return {
        name: "网络隔离",
        tier: "none",
        description: "macOS 应用沙箱需要 entitlements 签名",
        note: "当前未集成。依赖工具级权限门控",
      }
    default:
      return {
        name: "网络隔离",
        tier: "none",
        description: "当前未集成网络隔离",
      }
  }
}

function detectEnvFiltering(): SandboxFeature {
  return {
    name: "环境变量过滤",
    tier: "full",
    description: "Shell 子进程仅继承白名单环境变量，防止 token/secret 泄露",
  }
}

function detectTimeoutGuard(): SandboxFeature {
  return {
    name: "执行超时保护",
    tier: "full",
    description: "所有 shell 命令有硬超时上限（默认 120s），防止失控进程",
  }
}

function detectPathGuard(): SandboxFeature {
  return {
    name: "路径守卫",
    tier: "full",
    description: "阻止 shell 写入 Ripple 拦截的文件和项目外路径",
    note: "基于命令文本模式匹配，非系统调用拦截",
  }
}

// ── Main API ──

/**
 * Detect the current OS sandbox capability matrix.
 */
export function detectCapabilities(): OSCapabilityMatrix {
  const features = [
    detectProcessIsolation(),
    detectFileGuard(),
    detectNetworkIsolation(),
    detectEnvFiltering(),
    detectTimeoutGuard(),
    detectPathGuard(),
  ]

  // Overall rating: each "full" = 2 pts, "partial" = 1 pt, "none" = 0
  // Max possible: 6 features × 2 = 12, normalized to 0-10
  const rawScore = features.reduce((sum, f) => {
    switch (f.tier) {
      case "full": return sum + 2
      case "partial": return sum + 1
      case "none": return sum + 0
    }
  }, 0)
  const overallRating = Math.round((rawScore / 12) * 10)

  return {
    platform: platform(),
    arch: arch(),
    osName: formatOSName(),
    features,
    overallRating,
  }
}

function formatOSName(): string {
  const p = platform()
  switch (p) {
    case "win32": return `Windows ${arch()}`
    case "linux": return `Linux ${arch()}`
    case "darwin": return `macOS ${arch()}`
    default: return `${p} ${arch()}`
  }
}

// ── Banner formatting ──

/**
 * Format the capability matrix as a startup banner.
 * Printed once at agent initialization.
 */
export function formatCapabilityBanner(cap: OSCapabilityMatrix): string {
  const bold = (s: string) => `\x1b[1m${s}\x1b[0m`
  const green = (s: string) => `\x1b[1;32m${s}\x1b[0m`
  const yellow = (s: string) => `\x1b[1;33m${s}\x1b[0m`
  const red = (s: string) => `\x1b[1;31m${s}\x1b[0m`
  const dim = (s: string) => `\x1b[2m${s}\x1b[0m`

  function tierIcon(t: CapabilityTier): string {
    switch (t) {
      case "full": return green("●")
      case "partial": return yellow("◐")
      case "none": return red("○")
    }
  }

  function tierLabel(t: CapabilityTier): string {
    switch (t) {
      case "full": return green("可用")
      case "partial": return yellow("部分")
      case "none": return red("不可用")
    }
  }

  const lines: string[] = [
    "",
    bold(`  ══ Sandbox 能力矩阵: ${cap.osName} ══`),
    "",
  ]

  for (const f of cap.features) {
    lines.push(`  ${tierIcon(f.tier)} ${f.name}  ${tierLabel(f.tier)}`)
    lines.push(`    ${dim(f.description)}`)
    if (f.note) {
      lines.push(`    ${dim(`⚠ ${f.note}`)}`)
    }
  }

  lines.push("")
  lines.push(`  ${dim(`综合评分: ${cap.overallRating}/10`)}`)
  lines.push("")

  return lines.join("\n")
}

/**
 * Compact one-line capability summary for inline use.
 */
export function formatCapabilitySummary(cap: OSCapabilityMatrix): string {
  const dim = (s: string) => `\x1b[2m${s}\x1b[0m`
  const parts = cap.features.map(f => {
    const icon = f.tier === "full" ? "+" : f.tier === "partial" ? "~" : "-"
    return `${icon}${f.name.split(" ")[0]}`
  })
  return dim(`[sandbox: ${parts.join(" ")} | ${cap.overallRating}/10]`)
}

/**
 * Generate the capability banner for the current OS.
 */
export function getCapabilityBanner(): string {
  return formatCapabilityBanner(detectCapabilities())
}
