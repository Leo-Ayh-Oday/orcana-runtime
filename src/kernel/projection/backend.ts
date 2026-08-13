/**
 * AK-2 Native Projection Backend。
 *
 * 生产 backend：fuse-overlayfs（无特权 mount 环境的真实 overlay 语义）；
 * 探测复用 src/runtime/linux/workspace/overlay.ts 的公开 detectOverlayBackend()。
 *
 * 不变量：
 * - backend 只决定执行位置，**不改变 write authority**（writable/readonly
 *   范围由 Delta Scanner + Commit Validator 执行）；
 * - mount option 以数组参数传递（execFile，无 shell）；所有路径拒绝
 *   `,`/`:`/换行（option/分隔符注入）；
 * - label 必须是安全字符（防 delimiter/路径注入）；
 * - mount 后必须确认 merged ready（stat + readdir）；
 * - cleanup 只卸载/删除本 projection 自己创建的资源，幂等；
 * - 任何路径必须落在 projectionRoot 内。
 *
 * CopyProjectionFixtureBackend 仅为确定性测试 fixture，**TEST FIXTURE ONLY**，
 * 不能作为真实 overlay 通过证据。
 */

import { execFileSync, execFile } from "node:child_process"
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  statSync,
  statfsSync,
} from "node:fs"
import { join, resolve, sep } from "node:path"
import { detectOverlayBackend, type OverlayBackend } from "../../runtime/linux/workspace/overlay"
import { ProjectionError } from "./contracts"

export type NativeBackendKind = "overlayfs" | "fuse-overlayfs" | "fixture"

export interface CreateProjectionInput {
  /** 物化后的 immutable lower base（只读）。 */
  readonly lowerDir: string
  /** 本 projection 专属根目录（已存在，owner=coordinator）。 */
  readonly projectionRoot: string
  /** 安全标识（仅 [A-Za-z0-9._-]）。 */
  readonly label: string
}

export interface ProjectionInstance {
  readonly backend: NativeBackendKind
  /** Cell 可见 merged 工作区路径。 */
  readonly mergedPath: string
  /** 写层路径（upper / fixture 副本）。 */
  readonly writeLayerPath: string
  /** 确认 mount ready（生产 backend 挂载成功 + merged 可读）。 */
  readonly assertReady: () => void
  /** R2-06：复核 merged 仍是本次创建的同一 mount（生产 backend）；
   *  fixture 返回 true（无真实 mount）。 */
  readonly assertMountOwned?: () => boolean
  /**
   * 清理本 projection 自己创建的资源（卸载 merged、删除 upper/work）。
   * 返回清理是否成功；失败时调用方必须阻止 World commit。
   * 幂等：第二次调用返回 true。
   */
  cleanup(): boolean
  /** R4-06：seal —— 执行 writer 已终止后，把 merged 视图转为不可写、
   *  不可替换的稳定 scan 输入。返回 sealed 视图路径；失败 → { error }
   *  （调用方必须 fail-closed：不生成 delta、不 commit）。幂等。 */
  readonly sealForScan?: () => { readonly sealedPath: string } | { readonly error: string }
}

export interface NativeProjectionBackend {
  readonly id: string
  readonly kind: NativeBackendKind
  create(input: CreateProjectionInput): ProjectionInstance
}

/** 校验 label / 路径（delimiter/option/escape 注入拒绝）。 */
function assertSafeLabel(label: string): string {
  if (typeof label !== "string" || !/^[A-Za-z0-9._-]+$/.test(label)) {
    throw new ProjectionError("BACKEND_UNAVAILABLE", `invalid projection label: ${String(label)}`)
  }
  return label
}

function assertSafeMountPath(path: string, projectionRoot: string): string {
  if (typeof path !== "string" || path.length === 0) {
    throw new ProjectionError("BACKEND_UNAVAILABLE", "mount path must be a non-empty string")
  }
  if (/[,:\n\0]/.test(path)) {
    throw new ProjectionError("BACKEND_UNAVAILABLE", `mount path contains delimiter/option injection chars: ${path}`)
  }
  const resolved = resolve(path)
  if (!resolved.startsWith(resolve(projectionRoot) + sep)) {
    throw new ProjectionError("BACKEND_UNAVAILABLE", `mount path escapes projection root: ${path}`)
  }
  return resolved
}

function assertRealDirectory(path: string, label: string): void {
  if (!existsSync(path)) throw new ProjectionError("BACKEND_UNAVAILABLE", `${label} does not exist: ${path}`)
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new ProjectionError("BACKEND_UNAVAILABLE", `${label} must be a real directory: ${path}`)
  }
}

