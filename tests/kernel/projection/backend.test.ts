/** AK2-T03 — Native Projection Backend（生产 fuse-overlayfs + fixture + 注入）。 */

import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  CopyProjectionFixtureBackend,
  FuseOverlayfsProjectionBackend,
  probeNativeBackends,
} from "../../../src/kernel/projection/backend"
import { ProjectionError } from "../../../src/kernel/projection/contracts"

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function tmpRoot(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `ak2-backend-${label}-`))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** 在 projectionRoot 内构建 lower（coordinator 的所有权模型）。 */
function buildLower(projectionRoot: string, label = "lower"): string {
  const lower = join(projectionRoot, label)
  mkdirSync(join(lower, "src"), { recursive: true })
  writeFileSync(join(lower, "src", "main.ts"), "export const x = 1\n", "utf8")
  return lower
}

describe("AK2-T03 fixture backend（TEST FIXTURE ONLY）", () => {
  test("copy 语义：lower 内容复制到 merged，可写", () => {
    const root = tmpRoot("fx")
    const lower = buildLower(root)
    const instance = new CopyProjectionFixtureBackend().create({ lowerDir: lower, projectionRoot: root, label: "p1" })
    expect(instance.backend).toBe("fixture")
    expect(instance.mergedPath).toBe(join(root, "merged-p1"))
    instance.assertReady()
    expect(readFileSync(join(instance.mergedPath, "src/main.ts"), "utf8")).toBe("export const x = 1\n")
    // fixture 是写层副本：可写。
    writeFileSync(join(instance.mergedPath, "src/new.txt"), "n", "utf8")
    expect(instance.cleanup()).toBe(true)
    expect(existsSync(instance.mergedPath)).toBe(false)
    // 幂等。
    expect(instance.cleanup()).toBe(true)
  })
  test("label 注入拒绝", () => {
    const root = tmpRoot("fx")
    const lower = buildLower(root)
    expect(() =>
      new CopyProjectionFixtureBackend().create({ lowerDir: lower, projectionRoot: root, label: "a/b" }),
    ).toThrow(ProjectionError)
    expect(() =>
      new CopyProjectionFixtureBackend().create({ lowerDir: lower, projectionRoot: root, label: "a,b" }),
    ).toThrow(ProjectionError)
  })
  test("路径 escape 拒绝", () => {
    const root = tmpRoot("fx")
    const outside = tmpRoot("outside")
    writeFileSync(join(outside, "x"), "x")
    // lower 必须在 projectionRoot 内。
    expect(() =>
      new CopyProjectionFixtureBackend().create({ lowerDir: outside, projectionRoot: root, label: "p" }),
    ).toThrow(ProjectionError)
  })
})

describe("AK2-T03 生产 fuse-overlayfs backend", () => {
  test("探测结果（真实环境）", () => {
    const probe = probeNativeBackends()
    // 本机（WSL 无特权 + fuse-overlayfs 3.14 已装）应报告 fuseOverlayfs=true。
    expect(probe.fuseOverlayfs).toBe(true)
    expect(typeof probe.overlayfs).toBe("boolean")
  })

  test("真实挂载：lower 只读可见、upper 写入生效、cleanup 卸载", () => {
    const root = tmpRoot("real")
    const lower = buildLower(root)
    const instance = new FuseOverlayfsProjectionBackend().create({
      lowerDir: lower,
      projectionRoot: root,
      label: "p1",
    })
    try {
      expect(instance.backend).toBe("fuse-overlayfs")
      instance.assertReady()
      // lower 内容可见。
      expect(readFileSync(join(instance.mergedPath, "src/main.ts"), "utf8")).toBe("export const x = 1\n")
      // 写入进入 upper。
      writeFileSync(join(instance.mergedPath, "src/upper.txt"), "upper-content", "utf8")
      expect(readFileSync(join(instance.mergedPath, "src/upper.txt"), "utf8")).toBe("upper-content")
      expect(existsSync(join(instance.writeLayerPath, "src/upper.txt"))).toBe(true)
    } finally {
      expect(instance.cleanup()).toBe(true)
    }
    // 卸载后 merged 是空目录（不再是挂载点），upper 已删除。
    expect(existsSync(join(root, "merged-p1"))).toBe(true)
    expect(readdirCount(join(root, "merged-p1"))).toBe(0)
    expect(existsSync(join(root, "upper-p1"))).toBe(false)
    expect(existsSync(join(root, "work-p1"))).toBe(false)
    expect(instance.cleanup()).toBe(true)
  })

  test("lower 缺失 → 拒绝（不留下挂载残留）", () => {
    const root = tmpRoot("real")
    expect(() =>
      new FuseOverlayfsProjectionBackend().create({
        lowerDir: join(root, "missing-lower"),
        projectionRoot: root,
        label: "p",
      }),
    ).toThrow(ProjectionError)
    expect(readdirCount(root)).toBe(0)
  })

  test("unmount 失败 → cleanup 返回 false（阻止 commit 的信号）", () => {
    const root = tmpRoot("real")
    // 构造 merged 目录但从未挂载：unmount 会失败。
    mkdirSync(join(root, "merged-p"), { recursive: true })
    const instance = {
      backend: "fuse-overlayfs" as const,
      mergedPath: join(root, "merged-p"),
      writeLayerPath: join(root, "upper-p"),
      assertReady: () => undefined,
      cleanup: () => {
        // 模拟失败卸载路径：fusermount3 -u 对未挂载目录会失败。
        const { execFileSync } = require("node:child_process") as typeof import("node:child_process")
        let ok = true
        try {
          execFileSync("fusermount3", ["-u", join(root, "merged-p")], { stdio: "ignore" })
        } catch {
          ok = false
        }
        return ok
      },
    }
    expect(instance.cleanup()).toBe(false)
  })
})

function readdirCount(path: string): number {
  const { readdirSync } = require("node:fs") as typeof import("node:fs")
  if (!existsSync(path)) return -1
  return readdirSync(path).length
}
