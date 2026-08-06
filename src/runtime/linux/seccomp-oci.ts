/** PR-7: OCI seccomp JSON profile 生成（Podman --security-opt seccomp=<file>）。
 *
 *  Podman 要求 OCI 运行时格式（defaultAction + syscalls 列表），与 bwrap 的
 *  raw BPF 是两套不兼容协议 —— 不能共用一个生成器（P0-4 修复）。
 *  这里把 landlock-seccomp 的规则面编译为 OCI JSON：
 *  defaultAction=SCMP_ACT_ALLOW + deny 列表 SCMP_ACT_ERRNO(EPERM)。
 */

import { writeFileSync } from "node:fs"
import type { SeccompProfile } from "./landlock-seccomp"

export interface OciSeccompSyscall {
  names: string[]
  action: string
  errnoRet?: number
}

export interface OciSeccompProfile {
  defaultAction: string
  defaultErrnoRet?: number
  archMap?: Array<{ architecture: string; subArchitectures: string[] }>
  syscalls: OciSeccompSyscall[]
}

/** 规则面 → OCI seccomp JSON（deny 列表 ERRNO(EPERM)，其余 ALLOW）。 */
export function compileOciSeccomp(profile: SeccompProfile): OciSeccompProfile {
  const syscalls: OciSeccompSyscall[] = []
  if (profile.denySyscalls.length > 0) {
    syscalls.push({ names: [...profile.denySyscalls], action: "SCMP_ACT_ERRNO", errnoRet: 1 })
  }
  return {
    defaultAction: "SCMP_ACT_ALLOW",
    archMap: [{ architecture: "SCMP_ARCH_X86_64", subArchitectures: ["SCMP_ARCH_X86"] }],
    syscalls,
  }
}

/** 生成 OCI seccomp JSON 文件（Podman 专用）。 */
export function writeOciSeccompFile(profile: SeccompProfile, filePath: string): string {
  writeFileSync(filePath, JSON.stringify(compileOciSeccomp(profile), null, 2), "utf8")
  return filePath
}
