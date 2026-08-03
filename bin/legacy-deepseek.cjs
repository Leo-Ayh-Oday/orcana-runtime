#!/usr/bin/env node

// Legacy bin aliases (deepseek / deepseek-code / deepseek-orcana).
// Deprecated since the rename to Orcana Runtime: prints a deprecation
// warning and forwards to the same entry as `orcana` so existing scripts
// and npm-installed commands keep working for the transition period.
// Legacy DEEPSEEK_* env vars are mirrored by env-compat inside the entry.
const { pathToFileURL } = require("node:url")
const path = require("node:path")

const invokedAs = path.basename(process.argv[1] || "deepseek")
console.error(`[deprecated] the '${invokedAs}' command is deprecated — use 'orcana' instead.`)

const entry = path.join(__dirname, "..", "dist", "index.js")

;(async () => {
  try {
    await import(pathToFileURL(entry).href)
  } catch (error) {
    console.error("")
    console.error("Orcana failed to start.")
    console.error("")
    if (error && error.message) console.error(error.message)
    else console.error(error)
    console.error("")
    process.exit(1)
  }
})()
