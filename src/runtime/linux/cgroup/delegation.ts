/** LNXF-1.0: cgroup v2 delegation (LF-4, plan §11.5).
 *
 *  Orcana may only manage the cgroup subtree that is formally delegated to
 *  it. Priority: systemd user Scope+Delegate → existing container/orchestrator
 *  delegation → explicitly writable manual cgroup → none (resource isolation
 *  is marked degraded; strict profiles refuse).
 */

import { existsSync, readdirSync, writeFileSync, mkdirSync, readFileSync, rmdirSync } from "node:fs"
import { join } from "node:path"
import type { CgroupFs } from "./manager"

export interface DelegatedRoot {
  /** cgroupfs 根（v2 mount）。 */
  root: string
  /** Orcana 可管理的基础目录（委托点）。 */
  base: string
  source: "systemd-user" | "systemd-system" | "container-runtime" | "manual" | "none"
  controllers: string[]
  writable: boolean
}

export const ORCANA_CGROUP_NS = "orcana.scope"

function readControllers(root: string, fs: CgroupFs = REAL_DELEGATION_FS): string[] {
  try {
    return fs.read(join(root, "cgroup.controllers")).trim().split(/\s+/).filter(Boolean)
  } catch {
    return []
  }
}

/** 默认真 fs 实现。 */
export const REAL_DELEGATION_FS: CgroupFs = {
  exists: existsSync,
  read(path) {
    return readFileSync(path, "utf8")
  },
  write(path, content) {
    writeFileSync(path, content)
  },
  mkdir(path) {
    mkdirSync(path, { recursive: true })
  },
  rm(path) {
    rmdirSync(path)
  },
  readdir(path) {
    return readdirSync(path)
  },
}

function readFileSafe(path: string): string {
  return readFileSync(path, "utf8")
}

/** LNXF-R2 10.1：真实委托验证结果（controller 实际可写 + 进程迁移
 *  有效 + 清理协议可执行）。 */
export interface VerifiedCgroupDelegation {
  base: string
  source: DelegatedRoot["source"]
  controllers: { cpu: boolean; memory: boolean; pids: boolean }
  subtreeControlVerified: boolean
  processMigrationVerified: boolean
}

/**
 * LNXF-R2 10.1：委托真实探针（7 步，同步实现）——
 *  1. create temporary parent
 *  2. enable cpu/memory/pids subtree_control（父层授权链）
 *  3. create leaf
 *  4. 写限额属性：memory.high（软限，可写性验证且迁移自身无 OOM 风险）/
 *     pids.max（1024）/ cpu.max（1 核）
 *  5-6. 迁移验证（尽力而为）：把当前进程临时迁入 leaf → /proc/self/cgroup
 *      确认 → 迁回。同步 API 无法在子进程存活期间迁移（单线程死结），
 *      自身迁移受源 cgroup 可写性限制 —— 本机 WSL2 控制台进程挂 root
 *      属主 /init.scope 时迁移 EACCES（45eba78 已知场景），此时
 *      processMigrationVerified=false 如实记录，不判委托失败（enable/
 *      限额/清理协议仍已验证）。
 *  7. 补充 cgroup.freeze 接口验证（写 1 → 0，控制器实际生效证据）+
 *     populated=0 → rmdir（清理协议可执行）。
 * enable/限额/清理任一步失败 → 返回 null（delegation unavailable）。
 * 仅探测"目录存在 + pids.max 可写"不足以证明控制器/清理真的被委托
 * （capability-probe 过度声称根因）。
 */
export function verifyCgroupDelegation(base: string, source: DelegatedRoot["source"]): VerifiedCgroupDelegation | null {
  const probe = join(base, `.verify-${process.pid}`)
  const leaf = join(probe, "leaf")
  let processMigrationVerified = false
  try {
    // 1-2. temp parent + enable（父层授权链验证）
    mkdirSync(probe, { recursive: true })
    writeFileSync(join(probe, "cgroup.subtree_control"), "+cpu +memory +pids")
    // 3-4. leaf + 限额写（memory.high 软限 —— 自身迁移无 OOM 风险）
    mkdirSync(leaf)
    writeFileSync(join(leaf, "memory.high"), "1073741824")
    writeFileSync(join(leaf, "pids.max"), "1024")
    writeFileSync(join(leaf, "cpu.max"), "100000 100000")
    // 5-6. 自身迁移验证（尽力而为）：迁入 → 确认 → 迁回
    const origCg = readFileSync("/proc/self/cgroup", "utf8")
      .split("\n").map(l => l.trim()).filter(Boolean)
      .map(l => l.split(":")[2] ?? "")
      .find(p => p && p !== "/") ?? ""
    try {
      writeFileSync(join(leaf, "cgroup.procs"), String(process.pid))
      const moved = readFileSync("/proc/self/cgroup", "utf8")
      if (moved.includes(`${probe}/leaf`)) {
        processMigrationVerified = true
        // 迁回原 cgroup（失败则进程留 leaf —— 无硬内存限额，短时无害）
        if (origCg) {
          try {
            writeFileSync(join("/sys/fs/cgroup", origCg, "cgroup.procs"), String(process.pid))
          } catch {
            /* best-effort */
          }
        }
      }
    } catch {
      // 源 cgroup 不可写（/init.scope 等）→ 迁移不可验证，如实 false
    }
    // 7a. freeze 接口验证（空 cgroup 允许冻结/解冻）
    writeFileSync(join(leaf, "cgroup.freeze"), "1")
    writeFileSync(join(leaf, "cgroup.freeze"), "0")
    // 7b. populated=0 → rmdir（清理协议可执行）
    const deadline = Date.now() + 2000
    for (;;) {
      try {
        if (readFileSync(join(leaf, "cgroup.procs"), "utf8").trim() === "") break
      } catch {
        break // 文件消失 = 空
      }
      if (Date.now() > deadline) throw new Error("populated!=0 timeout")
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
    }
    rmdirSync(leaf)
    rmdirSync(probe)
    return {
      base,
      source,
      controllers: { cpu: true, memory: true, pids: true },
      subtreeControlVerified: true,
      processMigrationVerified,
    }
  } catch {
    try {
      rmdirSync(leaf)
    } catch {
      /* best-effort */
    }
    try {
      rmdirSync(probe)
    } catch {
      /* best-effort */
    }
    return null
  }
}

