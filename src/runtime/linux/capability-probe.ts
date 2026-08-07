/** LNXF-1.0: Linux capability probe (LF-1, plan §7.1).
 *
 *  Real system probing: cgroup v2 + controllers, namespace support (via
 *  /proc and unshare probes), bubblewrap/podman binaries, Landlock LSM,
 *  seccomp, tmpfs/overlayfs, systemd. Every degradation carries an explicit
 *  reason — no numeric scores as scheduling input.
 */

import { platform, arch } from "node:os"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { detectDelegatedRoot } from "./cgroup/delegation"
import type { LinuxCapabilities, NamespaceCapabilities } from "./contracts"

const CGROUP2_MAGIC = "0x63677270"

function bootId(): string {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()
  } catch {
    return "unknown-boot"
  }
}

function kernelRelease(): string {
  try {
    return readFileSync("/proc/sys/kernel/osrelease", "utf8").trim()
  } catch {
    return "unknown"
  }
}

/** cgroup v2 detection: /sys/fs/cgroup must be a cgroup2 fs. */
function probeCgroup(): LinuxCapabilities["cgroup"] {
  const reasons: string[] = []
  const mountPath = "/sys/fs/cgroup"
  const fsType = readFileSync("/proc/filesystems", "utf8")

  let version: 2 | 1 | 0 = 0
  try {
    const stat = readFileSync("/proc/self/mountinfo", "utf8")
    const line = stat.split("\n").find(l => l.includes(mountPath))
    if (line && line.includes("cgroup2")) version = 2
    else if (line && line.includes("cgroup ")) version = 1
  } catch {
    // fallthrough
  }
  if (version === 0 && fsType.includes("cgroup2")) {
    // mounted elsewhere or statically assumed v2 via cgroup.controllers
    if (existsSync("/sys/fs/cgroup/cgroup.controllers")) version = 2
  }

  const controllersRaw = version === 2 && existsSync(`${mountPath}/cgroup.controllers`)
    ? readFileSync(`${mountPath}/cgroup.controllers`, "utf8").trim().split(/\s+/)
    : []
  const controllers = controllersRaw.filter((c): c is "cpu" | "memory" | "pids" | "io" | "cpuset" =>
    c === "cpu" || c === "memory" || c === "pids" || c === "io" || c === "cpuset")

  // Delegation: LNXF-R2 10.1 —— 不再凭 user.slice 目录存在声称委托；
  // 以 detectDelegatedRoot 的真实 7 步探针（enable controllers + 写限额
  // + 进程迁移 + 清理）结果为准（capability-probe 过度声称根因消除）。
  const detected = detectDelegatedRoot()
  const delegated = detected.writable
  const delegationSource: LinuxCapabilities["cgroup"]["delegationSource"] = detected.writable && detected.source !== "none"
    ? detected.source
    : undefined

  if (version === 0) reasons.push("cgroup v2 不可用（无 cgroup2 挂载）")
  if (version === 2 && !delegated) reasons.push("无 cgroup 委托（systemd/容器运行时未委托子树）")
  if (!controllers.includes("memory")) reasons.push("memory 控制器不可用")
  if (!controllers.includes("pids")) reasons.push("pids 控制器不可用")

  return {
    version,
    mountPath: version === 0 ? undefined : mountPath,
    delegated,
    delegationSource,
    controllers,
    supportsKill: version === 2 && delegated,
    supportsFreeze: version === 2 && delegated,
    supportsPressure: version === 2 && controllers.includes("memory"),
  }
}

function probeNamespaces(): NamespaceCapabilities {
  const stats = readFileSync("/proc/self/status", "utf8")
  const line = stats.split("\n").find(l => l.startsWith("NSpid:")) ?? "NSpid:\t1"
  // Presence of an NSpid entry means we are inside at least a pid namespace
  // on modern kernels; per-namespace support via /proc/self/ns files.
  const nsFiles = existsSync("/proc/self/ns") ? readdirSync("/proc/self/ns") : []
  const has = (name: string): boolean => nsFiles.includes(name)
  const ns = {
    user: has("user"),
    mount: has("mnt"),
    pid: has("pid"),
    ipc: has("ipc"),
    uts: has("uts"),
    network: has("net"),
    cgroup: has("cgroup"),
  }
  return ns
}

function which(bin: string): string | undefined {
  const result = spawnSync("which", [bin], { encoding: "utf8", timeout: 5000 })
  const path = result.status === 0 ? result.stdout.trim() : undefined
  return path || undefined
}

function probeBubblewrap(): LinuxCapabilities["bubblewrap"] {
  const path = which("bwrap")
  if (!path) return { available: false, unprivilegedUsable: false }
  const version = spawnSync(path, ["--version"], { encoding: "utf8", timeout: 5000 }).stdout.trim() || undefined
  // unprivilegedUsable: user namespaces must be usable.
  const usernsProbe = spawnSync("unshare", ["--user", "--map-root-user", "true"], { encoding: "utf8", timeout: 5000 })
  const unprivilegedUsable = usernsProbe.status === 0
  return { available: true, path, version, unprivilegedUsable }
}