function execFileSyncSafe(binary: string, args: readonly string[]): void {
  execFileSync(binary, [...args], { stdio: "ignore", timeout: 60_000 })
}

/** 证明 merged 是本次真实 FUSE 挂载（R06.2）：
 *  1) statfs 类型必须是 FUSE_SUPER_MAGIC（fake binary 返回 0 但未挂载 → false）；
 *  2) /proc/self/mountinfo 必须存在该挂载点且 fs type 为 fuse/fuse.overlayfs
 *     （owned session identity：本进程挂载命名空间内的真实条目）。 */
function isOwnedFuseMount(merged: string): boolean {
  return ownedFuseMountId(merged) !== undefined
}

/** 返回 mountinfo 中该挂载点的 mount id（无 → undefined）。
 *  mountinfo 行：<mount-id> <parent> <major:minor> <root> <mount-point> ... */
function ownedFuseMountId(merged: string): string | undefined {
  try {
    if (statfsSync(merged).type !== 0x65735546) return undefined
  } catch {
    return undefined
  }
  try {
    const mountinfo = readFileSync("/proc/self/mountinfo", "utf8")
    for (const line of mountinfo.split("\n")) {
      const fields = line.split(" ")
      if (fields.length < 8 || fields[4] !== merged) continue
      const separator = fields.indexOf("-")
      if (separator < 0 || separator + 1 >= fields.length) continue
      const fsType = fields[separator + 1]!
      // fuse-overlayfs 挂载点显示为 fuse.fuse-overlayfs（也接受 fuse /
      // fuse.overlayfs）；宿主 ext4/overlay/tmpfs 等一律不匹配。
      if (fsType === "fuse" || fsType.startsWith("fuse.")) {
        // 同时验证 mount source 是本进程的 fuse-overlayfs（不是其它 FUSE）。
        const source = fields.slice(separator + 2).join(" ").split(" ")[0]
        if (source !== "fuse-overlayfs") return undefined
        return fields[0]
      }
    }
  } catch {
    return undefined
  }
  return undefined
}

/** 生产 backend —— fuse-overlayfs（无特权 mount 时真实可用；探测确认）。
 * overlayfs 由探测函数报告（有 CAP_SYS_ADMIN 时）但本实现统一走
 * fuse-overlayfs 二进制；若环境只有 native overlayfs，create 会明确失败。 */
export class FuseOverlayfsProjectionBackend implements NativeProjectionBackend {
  readonly id = "fuse-overlayfs"
  readonly kind = "fuse-overlayfs" as const

  private readonly binaryPath: string
  /** 测试注入窗口（test-only；生产不传）：mount attestation 成功后、
   *  readiness/chmod 前调用（R5-00-5 反例的确定性替换窗口）。
   *  无此选项时零开销（undefined 短路）。 */
  private readonly onAfterMountAttested?: (merged: string) => void

  constructor(options: string | { readonly binaryPath?: string; readonly onAfterMountAttested?: (merged: string) => void } = "fuse-overlayfs") {
    const resolved = typeof options === "string" ? { binaryPath: options } : options
    this.binaryPath = resolved.binaryPath ?? "fuse-overlayfs"
    this.onAfterMountAttested = resolved.onAfterMountAttested
  }

