import { describe, expect, test } from "bun:test"
import {
  requiredCapabilityFailures,
  type ScenarioResult,
} from "../../../evals/linux-sandbox-eval"
import type { LinuxCapabilities } from "../../../src/runtime/linux/contracts"

function capabilities(overrides: Partial<LinuxCapabilities> = {}): LinuxCapabilities {
  return {
    schemaVersion: "1.0",
    platform: "linux",
    architecture: "x64",
    kernelRelease: "test",
    bootId: "test",
    cgroup: {
      version: 2,
      delegated: true,
      delegationSource: "systemd-system",
      controllers: ["cpu", "memory", "pids"],
      supportsKill: true,
      supportsFreeze: true,
      supportsPressure: true,
    },
    namespaces: { user: true, mount: true, pid: true, ipc: true, uts: true, network: true, cgroup: true },
    bubblewrap: { available: true, unprivilegedUsable: true },
    podman: { available: true, rootlessReady: true },
    landlock: { available: false, filesystemRules: false, tcpRules: false, udpRules: false },
    seccomp: { available: true, filterMode: true },
    filesystem: { tmpfs: true, overlayfs: true, fuseOverlayfs: false },
    systemd: { available: true, userManager: true, delegationSupported: true },
    degradationReasons: [],
    ...overrides,
  }
}

function result(id: string, status: ScenarioResult["status"] = "PASS"): ScenarioResult {
  return { id, name: id, status }
}

describe("Linux eval capability-specific CI requirements", () => {
  test("bubblewrap lane rejects capability absence even if the policy scenario passes", () => {
    const caps = capabilities({ bubblewrap: { available: false, unprivilegedUsable: false } })
    expect(requiredCapabilityFailures(caps, [result("LX-012")], ["bubblewrap"]))
      .toContain("bubblewrap: backend unavailable or user namespaces unusable")
  })

  test("podman lane rejects a skipped real-container scenario", () => {
    expect(requiredCapabilityFailures(capabilities(), [result("LX-030", "SKIP")], ["podman"]))
      .toContain("podman: LX-030 real container scenario did not PASS")
  })

  test("cgroup lane requires every enforcement scenario to pass", () => {
    const results = ["LX-016", "LX-017", "LX-018", "LX-019"].map(id => result(id))
    expect(requiredCapabilityFailures(capabilities(), results, ["cgroup"])).toEqual([])
    results[2] = result("LX-018", "SKIP")
    expect(requiredCapabilityFailures(capabilities(), results, ["cgroup"]))
      .toContain("cgroup: LX-018 did not PASS")
  })
})
