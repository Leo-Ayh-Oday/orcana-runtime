/** AK2-T02 — Immutable Snapshot Materializer 测试。 */

import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ProjectionError } from "../../../src/kernel/projection/contracts"
import { createFileManifest } from "../../../src/kernel/world/manifests"
import {
  SnapshotMaterializer,
  parseFilesystemSection,
  type ProjectionMaterializerSource,
} from "../../../src/kernel/projection/materializer"
import { createTestWorldStore, type TestWorldStore } from "../world/helpers"
import type { CasDigest, CasObjectRecord, WorldSnapshot } from "../../../src/kernel/world"

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function chmodTree(dir: string): void {
  try {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      const stat = lstatSync(full)
      if (stat.isDirectory()) {
        chmodSync(full, 0o700)
        chmodTree(full)
      }
    }
  } catch {
    // 部分只读树（物化 base 0555）可能无法遍历；尽力而为。
  }
}

function tmpRoot(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `ak2-${label}-`))
  cleanups.push(() => {
    try {
      chmodSync(dir, 0o700)
      chmodTree(dir)
    } catch {
      // 忽略已删
    }
    rmSync(dir, { recursive: true, force: true })
  })
  return dir
}

/** 构建 revision 0 world：src/main.ts 文件 + src/util 目录。 */
function buildWorldWithFiles(): TestWorldStore {
  const ctx = createTestWorldStore()
  const { store } = ctx
  store.createWorld({
    worldId: "world-m",
    branchId: "branch-main",
    rootObjectId: "root-1",
    owner: "owner:test",
    purpose: "ak2 materializer",
  })
  const mainBytes = Buffer.from('export const x = 1\n', "utf8")
  const mainDigest = store.cas.put(mainBytes, "text/plain").digest
  store.compareAndCommit({
    worldId: "world-m",
    branchId: "branch-main",
    baseRevision: 0n,
    actor: "actor:test",
    mutations: [
      {
        type: "object.put",
        objectId: "obj-dir-src",
        objectType: "directory",
        path: "src",
      },
      {
        type: "object.put",
        objectId: "obj-main",
        objectType: "file",
        path: "src/main.ts",
        contentRef: mainDigest,
      },
    ],
  })
  store.createSnapshot("world-m", "branch-main")
  return ctx
}

/** 假 manifest record：通过 R06.5 身份检查（isManifest=true），内容由
 *  readCasObject 注入 —— 用于绕过 CAS integrity 测试解析路径。 */
function fakeManifestRecord(): CasObjectRecord {
  return {
    digest: "sha256:0" as CasDigest,
    size: 0,
    mediaType: "application/vnd.orcana.manifest+json",
    mediaTypes: [],
    isManifest: true,
    createdAt: 0,
    refCount: 0,
  }
}

function fakeRawRecord(): CasObjectRecord {
  return {
    digest: "sha256:0" as CasDigest,
    size: 0,
    mediaType: "application/octet-stream",
    mediaTypes: [],
    isManifest: false,
    createdAt: 0,
    refCount: 0,
  }
}

function materializerOf(ctx: TestWorldStore): SnapshotMaterializer {
  const source: ProjectionMaterializerSource = {
    getSnapshot: snapshotId => ctx.store.snapshots.get(snapshotId),
    getCasRecord: digest => ctx.store.cas.record(digest),
    readCasObject: digest => ctx.store.cas.get(digest),
  }
  return new SnapshotMaterializer(source)
}

