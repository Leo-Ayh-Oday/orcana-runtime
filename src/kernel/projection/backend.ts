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
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  cpSync,
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
  /**
   * 清理本 projection 自己创建的资源（卸载 merged、删除 upper/work）。
   * 返回清理是否成功；失败时调用方必须阻止 World commit。
   * 幂等：第二次调用返回 true。
   */
  cleanup(): boolean
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

/**
 * 生产 backend —— fuse-overlayfs（无特权 mount 时真实可用；探测确认）。
 * overlayfs 由探测函数报告（有 CAP_SYS_ADMIN 时）但本实现统一走
 * fuse-overlayfs 二进制；若环境只有 native overlayfs，create 会明确失败。
 */
export class FuseOverlayfsProjectionBackend implements NativeProjectionBackend {
  readonly id = "fuse-overlayfs"
  readonly kind = "fuse-overlayfs" as const

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
    mkdirSync(merged, { mode: 0o700 })

    let mounted = false
    try {
      // 数组参数 + 无 shell；路径已拒绝 `,`/`:` 注入。
      execFileSyncSafe("fuse-overlayfs", ["-o", `lowerdir=${lower},upperdir=${upper},workdir=${work}`, merged])
      mounted = true
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
      // 挂载失败 → 清理已建目录后抛出。
      if (mounted) this.unmount(merged)
      rmSync(upper, { recursive: true, force: true })
      rmSync(work, { recursive: true, force: true })
      rmSync(merged, { recursive: true, force: true })
      throw error instanceof ProjectionError
        ? error
        : new ProjectionError(
            "BACKEND_UNAVAILABLE",
            `fuse-overlayfs mount failed for ${label}`,
            error instanceof Error ? error.message : String(error),
          )
    }

    return {
      backend: "fuse-overlayfs",
      mergedPath: merged,
      writeLayerPath: upper,
      assertReady: () => {
        statSync(merged)
        readdirSync(merged)
      },
      cleanup: () => {
        if (!existsSync(merged) && !existsSync(upper) && !existsSync(work)) return true
        let ok = true
        // 幂等：仅当 merged 仍是 FUSE 挂载点才卸载（statfs type=FUSE_SUPER_MAGIC）。
        if (this.isFuseMount(merged)) ok = this.unmount(merged) && ok
        // 只删除本 projection 创建的 upper/work。
        rmSync(upper, { recursive: true, force: true })
        rmSync(work, { recursive: true, force: true })
        return ok
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
    const { chmodSync, lstatSync, readdirSync } = require("node:fs") as typeof import("node:fs")
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

function makeTreeWritable(root: string): void {
  const { chmodSync, lstatSync, readdirSync } = require("node:fs") as typeof import("node:fs")
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      const stat = lstatSync(full)
      if (stat.isDirectory()) {
        chmodSync(full, 0o700)
        visit(full)
      } else if (stat.isFile()) {
        chmodSync(full, 0o600)
      }
    }
  }
  chmodSync(root, 0o700)
  visit(root)
}

/**
 * TEST FIXTURE ONLY —— 确定性 copy backend：把 lower 复制为可写 merged。
 * 不创建任何真实 overlay 语义；仅用于 coordinator/delta/commit 逻辑测试。
 * 绝对不作为真实 Linux backend 通过证据。
 */
export class CopyProjectionFixtureBackend implements NativeProjectionBackend {
  readonly id = "fixture-copy"
  readonly kind = "fixture" as const
  readonly testFixtureOnly = true

  create(input: CreateProjectionInput): ProjectionInstance {
    const label = assertSafeLabel(input.label)
    const projectionRoot = resolve(input.projectionRoot)
    const lower = assertSafeMountPath(input.lowerDir, projectionRoot)
    assertRealDirectory(lower, "lower")
    assertRealDirectory(projectionRoot, "projectionRoot")

    const merged = assertSafeMountPath(join(projectionRoot, `merged-${label}`), projectionRoot)
    mkdirSync(merged, { mode: 0o700 })
    // 复制 lower → merged（可写副本；lower 的只读 mode 不继承 —— upper 语义）。
    cpSync(lower, merged, { recursive: true })
    makeTreeWritable(merged)

    return {
      backend: "fixture",
      mergedPath: merged,
      writeLayerPath: merged,
      assertReady: () => {
        statSync(merged)
        readdirSync(merged)
      },
      cleanup: () => {
        if (!existsSync(merged)) return true
        rmSync(merged, { recursive: true, force: true })
        return true
      },
    }
  }
}

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
