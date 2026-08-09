/** LNXF-1.0: cgroup v2 delegation (LF-4, plan §11.5).
 *
 *  Orcana may only manage the cgroup subtree that is formally delegated to
 *  it. Priority: systemd user Scope+Delegate → existing container/orchestrator
 *  delegation → explicitly writable manual cgroup → none (resource isolation
 *  is marked degraded; strict profiles refuse).
 */

import { existsSync, readdirSync, writeFileSync, mkdirSync, readFileSync, rmdirSync } from "node:fs"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
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

const CHILD_MIGRATION_PROBE = `
const { readFileSync, writeFileSync } = require("node:fs")
const { join } = require("node:path")
const leaf = process.argv[process.argv.length - 1]
writeFileSync(join(leaf, "cgroup.procs"), String(process.pid))
process.stdout.write(readFileSync("/proc/self/cgroup", "utf8"))
`

/** Verify migration with a short-lived child so the caller is never moved or frozen. */
export function probeChildProcessMigration(leaf: string, probe: string): boolean {
  try {
    const result = spawnSync(process.execPath, ["-e", CHILD_MIGRATION_PROBE, leaf], {
      encoding: "utf8",
      env: {},
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 2_000,
      killSignal: "SIGKILL",
    })
    return result.status === 0 && result.stdout.includes(`${probe}/leaf`)
  } catch {
    return false
  }
}

/**
 * LNXF-R2 10.1：委托真实探针（7 步，同步实现）——
 *  1. create temporary parent
 *  2. enable cpu/memory/pids subtree_control（父层授权链）
 *  3. create leaf
 *  4. 写限额属性：memory.high（软限）/
 *     pids.max（1024）/ cpu.max（1 核）
 *  5-6. 迁移验证（尽力而为）：启动短命子进程，由子进程把自身迁入 leaf，
 *      读取 /proc/self/cgroup 确认后退出。调用者永不迁移，避免 transient
 *      scope 被删除后无法迁回，更不能冻结调用者。子进程迁移仍受源 cgroup
 *      可写性限制 —— WSL2 /init.scope 场景会 EACCES，此时
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
    // 3-4. leaf + 限额写（memory.high 软限）
    mkdirSync(leaf)
    writeFileSync(join(leaf, "memory.high"), "1073741824")
    writeFileSync(join(leaf, "pids.max"), "1024")
    writeFileSync(join(leaf, "cpu.max"), "100000 100000")
    // 5-6. 子进程迁移验证（尽力而为）：调用者绝不进入 probe leaf。
    processMigrationVerified = probeChildProcessMigration(leaf, probe)
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
 *
 *  LR2-0E 修正：Orcana 不在"任意可写 cgroup 父目录中寻找权力"，只管理
 *  systemd 明确委托的子树。优先级设计：
 *   1. 自身被委托子树 —— 从 /proc/self/cgroup 出发逐级向上（execd 模型：
 *      systemd Delegate=cpu memory pids io 委托给 service 的私有子树；
 *      最近的可写前缀优先）。系统边界（init.scope/system.slice）跳过。
 *   2. systemd user manager 的 Delegate 子树 user@UID.service —— systemd 在
 *      user@.service（Delegate=pids memory cpu）启动时把该目录 chown 给用户，
 *      是 WSL2（systemd=true）上普通用户唯一可写的委托点。
 *      存在性判据是目录本身，不是 ~/.config/systemd/user：后者只在用户有
 *      自定义 user unit 时创建，user manager 在跑而目录缺失时委托依然存在
 *      （2026-08-07 OTS-004 事故后实测：本机即此场景，旧判据漏检）。
 *   2b. 老式 ~/.config/systemd/user → user-UID.slice（老 systemd chown 层级）。
 *
 *  不再扫描 /sys/fs/cgroup/user.slice 根与 cgroupRoot 本身（任意可写父目录
 *  ≠ 明确委托；container-runtime 场景由容器运行时自身委托）。 */
export function buildDelegationCandidates(
  home: string,
  uid: number,
  cgroupRoot = "/sys/fs/cgroup",
  selfCgroup = "",
): Array<{ dir: string; source: DelegatedRoot["source"] }> {
  const candidates: Array<{ dir: string; source: DelegatedRoot["source"] }> = []
  // 1. 自身被委托子树（从自身路径逐级向上，跳过系统边界）。
  if (selfCgroup && selfCgroup.startsWith(cgroupRoot)) {
    const parts = selfCgroup.slice(cgroupRoot.length).split("/").filter(Boolean)
    for (let i = parts.length; i >= 1; i--) {
      const dir = join(cgroupRoot, ...parts.slice(0, i))
      const source = sourceOfPath(parts.slice(0, i))
      if (source === "none") continue
      candidates.push({ dir, source })
    }
  }
  // 2. systemd user 委托树（明确 chown 给用户的子树）。
  const userSlice = join(cgroupRoot, "user.slice", `user-${uid}.slice`)
  if (existsSync(join(userSlice, `user@${uid}.service`))) {
    candidates.push({ dir: join(userSlice, `user@${uid}.service`), source: "systemd-user" })
  }
  if (existsSync(join(home, ".config/systemd/user"))) {
    candidates.push({ dir: userSlice, source: "systemd-user" })
  }
  return candidates
}

/** 自身路径前缀的委托来源判定（LR2-0E）。
 *  只拒绝顶层系统边界目录本身（init.scope / system.slice / user.slice 根）；
 *  user.slice 之下的 user-UID.slice / user@UID.service 是 systemd 明确
 *  chown 的委托子树，属于可管理范围。 */
function sourceOfPath(parts: string[]): DelegatedRoot["source"] {
  if (parts.length === 0) return "none"
  if (parts.length === 1) {
    const first = parts[0]!
    if (first === "init.scope" || first === "system.slice" || first === "user.slice") return "none"
  }
  if (parts.some(p => p.includes("user@"))) return "systemd-user"
  if (parts.some(p => p.includes("user-"))) return "systemd-system"
  return "container-runtime"
}

/** 自身 cgroup 路径（/proc/self/cgroup，v2 "0::" 行；无则空串）。 */
function selfCgroupPath(): string {
  try {
    const line = readFileSync("/proc/self/cgroup", "utf8").split("\n").find(l => l.startsWith("0::"))
    return line ? line.slice(3).replace(/\/+$/, "") : ""
  } catch {
    return ""
  }
}

/** 探测当前用户可用的委托根。
 *  LR2-0E：优先自身被委托子树（/proc/self/cgroup 逐级向上），
 *  其次 systemd 明确委托给用户的子树；不再扫描任意可写父目录。 */
export function detectDelegatedRoot(): DelegatedRoot {
  const home = process.env.HOME ?? "/root"
  const uid = process.getuid?.() ?? 0
  const self = selfCgroupPath()
  const candidates = buildDelegationCandidates(home, uid, "/sys/fs/cgroup", self)

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