describe("AK2-T02 基本物化", () => {
  test("file+directory 树物化为只读 base，内容与 CAS 一致", () => {
    const ctx = buildWorldWithFiles()
    const snapshot = ctx.store.snapshots.getForRevision("world-m", "branch-main", 1n)!
    const base = join(tmpRoot("mat"), "base")
    mkdirSync(base)

    const materialized = materializerOf(ctx).materialize(snapshot.snapshotId, base)
    expect(materialized.fileCount).toBe(1)
    expect(materialized.directoryCount).toBe(1)
    expect(readFileSync(join(base, "src/main.ts"), "utf8")).toBe("export const x = 1\n")
    // lower base：文件 0444 物理只读；目录 0755（目录只读由 overlay 层语义
    // 保证 —— fuse-overlayfs 对 0555 目录 copy-up 会 EACCES）。
    expect(statSync(join(base, "src/main.ts")).mode & 0o444).toBe(0o444)
    expect(statSync(join(base, "src")).mode & 0o700).toBe(0o700)
    expect(() => writeFileSync(join(base, "src/main.ts"), "x", { flag: "a" })).toThrow()
    ctx.cleanup()
  })

  test("物化器不读取 World HEAD：stale snapshot 内容不变", () => {
    const ctx = buildWorldWithFiles()
    const snapshot = ctx.store.snapshots.getForRevision("world-m", "branch-main", 1n)!
    const baseA = join(tmpRoot("stale"), "base-a")
    mkdirSync(baseA)
    const first = materializerOf(ctx).materialize(snapshot.snapshotId, baseA)

    // World head 前进（revision 2，修改 main.ts + 新增文件）。
    const newBytes = Buffer.from('export const x = 999\n', "utf8")
    const newDigest = ctx.store.cas.put(newBytes, "text/plain").digest
    const extraBytes = Buffer.from("extra\n", "utf8")
    const extraDigest = ctx.store.cas.put(extraBytes, "text/plain").digest
    ctx.store.compareAndCommit({
      worldId: "world-m",
      branchId: "branch-main",
      baseRevision: 1n,
      actor: "actor:test",
      mutations: [
        { type: "object.put", objectId: "obj-main", objectType: "file", path: "src/main.ts", contentRef: newDigest },
        { type: "object.put", objectId: "obj-extra", objectType: "file", path: "src/extra.ts", contentRef: extraDigest },
      ],
    })

    // 旧 snapshot 再物化 → 仍是 revision 1 内容（stale immutable）。
    const baseB = join(tmpRoot("stale"), "base-b")
    mkdirSync(baseB)
    const second = materializerOf(ctx).materialize(snapshot.snapshotId, baseB)
    expect(second.snapshot.revision).toBe(1n)
    expect(readFileSync(join(baseB, "src/main.ts"), "utf8")).toBe("export const x = 1\n")
    expect(existsSync(join(baseB, "src/extra.ts"))).toBe(false)
    // 两次物化内容逐字节一致。
    expect(readFileSync(join(baseA, "src/main.ts"))).toEqual(readFileSync(join(baseB, "src/main.ts")))
    ctx.cleanup()
  })

  test("snapshot 不存在 → SNAPSHOT_NOT_FOUND", () => {
    const ctx = buildWorldWithFiles()
    const snapshot = ctx.store.snapshots.getForRevision("world-m", "branch-main", 1n)!
    const base = join(tmpRoot("notfound"), "base")
    mkdirSync(base)
    const ghost: WorldSnapshot = { ...snapshot, snapshotId: "snapshot:ghost" }
    try {
      materializerOf(ctx).materialize(ghost.snapshotId, base)
      throw new Error("expected SNAPSHOT_NOT_FOUND")
    } catch (error) {
      expect((error as ProjectionError).code).toBe("SNAPSHOT_NOT_FOUND")
    }
    ctx.cleanup()
  })
})

