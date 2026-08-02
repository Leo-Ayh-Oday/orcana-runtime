/**
 * H0: shared schema type used across Harness contracts.
 *
 * A structural subset of JSON Schema sufficient for interrupt responses and
 * capability input/output validation. Kept minimal and provider-agnostic.
 */

export type JsonSchemaType = "object" | "array" | "string" | "number" | "integer" | "boolean" | "null"

export interface JsonSchema {
  type: JsonSchemaType | JsonSchemaType[]
  description?: string
  properties?: Record<string, JsonSchema>
  items?: JsonSchema
  required?: string[]
  enum?: readonly (string | number | boolean | null)[]
  additionalProperties?: boolean | JsonSchema
  /** Marks the schema as a schema reference, not inline data. */
  $ref?: string
}