  create(input: CreateProjectionInput): ProjectionInstance {
    const label = assertSafeLabel(input.label)
    const projectionRoot = resolve(input.projectionRoot)
    const lower = assertSafeMountPath(input.lowerDir, projectionRoot)
    assertRealDirectory(lower, "lower")
    assertRealDirectory(projectionRoot, "projectionRoot")

    const upper = assertSafeMountPath(join(projectionRoot, `upper-${label}`), projectionRoot)
    const work = assertSafeMountPath(join(projectionRoot, `work-${label}`), projectionRoot)
    const merged = assertSafeMountPath(join(projectionRoot, `merged-${label}`), projectionRoot)
    mkdirSync(upper, { mode: 0o700 })
    mkdirSync(work, { mode: 0o700 })
    // 已存在（可能含外部/错误挂载）→ 不覆盖，交给 P2-3 beforeMounted 检查。
    if (!existsSync(merged)) mkdirSync(merged, { mode: 0o700 })

    let mounted = false
    let afterMountId: string | undefined
    try {
      // P2-3：invocation 之前不允许存在对应 owned mount —— 挂载前快照
      // merged 的 mountinfo 状态（已有 FUSE 挂载 → 拒绝：不是本次创建）。
      const beforeMounted = isOwnedFuseMount(merged)
      if (beforeMounted) {
        throw new ProjectionError(
          "BACKEND_UNAVAILABLE",
          `merged ${merged} already has a FUSE mount before this invocation (wrong/foreign mount refused)`,
        )
      }
      const beforeMountId = ownedFuseMountId(merged)
      // 数组参数 + 无 shell；路径已拒绝 `,`/`:` 注入。
      execFileSyncSafe(this.binaryPath, ["-o", `lowerdir=${lower},upperdir=${upper},workdir=${work}`, merged])
      mounted = true
      // R06.1/2 + P2-3：exit 0 不等于已挂载 —— statfs + mountinfo 证明本次
      // 真实 FUSE mount；且挂载 identity 必须是 invocation 后新出现的
      //（fake binary 创建“真的但错误的 FUSE mount”在 before 快照即拒绝；
      //  返回 0 未挂载 → mountinfo 无新条目 → 拒绝）。
      afterMountId = ownedFuseMountId(merged)
      if (
        afterMountId === undefined ||
        afterMountId === beforeMountId ||
        !isOwnedFuseMount(merged)
      ) {
        throw new ProjectionError(
          "BACKEND_UNAVAILABLE",
          `fuse-overlayfs exited 0 but ${merged} is not a real FUSE mount created by this invocation (statfs/mountinfo attestation failed)`,
        )
      }
      // 测试注入窗口（test-only）：attestation 成功后、readiness/chmod 前
      // （R5-00-5 反例的确定性 foreign-swap 窗口）。
      this.onAfterMountAttested?.(merged)
      // mount ready 确认。
      try {
        statSync(merged)
        readdirSync(merged)
      } catch (error) {
        throw new ProjectionError(
          "BACKEND_UNAVAILABLE",
          `fuse-overlayfs merged not ready: ${merged}`,
          error instanceof Error ? error.message : String(error),
        )
      }
      // lower 物理只读（0444/0555）；OverlayFS copy-up 会继承只读 mode，
      // 使执行无法写入。挂载后递归 chmod merged（触发全量 copy-up 到
      // upper）：文件 0644、目录 0755 —— merged 视图可写，lower 物理
      // 文件保持只读（写永远落在 upper，lower 不可被 merged 写穿透）。
      this.chmodMergedWritable(merged)
    } catch (error) {
      // R2-06-5/R4-00-9：真实挂载中且 unmount 失败时不得递归删除
      // upper/work/merged（可能仍在被内核使用 —— residue 保留供诊断）。
      // unmount 报告成功 ≠ 已卸载 —— 必须重新确认 mount 已消失；仍挂载
      // → 禁止 rm/chmod 任何内容（R4-05.7）。
      if (mounted && this.isFuseMount(merged)) {
        const unmounted = this.unmount(merged)
        if (!unmounted) {
          throw error instanceof ProjectionError
            ? error
            : new ProjectionError(
                "BACKEND_UNAVAILABLE",
                `fuse-overlayfs mount failed for ${label} (unmount failed; residue retained)`,
                error instanceof Error ? error.message : String(error),
              )
        }
        if (this.isFuseMount(merged)) {
          throw new ProjectionError(
            "BACKEND_UNAVAILABLE",
            `fuse-overlayfs mount failed for ${label} (unmount reported success but mount still active; residue retained — no recursive deletion of a mounted directory)`,
            error instanceof Error ? error.message : String(error),
          )
        }
      }
      try {
        rmSync(upper, { recursive: true, force: true })
        rmSync(work, { recursive: true, force: true })
        // R4-05.8：merged 只允许在确认非 mount 后删除；非空 → 保留 residue。
        if (existsSync(merged) && !this.isFuseMount(merged)) {
          try {
            if (readdirSync(merged).length === 0) rmdirSync(merged)
          } catch {
            // residue 保留
          }
        }
      } catch {
        // best-effort
      }
      throw error instanceof ProjectionError
        ? error
        : new ProjectionError(
            "BACKEND_UNAVAILABLE",
            `fuse-overlayfs mount failed for ${label}`,
            error instanceof Error ? error.message : String(error),
          )
    }

    // R2-06：本次 create 的 mount identity（mountId + upper 目录身份 ——
    // mount id 在卸载重挂载时会被内核复用，upper dev/ino 是更强的绑定：
    // 攻击者替换 upper 重挂载 → 身份不匹配 → fail-closed）。
    const mountId = afterMountId
    const upperStat = lstatSync(upper)
    const upperIdentity = { dev: upperStat.dev, ino: upperStat.ino }
    // R4-06：seal 状态 —— RW mount 卸载后以 ro 重挂载同一 lower/upper/work
    //（内核 MS_RDONLY 强制：写入 EROFS，不可替换）。sealedMountId 是新的
    // mount identity（ownership 复核两者皆可）。
    let sealedMountId: string | undefined = undefined
    let sealed = false
    return {
      backend: "fuse-overlayfs",
      mergedPath: merged,
      writeLayerPath: upper,
      assertReady: () => {
        statSync(merged)
        readdirSync(merged)
      },
      // R2-06：复核 merged 仍是本次创建的同一 mount —— mountId 匹配 +
      // mountpoint 未被 symlink/rename 替换 + upper 目录身份一致（mount id
      // 会被内核复用，upper dev/ino 绑定本次创建）。execute 前/后、scan
      // 前、cleanup 时调用；mount 消失/被替换 → false（fail-closed）。
      // R4-06：seal 后接受 sealed mount id（同一 upper 身份的 ro 重挂载）。
      assertMountOwned: () => {
        if (!existsSync(merged)) return false
        try {
          const stat = lstatSync(merged)
          if (stat.isSymbolicLink()) return false
        } catch {
          return false
        }
        const current = ownedFuseMountId(merged)
        if (current !== mountId && current !== sealedMountId) return false
        try {
          const upperNow = lstatSync(upper)
          if (upperNow.dev !== upperIdentity.dev || upperNow.ino !== upperIdentity.ino) return false
        } catch {
          return false
        }
        return true
      },
      // R4-06：seal —— 执行 writer 已终止（cleanup proof）后调用：
      // ownership 复核 → 卸载 RW mount（确认已消失）→ 以 ro 重挂载
      //（同一 lower/upper/work）→ 确认真实挂载。失败 → { error }（
      // fail-closed：不生成 delta、不 commit）。幂等。
      sealForScan: () => {
        if (sealed) return { sealedPath: merged }
        if (!existsSync(merged)) return { error: "merged missing before seal" }
        try {
          const stat = lstatSync(merged)
          if (stat.isSymbolicLink()) return { error: "merged replaced by symlink before seal" }
        } catch (error) {
          return { error: `merged unreadable before seal: ${error instanceof Error ? error.message : String(error)}` }
        }
        if (ownedFuseMountId(merged) !== mountId) {
          return { error: "mount no longer owned by this session; seal refused" }
        }
        try {
          const upperNow = lstatSync(upper)
          if (upperNow.dev !== upperIdentity.dev || upperNow.ino !== upperIdentity.ino) {
            return { error: "upper identity changed; seal refused" }
          }
        } catch {
          return { error: "upper unreadable before seal" }
        }
        // 卸载 RW mount 并确认已消失（R4-05.7：unmount 报告成功 ≠ 已卸载）。
        if (!this.unmount(merged)) {
          return { error: "unmount failed during seal (writers may remain); seal refused" }
        }
        if (this.isFuseMount(merged)) {
          return { error: "mount still active after unmount during seal; seal refused" }
        }
        // ro 重挂载（内核 MS_RDONLY：写入 EROFS —— 不可写、不可替换视图）。
        try {
          execFileSyncSafe(this.binaryPath, ["-o", `lowerdir=${lower},upperdir=${upper},workdir=${work},ro`, merged])
        } catch (error) {
          return { error: `read-only remount failed: ${error instanceof Error ? error.message : String(error)}` }
        }
        const sealedId = ownedFuseMountId(merged)
        if (sealedId === undefined || !isOwnedFuseMount(merged)) {
          return { error: "read-only remount did not produce a real FUSE mount; seal refused" }
        }
        sealedMountId = sealedId
        sealed = true
        return { sealedPath: merged }
      },
      cleanup: () => {
        if (!existsSync(merged) && !existsSync(upper) && !existsSync(work)) return true
        // R2-06-4/R3-00-8：只卸载本 projection 创建的 mount（mountId 匹配
        // + upper 身份一致）；foreign mount（含同路径重挂载）拒绝卸载、
        // 拒绝 rm/chmod 任何内容 —— 立即返回 cleanup failure（不抛）。
        let upperOwned = false
        try {
          const upperNow = lstatSync(upper)
          upperOwned = upperNow.dev === upperIdentity.dev && upperNow.ino === upperIdentity.ino
        } catch {
          upperOwned = false
        }
        const stillFuse = this.isFuseMount(merged)
        if (stillFuse) {
          const current = ownedFuseMountId(merged)
          if ((current !== mountId && current !== sealedMountId) || !upperOwned) {
            // R3-03.1：foreign mount / mount identity mismatch → cleanup
            // failure；禁止 unmount、禁止 rm/chmod upper/work/merged。
            return false
          }
          const unmounted = this.unmount(merged)
          if (!unmounted) {
            // R03.2/3 + R2-06-5：确认真实卸载成功前禁止删除仍在使用的
            // upper/work/merged（unmount 失败 → residue 保留，返回 false）。
            return false
          }
          // R3-03.2：删除前再次证明 mount 已消失（fusermount exit 0 不等于
          // 已卸载 —— 复核 statfs；仍挂载 → 不删除，返回 failure）。
          if (this.isFuseMount(merged)) {
            return false
          }
        }
        // 卸载成功（或从未挂载）：才删除本 projection 创建的 upper/work。
        // R4-05.8：merged mountpoint 只允许在确认空且非 mount 后用 rmdir
        // 删除（禁止递归穿越仍挂载/非空目录）。rmSync 抛错 → cleanup
        // failure（不抛）。
        try {
          rmSync(upper, { recursive: true, force: true })
          rmSync(work, { recursive: true, force: true })
          if (existsSync(merged)) {
            if (this.isFuseMount(merged)) return false
            if (readdirSync(merged).length !== 0) return false
            rmdirSync(merged)
          }
        } catch {
          return false
        }
        return true
      },
    }
  }

