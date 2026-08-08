/** LR2-4（P4-A）：seccomp Profile 体系。
 *
 *  Profile 维度（计划 §8.2）：runtimeFamily + toolKind + sandboxProfile
 *  + architecture —— 维度键稳定，Profile 演进可寻址。
 *
 *  首批 6 个：node-bun-readonly / node-bun-build / python-readonly / git /
 *  compiler / unknown-deny（unknown-deny 默认拒绝一切未分类 syscall）。
 *
 *  演进流程（SECCOMP_AUTO_PROMOTION = 0）：观察只生成候选，不允许自动
 *  晋升 —— observe → candidate → compatibility replay → security replay
 *  → canary → enforce（每一步人工/评测确认）。
 */

import type { SeccompProfile } from "../landlock-seccomp"

export type SeccompRuntimeFamily = "node-bun" | "python" | "generic"
export type SeccompToolKind = "readonly" | "build" | "test" | "git" | "compiler" | "unknown"
export type SeccompSandboxProfile = "strict" | "standard"
export type SeccompArchitecture = "x86_64" | "aarch64"

export interface SeccompProfileKey {
  runtimeFamily: SeccompRuntimeFamily
  toolKind: SeccompToolKind
  sandboxProfile: SeccompSandboxProfile
  architecture: SeccompArchitecture
}

/** 演进阶段（观察不得自动晋升）。 */
export type SeccompEvolutionStage =
  | "observe"
  | "candidate"
  | "compatibility-replay"
  | "security-replay"
  | "canary"
  | "enforce"

export const EVOLUTION_ORDER: readonly SeccompEvolutionStage[] = [
  "observe", "candidate", "compatibility-replay", "security-replay", "canary", "enforce",
]

/** 允许的晋升：只前进一格，且不能跳过（无自动晋升 —— 每格需确认）。 */
export function canAdvanceStage(from: SeccompEvolutionStage, to: SeccompEvolutionStage): boolean {
  const fromIdx = EVOLUTION_ORDER.indexOf(from)
  const toIdx = EVOLUTION_ORDER.indexOf(to)
  return fromIdx >= 0 && toIdx === fromIdx + 1
}

/** 维度键的稳定字符串（Profile 寻址）。 */
export function seccompProfileKeyOf(key: SeccompProfileKey): string {
  return [key.runtimeFamily, key.toolKind, key.sandboxProfile, key.architecture].join(":")
}

