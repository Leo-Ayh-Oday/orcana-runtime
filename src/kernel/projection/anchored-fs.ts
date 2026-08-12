/**
 * AK-2 Anchored Traversal 原语（P1-5）—— scanner 与 validator 共享。
 *
 * O_NOFOLLOW 只保护最终 component；这里提供 dirfd 锚定的逐层无跟随
 * 查找：
 * - root 以 open(O_DIRECTORY|O_NOFOLLOW) 打开，后续路径解析全部相对
 *   已打开的目录 fd（`/proc/self/fd/<fd>/<name>`，内核特殊处理 fd
 *   symlink 跟随）—— 父目录 rename/swap 不影响已锚定的 fd；
 * - 每层 open 都带 O_NOFOLLOW（任何 symlink 组件拒绝）；
 * - 目录打开后 fstat 验证类型；文件读取前后 fstat 验证 dev/ino/type/
 *   size/nlink 与 walk 记录一致（swap/swap-back/grow fail-closed）。
 */

import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs"
import { join } from "node:path"
import { ProjectionError } from "./contracts"

/** 通过已锚定目录 fd 相对打开（no-follow 最终组件；O_NONBLOCK ——
 *  FIFO/device 的 O_RDONLY 打开会阻塞，必须立即返回供 fstat 拒绝）。 */
export function openAtNoFollow(dirFd: number, name: string, extraFlags = 0): number {
  return openSync(
    join("/proc/self/fd", String(dirFd), name),
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK | extraFlags,
  )
}

/** 目录身份（dev/ino/nlink）—— walk 记录与复核用。 */
export interface DirIdentity {
  readonly dev: number
  readonly ino: number
}

/** 打开目录（无跟随；非目录/symlink 拒绝），返回 fd + 身份。 */
export function openDirAnchored(parentFd: number, name: string): { fd: number; identity: DirIdentity } {
  const fd = openAtNoFollow(parentFd, name, fsConstants.O_DIRECTORY)
  const stat = fstatSync(fd)
  if (!stat.isDirectory()) {
    closeSync(fd)
    throw new ProjectionError("DELTA_SCAN_FAILED", `anchored open is not a directory: ${name}`)
  }
  return { fd, identity: { dev: stat.dev, ino: stat.ino } }
}

/** 打开根目录（无跟随；必须真实目录）。 */
export function openRootAnchored(rootPath: string): { fd: number; identity: DirIdentity } {
  let fd: number
  try {
    fd = openSync(rootPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_DIRECTORY)
  } catch (error) {
    throw new ProjectionError(
      "DELTA_SCAN_FAILED",
      `cannot open root anchored: ${rootPath}`,
      error instanceof Error ? error.message : String(error),
    )
  }
  const stat = fstatSync(fd)
  if (!stat.isDirectory()) {
    closeSync(fd)
    throw new ProjectionError("DELTA_SCAN_FAILED", `root is not a directory: ${rootPath}`)
  }
  return { fd, identity: { dev: stat.dev, ino: stat.ino } }
}

/** 从锚定目录 fd 读取文件（O_NOFOLLOW；fstat 前后验证 dev/ino/type/size/nlink
 *  与 walk 记录一致；swap/swap-back/grow → DELTA_SCAN_FAILED）。 */
export function readFileAnchored(
  parentFd: number,
  name: string,
  expected: { readonly dev: number; readonly ino: number; readonly size: number; readonly nlink: number },
  relative: string,
): Buffer {
  const fd = openAtNoFollow(parentFd, name)
  try {
    const before = fstatSync(fd)
    if (!before.isFile()) {
      throw new ProjectionError("DELTA_SCAN_FAILED", `entry type changed during scan: ${relative}`)
    }
    if (before.dev !== expected.dev || before.ino !== expected.ino) {
      throw new ProjectionError("DELTA_SCAN_FAILED", `entry identity changed during scan: ${relative}`)
    }
    if (before.nlink !== expected.nlink) {
      throw new ProjectionError("DELTA_SCAN_FAILED", `entry link count changed during scan: ${relative}`)
    }
    const bytes = readFileSync(fd)
    const after = fstatSync(fd)
    if (!after.isFile() || after.dev !== expected.dev || after.ino !== expected.ino) {
      throw new ProjectionError("DELTA_SCAN_FAILED", `entry identity changed during read: ${relative}`)
    }
    if (after.nlink !== expected.nlink) {
      throw new ProjectionError("DELTA_SCAN_FAILED", `entry link count changed during read: ${relative}`)
    }
    if (bytes.byteLength !== expected.size) {
      throw new ProjectionError("DELTA_SCAN_FAILED", `file size changed during scan (grow/shrink): ${relative}`)
    }
    return bytes
  } finally {
    closeSync(fd)
  }
}

/** 锚定目录的 readdir（原始字节 + 排序 + 名称卫生在调用方）。
 *  bun 的 readdirSync 不接受 fd —— 经 /proc/self/fd/<fd> 路径解析到
 *  已锚定目录（rename/swap 不影响 fd 指向的 inode）。 */
export function readDirAnchored(fd: number): Buffer[] {
  return readdirSync(join("/proc/self/fd", String(fd)), { encoding: "buffer" }) as Buffer[]
}

/** expected-output 类型检查（validator）：O_NOFOLLOW 锚定打开 + fstat
 *  验证（symlink/special file 拒绝）。 */
export function statExpectedOutputAnchored(rootFd: number, relPath: string, output: string): "file" | "directory" {
  const segments = relPath.split("/")
  const opened: number[] = []
  try {
    let dirFd = rootFd
    for (let index = 0; index < segments.length - 1; index++) {
      const { fd } = openDirAnchored(dirFd, segments[index]!)
      opened.push(fd)
      dirFd = fd
    }
    const name = segments[segments.length - 1]!
    const fd = openAtNoFollow(dirFd, name)
    try {
      const stat = fstatSync(fd)
      if (stat.isFile()) return "file"
      if (stat.isDirectory()) return "directory"
      throw new ProjectionError("VALIDATION_REJECTED", `expected output is not a regular file/directory: ${output}`)
    } finally {
      closeSync(fd)
    }
  } catch (error) {
    // 共享原语以 DELTA_SCAN_FAILED 表达拒绝 —— validator 语义统一为
    // VALIDATION_REJECTED（缺失/symlink/类型/身份变化全部 fail-closed）。
    throw new ProjectionError(
      "VALIDATION_REJECTED",
      `expected output check failed: ${output}`,
      error instanceof Error ? error.message : String(error),
    )
  } finally {
    for (const fd of opened) {
      try {
        closeSync(fd)
      } catch {
        // 已关
      }
    }
  }
}

/** 校验目录 fd 身份未变（目录替换 → fail-closed）。 */
export function assertDirIdentityUnchanged(fd: number, expected: DirIdentity, relative: string): void {
  const stat = fstatSync(fd)
  if (!stat.isDirectory() || stat.dev !== expected.dev || stat.ino !== expected.ino) {
    throw new ProjectionError("DELTA_SCAN_FAILED", `directory identity changed during scan: ${relative}`)
  }
}
