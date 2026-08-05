/** LNXF-1.0: sandbox profiles (plan §9).
 *
 *  Seven profiles with default backends, isolation minimums, network modes,
 *  resource ranges and degradation policy. Strict profiles (untrusted /
 *  evolution) are `allowDegradation: false` — they must refuse when the
 *  required backend is unavailable.
 */

import type { ExecutionCellSpec, ExecutionProfile, IsolationMinimum, NetworkMode, BackendId } from "./contracts"

export interface ProfileDefaults {
  profile: ExecutionProfile
  backend: BackendId
  minimum: IsolationMinimum
  network: NetworkMode
  allowDegradation: boolean
  memoryMaxBytes: number
  memoryHighBytes: number
  pidsMax: number
  emptyHome: boolean
}

const MB = 1024 * 1024
const GB = 1024 * MB

export const PROFILE_DEFAULTS: Record<ExecutionProfile, ProfileDefaults> = {
  inspect: {
    profile: "inspect",
    backend: "bubblewrap",
    minimum: "namespace",
    network: "none",
    allowDegradation: true, // 显式允许时可由用户降级到 audit（低风险）
    memoryMaxBytes: 512 * MB,
    memoryHighBytes: 256 * MB,
    pidsMax: 32,
    emptyHome: true,
  },
  build: {
    profile: "build",
    backend: "bubblewrap",
    minimum: "namespace",
    network: "none",
    allowDegradation: true,
    memoryMaxBytes: 2 * GB,
    memoryHighBytes: GB,
    pidsMax: 128,
    emptyHome: true,
  },
  test: {
    profile: "test",
    backend: "bubblewrap",
    minimum: "namespace",
    network: "none",
    allowDegradation: false,
    memoryMaxBytes: 2 * GB,
    memoryHighBytes: GB,
    pidsMax: 256,
    emptyHome: true,
  },
  dependency: {
    profile: "dependency",
    backend: "rootless-podman",
    minimum: "container",
    network: "proxy-allowlist",
    allowDegradation: false,
    memoryMaxBytes: 2 * GB,
    memoryHighBytes: GB,
    pidsMax: 256,
    emptyHome: true,
  },
  service: {
    profile: "service",
    backend: "bubblewrap",
    minimum: "namespace",
    network: "loopback",
    allowDegradation: false,
    memoryMaxBytes: 2 * GB,
    memoryHighBytes: GB,
    pidsMax: 128,
    emptyHome: true,
  },
  untrusted: {
    profile: "untrusted",
    backend: "rootless-podman",
    minimum: "container",
    network: "none",
    allowDegradation: false,
    memoryMaxBytes: GB,
    memoryHighBytes: 512 * MB,
    pidsMax: 64,
    emptyHome: true,
  },
  evolution: {
    profile: "evolution",
    backend: "rootless-podman",
    minimum: "container",
    network: "none",
    allowDegradation: false,
    memoryMaxBytes: GB,
    memoryHighBytes: 512 * MB,
    pidsMax: 64,
    emptyHome: true,
  },
}

export function profileDefaults(profile: ExecutionProfile): ProfileDefaults {
  return PROFILE_DEFAULTS[profile]
}

export function isStrictProfile(profile: ExecutionProfile): boolean {
  return PROFILE_DEFAULTS[profile].allowDegradation === false
}

/** Apply profile defaults onto a partial spec (identity/command must be
 *  provided by the caller). */
export function applyProfileDefaults(
  identity: ExecutionCellSpec["identity"],
  command: ExecutionCellSpec["command"],
  profile: ExecutionProfile,
  overrides: Partial<ExecutionCellSpec> = {},
): ExecutionCellSpec {
  const defaults = PROFILE_DEFAULTS[profile]
  return {
    schemaVersion: "1.0",
    identity,
    command,
    profile,
    isolation: {
      minimum: defaults.minimum,
      preferredBackend: overrides.isolation?.preferredBackend ?? (defaults.backend === "rootless-podman" ? "podman" : defaults.backend === "bubblewrap" ? "bubblewrap" : "auto"),
      allowDegradation: defaults.allowDegradation,
    },
    filesystem: {
      readonlyMounts: [],
      writableMounts: [],
      tmpfsMounts: [{ target: "/tmp", sizeBytes: overrides.resources?.tmpfsMaxBytes ?? 512 * MB }],
      hiddenPaths: [],
      emptyHome: defaults.emptyHome,
      worktreeRoot: overrides.filesystem?.worktreeRoot,
      ownerFiles: overrides.filesystem?.ownerFiles,
    },
    network: { mode: defaults.network },
    environment: { variables: {}, inheritHost: false, locale: "C.UTF-8", pathEntries: [] },
    secrets: [],
    resources: {
      memoryMaxBytes: defaults.memoryMaxBytes,
      memoryHighBytes: defaults.memoryHighBytes,
      pidsMax: defaults.pidsMax,
      wallTimeMs: 60_000,
      stdoutMaxBytes: 16 * MB,
      stderrMaxBytes: 16 * MB,
      tmpfsMaxBytes: 512 * MB,
    },
    cache: [],
    lifecycle: { killOnParentExit: true, cleanupOnExit: true, retainOnFailure: false, serviceMode: profile === "service" },
    policyDigest: "",
    ...overrides,
  }
}
