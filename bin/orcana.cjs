#!/usr/bin/env node

// Orcana CLI entry. Published npm users should only need Node.js; Bun remains
// the contributor package manager/test runner.
const { pathToFileURL } = require("node:url")
const path = require("node:path")

const root = path.resolve(__dirname, "..")
const entry = path.join(root, "dist", "index.js");

(async () => {
  try {
    await import(pathToFileURL(entry).href)
  } catch (error) {
    console.error("")
    console.error("Orcana failed to start.")
    console.error("")
    if (error && error.message) console.error(error.message)
    else console.error(error)
    console.error("")
    console.error("Try `orcana doctor` for a local environment check.")
    console.error("")
    process.exit(1)
  }
})()
