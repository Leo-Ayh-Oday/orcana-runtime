/**
 * AK2-R4 Correction Gate —— R4-00-10 World 最终 namespace 反例冻结。
 *
 * 每个反例在修复前必须 RED（断言当前 store 校验的错误行为），修复后
 * GREEN。要求 validator 重写为真正 final-state 模型（R4-07）：
 * 1. 先按 objectId 加载 current state；
 * 2. 按 mutation 应用 delete/put（put 同一 objectId 先移除旧 state/path）；
 * 3. 从最终 byId 重建 byPath；
 * 4. 全局验证：canonical path / path 唯一 / objectId 唯一身份 /
 *    file+directory 必须有 path / workspace 必须无 path /
 *    file 必须有 contentRef / 显式祖先必须为 directory / file 不得为祖先。
 */

import { describe, expect, test } from "bun:test"
import { createTestWorldStore } from "./helpers"

function mkStore(worldId: string): ReturnType<typeof createTestWorldStore> {
  const c = createTestWorldStore()
  c.store.createWorld({ worldId, branchId: "b", rootObjectId: "r", owner: "o", purpose: "p" })
  return c
}

function fileDigest(c: ReturnType<typeof createTestWorldStore>, content = "x\n"): string {
  return c.store.cas.put(Buffer.from(content, "utf8"), "text/plain").digest
}

describe("AK2-R4-00-10 World namespace 反例（先红冻结）", () => {
  test("R4-00-10a：directory object 从 a 移到 b 后留下 a/x orphan → 拒绝", () => {
    const c = mkStore("w-ns10a")
    const d = fileDigest(c)
    c.store.compareAndCommit({
      worldId: "w-ns10a", branchId: "b", baseRevision: 0n, actor: "a",
      mutations: [
        { type: "object.put", objectId: "D", objectType: "directory", path: "a" },
        { type: "object.put", objectId: "F", objectType: "file", path: "a/x", contentRef: d },
      ],
    })
    // 只 put D 到 b（未删除 a）：最终 byId 里 D 只应在 b，a/x 失去祖先。
    try {
      c.store.compareAndCommit({
        worldId: "w-ns10a", branchId: "b", baseRevision: 1n, actor: "a",
        mutations: [{ type: "object.put", objectId: "D", objectType: "directory", path: "b" }],
      })
      throw new Error("R4-00-10a RED: moved directory left orphan child a/x and was accepted")
    } catch (error) {
      expect(String((error as Error).message)).toMatch(/ancestor|orphan|namespace/i)
    }
    expect(c.store.getWorld("w-ns10a")!.currentRevision).toBe(1n)
    c.cleanup()
  })

  test("R4-00-10b：directory a/b + file a 的反序 mutation → 拒绝（file 不能成为祖先）", () => {
    const c = mkStore("w-ns10b")
    const d = fileDigest(c)
    try {
      c.store.compareAndCommit({
        worldId: "w-ns10b", branchId: "b", baseRevision: 0n, actor: "a",
        mutations: [
          { type: "object.put", objectId: "D", objectType: "directory", path: "a/b" },
          { type: "object.put", objectId: "F", objectType: "file", path: "a", contentRef: d },
        ],
      })
      throw new Error("R4-00-10b RED: directory under file ancestor a was accepted")
    } catch (error) {
      expect(String((error as Error).message)).toMatch(/ancestor|file|namespace/i)
    }
    expect(c.store.getWorld("w-ns10b")!.currentRevision).toBe(0n)
    c.cleanup()
  })

  test("R4-00-10c：pathless file / pathless directory → 拒绝", () => {
    {
      const c = mkStore("w-ns10c1")
      const d = fileDigest(c)
      try {
        c.store.compareAndCommit({
          worldId: "w-ns10c1", branchId: "b", baseRevision: 0n, actor: "a",
          mutations: [{ type: "object.put", objectId: "F", objectType: "file", contentRef: d }],
        })
        throw new Error("R4-00-10c RED: pathless file accepted")
      } catch (error) {
        expect(String((error as Error).message)).toMatch(/path|namespace/i)
      }
      expect(c.store.getWorld("w-ns10c1")!.currentRevision).toBe(0n)
      c.cleanup()
    }
    {
      const c = mkStore("w-ns10c2")
      try {
        c.store.compareAndCommit({
          worldId: "w-ns10c2", branchId: "b", baseRevision: 0n, actor: "a",
          mutations: [{ type: "object.put", objectId: "D", objectType: "directory" }],
        })
        throw new Error("R4-00-10c RED: pathless directory accepted")
      } catch (error) {
        expect(String((error as Error).message)).toMatch(/path|namespace/i)
      }
      expect(c.store.getWorld("w-ns10c2")!.currentRevision).toBe(0n)
      c.cleanup()
    }
  })

  test("R4-00-10d：pathful workspace → 拒绝（workspace 必须无 path，与 materializer 契约一致）", () => {
    const c = mkStore("w-ns10d")
    try {
      c.store.compareAndCommit({
        worldId: "w-ns10d", branchId: "b", baseRevision: 0n, actor: "a",
        mutations: [{ type: "object.put", objectId: "W", objectType: "workspace", path: "ws" }],
      })
      throw new Error("R4-00-10d RED: workspace with path accepted")
    } catch (error) {
      expect(String((error as Error).message)).toMatch(/workspace|path|namespace/i)
    }
    expect(c.store.getWorld("w-ns10d")!.currentRevision).toBe(0n)
    c.cleanup()
  })

  test("R4-00-10e：object move 后由其他 object 复用旧 path → 必须接受（final-state 语义）", () => {
    const c = mkStore("w-ns10e")
    c.store.compareAndCommit({
      worldId: "w-ns10e", branchId: "b", baseRevision: 0n, actor: "a",
      mutations: [{ type: "object.put", objectId: "D", objectType: "directory", path: "a" }],
    })
    // D 移到 b（旧 path a 释放），E 复用 a —— 最终 byId：D→b、E→a。
    try {
      const receipt = c.store.compareAndCommit({
        worldId: "w-ns10e", branchId: "b", baseRevision: 1n, actor: "a",
        mutations: [
          { type: "object.put", objectId: "D", objectType: "directory", path: "b" },
          { type: "object.put", objectId: "E", objectType: "directory", path: "a" },
        ],
      })
      expect(receipt.newRevision).toBe(2n)
    } catch (error) {
      throw new Error(`R4-00-10e RED: valid move + old-path reuse rejected: ${(error as Error).message}`)
    }
    expect(c.store.getWorld("w-ns10e")!.currentRevision).toBe(2n)
    c.cleanup()
  })
})
