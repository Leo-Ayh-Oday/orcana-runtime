import { describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  recoverWorldStore,
  sha256Digest,
  WorldStore,
} from "../../../src/kernel/world"
import { createTestWorldStore } from "./helpers"

describe("AK-1 CAS filesystem confinement", () => {
  test("a configured World root symlink is rejected before subdirectories are created", () => {
    const parent = mkdtempSync(join(tmpdir(), "orcana-world-root-parent-"))
    const outside = mkdtempSync(join(tmpdir(), "orcana-world-root-outside-"))
    const root = join(parent, "world-link")
    try {
      writeFileSync(join(outside, "sentinel"), "outside")
      symlinkSync(outside, root, "dir")
      expect(() => new WorldStore(root)).toThrow(/World root must be a real directory/)
      expect(readFileSync(join(outside, "sentinel"), "utf8")).toBe("outside")
      expect(existsSync(join(outside, "ledger"))).toBe(false)
    } finally {
      rmSync(parent, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  test("objects and staging roots reject pre-existing symlinks", () => {
    for (const relative of [
      ["cas", "sha256"],
      ["recovery", "cas-staging"],
    ]) {
      const root = mkdtempSync(join(tmpdir(), "orcana-world-cas-root-"))
      const outside = mkdtempSync(join(tmpdir(), "orcana-world-cas-outside-"))
      const target = join(root, ...relative)
      try {
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(join(outside, "sentinel"), "outside")
        symlinkSync(outside, target, "dir")
        expect(() => new WorldStore(root)).toThrow()
        expect(readFileSync(join(outside, "sentinel"), "utf8")).toBe("outside")
      } finally {
        rmSync(root, { recursive: true, force: true })
        rmSync(outside, { recursive: true, force: true })
      }
    }
  })

  test("digest-prefix symlinks cannot redirect put or recovery deletion", () => {
    const fixture = createTestWorldStore()
    const outside = mkdtempSync(join(tmpdir(), "orcana-world-cas-prefix-outside-"))
    try {
      fixture.store.createWorld({ worldId: "w1", owner: "user:owner" })
      const digest = sha256Digest("outside escape")
      const hex = digest.slice("sha256:".length)
      const outsideFile = join(outside, hex)
      writeFileSync(outsideFile, "must survive")
      symlinkSync(outside, join(fixture.store.cas.objectsRoot, hex.slice(0, 2)), "dir")

      expect(() => fixture.store.cas.put(Buffer.from("outside escape"), "text/plain")).toThrow()
      expect(existsSync(join(outside, hex))).toBe(true)
      expect(() => recoverWorldStore(fixture.store)).toThrow(/unsafe CAS prefix path/)
      expect(readFileSync(outsideFile, "utf8")).toBe("must survive")
      expect(fixture.store.getWorld("w1")?.status).toBe("active")
    } finally {
      fixture.cleanup()
      rmSync(outside, { recursive: true, force: true })
    }
  })

  test("recovery refuses staging-entry symlinks without touching their targets", () => {
    const fixture = createTestWorldStore()
    const outside = mkdtempSync(join(tmpdir(), "orcana-world-cas-staging-outside-"))
    try {
      fixture.store.createWorld({ worldId: "w1", owner: "user:owner" })
      const outsideFile = join(outside, "sentinel")
      writeFileSync(outsideFile, "must survive")
      symlinkSync(outsideFile, join(fixture.store.cas.stagingRoot, "malicious.tmp"), "file")

      expect(() => recoverWorldStore(fixture.store)).toThrow(/unsafe CAS staging entry/)
      expect(readFileSync(outsideFile, "utf8")).toBe("must survive")
      expect(fixture.store.getWorld("w1")?.status).toBe("active")
    } finally {
      fixture.cleanup()
      rmSync(outside, { recursive: true, force: true })
    }
  })
})