function probeWritable(dir: string): boolean {
  try {
    const probe = join(dir, `.probe-${process.pid}`)
    mkdirSync(probe, { recursive: true })
    writeFileSync(join(probe, "pids.max"), "max")
    rmdirSync(probe)
    return true
  } catch {
    return false
  }
}

/** 候选委托根（纯函数，可测）：按优先级排列，detectDelegatedRoot 逐项探测。
 *  优先级设计：
 *   1. systemd user manager 的 Delegate 子树 user@UID.service —— systemd 在
 *      user@.service（Delegate=pids memory cpu）启动时把该目录 chown 给用户，
 *      是 WSL2（systemd=true）上普通用户唯一可写的委托点。
 *      存在性判据是目录本身，不是 ~/.config/systemd/user：后者只在用户有
 *      自定义 user unit 时创建，user manager 在跑而目录缺失时委托依然存在
 *      （2026-08-07 OTS-004 事故后实测：本机即此场景，旧判据漏检）。
 *   1b. 老式 ~/.config/systemd/user → user-UID.slice（老 systemd chown 层级）。
 *   2. systemd system user.slice（root/已 chown 场景）。
 *   3. 容器运行时委托（/sys/fs/cgroup 本身可写时）。 */
export function buildDelegationCandidates(home: string, uid: number, cgroupRoot = "/sys/fs/cgroup"): Array<{ dir: string; source: DelegatedRoot["source"] }> {
  const candidates: Array<{ dir: string; source: DelegatedRoot["source"] }> = []
  const userSlice = join(cgroupRoot, "user.slice", `user-${uid}.slice`)
  if (existsSync(join(userSlice, `user@${uid}.service`))) {
    candidates.push({ dir: join(userSlice, `user@${uid}.service`), source: "systemd-user" })
  }
  if (existsSync(join(home, ".config/systemd/user"))) {
    candidates.push({ dir: userSlice, source: "systemd-user" })
  }
  if (existsSync(join(cgroupRoot, "user.slice"))) {
    candidates.push({ dir: join(cgroupRoot, "user.slice"), source: "systemd-system" })
  }
  candidates.push({ dir: cgroupRoot, source: "container-runtime" })
  return candidates
}

/** 探测当前用户可用的委托根。 */
export function detectDelegatedRoot(): DelegatedRoot {
  const home = process.env.HOME ?? "/root"
  const uid = process.getuid?.() ?? 0
  const candidates = buildDelegationCandidates(home, uid)

  for (const candidate of candidates) {
    if (!existsSync(candidate.dir)) continue
    if (probeWritable(candidate.dir)) {
      // LNXF-R2 10.1：目录可写 ≠ 控制器/迁移/清理全部被委托 ——
      // 真实 7 步探针验证通过才宣称 writable（消除能力探测过度声称）。
      const verified = verifyCgroupDelegation(candidate.dir, candidate.source)
      if (verified) {
        return {
          root: "/sys/fs/cgroup",
          base: candidate.dir,
          source: candidate.source,
          controllers: readControllers(candidate.dir),
          writable: true,
        }
      }
    }
  }

  return {
    root: "/sys/fs/cgroup",
    base: "",
    source: "none",
    controllers: readControllers("/sys/fs/cgroup"),
    writable: false,
  }
}

/** 控制器的 subtree_control 启用（需要 base 可写；fs 可注入以便测试）。 */
export function enableControllers(
  base: string,
  wanted: string[],
  fs: CgroupFs = REAL_DELEGATION_FS,
): { ok: boolean; enabled: string[]; missing: string[] } {
  const enabled: string[] = []
  const missing: string[] = []
  const controlFile = join(base, "cgroup.subtree_control")
  if (!fs.exists(controlFile)) return { ok: false, enabled, missing: wanted }
  let current: string[] = []
  try {
    current = fs.read(controlFile).trim().split(/\s+/).filter(Boolean)
  } catch {
    return { ok: false, enabled, missing: wanted }
  }
  const available = readControllers(base, fs)
  for (const controller of wanted) {
    if (!available.includes(controller)) {
      missing.push(controller)
      continue
    }
    const token = controller[0] === "+" || controller[0] === "-" ? controller : `+${controller}`
    if (current.includes(token.slice(1))) {
      enabled.push(controller)
      continue
    }
    try {
      fs.write(controlFile, `${token} ${controller}`)
      enabled.push(controller)
    } catch {
      missing.push(controller)
    }
  }
  return { ok: missing.length === 0, enabled, missing }
}

/** 无委托检测辅助（严格 Profile 拒绝依据）。 */
export function delegationAvailable(delegated: DelegatedRoot): boolean {
  return delegated.writable && delegated.source !== "none"
}