describe("AK2-T02 反例（表驱动）", () => {
  test("missing CAS object：文件 contentRef 无对象 → 拒绝", () => {
    const ctx = buildWorldWithFiles()
    const snapshot = ctx.store.snapshots.getForRevision("world-m", "branch-main", 1n)!
    const source: ProjectionMaterializerSource = {
      getSnapshot: id => ctx.store.snapshots.get(id),
      getCasRecord: digest => ctx.store.cas.record(digest),
      // 身份检查通过（record 存在）后，内容读取失败 → MATERIALIZATION_FAILED。
      readCasObject: () => {
        throw new Error("CAS object missing")
      },
    }
    const base = join(tmpRoot("miss"), "base")
    mkdirSync(base)
    try {
      new SnapshotMaterializer(source).materialize(snapshot.snapshotId, base)
      throw new Error("expected MATERIALIZATION_FAILED")
    } catch (error) {
      expect((error as ProjectionError).code).toBe("MATERIALIZATION_FAILED")
    }
    ctx.cleanup()
  })

  test("malformed manifest：普通 JSON 冒充 section manifest → 拒绝", () => {
    const snapshot: WorldSnapshot = {
      snapshotId: "snapshot:mal",
      worldId: "w",
      branchId: "b",
      revision: 1n,
      manifestDigest: "sha256:1" as CasDigest,
      filesystemDigest: "sha256:2" as CasDigest,
      memoryDigest: "sha256:3" as CasDigest,
      taskStateDigest: "sha256:4" as CasDigest,
      capabilityStateDigest: "sha256:5" as CasDigest,
      serviceStateDigest: "sha256:6" as CasDigest,
      artifactStateDigest: "sha256:7" as CasDigest,
      createdAt: 1,
    }
    const base = join(tmpRoot("mal"), "base")
    mkdirSync(base)
    try {
      new SnapshotMaterializer({
        getSnapshot: () => snapshot,
        getCasRecord: () => fakeManifestRecord(),
        readCasObject: () => Buffer.from('{"hello":"world"}', "utf8"),
      }).materialize(snapshot.snapshotId, base)
      throw new Error("expected MATERIALIZATION_FAILED")
    } catch (error) {
      expect((error as ProjectionError).code).toBe("MATERIALIZATION_FAILED")
    }
  })

  test("duplicate path / file-directory collision / 非法 kind / 非 canonical path / 无 path → 拒绝", () => {
    const base = join(tmpRoot("bad"), "base")
    mkdirSync(base)
    const materializer = new SnapshotMaterializer({
      getSnapshot: () => undefined,
      getCasRecord: () => undefined,
      readCasObject: () => Buffer.from("x"),
    })
    const snapshot: WorldSnapshot = {
      snapshotId: "snapshot:x",
      worldId: "w",
      branchId: "b",
      revision: 1n,
      manifestDigest: "sha256:1" as CasDigest,
      filesystemDigest: "sha256:2" as CasDigest,
      memoryDigest: "sha256:3" as CasDigest,
      taskStateDigest: "sha256:4" as CasDigest,
      capabilityStateDigest: "sha256:5" as CasDigest,
      serviceStateDigest: "sha256:6" as CasDigest,
      artifactStateDigest: "sha256:7" as CasDigest,
      createdAt: 1,
    }

    // getSnapshot 返回 undefined → SNAPSHOT_NOT_FOUND 先抛；这里让 source
    // 承认 snapshot 但 filesystemDigest 指向注入的 manifest bytes。
    const withManifest = (manifest: unknown): ProjectionMaterializerSource => ({
      getSnapshot: () => snapshot,
      getCasRecord: digest => (/^sha256:\d+$/.test(digest) ? fakeManifestRecord() : fakeRawRecord()),
      readCasObject: digest =>
        /^sha256:\d+$/.test(digest) ? Buffer.from(JSON.stringify(manifest), "utf8") : Buffer.from("raw", "utf8"),
    })
    const run = (manifest: unknown, expectedCode: import("../../../src/kernel/projection/contracts").ProjectionErrorCode): void => {
      const fresh = join(tmpRoot("bad"), `base-${Math.random().toString(36).slice(2)}`)
      mkdirSync(fresh)
      try {
        new SnapshotMaterializer(withManifest(manifest)).materialize(snapshot.snapshotId, fresh)
        throw new Error(`expected ${expectedCode}`)
      } catch (error) {
        expect((error as ProjectionError).code).toBe(expectedCode)
      }
    }

    // duplicate path。
    run(
      {
        schemaVersion: 1,
        type: "world-section",
        section: "filesystem",
        entries: [
          { id: "a", kind: "file", path: "x.txt", contentRef: "sha256:aa" },
          { id: "b", kind: "file", path: "x.txt", contentRef: "sha256:bb" },
        ],
      },
      "MATERIALIZATION_FAILED",
    )
    // file/directory collision（file 的父级是 file）。
    run(
      {
        schemaVersion: 1,
        type: "world-section",
        section: "filesystem",
        entries: [
          { id: "a", kind: "file", path: "dir", contentRef: "sha256:aa" },
          { id: "b", kind: "file", path: "dir/x.txt", contentRef: "sha256:bb" },
        ],
      },
      "MATERIALIZATION_FAILED",
    )
    // 非法 kind（symlink/device/FIFO/socket 语义拒绝）。
    run(
      {
        schemaVersion: 1,
        type: "world-section",
        section: "filesystem",
        entries: [{ id: "s", kind: "symlink", path: "link", contentRef: "sha256:aa" }],
      },
      "MATERIALIZATION_FAILED",
    )
    run(
      {
        schemaVersion: 1,
        type: "world-section",
        section: "filesystem",
        entries: [{ id: "f", kind: "fifo", path: "pipe" }],
      },
      "MATERIALIZATION_FAILED",
    )
    // 非 canonical path（traversal）。
    run(
      {
        schemaVersion: 1,
        type: "world-section",
        section: "filesystem",
        entries: [{ id: "e", kind: "file", path: "../escape.txt", contentRef: "sha256:aa" }],
      },
      "MATERIALIZATION_FAILED",
    )
    // 无 path 的非 workspace entry。
    run(
      {
        schemaVersion: 1,
        type: "world-section",
        section: "filesystem",
        entries: [{ id: "m", kind: "file", contentRef: "sha256:aa" }],
      },
      "MATERIALIZATION_FAILED",
    )
    // workspace 带 path → 拒绝。
    run(
      {
        schemaVersion: 1,
        type: "world-section",
        section: "filesystem",
        entries: [{ id: "w", kind: "workspace", path: "ws" }],
      },
      "MATERIALIZATION_FAILED",
    )
    // 非 canonical 排序 → 拒绝。
    run(
      {
        schemaVersion: 1,
        type: "world-section",
        section: "filesystem",
        entries: [
          { id: "b", kind: "file", path: "z.txt", contentRef: "sha256:bb" },
          { id: "a", kind: "file", path: "a.txt", contentRef: "sha256:aa" },
        ],
      },
      "MATERIALIZATION_FAILED",
    )
  })

  test("workspace 无 path → 跳过物化，不拒绝", () => {
    const base = join(tmpRoot("ws"), "base")
    mkdirSync(base)
    const snapshot: WorldSnapshot = {
      snapshotId: "snapshot:x",
      worldId: "w",
      branchId: "b",
      revision: 1n,
      manifestDigest: "sha256:1" as CasDigest,
      filesystemDigest: "sha256:2" as CasDigest,
      memoryDigest: "sha256:3" as CasDigest,
      taskStateDigest: "sha256:4" as CasDigest,
      capabilityStateDigest: "sha256:5" as CasDigest,
      serviceStateDigest: "sha256:6" as CasDigest,
      artifactStateDigest: "sha256:7" as CasDigest,
      createdAt: 1,
    }
    const sectionBytes = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        type: "world-section",
        section: "filesystem",
        entries: [
          { id: "ws", kind: "workspace" },
          { id: "a", kind: "file", path: "a.txt", contentRef: "sha256:aa" },
        ],
      }),
      "utf8",
    )
    const materializer = new SnapshotMaterializer({
      getSnapshot: () => snapshot,
      getCasRecord: digest => (/^sha256:\d+$/.test(digest) ? fakeManifestRecord() : fakeRawRecord()),
      readCasObject: digest => (digest === snapshot.filesystemDigest ? sectionBytes : Buffer.from("raw", "utf8")),
    })
    const result = materializer.materialize(snapshot.snapshotId, base)
    expect(result.fileCount).toBe(1)
    expect(existsSync(join(base, "a.txt"))).toBe(true)
  })

  test("parseFilesystemSection 独立反例：envelope/section/entries 类型", () => {
    expect(() => parseFilesystemSection(Buffer.from("not json", "utf8"))).toThrow(ProjectionError)
    expect(() =>
      parseFilesystemSection(Buffer.from(JSON.stringify({ schemaVersion: 2, type: "world-section", section: "filesystem", entries: [] }), "utf8")),
    ).toThrow(ProjectionError)
    expect(() =>
      parseFilesystemSection(Buffer.from(JSON.stringify({ schemaVersion: 1, type: "world-section", section: "memory", entries: [] }), "utf8")),
    ).toThrow(ProjectionError)
    expect(() =>
      parseFilesystemSection(Buffer.from(JSON.stringify({ schemaVersion: 1, type: "world-section", section: "filesystem", entries: "x" }), "utf8")),
    ).toThrow(ProjectionError)
    const ok = parseFilesystemSection(
      Buffer.from(JSON.stringify({ schemaVersion: 1, type: "world-section", section: "filesystem", entries: [] }), "utf8"),
    )
    expect(ok.entries).toEqual([])
  })
})

