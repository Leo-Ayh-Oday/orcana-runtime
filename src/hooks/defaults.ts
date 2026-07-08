import { HookSystem } from "./index"
import { createWriteGuardBefore, createWriteGuardAfter, createJournalGuard, type WriteGuardMode } from "./builtin"
import { createSafetyPolicyHook } from "./safety-policy"
import { createSideEffectPolicyHook } from "./side-effect-policy"

export interface DefaultHookSystemOptions {
  projectRoot: string
  allowOutsideProject?: boolean
  writeGuardMode?: WriteGuardMode
}

export function createDefaultHookSystem(options: DefaultHookSystemOptions): HookSystem {
  const hooks = new HookSystem()
  const writeGuardReadFiles = new Set<string>()

  // Pre-tool hooks run from broad safety policy to narrower file-state policy.
  hooks.onToolBefore(createSafetyPolicyHook({
    projectRoot: options.projectRoot,
    allowOutsideProject: options.allowOutsideProject,
  }))
  hooks.onToolBefore(createSideEffectPolicyHook({
    projectRoot: options.projectRoot,
  }))
  hooks.onToolBefore(createWriteGuardBefore({
    cwd: options.projectRoot,
    mode: options.writeGuardMode ?? "strict",
    readFiles: writeGuardReadFiles,
  }))

  // Post-tool hooks first update state, then evaluate write-side invariants.
  hooks.onToolAfter(createWriteGuardAfter({
    cwd: options.projectRoot,
    readFiles: writeGuardReadFiles,
  }))
  hooks.onToolAfter(createJournalGuard(options.projectRoot))

  return hooks
}
