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

/** R6-01：production backend 类型**不包含** fixture discriminant ——
 *  生产模块无法表达 test-only backend（fixture 只存在于 tests/**）。 */
export type NativeBackendKind = "overlayfs" | "fuse-overlayfs"

/**
 * R7-01：生产模块不再提供任何 test authorization（公开 mark 函数已
 * 删除）。fixture backend 只存在于 tests/**（test-only composition）；
 * kind 字符串与 TypeScript cast 不授予 production World commit。
 */
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

/** 返回该挂载点的 FUSE mount 信息（id/fsType/source；无 → undefined）。
 *  mountinfo 行：<mount-id> <parent> <major:minor> <root> <mount-point> ... - <fs-type> <source> ... */
function fuseMountInfo(merged: string): { readonly id: string; readonly fsType: string; readonly source: string } | undefined {
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
        const source = fields.slice(separator + 2).join(" ").split(" ")[0] ?? ""
        return { id: fields[0]!, fsType, source }
      }
    }
  } catch {
    return undefined
  }
  return undefined
}

/** 证明 merged 是本次真实 FUSE 挂载（R06.2）：
 *  1) statfs 类型必须是 FUSE_SUPER_MAGIC（fake binary 返回 0 但未挂载 → false）；
 *  2) /proc/self/mountinfo 必须存在该挂载点且 fs type 为 fuse/fuse.overlayfs
 *     且 source 是本进程的 fuse-overlayfs（不是其它 FUSE）。 */
function isOwnedFuseMount(merged: string): boolean {
  return ownedFuseMountId(merged) !== undefined
}

/** 返回 mountinfo 中该挂载点的 mount id（无/非 fuse-overlayfs → undefined）。 */
function ownedFuseMountId(merged: string): string | undefined {
  const info = fuseMountInfo(merged)
  return info !== undefined && info.source === "fuse-overlayfs" ? info.id : undefined
}

/**
 * R5-04：mount id 在卸载后会被内核**复用**（同路径重挂载可拿到相同 id）——
 * id + upper dev/ino 都不足以区分「我们的挂载」与「同路径 foreign 重挂载」。
 * 真实判别依据：fuse-overlayfs daemon 的命令行（/proc/<pid>/cmdline）必须
 * 同时包含我们的 upperdir 与挂载点路径（daemon 选项不进入 mountinfo）。
 */
