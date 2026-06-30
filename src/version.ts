import { existsSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

function readPackageVersion(startDir: string): string | null {
  let dir = startDir
  for (let i = 0; i < 6; i++) {
    const pkgPath = resolve(dir, "package.json")
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { name?: string; version?: string }
        if (pkg.name === "deepseek-orcana" && typeof pkg.version === "string") return pkg.version
      } catch {
        return null
      }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

const moduleDir = dirname(fileURLToPath(import.meta.url))

export const VERSION = readPackageVersion(moduleDir) ?? "0.0.0-dev"
export const VERSION_LABEL = `v${VERSION}`