function probePodman(): LinuxCapabilities["podman"] {
  const path = which("podman")
  if (!path) return { available: false, rootlessReady: false }
  const version = spawnSync(path, ["--version"], { encoding: "utf8", timeout: 5000 }).stdout.trim() || undefined
  const info = spawnSync(path, ["info", "--format", "{{.Store.GraphDriverName}}"], { encoding: "utf8", timeout: 10_000 })
  const storageDriver = info.status === 0 ? info.stdout.trim() || undefined : undefined
  // Rootless readiness: newuidmap/newgidmap or shadow-utils present, and userns usable.
  const rootlessReady = (which("newuidmap") !== undefined || which("uidmap") !== undefined) && unshareProbe()
  return { available: true, path, version, rootlessReady, storageDriver }
}

function unshareProbe(): boolean {
  return spawnSync("unshare", ["--user", "--map-root-user", "true"], { encoding: "utf8", timeout: 5000 }).status === 0
}

function probeLandlock(): LinuxCapabilities["landlock"] {
  let lsm = ""
  try {
    lsm = readFileSync("/sys/kernel/security/lsm", "utf8")
  } catch {
    return { available: false, filesystemRules: false, tcpRules: false, udpRules: false }
  }
  if (!lsm.includes("landlock")) {
    return { available: false, filesystemRules: false, tcpRules: false, udpRules: false }
  }
  // ABI read from kernel headers is not directly visible; treat >=5.13 as
  // filesystem rules capable (ABI 1), >=6.7 for network rules (ABI 4).
  const release = kernelRelease()
  const majorMinor = release.split(".").slice(0, 2).map(Number)
  const [major, minor] = [majorMinor[0] ?? 0, majorMinor[1] ?? 0]
  const abi = major > 5 || (major === 5 && minor >= 13) ? (major > 6 || (major === 6 && minor >= 7) ? 4 : 1) : 0
  return {
    available: abi > 0,
    abi,
    filesystemRules: abi >= 1,
    tcpRules: abi >= 4,
    udpRules: abi >= 4,
  }
}

function probeSeccomp(): LinuxCapabilities["seccomp"] {
  try {
    const status = readFileSync("/proc/self/status", "utf8")
    const seccomp = status.split("\n").find(l => l.startsWith("Seccomp:"))
    const mode = seccomp ? Number(seccomp.split(":")[1]?.trim() ?? 0) : 0
    return { available: mode > 0, filterMode: mode === 2 }
  } catch {
    return { available: false, filterMode: false }
  }
}

function probeFilesystem(): LinuxCapabilities["filesystem"] {
  const mounts = readFileSync("/proc/self/mountinfo", "utf8")
  return {
    tmpfs: mounts.includes(" tmpfs "),
    overlayfs: mounts.includes(" overlay "),
    fuseOverlayfs: mounts.includes("fuse.overlayfs"),
  }
}

function probeSystemd(): LinuxCapabilities["systemd"] {
  const hasSystemctl = which("systemctl") !== undefined
  if (!hasSystemctl) return { available: false, userManager: false, delegationSupported: false }
  const user = spawnSync("systemctl", ["--user", "is-system-running"], { encoding: "utf8", timeout: 5000 })
  const userManager = user.status === 0 || user.stderr.includes("SYSTEMD_BUS")
  // Delegation is available when the session scope exists under user.slice.
  const delegationSupported = existsSync("/sys/fs/cgroup/user.slice")
  return { available: true, userManager, delegationSupported }
}

let cache: LinuxCapabilities | null = null

/** Probe once per process; `refresh: true` forces re-probing. */
export function probeLinuxCapabilities(options: { refresh?: boolean } = {}): LinuxCapabilities {
  if (cache && !options.refresh) return cache
  const degradationReasons: string[] = []

  const cgroup = probeCgroup()
  const namespaces = probeNamespaces()
  const bubblewrap = probeBubblewrap()
  const podman = probePodman()
  const landlock = probeLandlock()
  const seccomp = probeSeccomp()
  const filesystem = probeFilesystem()
  const systemd = probeSystemd()

  if (!bubblewrap.available) degradationReasons.push("bubblewrap 不可用")
  else if (!bubblewrap.unprivilegedUsable) degradationReasons.push("bubblewrap 无法使用非特权用户命名空间")
  if (!podman.available) degradationReasons.push("podman 不可用")
  else if (!podman.rootlessReady) degradationReasons.push("podman rootless 预检未通过")
  if (!landlock.available) degradationReasons.push("Landlock LSM 未启用")
  if (cgroup.version === 0) degradationReasons.push("cgroup v2 不可用")
  if (!cgroup.delegated) degradationReasons.push("cgroup 未委托")

  const caps: LinuxCapabilities = {
    schemaVersion: "1.0",
    platform: "linux",
    architecture: arch(),
    kernelRelease: kernelRelease(),
    bootId: bootId(),
    cgroup,
    namespaces,
    bubblewrap,
    podman,
    landlock,
    seccomp,
    filesystem,
    systemd,
    degradationReasons,
  }
  cache = caps
  return caps
}

/** Stable hash of the capability set (excludes bootId — it changes per boot). */
export function capabilitiesDigest(caps: LinuxCapabilities): string {
  const { bootId: _boot, ...stable } = caps
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex").slice(0, 16)
}

/** Non-linux platforms: no foundation (Windows keeps legacy paths). */
export function requireLinuxPlatform(): LinuxCapabilities {
  if (platform() !== "linux") {
    throw new Error("LINUX_PLATFORM_REQUIRED: Linux execution foundation requires a Linux platform")
  }
  return probeLinuxCapabilities()
}
