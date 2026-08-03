/** CapabilityRegistry implementation (H9, plan §15.2).
 *
 *  In-memory registry over the H0 contract. Duplicate registration and
 *  unknown resolution fail with explicit HarnessError kinds so callers can
 *  branch without string-matching.
 */

import { HarnessError } from "../contracts/errors"
import type {
  CapabilityFilter,
  CapabilityRegistry,
  RegisteredCapability,
} from "../contracts/capability"

export function createCapabilityRegistry(): CapabilityRegistry {
  const capabilities = new Map<string, RegisteredCapability>()

  return {
    register(descriptor, handler) {
      if (capabilities.has(descriptor.id)) {
        throw new HarnessError(
          "capability_already_registered",
          `Capability already registered: ${descriptor.id}`,
        )
      }
      capabilities.set(descriptor.id, { descriptor, handler })
    },

    resolve(id) {
      const registered = capabilities.get(id)
      if (!registered) {
        throw new HarnessError("capability_not_found", `Capability not found: ${id}`)
      }
      return registered
    },

    list(filter) {
      const all = [...capabilities.values()]
      if (!filter) return all
      return all.filter(
        (entry) =>
          (filter.kind === undefined || entry.descriptor.kind === filter.kind) &&
          (filter.sideEffect === undefined || entry.descriptor.sideEffect === filter.sideEffect) &&
          (filter.concurrencyGroup === undefined || entry.descriptor.concurrencyGroup === filter.concurrencyGroup),
      )
    },
  }
}