/** 首批 6 个 Profile（unknown-deny 默认拒绝）。 */
export const FIRST_BATCH_PROFILES: ReadonlyArray<{ key: SeccompProfileKey; profile: SeccompProfile }> = [
  {
    key: { runtimeFamily: "node-bun", toolKind: "readonly", sandboxProfile: "strict", architecture: "x86_64" },
    profile: { defaultAction: "SCMP_ACT_ERRNO" as const, allowSyscalls: ["rt_sigreturn", "clone", "getcwd", "chdir", "faccessat", "faccessat2", "readlinkat", "read", "write", "openat", "close", "fstat", "lseek", "readlink", "getdents64", "mmap", "munmap", "mprotect", "brk", "access", "newfstatat", "exit", "exit_group", "rt_sigaction", "rt_sigprocmask", "ioctl", "writev", "readv", "pread64", "pwrite64", "futex", "clock_gettime", "getrandom", "prlimit64", "rseq", "sched_getaffinity", "getpid", "gettid", "tgkill", "arch_prctl", "set_tid_address", "set_robust_list", "execve", "execveat"], denySyscalls: [] },
  },
  {
    key: { runtimeFamily: "node-bun", toolKind: "build", sandboxProfile: "strict", architecture: "x86_64" },
    profile: { defaultAction: "SCMP_ACT_ERRNO" as const, allowSyscalls: ["rt_sigreturn", "clone", "getcwd", "chdir", "faccessat", "faccessat2", "readlinkat", "read", "write", "openat", "close", "fstat", "lseek", "readlink", "getdents64", "mmap", "munmap", "mprotect", "brk", "access", "newfstatat", "exit", "exit_group", "rt_sigaction", "rt_sigprocmask", "ioctl", "writev", "readv", "pread64", "pwrite64", "futex", "clock_gettime", "getrandom", "prlimit64", "rseq", "sched_getaffinity", "getpid", "gettid", "tgkill", "arch_prctl", "set_tid_address", "set_robust_list", "execve", "execveat", "clone3", "wait4", "waitid", "kill", "dup", "dup2", "dup3", "pipe", "pipe2", "fcntl", "statfs", "fstatfs", "mkdir", "mkdirat", "unlink", "unlinkat", "rename", "renameat", "renameat2", "chmod", "fchmod", "fchmodat", "utimensat", "truncate", "ftruncate", "linkat", "symlinkat", "socket", "connect", "sendto", "recvfrom", "sendmsg", "recvmsg", "bind", "getsockname", "getpeername", "setsockopt", "getsockopt", "poll", "ppoll", "epoll_create1", "epoll_ctl", "epoll_wait", "eventfd2", "timerfd_create", "timerfd_settime", "clock_nanosleep", "nanosleep", "sched_yield"], denySyscalls: [] },
  },
  {
    key: { runtimeFamily: "python", toolKind: "readonly", sandboxProfile: "strict", architecture: "x86_64" },
    profile: { defaultAction: "SCMP_ACT_ERRNO" as const, allowSyscalls: ["rt_sigreturn", "clone", "getcwd", "chdir", "faccessat", "faccessat2", "readlinkat", "read", "write", "openat", "close", "fstat", "lseek", "readlink", "getdents64", "mmap", "munmap", "mprotect", "brk", "access", "newfstatat", "exit", "exit_group", "rt_sigaction", "rt_sigprocmask", "ioctl", "writev", "readv", "pread64", "pwrite64", "futex", "clock_gettime", "getrandom", "prlimit64", "rseq", "sched_getaffinity", "getpid", "gettid", "tgkill", "arch_prctl", "set_tid_address", "set_robust_list", "execve", "execveat"], denySyscalls: [] },
  },
  {
    key: { runtimeFamily: "generic", toolKind: "git", sandboxProfile: "strict", architecture: "x86_64" },
    profile: { defaultAction: "SCMP_ACT_ERRNO" as const, allowSyscalls: ["rt_sigreturn", "clone", "getcwd", "chdir", "faccessat", "faccessat2", "readlinkat", "read", "write", "openat", "close", "fstat", "lseek", "readlink", "getdents64", "mmap", "munmap", "mprotect", "brk", "access", "newfstatat", "exit", "exit_group", "rt_sigaction", "rt_sigprocmask", "ioctl", "writev", "readv", "pread64", "pwrite64", "futex", "clock_gettime", "getrandom", "prlimit64", "rseq", "sched_getaffinity", "getpid", "gettid", "tgkill", "arch_prctl", "set_tid_address", "set_robust_list", "execve", "execveat", "clone3", "wait4", "dup", "dup2", "dup3", "pipe", "pipe2", "fcntl", "statfs", "fstatfs", "mkdir", "mkdirat", "unlink", "unlinkat", "rename", "renameat", "renameat2", "chmod", "fchmod", "fchmodat", "utimensat", "truncate", "ftruncate", "linkat", "symlinkat", "socket", "connect", "sendto", "recvfrom", "poll", "ppoll", "epoll_create1", "epoll_ctl", "epoll_wait", "eventfd2", "clock_nanosleep", "nanosleep", "sched_yield"], denySyscalls: [] },
  },
  {
    key: { runtimeFamily: "generic", toolKind: "compiler", sandboxProfile: "strict", architecture: "x86_64" },
    profile: { defaultAction: "SCMP_ACT_ERRNO" as const, allowSyscalls: ["rt_sigreturn", "clone", "getcwd", "chdir", "faccessat", "faccessat2", "readlinkat", "read", "write", "openat", "close", "fstat", "lseek", "readlink", "getdents64", "mmap", "munmap", "mprotect", "brk", "access", "newfstatat", "exit", "exit_group", "rt_sigaction", "rt_sigprocmask", "ioctl", "writev", "readv", "pread64", "pwrite64", "futex", "clock_gettime", "getrandom", "prlimit64", "rseq", "sched_getaffinity", "getpid", "gettid", "tgkill", "arch_prctl", "set_tid_address", "set_robust_list", "execve", "execveat", "clone3", "wait4", "dup", "dup2", "dup3", "pipe", "pipe2", "fcntl", "statfs", "fstatfs", "mkdir", "mkdirat", "unlink", "unlinkat", "rename", "renameat", "renameat2", "chmod", "fchmod", "fchmodat", "utimensat", "truncate", "ftruncate", "linkat", "symlinkat"], denySyscalls: [] },
  },
  {
    key: { runtimeFamily: "generic", toolKind: "unknown", sandboxProfile: "strict", architecture: "x86_64" },
    profile: { defaultAction: "SCMP_ACT_ERRNO" as const, allowSyscalls: ["exit", "exit_group", "rt_sigreturn", "read", "write", "close", "fstat"], denySyscalls: [] },
  },
]

/** 按维度键取 Profile（未命中 → unknown-deny 语义）。 */
export function resolveSeccompProfile(key: SeccompProfileKey): SeccompProfile {
  const found = FIRST_BATCH_PROFILES.find(p =>
    p.key.runtimeFamily === key.runtimeFamily &&
    p.key.toolKind === key.toolKind &&
    p.key.sandboxProfile === key.sandboxProfile &&
    p.key.architecture === key.architecture,
  )
  if (found) {
    // m11（LR2-4 审核）：返回冻结副本 —— 调用方修改 allowSyscalls 不得
    // 毒化全局首批表。
    return {
      defaultAction: found.profile.defaultAction,
      allowSyscalls: Object.freeze([...found.profile.allowSyscalls]),
      denySyscalls: Object.freeze([...found.profile.denySyscalls]),
      target: found.profile.target,
    }
  }
  // 未命中 → unknown-deny（默认拒绝一切未分类）
  return { defaultAction: "SCMP_ACT_ERRNO" as const, allowSyscalls: Object.freeze(["exit", "exit_group", "rt_sigreturn"]), denySyscalls: [] }
}