function fuseDaemonUsesUpper(merged: string, upper: string): boolean {
  try {
    for (const pidDir of readdirSync("/proc")) {
      if (!/^[0-9]+$/.test(pidDir)) continue
      let cmdline: string
      try {
        cmdline = readFileSync(`/proc/${pidDir}/cmdline`, "utf8")
      } catch {
        continue
      }
      if (!cmdline.includes("fuse-overlayfs")) continue
      if (!cmdline.includes(merged)) continue
      if (!cmdline.includes(`upperdir=${upper}`)) continue
      return true
    }
  } catch {
    return false
  }
  return false
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
    // R5-04：本次 create 的 mountpoint 身份（merged 目录 dev/ino ——
    // 挂载点被替换/rename → 身份不匹配 → fail-closed）。
    const mergedStatAtCreate = lstatSync(merged)
    const mergedIdentity = { dev: mergedStatAtCreate.dev, ino: mergedStatAtCreate.ino }
    // upper 身份（mount/unmount/rm 的更强绑定 —— mount id 会被内核复用）。
    const upperStatAtCreate = lstatSync(upper)
    const upperIdentity = { dev: upperStatAtCreate.dev, ino: upperStatAtCreate.ino }
    // R7-04：work 身份同样在创建时记录（mount 消失后替换 upper/work 为
    // foreign 目录时，删除分支必须复核两侧身份 —— R7-00-7）。
    const workStatAtCreate = lstatSync(work)
    const workIdentity = { dev: workStatAtCreate.dev, ino: workStatAtCreate.ino }

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
      // R5-00-5/R5-04：只卸载**本次创建**的 mount —— mountId 必须仍匹配
      // 且 upper/mountpoint 身份一致。foreign/unknown/replaced mount →
      // 不卸载、不 rm/chmod upper/work/merged（可能正在被 foreign mount
      // 使用 —— mounted-tree recursive delete 禁止），保留 residue。
      // unmount 报告成功 ≠ 已卸载 —— 必须重新确认 mount 已消失；仍挂载
      // → 禁止 rm/chmod 任何内容（R4-05.7）。
      const stillOwned =
        mounted &&
        afterMountId !== undefined &&
        ownedFuseMountId(merged) === afterMountId &&
        this.upperMatches(upper, upperIdentity) &&
        // R5-00-5/R5-04：mount id 会被内核复用 —— daemon 命令行必须仍指向
        // 我们的 upperdir（foreign 同路径重挂载 → false → 不卸载/不删除）。
        this.fuseDaemonUsesUpper(merged, upper)
      if (stillOwned) {
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
      } else if (mounted && this.isFuseMount(merged)) {
        // foreign/unknown mount 出现在 merged —— 什么都不卸载/删除。
        throw new ProjectionError(
          "BACKEND_UNAVAILABLE",
          `fuse-overlayfs create failed for ${label}: a foreign/unknown FUSE mount is present at ${merged}; nothing unmounted or removed (residue retained for diagnosis)`,
          error instanceof Error ? error.message : String(error),
        )
      } else if (mounted) {
        // 无挂载（fake binary 返回 0 但未挂载 / 已被外部卸载）—— 无
        // mounted-tree 风险 → 清理本 create 创建的 upper/work/merged。
        try {
          rmSync(upper, { recursive: true, force: true })
          rmSync(work, { recursive: true, force: true })
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
    // R2-06：upper 身份（mount id 卸载后会被内核复用 —— upper dev/ino 是
    // 更强绑定：攻击者替换 upper 重挂载 → 身份不匹配 → fail-closed）。
    // R5-04：mountpoint 身份（merged dev/ino）+ fsType/source 一并绑定。
    // R6-05-1：wasMounted —— 本次 invocation 确实完成了 FUSE mount；
    // 之后 mount 消失（外部卸载）→ assertMountOwned 必须 false（仅剩
    // 底层 merged inode 不算 owned —— 生产 backend 无「从未挂载」状态）。
    const wasMounted = mounted
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
      // R5-04：mountpoint 身份（dev/ino）+ fsType/source 一并复核。
      // R6-05：多因子 ownership 复核 —— mount id + fsType + source +
      // upper 身份 + daemon 命令行，缺任何一项都拒绝（/proc cmdline 子串
      // 从不单独构成 authority）。
      assertMountOwned: () => {
        if (!existsSync(merged)) return false
        try {
          const stat = lstatSync(merged)
          if (stat.isSymbolicLink()) return false
        } catch {
          return false
        }
        // R6-05-1：生产 backend 已真实挂载过 —— mount 消失（无 FUSE
        // mountinfo/statfs）→ 直接 false。仅剩底层 merged inode 不算 owned
        // （曾挂载 ≠ 仍挂载；生产 backend 无「从未挂载」回退）。
        if (wasMounted) {
          return this.fullOwnershipCheck(merged, upper, upperIdentity, mountId, sealedMountId)
        }
        // 从未挂载（仅测试可构造的退化路径）：mountpoint 必须是原目录。
        try {
          const stat = lstatSync(merged)
          if (stat.dev !== mergedIdentity.dev || stat.ino !== mergedIdentity.ino) return false
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
        if (sealedId === undefined) {
          // R5-04：RO remount 成功但 attestation 失败 —— 若 merged 仍是
          // FUSE mount 且 upper 身份未变（我们的 ro remount），**不得遗失
          // owned mount 的清理依据**：记录 lenient mount id → cleanup 仍
          // 能卸载（OWNED_MOUNT_SILENT_LEAK = 0）；seal 本身 fail-closed。
          if (this.isFuseMount(merged)) {
            const lenient = fuseMountInfo(merged)
            if (lenient !== undefined && this.upperMatches(upper, upperIdentity)) {
              sealedMountId = lenient.id
              return { error: "read-only remount attestation failed (mount retained for cleanup; seal refused)" }
            }
            return { error: "read-only remount produced an unowned/foreign FUSE mount; seal refused" }
          }
          return { error: "read-only remount did not produce a real FUSE mount; seal refused" }
        }
        // R6-05-4：RO remount 后**重新证明完整 ownership**（多因子：mount
        // id + fsType + source + upper 身份 + daemon 命令行）—— 仅凭 mount
        // id 存在不够（foreign 同路径重挂载 / 替换 upper 均拒绝）。
        if (!this.fullOwnershipCheck(merged, upper, upperIdentity, mountId, sealedId)) {
          return { error: "read-only remount ownership re-proof failed (mount id/fsType/source/upper/daemon mismatch); seal refused" }
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
          // R2-06-4/R3-00-8/R5-04：只卸载本 projection 创建的 mount ——
          // mountId 匹配 + upper 身份一致 + daemon 命令行使用我们的 upper
          // （mount id 会被内核复用；foreign/unknown/replaced 一律拒绝卸载、
          // 拒绝 rm/chmod 任何内容）。
          if (
            (current !== mountId && current !== sealedMountId) ||
            !upperOwned ||
            !this.fuseDaemonUsesUpper(merged, upper)
          ) {
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
        // R7-04/R7-00-7：**所有删除分支先复核身份** —— mount 消失不代表
        // 路径仍归本 session 所有：upper/work 被替换为 foreign 目录 →
        // 不 rm/chmod，返回 residue（cleanup failure）。merged 同理
        // （身份不符 → 不 rmdir）。
        let workOwned = false
        try {
          const workNow = lstatSync(work)
          workOwned = workNow.dev === workIdentity.dev && workNow.ino === workIdentity.ino
        } catch {
          workOwned = false
        }
        if (!upperOwned || !workOwned) {
          // foreign/replaced/unknown 路径：不 unmount、不 chmod、不 rm。
          return false
        }
        try {
          rmSync(upper, { recursive: true, force: true })
          rmSync(work, { recursive: true, force: true })
          if (existsSync(merged)) {
            if (this.isFuseMount(merged)) return false
            try {
              const mergedNow = lstatSync(merged)
              if (
                mergedNow.dev !== mergedIdentity.dev ||
                mergedNow.ino !== mergedIdentity.ino
              ) {
                return false
              }
            } catch {
              return false
            }
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

  /** R6-05-2/3/4：统一多因子 ownership 复核（assertMountOwned 与 seal 共用）。
   *  mount id + fsType（fuse/fuse.*）+ source（fuse-overlayfs）+ upper 身份
   *  + daemon 命令行 —— 缺任何一项都拒绝；/proc cmdline 子串不单独构成
   *  authority。seal 后的 RO remount 用 sealedMountId 重新证明。 */
  private fullOwnershipCheck(
    merged: string,
    upper: string,
    upperIdentity: { readonly dev: number; readonly ino: number },
    mountId: string | undefined,
    sealedMountId: string | undefined,
  ): boolean {
    const info = fuseMountInfo(merged)
    if (info === undefined) return false
    // fsType：必须是 fuse / fuse.*（fuseMountInfo 已过滤 —— 显式再校验）。
    if (!(info.fsType === "fuse" || info.fsType.startsWith("fuse."))) return false
    if (info.source !== "fuse-overlayfs") return false
    if (info.id !== mountId && info.id !== sealedMountId) return false
    if (!this.upperMatches(upper, upperIdentity)) return false
    // R5-04/R6-05-3：mount id 会被内核复用 —— daemon 必须仍使用我们的
    // upper（多因子之一，不单独构成 authority）。
    if (!this.fuseDaemonUsesUpper(merged, upper)) return false
    return true
  }

  /** R5-04：upper 目录身份复核（mount/unmount/rm 的更强绑定）。 */
  private upperMatches(upper: string, upperIdentity: { readonly dev: number; readonly ino: number }): boolean {
    try {
      const upperNow = lstatSync(upper)
      return upperNow.dev === upperIdentity.dev && upperNow.ino === upperIdentity.ino
    } catch {
      return false
    }
  }

  /** R5-04：daemon 命令行必须仍使用我们的 upper（mount id 复用判别）。 */
  private fuseDaemonUsesUpper(merged: string, upper: string): boolean {
    return fuseDaemonUsesUpper(merged, upper)
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
