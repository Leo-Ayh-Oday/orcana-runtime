/** Tests for SandboxCapability — PR-5.5 OS detection and banner formatting. */
import { describe, expect, test } from "bun:test"
import {
  detectCapabilities,
  formatCapabilityBanner,
  formatCapabilitySummary,
  type OSCapabilityMatrix,
  type SandboxFeature,
} from "../src/sandbox/capability"

// ── Detection ──

describe("detectCapabilities", () => {
  test("returns a valid capability matrix for current OS", () => {
    const cap = detectCapabilities()

    expect(cap.platform).toBeDefined()
    expect(cap.arch).toBeDefined()
    expect(cap.osName).toBeDefined()
    expect(cap.osName.length).toBeGreaterThan(0)
    expect(cap.features.length).toBe(6)
    expect(cap.overallRating).toBeGreaterThanOrEqual(0)
    expect(cap.overallRating).toBeLessThanOrEqual(10)
  })

  test("all features have valid tiers", () => {
    const cap = detectCapabilities()
    for (const f of cap.features) {
      expect(["full", "partial", "none"]).toContain(f.tier)
      expect(f.name.length).toBeGreaterThan(0)
      expect(f.description.length).toBeGreaterThan(0)
    }
  })

  test("has exactly 6 features", () => {
    const cap = detectCapabilities()
    const names = cap.features.map(f => f.name)
    expect(names.length).toBe(6)
    // All expected features present
    expect(names.some(n => n.includes("进程隔离"))).toBe(true)
    expect(names.some(n => n.includes("文件守护"))).toBe(true)
    expect(names.some(n => n.includes("网络隔离"))).toBe(true)
    expect(names.some(n => n.includes("环境变量过滤"))).toBe(true)
    expect(names.some(n => n.includes("超时保护"))).toBe(true)
    expect(names.some(n => n.includes("路径守卫"))).toBe(true)
  })

  test("env filtering and timeout guard are always full tier", () => {
    const cap = detectCapabilities()
    const envFilter = cap.features.find(f => f.name.includes("环境变量过滤"))!
    expect(envFilter.tier).toBe("full")
    const timeout = cap.features.find(f => f.name.includes("超时保护"))!
    expect(timeout.tier).toBe("full")
  })

  test("file guard is always full tier", () => {
    const cap = detectCapabilities()
    const fileGuard = cap.features.find(f => f.name.includes("文件守护"))!
    expect(fileGuard.tier).toBe("full")
  })

  test("overall rating is computed correctly", () => {
    // full=2, partial=1, none=0 → scaled to 0-10
    const cap = detectCapabilities()
    const score = cap.features.reduce((s, f) => {
      switch (f.tier) {
        case "full": return s + 2
        case "partial": return s + 1
        case "none": return s + 0
      }
    }, 0)
    expect(cap.overallRating).toBe(Math.round((score / 12) * 10))
  })
})

// ── Banner formatting ──

describe("formatCapabilityBanner", () => {
  test("includes OS name", () => {
    const cap = detectCapabilities()
    const banner = formatCapabilityBanner(cap)
    expect(banner).toContain("Sandbox 能力矩阵")
    expect(banner).toContain(cap.osName)
  })

  test("includes all 6 features", () => {
    const cap = detectCapabilities()
    const banner = formatCapabilityBanner(cap)
    for (const f of cap.features) {
      expect(banner).toContain(f.name)
    }
  })

  test("includes overall rating", () => {
    const cap = detectCapabilities()
    const banner = formatCapabilityBanner(cap)
    expect(banner).toContain("综合评分")
    expect(banner).toContain(String(cap.overallRating))
  })

  test("uses ANSI formatting codes", () => {
    const cap = detectCapabilities()
    const banner = formatCapabilityBanner(cap)
    // Should contain ANSI escape codes
    expect(banner).toContain("\x1b[")
  })
})

// ── Summary formatting ──

describe("formatCapabilitySummary", () => {
  test("compact summary is one line", () => {
    const cap = detectCapabilities()
    const summary = formatCapabilitySummary(cap)
    expect(summary).toContain("[sandbox:")
    expect(summary).toContain(String(cap.overallRating))
    // Should not contain newlines
    expect(summary).not.toContain("\n")
  })

  test("includes feature icons", () => {
    const cap = detectCapabilities()
    const summary = formatCapabilitySummary(cap)
    // Each feature shows as +name or ~name or -name
    // Strip ANSI codes for pattern matching
    const stripped = summary.replace(/\x1b\[[\d;]*m/g, "")
    expect(stripped).toMatch(/[+~-]\S+/)
    // Verify at least 3 feature icons present
    const icons = stripped.match(/[+~-]\S+/g) ?? []
    expect(icons.length).toBeGreaterThanOrEqual(3)
  })
})
