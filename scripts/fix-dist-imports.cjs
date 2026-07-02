const { existsSync, readdirSync, readFileSync, statSync, writeFileSync } = require("node:fs")
const { join } = require("node:path")

const distRoot = join(process.cwd(), "dist")

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) walk(path, out)
    else if (path.endsWith(".js")) out.push(path)
  }
  return out
}

function hasKnownExtension(specifier) {
  return /\.[cm]?js$|\.json$|\.node$/.test(specifier)
}

function resolveSpecifier(fromFile, specifier) {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return specifier
  if (hasKnownExtension(specifier)) return specifier

  const base = join(fromFile, "..", specifier)
  if (existsSync(`${base}.js`)) return `${specifier}.js`
  if (existsSync(join(base, "index.js"))) return `${specifier}/index.js`
  return specifier
}

function fixFile(file) {
  const before = readFileSync(file, "utf-8")
  let after = before

  after = after.replace(
    /\b(from\s*["'])(\.{1,2}\/[^"']+)(["'])/g,
    (_match, prefix, specifier, suffix) => `${prefix}${resolveSpecifier(file, specifier)}${suffix}`,
  )

  after = after.replace(
    /\b(import\s*\(\s*["'])(\.{1,2}\/[^"']+)(["']\s*\))/g,
    (_match, prefix, specifier, suffix) => `${prefix}${resolveSpecifier(file, specifier)}${suffix}`,
  )

  if (after !== before) writeFileSync(file, after, "utf-8")
}

if (existsSync(distRoot)) {
  for (const file of walk(distRoot)) fixFile(file)
}
