const { existsSync, mkdtempSync, rmSync } = require("node:fs")
const { tmpdir } = require("node:os")
const { join, posix, resolve, win32 } = require("node:path")
const { spawnSync } = require("node:child_process")

function npmCommand(platform = process.platform) {
  return platform === "win32" ? "npm.cmd" : "npm"
}

function resolveInstalledBin(prefix, name, platform = process.platform) {
  return platform === "win32"
    ? win32.join(prefix, `${name}.cmd`)
    : posix.join(prefix, "bin", name)
}

function createSmokeEnv(baseEnv, tempRoot) {
  const home = join(tempRoot, "home")
  return {
    ...baseEnv,
    HOME: home,
    USERPROFILE: home,
    npm_config_cache: join(tempRoot, "npm-cache"),
  }
}

function shellQuote(value) {
  const text = String(value)
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(text)) return text
  return `"${text.replace(/"/g, '\\"')}"`
}

function run(command, args, options = {}) {
  const { shell: requestedShell, stdio = "pipe", timeout = 120_000, ...spawnOptions } = options
  const shell = requestedShell ?? (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command))
  const result = shell
    ? spawnSync([command, ...args].map(shellQuote).join(" "), {
        stdio,
        encoding: "utf-8",
        shell: true,
        timeout,
        ...spawnOptions,
      })
    : spawnSync(command, args, {
        stdio,
        encoding: "utf-8",
        shell: false,
        timeout,
        ...spawnOptions,
      })

  if (result.error) throw result.error
  if (result.status !== 0) {
    const out = [result.stdout, result.stderr].filter(Boolean).join("\n")
    throw new Error(`${command} ${args.join(" ")} failed with ${result.status}\n${out}`)
  }
  return result
}

function packProject(projectRoot, tempRoot) {
  const result = run(npmCommand(), ["pack", projectRoot, "--pack-destination", tempRoot, "--silent"], {
    cwd: projectRoot,
    stdio: "pipe",
  })
  const filename = String(result.stdout ?? "").trim().split(/\r?\n/).filter(Boolean).pop()
  if (!filename) throw new Error("npm pack did not return a tarball filename")
  const tarball = resolve(tempRoot, filename)
  if (!existsSync(tarball)) throw new Error(`Packed tarball was not found: ${tarball}`)
  return tarball
}

function smokeRelease(projectRoot = process.cwd()) {
  const tempRoot = mkdtempSync(join(tmpdir(), "orcana-release-smoke-"))
  const prefix = join(tempRoot, "prefix")
  const env = createSmokeEnv(process.env, tempRoot)

  try {
    const tarball = packProject(projectRoot, tempRoot)
    run(npmCommand(), ["install", "-g", "--prefix", prefix, tarball, "--silent"], {
      cwd: projectRoot,
      env,
      stdio: "pipe",
      timeout: 180_000,
    })

    const orcana = resolveInstalledBin(prefix, "orcana")
    if (!existsSync(orcana)) throw new Error(`Installed CLI was not found: ${orcana}`)

    const checks = [
      ["--version"],
      ["--help"],
      ["doctor"],
      ["list"],
    ]
    for (const args of checks) {
      run(orcana, args, {
        cwd: projectRoot,
        env,
        stdio: "pipe",
        timeout: 30_000,
      })
    }

    console.log(`release smoke passed: ${tarball}`)
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

if (require.main === module) {
  try {
    smokeRelease()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

module.exports = {
  createSmokeEnv,
  npmCommand,
  packProject,
  resolveInstalledBin,
  shellQuote,
  smokeRelease,
}
