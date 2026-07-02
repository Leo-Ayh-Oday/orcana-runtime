import { describe, expect, test } from "bun:test"
import { createRequire } from "node:module"
import { join } from "node:path"

const require = createRequire(import.meta.url)
const {
  createSmokeEnv,
  npmCommand,
  resolveInstalledBin,
  shellQuote,
} = require("../scripts/release-smoke.cjs") as {
  createSmokeEnv: (baseEnv: NodeJS.ProcessEnv, tempRoot: string) => NodeJS.ProcessEnv
  npmCommand: (platform?: NodeJS.Platform) => string
  resolveInstalledBin: (prefix: string, name: string, platform?: NodeJS.Platform) => string
  shellQuote: (value: string) => string
}

describe("release smoke script helpers", () => {
  test("uses npm.cmd on Windows and npm elsewhere", () => {
    expect(npmCommand("win32")).toBe("npm.cmd")
    expect(npmCommand("linux")).toBe("npm")
    expect(npmCommand("darwin")).toBe("npm")
  })

  test("resolves installed global bin path by platform", () => {
    expect(resolveInstalledBin("C:\\tmp\\prefix", "orcana", "win32")).toBe("C:\\tmp\\prefix\\orcana.cmd")
    expect(resolveInstalledBin("/tmp/prefix", "orcana", "linux")).toBe("/tmp/prefix/bin/orcana")
  })

  test("quotes shell tokens only when needed", () => {
    expect(shellQuote("npm.cmd")).toBe("npm.cmd")
    expect(shellQuote("C:\\tmp dir\\orcana.cmd")).toBe("\"C:\\tmp dir\\orcana.cmd\"")
  })

  test("isolates home and npm cache under the temp smoke directory", () => {
    const env = createSmokeEnv({ PATH: "x", USERPROFILE: "old" }, join("tmp", "smoke"))
    expect(env.PATH).toBe("x")
    expect(env.HOME).toContain(join("tmp", "smoke", "home"))
    expect(env.USERPROFILE).toBe(env.HOME)
    expect(env.npm_config_cache).toContain(join("tmp", "smoke", "npm-cache"))
  })
})
