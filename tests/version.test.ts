import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { VERSION, VERSION_LABEL } from "../src/version"

describe("version", () => {
  test("reads version from package.json", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf-8")) as { version: string }
    expect(VERSION).toBe(pkg.version)
    expect(VERSION_LABEL).toBe(`v${pkg.version}`)
  })
})
