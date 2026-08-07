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
      return {
        root: "/sys/fs/cgroup",
        base: candidate.dir,
        source: candidate.source,
        controllers: readControllers(candidate.dir),
        writable: true,
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