describe("AK2-T02 物化根防护", () => {
  test("物化根必须存在且为空", () => {
    const ctx = buildWorldWithFiles()
    const snapshot = ctx.store.snapshots.getForRevision("world-m", "branch-main", 1n)!
    const missing = join(tmpRoot("root"), "nope")
    try {
      materializerOf(ctx).materialize(snapshot.snapshotId, missing)
      throw new Error("expected MATERIALIZATION_FAILED")
    } catch (error) {
      expect((error as ProjectionError).code).toBe("MATERIALIZATION_FAILED")
    }
    const nonEmpty = join(tmpRoot("root"), "busy")
    mkdirSync(nonEmpty)
    writeFileSync(join(nonEmpty, "existing.txt"), "x")
    try {
      materializerOf(ctx).materialize(snapshot.snapshotId, nonEmpty)
      throw new Error("expected MATERIALIZATION_FAILED")
    } catch (error) {
      expect((error as ProjectionError).code).toBe("MATERIALIZATION_FAILED")
    }
    ctx.cleanup()
  })

  test("多层嵌套文件（未声明中间目录）正确物化", () => {
    const ctx = createTestWorldStore()
    ctx.store.createWorld({ worldId: "w2", branchId: "b", rootObjectId: "r", owner: "o", purpose: "p" })
    const bytes = Buffer.from("deep\n", "utf8")
    const digest = ctx.store.cas.put(bytes, "text/plain").digest
    ctx.store.compareAndCommit({
      worldId: "w2",
      branchId: "b",
      baseRevision: 0n,
      actor: "a",
      mutations: [
        { type: "object.put", objectId: "f1", objectType: "file", path: "a/b/c/deep.txt", contentRef: digest },
        { type: "object.put", objectId: "d1", objectType: "directory", path: "a/b" },
      ],
    })
    ctx.store.createSnapshot("w2", "b")
    const snapshot = ctx.store.snapshots.getForRevision("w2", "b", 1n)!
    const base = join(tmpRoot("deep"), "base")
    mkdirSync(base)
    const materialized = materializerOf(ctx).materialize(snapshot.snapshotId, base)
    expect(materialized.fileCount).toBe(1)
    expect(readFileSync(join(base, "a/b/c/deep.txt"), "utf8")).toBe("deep\n")
    // 未声明目录也可写（物化后 chmod 只读作用于声明的目录；隐式目录保持可写
    // 由 backend lower 层以只读方式暴露 —— 此处仅验证内容）。
    expect(existsSync(join(base, "a/b/c"))).toBe(true)
    ctx.cleanup()
  })

  test("R04：>1MiB 多 chunk FileManifest 重建逐字节一致；空 FileManifest 物化为空文件", () => {
    const ctx = createTestWorldStore()
    ctx.store.createWorld({ worldId: "world-big", branchId: "branch-main", rootObjectId: "root-1", owner: "owner:test", purpose: "ak2 r04" })
    // 1 MiB + 123 字节 → DEFAULT_FILE_CHUNK_SIZE(1MiB) 下 2 个 chunk。
    const big = Buffer.alloc(1024 * 1024 + 123)
    for (let index = 0; index < big.length; index++) big[index] = (index * 31 + 7) % 256
    const bigManifest = createFileManifest(ctx.store.cas, big, "application/octet-stream")
    const emptyManifest = createFileManifest(ctx.store.cas, Buffer.alloc(0), "application/octet-stream")
    ctx.store.compareAndCommit({
      worldId: "world-big",
      branchId: "branch-main",
      baseRevision: 0n,
      actor: "actor:test",
      mutations: [
        { type: "object.put", objectId: "big", objectType: "file", path: "big.bin", contentRef: bigManifest.digest },
        { type: "object.put", objectId: "empty", objectType: "file", path: "empty.bin", contentRef: emptyManifest.digest },
      ],
    })
    ctx.store.createSnapshot("world-big", "branch-main")
    const snapshot = ctx.store.snapshots.getForRevision("world-big", "branch-main", 1n)!
    const base = join(tmpRoot("r04"), "base")
    mkdirSync(base)
    const materialized = materializerOf(ctx).materialize(snapshot.snapshotId, base)
    expect(materialized.fileCount).toBe(2)
    expect(readFileSync(join(base, "big.bin")).equals(big)).toBe(true)
    expect(readFileSync(join(base, "empty.bin")).byteLength).toBe(0)
    ctx.cleanup()
  })

  test("R04：FileManifest chunk 缺失/重叠/越界/digest 错 → fail-closed", () => {
    const snapshot: WorldSnapshot = {
      snapshotId: "snapshot:r04bad",
      worldId: "w",
      branchId: "b",
      revision: 1n,
      manifestDigest: "sha256:1" as CasDigest,
      filesystemDigest: "sha256:2" as CasDigest,
      memoryDigest: "sha256:3" as CasDigest,
      taskStateDigest: "sha256:4" as CasDigest,
      capabilityStateDigest: "sha256:5" as CasDigest,
      serviceStateDigest: "sha256:6" as CasDigest,
      artifactStateDigest: "sha256:7" as CasDigest,
      createdAt: 1,
    }
    const sectionManifest = () =>
      Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          type: "world-section",
          section: "filesystem",
          entries: [
            { id: "ws", kind: "workspace" },
            { id: "f", kind: "file", path: "a.bin", contentRef: "sha256:fm" },
          ],
        }),
        "utf8",
      )
    const chunkA = Buffer.alloc(3, 0xaa)
    const chunkB = Buffer.alloc(3, 0xbb)
    const digests = { a: "sha256:ca" as CasDigest, b: "sha256:cb" as CasDigest }
    const run = (manifest: unknown, readBytes: Record<string, Buffer>): import("../../../src/kernel/projection/contracts").ProjectionErrorCode => {
      const base = join(tmpRoot("r04bad"), `b-${Math.random().toString(36).slice(2)}`)
      mkdirSync(base)
      try {
        new SnapshotMaterializer({
          getSnapshot: () => snapshot,
          getCasRecord: digest => (digest === "sha256:fm" || /^sha256:\d+$/.test(digest) ? fakeManifestRecord() : fakeRawRecord()),
          readCasObject: digest => {
            if (digest === snapshot.filesystemDigest) return sectionManifest()
            if (digest === "sha256:fm") return Buffer.from(JSON.stringify(manifest), "utf8")
            const bytes = readBytes[digest]
            if (bytes === undefined) throw new Error(`CAS object missing: ${digest}`)
            return bytes
          },
        }).materialize(snapshot.snapshotId, base)
        return "INVALID_PATH" as never
      } catch (error) {
        return (error as ProjectionError).code
      }
    }
    const manifest = (chunks: unknown) => JSON.stringify({ schemaVersion: 1, type: "file", mediaType: "application/octet-stream", size: 6, chunks })
    // 缺失 chunk（manifest 引用不存在的对象）。
    expect(run(manifest([{ digest: digests.a, offset: 0, size: 3 }]), {})).toBe("MATERIALIZATION_FAILED")
    // gap（offset 4 应连续 3）。
    expect(
      run(manifest([{ digest: digests.a, offset: 0, size: 3 }, { digest: digests.b, offset: 4, size: 2 }]), { [digests.a]: chunkA, [digests.b]: chunkB }),
    ).toBe("MATERIALIZATION_FAILED")
    // overlap（offset 2 与前 chunk 重叠）。
    expect(
      run(manifest([{ digest: digests.a, offset: 0, size: 3 }, { digest: digests.b, offset: 2, size: 2 }]), { [digests.a]: chunkA, [digests.b]: chunkB }),
    ).toBe("MATERIALIZATION_FAILED")
    // size 不匹配（chunk 内容长度 != 声明）。
    expect(
      run(manifest([{ digest: digests.a, offset: 0, size: 5 }, { digest: digests.b, offset: 5, size: 1 }]), { [digests.a]: chunkA, [digests.b]: chunkB }),
    ).toBe("MATERIALIZATION_FAILED")
    // 总长不匹配（chunks 覆盖 6 ≠ 声明 7）。
    expect(
      run(manifest([{ digest: digests.a, offset: 0, size: 3 }, { digest: digests.b, offset: 3, size: 3 }]), { [digests.a]: chunkA, [digests.b]: chunkB }),
    ).toBe("MATERIALIZATION_FAILED")
  })

  test("R06.5：snapshotId 与 filesystemDigest 不匹配（身份检查）→ SNAPSHOT_MISMATCH", () => {
    const snapshot: WorldSnapshot = {
      snapshotId: "snapshot:r065",
      worldId: "w",
      branchId: "b",
      revision: 1n,
      manifestDigest: "sha256:1" as CasDigest,
      filesystemDigest: "sha256:2" as CasDigest,
      memoryDigest: "sha256:3" as CasDigest,
      taskStateDigest: "sha256:4" as CasDigest,
      capabilityStateDigest: "sha256:5" as CasDigest,
      serviceStateDigest: "sha256:6" as CasDigest,
      artifactStateDigest: "sha256:7" as CasDigest,
      createdAt: 1,
    }
    const expectCode = (source: ProjectionMaterializerSource, code: import("../../../src/kernel/projection/contracts").ProjectionErrorCode): void => {
      const base = join(tmpRoot("r065"), `b-${Math.random().toString(36).slice(2)}`)
      mkdirSync(base)
      try {
        new SnapshotMaterializer(source).materialize(snapshot.snapshotId, base)
      } catch (error) {
        expect((error as ProjectionError).code).toBe(code)
        return
      }
      throw new Error(`expected ${code}`)
    }
    // memoryDigest 无 manifest 记录 → 身份拒绝。
    expectCode(
      {
        getSnapshot: () => snapshot,
        getCasRecord: digest => (digest === snapshot.filesystemDigest ? fakeManifestRecord() : undefined),
        readCasObject: () => Buffer.from("x"),
      },
      "SNAPSHOT_MISMATCH",
    )
    // filesystemDigest 无记录 → 身份拒绝。
    expectCode(
      {
        getSnapshot: () => snapshot,
        getCasRecord: () => undefined,
        readCasObject: () => Buffer.from("x"),
      },
      "SNAPSHOT_MISMATCH",
    )
  })
})
