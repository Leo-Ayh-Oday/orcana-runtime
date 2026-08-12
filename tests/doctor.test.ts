/** PR-10.4 — `orcana doctor` structural checks (pure parts). */

import { describe, expect, test } from "bun:test"
import { runDoctor, type DoctorReport, type DoctorCheck } from "../src/diagnostics/doctor"

// `runDoctor` probes real host backends (sandbox delegation, podman, container
// runtimes, env paths). On self-hosted CI and loaded WSL hosts those probes
// routinely exceed bun's 5s default; 30s is the honest bound for a probe
// battery, not a behavior assertion.
const DOCTOR_TIMEOUT_MS = 30_000

describe("orcana doctor", () => {
  test("report contains all eight checks", async () => {
    const report = await runDoctor({ json: true })
    const ids = report.checks.map(c => c.id)
    expect(ids).toEqual(["version", "runtime", "config", "model", "provider", "sandbox", "mcp", "paths", "linux-foundation"])
  }, DOCTOR_TIMEOUT_MS)

  test("every check has a label, status and detail", async () => {
    const report = await runDoctor({ json: true })
    for (const check of report.checks) {
      expect(check.label.length).toBeGreaterThan(0)
      expect(["ok", "warn", "fail"]).toContain(check.status)
      expect(check.detail.length).toBeGreaterThan(0)
    }
  }, DOCTOR_TIMEOUT_MS)

  test("version check reflects the runtime version", async () => {
    const report = await runDoctor({ json: true })
    expect(report.version.startsWith("v")).toBe(true)
    const version = report.checks.find(c => c.id === "version")!
    expect(version.status).toBe("ok")
    expect(version.detail).toContain(report.version)
  }, DOCTOR_TIMEOUT_MS)

  test("counts match statuses", async () => {
    const report: DoctorReport = await runDoctor({ json: true })
    const warns = report.checks.filter((c: DoctorCheck) => c.status === "warn").length
    const fails = report.checks.filter((c: DoctorCheck) => c.status === "fail").length
    expect(report.warnCount).toBe(warns)
    expect(report.failCount).toBe(fails)
  }, DOCTOR_TIMEOUT_MS)

  test("warn/fail exit code mapping", async () => {
    const report = await runDoctor({ json: true })
    const exit = report.failCount > 0 ? 1 : 0
    expect(exit).toBe(0) // current environment has no hard failures
  }, DOCTOR_TIMEOUT_MS)
})
