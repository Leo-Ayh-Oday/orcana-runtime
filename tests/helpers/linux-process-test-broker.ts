import { platform } from "node:os"
import { createLinuxBroker } from "../../src/runtime/linux/broker"
import type { LinuxCapabilities } from "../../src/runtime/linux/contracts"
import { setLinuxProcessBrokerForTests } from "../../src/runtime/process-executor"

export const HOST_AUDIT_TEST_CAPABILITIES: LinuxCapabilities = {
  schemaVersion: "1.0",
  platform: "linux",
  architecture: "test",
  kernelRelease: "test",
  bootId: "test",
  cgroup: {
    version: 2,
    delegated: false,
    controllers: [],
    supportsKill: false,
    supportsFreeze: false,
    supportsPressure: false,
  },
  namespaces: { user: false, mount: false, pid: false, ipc: false, uts: false, network: false, cgroup: false },
  bubblewrap: { available: false, unprivilegedUsable: false },
  podman: { available: false, rootlessReady: false },
  landlock: { available: false, filesystemRules: false, tcpRules: false, udpRules: false },
  seccomp: { available: false, filterMode: false },
  filesystem: { tmpfs: true, overlayfs: false, fuseOverlayfs: false },
  systemd: { available: false, userManager: false, delegationSupported: false },
  degradationReasons: ["test fixture: optional isolation backends disabled"],
}

export function installHostAuditProcessBroker(): void {
  if (platform() !== "linux") return
  setLinuxProcessBrokerForTests(createLinuxBroker({
    mode: "enabled",
    testCapabilities: HOST_AUDIT_TEST_CAPABILITIES,
  }))
}

export function resetProcessBroker(): void {
  if (platform() !== "linux") return
  setLinuxProcessBrokerForTests(null)
}
