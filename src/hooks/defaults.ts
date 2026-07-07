import { HookSystem } from "./index"
import { writeGuardBefore, writeGuardAfter, createJournalGuard } from "./builtin"
import { createSafetyPolicyHook } from "./safety-policy"

export interface DefaultHookSystemOptions {
  projectRoot: string
  allowOutsideProject?: boolean
}

export function createDefaultHookSystem(options: DefaultHookSystemOptions): HookSystem {
  const hooks = new HookSystem()

  // Pre-tool hooks run from broad safety policy to narrower file-state policy.
  hooks.onToolBefore(createSafetyPolicyHook({
    projectRoot: options.projectRoot,
    allowOutsideProject: options.allowOutsideProject,
  }))
  hooks.onToolBefore(writeGuardBefore)

  // Post-tool hooks first update state, then evaluate write-side invariants.
  hooks.onToolAfter(writeGuardAfter)
  hooks.onToolAfter(createJournalGuard(options.projectRoot))

  return hooks
}
