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
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  statSync,
  unlinkSync,
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

/** 打开目录（无跟随；非目录/symlink 拒绝），返回 fd + 身份。
 *  open 失败（缺失/替换为 symlink/bun 对 /proc/self/fd 缺失路径的
 *  EFAULT 等）统一包装为 DELTA_SCAN_FAILED（fail-closed，不泄露裸
 *  系统错误码）。 */
export function openDirAnchored(parentFd: number, name: string): { fd: number; identity: DirIdentity } {
  let fd: number
  try {
    fd = openAtNoFollow(parentFd, name, fsConstants.O_DIRECTORY)
  } catch (error) {
    throw new ProjectionError(
      "DELTA_SCAN_FAILED",
      `cannot open anchored directory ${name}`,
      error instanceof Error ? error.message : String(error),
    )
  }
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

/** 从锚定目录 fd 读取文件（O_NOFOLLOW；fstat 前后验证 dev/ino/type/size/
 *  nlink/mtime/ctime 与 walk 记录一致；swap/swap-back/grow/same-size
 *  in-place mutation → DELTA_SCAN_FAILED）。 */
export function readFileAnchored(
  parentFd: number,
  name: string,
  expected: { readonly dev: number; readonly ino: number; readonly size: number; readonly nlink: number; readonly mtimeMs?: number; readonly ctimeMs?: number },
  relative: string,
  onReadAfter?: (relative: string) => void,
): Buffer {
  let fd: number
  try {
    fd = openAtNoFollow(parentFd, name)
  } catch (error) {
    throw new ProjectionError(
      "DELTA_SCAN_FAILED",
      `cannot open anchored file ${relative}`,
      error instanceof Error ? error.message : String(error),
    )
  }
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
    if (expected.mtimeMs !== undefined && before.mtimeMs !== expected.mtimeMs) {
      throw new ProjectionError("DELTA_SCAN_FAILED", `entry mtime changed during scan (in-place mutation): ${relative}`)
    }
    if (expected.ctimeMs !== undefined && before.ctimeMs !== expected.ctimeMs) {
      throw new ProjectionError("DELTA_SCAN_FAILED", `entry ctime changed during scan (in-place mutation): ${relative}`)
    }
    const bytes = readFileSync(fd)
    // 测试注入窗口：读取后、复核前（模拟读取期间被同 size 原地覆盖）。
    onReadAfter?.(relative)
    // R2-05：读后二次读取（reopen）内容对比 —— bun 的 statSync 存在进程内
    // 偶发缓存（写入后立即 fstat 可能返回旧时间戳），时间戳检查之上叠加
    // 内容级校验（同 size 原地覆盖必然被捕获；缓存盲窗不产生假阴性）。
    let verify: Buffer
    const verifyFd = openAtNoFollow(parentFd, name)
    try {
      verify = readFileSync(verifyFd)
    } finally {
      closeSync(verifyFd)
    }
    const after = fstatSync(fd)
    if (!after.isFile() || after.dev !== expected.dev || after.ino !== expected.ino) {
      throw new ProjectionError("DELTA_SCAN_FAILED", `entry identity changed during read: ${relative}`)
    }
    if (after.nlink !== expected.nlink) {
      throw new ProjectionError("DELTA_SCAN_FAILED", `entry link count changed during read: ${relative}`)
    }
    if (expected.mtimeMs !== undefined && after.mtimeMs !== expected.mtimeMs) {
      throw new ProjectionError("DELTA_SCAN_FAILED", `entry mtime changed during read (in-place mutation): ${relative}`)
    }
    if (bytes.byteLength !== expected.size) {
      throw new ProjectionError("DELTA_SCAN_FAILED", `file size changed during scan (grow/shrink): ${relative}`)
    }
    if (verify.byteLength !== bytes.byteLength || !verify.equals(bytes)) {
      throw new ProjectionError("DELTA_SCAN_FAILED", `file content changed during scan (in-place mutation): ${relative}`)
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

/**
 * R3-03.4/5：fd 锚定、no-follow、identity-fenced 的树删除原语。
 *
 * 传入**已验证**的根目录 fd（open O_NOFOLLOW|O_DIRECTORY 获得）。递归
 * 删除全程经过 `/proc/self/fd/<fd>/<name>` 相对解析（父目录 rename/swap
 * 不影响已锚定 fd）：
 * - 子项 open 带 O_NOFOLLOW（symlink/特殊文件拒绝跟随 → 直接 unlink 本身）；
 * - 目录 fchmod(fd)（fchmod 不跟随，外部 sentinel 不被 chmod）；
 * - 文件/符号链接 unlink（不跟随）；
 * - 返回后调用方 closeSync(fd) + 空目录 rmdir（调用方负责路径身份再验证）。
 */
export function removeTreeAnchored(rootFd: number, relative = ""): void {
  let names: string[]
  try {
    names = readdirSync(join("/proc/self/fd", String(rootFd))) as string[]
  } catch (error) {
    throw new ProjectionError(
      "PROJECTION_ROOT_ESCAPE",
      `cannot read projection subtree ${relative}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  for (const raw of names) {
    const name = Buffer.from(raw).toString("utf8")
    const child = join("/proc/self/fd", String(rootFd), name)
    let stat
    try {
      stat = lstatSync(child)
    } catch (error) {
      // 条目已消失（并发删除）—— 继续（fail-open 于条目本身，但 fd 锚定
      // 保证不会误删其他路径）。
      continue
    }
    if (stat.isDirectory()) {
      let childFd: number
      try {
        childFd = openSync(
          child,
          fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
        )
      } catch (error) {
        // 目录被替换为 symlink/文件 → 拒绝跟随；直接 unlink 条目本身。
        unlinkSync(child)
        continue
      }
      try {
        fchmodSync(childFd, 0o700)
        removeTreeAnchored(childFd, join(relative, name))
      } finally {
        closeSync(childFd)
      }
      try {
        // 目录用 rmdir（unlink 对目录 EISDIR；打开中的目录 EPERM ——
        // childFd 已关闭）。非空（并发写入）→ residue 保留（调用方以
        // cleanupOk=false 记录）。
        rmdirSync(child)
      } catch (error) {
        throw new ProjectionError(
          "PROJECTION_ROOT_ESCAPE",
          `projection subtree not empty after anchored removal: ${join(relative, name)} (${error instanceof Error ? (error as Error & { code?: string }).code ?? error.message : String(error)})`,
        )
      }
    } else {
      // 文件 / symlink / 特殊文件：unlink 不跟随 symlink（sentinel 安全）。
      try {
        unlinkSync(child)
      } catch (error) {
        throw new ProjectionError(
          "PROJECTION_ROOT_ESCAPE",
          `cannot remove projection entry ${join(relative, name)}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  }
}
