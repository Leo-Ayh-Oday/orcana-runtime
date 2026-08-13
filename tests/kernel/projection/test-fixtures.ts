/**
 * AK2-R4 —— test-only fixture factory。
 *
 * R4-01：fixture backend 从生产模块移出（src/kernel/projection/backend.ts
 * 不再导出任何 fixture 执行能力 —— PUBLIC_FIXTURE_AUTHORITY = 0）。
 * 本文件位于 tests/（非生产导出面）。
 *
 * 只允许经 `allowTestBackends: true` 的 test coordinator 使用；production
 * backend（kind !== "fixture"）永远不满足 receiptless gate。
 */

import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs"
import { join, resolve, sep } from "node:path"
import type {
  CreateProjectionInput,
  NativeProjectionBackend,
  ProjectionInstance,
} from "../../../src/kernel/projection/backend"
import { ProjectionError } from "../../../src/kernel/projection/contracts"

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

function makeTreeWritable(root: string): void {
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
 *
 * R4-06：sealForScan 为 mode-based 只读（dirs 0555 / files 0444）——
 * 同 UID 可 chmod 还原，因此只是 fixture 语义；真实 seal 是生产 backend
 * 的 FUSE ro remount（内核 EROFS）。
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

    let sealed = false
    return {
      backend: "fixture",
      mergedPath: merged,
      writeLayerPath: merged,
      assertReady: () => {
        statSync(merged)
        readdirSync(merged)
      },
      // R4-06：fixture seal —— mode-based 只读（test-only；同 UID 可还原，
      // 不冒充真实不可变证明）。
      sealForScan: () => {
        if (sealed) return { sealedPath: merged }
        const visit = (dir: string): void => {
          for (const entry of readdirSync(dir)) {
            const full = join(dir, entry)
            const stat = lstatSync(full)
            if (stat.isDirectory()) {
              chmodSync(full, 0o555)
              visit(full)
            } else if (stat.isFile()) {
              chmodSync(full, 0o444)
            }
          }
        }
        chmodSync(merged, 0o555)
        visit(merged)
        sealed = true
        return { sealedPath: merged }
      },
      cleanup: () => {
        if (!existsSync(merged)) return true
        // sealed 树（0555/0444）先还原可写再删除（rmSync 不能穿越只读目录）。
        try {
          makeTreeWritable(merged)
        } catch {
          return false
        }
        rmSync(merged, { recursive: true, force: true })
        return true
      },
    }
  }
}
