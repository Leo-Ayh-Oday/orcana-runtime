/** Interrupt response validation (H7, plan §11.3 rule 2).
 *
 *  RT-1: the validator moved to capabilities/schema-validator.ts (shared by
 *  the CapabilityExecutor, interrupt manager and human node); this module
 *  re-exports it so existing importers stay unchanged.
 */

import type { JsonSchema } from "../contracts/schema"

export { validateJsonSchema } from "../capabilities/schema-validator"
export type { JsonSchema }
