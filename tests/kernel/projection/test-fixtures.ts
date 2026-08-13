/**
 * AK2-R4 TEST-ONLY factory —— fixture 执行 authority 的唯一来源。
 *
 * R4-01：fixture backend / coordinator / 放行 token 全部移出生产导出面：
 * - `CopyProjectionFixtureBackend` 不再从 src/kernel/projection/backend.ts
 *   导出（生产 index.ts 的 export * 面不得包含 fixture 实现）；
 * - `FIXTURE_EXECUTION_TOKEN` 只在 tests/ 定义 —— 任何生产模块无法导入；
 * - `createFixtureProjectionCoordinator()` 是构造 fixture coordinator 的
 *   唯一受支持入口（自动注入 token + allowTestBackends）。
 *
 * 注意：token 是不透明标记（无密码学权重）—— 真正的结构性门是
 * `backend.kind === "fixture"`（production backend 永远不满足）。token
 * 只表达「调用方显式选择了 test-only capability」。
 */

import { mkdirSync, cpSync, chmodSync, existsSync, statSync, readdirSync, rmSync, lstatSync } from "node:fs"
import { join, resolve, sep } from "node:path"
import type { CreateProjectionInput, NativeProjectionBackend, ProjectionInstance } from "../../../src/kernel/projection/backend"
import { ProjectionError } from "../../../src/kernel/projection/contracts"
import { ProjectionCoordinator, type ProjectionCoordinatorOptions } from "../../../src/kernel/projection/coordinator"

/** fixture 执行放行 token —— test-only。生产模块不得导入本模块。 */
export const FIXTURE_EXECUTION_TOKEN: unique symbol = Symbol("orcana.ak2.fixture-execution")

/** 校验 label / 路径（与生产 backend 相同的不变量）。 */
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

/** 构造 fixture coordinator（test-only 工厂；自动注入 token + 显式 test
 *  capability）。production 代码不得调用。 */
export function createFixtureProjectionCoordinator(
  options: Omit<ProjectionCoordinatorOptions, "backend" | "fixtureExecutionToken" | "allowTestBackends"> & {
    backend?: NativeProjectionBackend
  },
): ProjectionCoordinator {
  return new ProjectionCoordinator({
    ...options,
    backend: options.backend ?? new CopyProjectionFixtureBackend(),
    allowTestBackends: true,
    fixtureExecutionToken: FIXTURE_EXECUTION_TOKEN,
  })
}