  private isFuseMount(path: string): boolean {
    try {
      return statfsSync(path).type === 0x65735546 // FUSE_SUPER_MAGIC
    } catch {
      return false
    }
  }

  /** 递归 chmod merged 内的文件（触发文件 copy-up；目录保持 0755 ——
   *  fuse-overlayfs 对只读目录的 copy-up 会 EACCES，overlay 层语义已保证
   *  merged 写入落 upper）。lower 物理文件保持 0444 只读。 */
  private chmodMergedWritable(merged: string): void {
    const visit = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        const stat = lstatSync(full)
        if (stat.isDirectory()) visit(full)
        else if (stat.isFile()) chmodSync(full, 0o644)
      }
    }
    visit(merged)
  }

  private unmount(merged: string): boolean {
    for (const binary of ["fusermount3", "fusermount"]) {
      try {
        execFileSyncSafe(binary, ["-u", merged])
        return true
      } catch {
        // 尝试下一个
      }
    }
    return false
  }
}

/** TEST FIXTURE ONLY —— 确定性 copy backend：把 lower 复制为可写 merged。
 *  不创建任何真实 overlay 语义；仅用于 coordinator/delta/commit 逻辑测试。
 *  绝对不作为真实 Linux backend 通过证据。
 *
 *  R4-01：fixture backend 移出生产导出面 —— 本类已迁至
 *  tests/kernel/projection/test-fixtures.ts（test-only factory）。
 *  生产模块（src/kernel/projection/backend.ts / index.ts）不再导出
 *  任何 fixture 执行能力（PUBLIC_FIXTURE_AUTHORITY = 0）。
 */
