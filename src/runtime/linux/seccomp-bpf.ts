/** R3: seccomp-BPF 文件生成器（P0-7 修复 —— 真实 seccomp 接入）。
 *
 *  bwrap --seccomp 需要 BPF 过滤文件（raw sock_filter 数组，libseccomp
 *  输出格式）。本模块把 landlock-seccomp 的规则面编译为可落盘的 BPF：
 *    x86_64 arch 校验 → deny 列表返回 EPERM → 其余 SCMP_ACT_ALLOW。
 *  仅支持 x86_64（运行平台探测后使用；其他架构抛 LINUX_PLATFORM_REQUIRED）。
 */

import { writeFileSync } from "node:fs"
import { arch } from "node:os"
import type { SeccompProfile } from "./landlock-seccomp"
import { LinuxExecutionError } from "./errors"

// seccomp BPF 常量（linux/filter.h）
const BPF_LD = 0x00
const BPF_W = 0x00
const BPF_ABS = 0x20
const BPF_JMP = 0x05
const BPF_JEQ = 0x10
const BPF_K = 0x00
const BPF_RET = 0x06

const AUDIT_ARCH_X86_64 = 0xc000003e
// SECCOMP_RET_ERRNO | EPERM；SECCOMP_RET_ALLOW
const RET_ERRNO_EPERM = 0x00050001
const RET_ALLOW = 0x7fff0000
const RET_KILL = 0x00000000

/** x86_64 syscall 号（deny 面用，与内核 uapi 一致）。 */
const X86_64_SYSCALLS: Record<string, number> = {
  // deny 列表
  ptrace: 101, mount: 165, umount2: 166, reboot: 169, pivot_root: 155,
  setns: 308, unshare: 272, kexec_load: 246, bpf: 321, perf_event_open: 298,
  userfaultfd: 323,
  // RC-06 B6: 白名单面（BASE_SYSCALLS + net/epoll/timerfd 运行时面）。
  read: 0, write: 1, open: 2, close: 3, stat: 4, fstat: 5, lstat: 6,
  lseek: 8, mmap: 9, mprotect: 10, munmap: 11, brk: 12, rt_sigaction: 13,
  rt_sigprocmask: 14, rt_sigreturn: 15, ioctl: 16, pread64: 17, pwrite64: 18,
  readv: 19, writev: 20, access: 21, pipe: 22, dup: 32, dup2: 33,
  sendfile: 40, socket: 41, connect: 42, shutdown: 48, bind: 49, listen: 50,
  getsockname: 51, getpeername: 52, socketpair: 53, setsockopt: 54,
  getsockopt: 55, clone: 56, execve: 59, exit: 60, wait4: 61, fcntl: 72,
  getdents64: 217, openat: 257, newfstatat: 262, readlinkat: 267,
  readlink: 89, getpid: 39, gettid: 186, getuid: 102, getgid: 104,
  geteuid: 107, getegid: 108, arch_prctl: 158, clock_gettime: 228,
  getrandom: 318, futex: 202, pipe2: 293, exit_group: 231,
  epoll_create1: 291, epoll_ctl: 233, epoll_wait: 232, eventfd2: 290,
  timerfd_create: 283, timerfd_settime: 286, accept4: 288, dup3: 292,
}

interface BpfInsn { code: number; jt: number; jf: number; k: number }

function insn(code: number, jt: number, jf: number, k: number): BpfInsn {
  return { code, jt, jf, k }
}

function encode(insns: BpfInsn[]): Uint8Array {
  const out = new Uint8Array(insns.length * 8)
  const view = new DataView(out.buffer)
  insns.forEach((i, idx) => {
    view.setUint16(idx * 8, i.code, true)
    view.setUint8(idx * 8 + 2, i.jt)
    view.setUint8(idx * 8 + 3, i.jf)
    view.setUint32(idx * 8 + 4, i.k, true)
  })
  return out
}

/** 编译保守 seccomp filter（defaultAction=ALLOW + deny 列表 ERRNO）。 */
export function compileSeccompBpf(profile: SeccompProfile): Uint8Array {
  if (arch() !== "x64") {
    throw new LinuxExecutionError("LINUX_PLATFORM_REQUIRED", `seccomp-bpf 生成仅支持 x86_64（当前 ${arch()}）`)
  }
  const insns: BpfInsn[] = []
  // 1. load arch → 非 x86_64 一律 KILL（跨架构 syscall 号不可信）。
  insns.push(insn(BPF_LD | BPF_W | BPF_ABS, 0, 0, 4))
  const archCheck = insn(BPF_JMP | BPF_JEQ | BPF_K, 0, 1, AUDIT_ARCH_X86_64)
  insns.push(archCheck)
  insns.push(insn(BPF_RET | BPF_K, 0, 0, RET_KILL))

  // 2. deny 列表：load nr → jeq → ret errno（显式拒绝优先于白名单）。
  for (const name of profile.denySyscalls) {
    const nr = X86_64_SYSCALLS[name]
    if (nr === undefined) continue
    insns.push(insn(BPF_LD | BPF_W | BPF_ABS, 0, 0, 0))
    const jeq = insn(BPF_JMP | BPF_JEQ | BPF_K, 0, 0, nr)
    insns.push(jeq)
    insns.push(insn(BPF_RET | BPF_K, 0, 0, RET_ERRNO_EPERM))
    jeq.jf = 1
  }

  // 3. RC-06 B6: 尊重 profile.defaultAction——
  //    SCMP_ACT_ERRNO = deny-by-default：仅 allowSyscalls 白名单放行，其余 EPERM；
  //    否则向后兼容 deny-list 模式（默认 ALLOW）。
  if (profile.defaultAction === "SCMP_ACT_ERRNO") {
    for (const name of profile.allowSyscalls) {
      const nr = X86_64_SYSCALLS[name]
      if (nr === undefined) continue
      insns.push(insn(BPF_LD | BPF_W | BPF_ABS, 0, 0, 0))
      const jeq = insn(BPF_JMP | BPF_JEQ | BPF_K, 0, 0, nr)
      insns.push(jeq)
      insns.push(insn(BPF_RET | BPF_K, 0, 0, RET_ALLOW))
      jeq.jf = 1
    }
    insns.push(insn(BPF_RET | BPF_K, 0, 0, RET_ERRNO_EPERM))
  } else {
    // 默认允许（兼容：未声明 ERRNO 的调用方）。
    insns.push(insn(BPF_RET | BPF_K, 0, 0, RET_ALLOW))
  }
  return encode(insns)
}

/** 生成 seccomp 文件（bwrap --seccomp 传入）。 */
export function writeSeccompBpfFile(profile: SeccompProfile, filePath: string): string {
  writeFileSync(filePath, compileSeccompBpf(profile))
  return filePath
}
