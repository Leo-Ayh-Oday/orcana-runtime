/** LNXF R2.1 PR-12.1: seccomp-BPF 语义测试（TDD —— 修复前应失败）。
 *
 *  编译产物是 raw sock_filter 数组（每指令 8 字节：u16 code / u8 jt / u8 jf / u32 k）。
 *  本测试解码并模拟经典 BPF 执行，按 (arch, nr) 判定 filter 终态：
 *    - 非 x86_64 arch 必须 KILL（跨架构 syscall 号不可信）
 *    - x86_64 必须通过 arch 门，进入 deny/allow 判定
 *    - deny 列表命中 → EPERM
 *    - ERRNO 模式：白名单命中 → ALLOW；其余 → EPERM（兜底）
 *  修复前（jt/jf 反转）：x86_64 命中即 RET_KILL —— 本测试必须红。
 */

import { describe, expect, test } from "bun:test"
import { compileSeccompBpf } from "../../../src/runtime/linux/seccomp-bpf"
import { compileSeccompProfile } from "../../../src/runtime/linux/landlock-seccomp"

// seccomp action 常量（与 seccomp-bpf.ts 一致）
const RET_KILL = 0x00000000
const RET_ERRNO_EPERM = 0x00050001
const RET_ALLOW = 0x7fff0000
const AUDIT_ARCH_X86_64 = 0xc000003e
const AUDIT_ARCH_I386 = 0x40000003

// BPF opcode 位域
const BPF_LD = 0x00
const BPF_JMP = 0x05
const BPF_RET = 0x06
const BPF_JEQ = 0x10

interface BpfInsn { code: number; jt: number; jf: number; k: number }

/** 解码 raw BPF 文件（libseccomp 输出格式，little-endian）。 */
function decode(filter: Uint8Array): BpfInsn[] {
  const insns: BpfInsn[] = []
  const view = new DataView(filter.buffer, filter.byteOffset, filter.byteLength)
  for (let i = 0; i < filter.byteLength; i += 8) {
    insns.push({
      code: view.getUint16(i, true),
      jt: view.getUint8(i + 2),
      jf: view.getUint8(i + 3),
      k: view.getUint32(i + 4, true),
    })
  }
  return insns
}

/** 经典 BPF 模拟器：seccomp_data {nr(off 0), arch(off 4)}。 */
function simulate(filter: Uint8Array, data: { arch: number; nr: number }): number {
  const insns = decode(filter)
  let pc = 0
  let A = 0
  while (pc < insns.length) {
    const ins = insns[pc]!
    const kind = ins.code & 0x07
    if (kind === BPF_LD) {
      // BPF_LD|BPF_W|BPF_ABS：A = 内存[k]（seccomp_data 字偏移）
      A = ins.k === 0 ? data.nr : ins.k === 4 ? data.arch : 0
      pc += 1
    } else if (kind === BPF_JMP) {
      const op = ins.code & 0xf0
      let cond: boolean
      if (op === BPF_JEQ) cond = A === ins.k
      else cond = false // 本 filter 仅用 JEQ
      pc += 1 + (cond ? ins.jt : ins.jf)
    } else if (kind === BPF_RET) {
      return ins.k
    } else {
      pc += 1
    }
  }
  return 0
}

const profile = compileSeccompProfile("untrusted")
const filter = compileSeccompBpf(profile)

describe("seccomp-BPF arch 门（LNXF-R2 12.1）", () => {
  test("非 x86_64 arch 必须 KILL（跨架构 syscall 号不可信）", () => {
    // i386 compat 请求：arch 不匹配 → 首拍即杀
    expect(simulate(filter, { arch: AUDIT_ARCH_I386, nr: 59 })).toBe(RET_KILL)
  })

  test("x86_64 arch 必须通过 arch 门（不得 KILL）", () => {
    // 任意合法 syscall：进入 deny/allow 判定而非被杀
    expect(simulate(filter, { arch: AUDIT_ARCH_X86_64, nr: 59 })).not.toBe(RET_KILL)
  })
})

describe("seccomp-BPF deny 面（untrusted profile）", () => {
  test("deny 列表命中 → EPERM（ptrace=101）", () => {
    expect(simulate(filter, { arch: AUDIT_ARCH_X86_64, nr: 101 })).toBe(RET_ERRNO_EPERM)
  })

  test("deny 列表命中 → EPERM（mount=165）", () => {
    expect(simulate(filter, { arch: AUDIT_ARCH_X86_64, nr: 165 })).toBe(RET_ERRNO_EPERM)
  })
})

describe("seccomp-BPF deny-by-default 兜底（untrusted → SCMP_ACT_ERRNO）", () => {
  test("白名单 syscall 命中 → ALLOW（read=0）", () => {
    expect(simulate(filter, { arch: AUDIT_ARCH_X86_64, nr: 0 })).toBe(RET_ALLOW)
  })

  test("非白名单 syscall → EPERM 兜底（chdir=80 不在白名单）", () => {
    expect(simulate(filter, { arch: AUDIT_ARCH_X86_64, nr: 80 })).toBe(RET_ERRNO_EPERM)
  })

  test("架构未知 syscall 号 → EPERM 兜底", () => {
    expect(simulate(filter, { arch: AUDIT_ARCH_X86_64, nr: 9999 })).toBe(RET_ERRNO_EPERM)
  })
})