// （实现位于 tests/kernel/projection/test-fixtures.ts）

export interface NativeBackendProbe {
  readonly overlayfs: boolean
  readonly fuseOverlayfs: boolean
}

/** 探测可用 backend（复用 runtime/linux 公开探测；git-worktree/none 视为
 *  native 不可用 —— AK-2 不接受 copy/worktree 冒充 overlay 语义）。 */
export function probeNativeBackends(): NativeBackendProbe {
  const detected: OverlayBackend = detectOverlayBackend()
  let fuseOverlayfs = false
  if (detected === "fuse-overlayfs" || detected === "overlayfs") {
    // fuse-overlayfs 二进制存在性独立探测（native mount 成功 ≠ 该二进制存在）。
    try {
      execFileSyncSafe("fuse-overlayfs", ["--version"])
      fuseOverlayfs = true
    } catch {
      fuseOverlayfs = false
    }
  }
  return Object.freeze({
    overlayfs: detected === "overlayfs",
    fuseOverlayfs,
  })
}

/** 选择生产 backend；不可用时返回 undefined（调用方标记 ENV_BLOCKED）。 */
export function createProductionProjectionBackend(): FuseOverlayfsProjectionBackend | undefined {
  const probe = probeNativeBackends()
  if (!probe.fuseOverlayfs) return undefined
  return new FuseOverlayfsProjectionBackend()
}
