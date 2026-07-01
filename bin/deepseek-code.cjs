#!/usr/bin/env bun

// Orcana CLI entry — Bun-first. Node wrapper not needed; this imports the compiled ESM directly.
const { pathToFileURL } = await import("node:url")
const path = await import("node:path")

const root = path.resolve(import.meta.dir, "..")
const entry = path.join(root, "dist", "index.js")

try {
  await import(pathToFileURL(entry).href)
} catch (error) {
  console.error("")
  console.error("Orcana failed to start.")
  console.error("")
  if (error && error.message) console.error(error.message)
  else console.error(error)
  console.error("")
  console.error("Orcana requires Bun. Install it from https://bun.sh")
  console.error("")
  process.exit(1)
}
