/** LNXF-1.0: Landlock + seccomp (LF-7, plan §19).
 *
 *  Landlock/seccomp are combinable mechanisms, not standalone sandboxes —
 *  they harden Bubblewrap/Podman. First version: probing + interface;
 *  conservative rulesets for inspect/untrusted; ruleset changes require
 *  compatibility tests (no shared seccomp list across languages).
 */

import type { LinuxCapabilities } from "./contracts"

// ── Landlock ──

export interface LandlockRuleset {
  /** ABI 级别的可用规则类型。 */
  abi: number
  filesystem?: {
    /** 允许读的路径（含子路径）。 */
    readable: string[]
    /** 允许写的路径。 */
    writable: string[]
    /** 禁止执行。 */
    noExec: string[]
  }
  network?: {
    /** TCP connect 允许（ABI 4+）。 */
    tcpConnect: string[]
    udpConnect: string[]
  }
}

/** 为某 profile 编译 Landlock 规则（叠加在命名空间隔离之上）。 */
export function compileLandlockRuleset(caps: LinuxCapabilities, profile: string, worktreeRoot?: string): LandlockRuleset {
  const abi = caps.landlock.abi ?? 0
  const ruleset: LandlockRuleset = { abi }
  if (abi >= 1) {
    ruleset.filesystem = {
      readable: ["/usr", "/bin", "/lib", "/lib64", "/etc/ssl/certs", "/workspace", "/tmp"],
      writable: profile === "inspect" ? [] : ["/workspace", "/tmp"],
      noExec: ["/home"],
    }
  }
  if (abi >= 4) {
    ruleset.network = { tcpConnect: [], udpConnect: [] }
  }
  return ruleset
}

/** Landlock 不可用时正确降级（记录原因，不失败）。 */
export function landlockUsable(caps: LinuxCapabilities): { ok: boolean; reason?: string } {
  if (!caps.landlock.available) return { ok: false, reason: "Landlock LSM 未启用" }
  if (!caps.landlock.filesystemRules) return { ok: false, reason: "Landlock ABI 不支持文件系统规则" }
  return { ok: true }
}

// ── seccomp ──

/** seccomp profile：允许的系统调用面（保守子集 + 白名单语言运行时）。 */
export interface SeccompProfile {
  defaultAction: "SCMP_ACT_ERRNO" | "SCMP_ACT_ALLOW"
  allowSyscalls: readonly string[]
  /** 明确拒绝的危险调用（即使允许列表包含）。 */
  denySyscalls: readonly string[]
  /** 目标语言运行时（不同语言不同白名单 —— 不共享列表）。 */
  target?: string
}

const BASE_SYSCALLS = [
  "read", "write", "close", "fstat", "lseek", "mmap", "mprotect", "munmap",
  "brk", "access", "openat", "readlink", "readlinkat", "exit", "exit_group",
  "getpid", "gettid", "getuid", "getgid", "geteuid", "getegid", "arch_prctl",
  "rt_sigaction", "rt_sigprocmask", "rt_sigreturn", "clock_gettime",
  "getrandom", "clone", "execve", "wait4", "futex", "pipe", "pipe2",
  "dup", "dup2", "dup3", "fcntl", "ioctl", "stat", "lstat", "newfstatat",
  "getdents64", "readv", "writev", "pread64", "pwrite64", "sendfile",
]

const DENY_SYSCALLS = [
  "ptrace", "kexec_load", "reboot", "mount", "umount2", "pivot_root",
  "setns", "unshare", "bpf", "perf_event_open", "userfaultfd",
]

/** 保守规则（inspect/untrusted）。 */
export function compileSeccompProfile(target: "inspect" | "untrusted" | "node" | "bun" | "generic"): SeccompProfile {
  const base = new Set(BASE_SYSCALLS)
  if (target === "node" || target === "bun") {
    // 运行时需要更多面：net/socket/epoll/eventfd。
    base.add("socket").add("connect").add("bind").add("listen").add("accept4")
    base.add("epoll_create1").add("epoll_ctl").add("epoll_wait").add("eventfd2").add("timerfd_create").add("timerfd_settime")
    base.add("getsockname").add("getsockopt").add("setsockopt").add("shutdown")
    base.add("writefile").add("readfile") // js 内部虚拟调用（忽略）
  }
  return {
    defaultAction: "SCMP_ACT_ERRNO",
    allowSyscalls: [...base].filter(s => s !== "writefile" && s !== "readfile"),
    denySyscalls: [...DENY_SYSCALLS],
    target,
  }
}

/** 规则变更兼容性：新 profile 必须包含旧 profile 的允许面（或显式移除）。 */
export function seccompBackwardCompatible(oldProfile: SeccompProfile, newProfile: SeccompProfile): boolean {
  const oldSet = new Set(oldProfile.allowSyscalls)
  const removed = oldProfile.allowSyscalls.filter(s => !newProfile.allowSyscalls.includes(s))
  return removed.length === 0 || removed.every(s => newProfile.denySyscalls.includes(s))
}
