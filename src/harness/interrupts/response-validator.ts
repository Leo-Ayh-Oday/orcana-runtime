/** Interrupt response validation (H7, plan §11.3 rule 2).
 *
 *  Minimal JSON-Schema-subset validator for interrupt responses (the
 *  contracts/schema.ts JsonSchema shape). Returns a list of human-readable
 *  errors; an empty list means the response passes.
 */

import type { JsonSchema } from "../contracts/schema"

export function validateJsonSchema(value: unknown, schema: JsonSchema): string[] {
  const errors: string[] = []
  check(value, schema, "$", errors)
  return errors
}

function check(value: unknown, schema: JsonSchema, path: string, errors: string[]): void {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type]

  if (schema.enum) {
    if (!schema.enum.some(option => option === value)) {
      errors.push(`${path}: value not in enum`)
      return
    }
    return
  }

  if (value === null) {
    if (!types.includes("null")) errors.push(`${path}: expected ${types.join("|")}, got null`)
    return
  }

  const valueType = Array.isArray(value) ? "array" : typeof value
  if (!types.includes(valueType as never) && !(valueType === "object" && types.includes("object"))) {
    errors.push(`${path}: expected ${types.join("|")}, got ${valueType}`)
    return
  }

  if (schema.type === "object" || types.includes("object")) {
    if (typeof value !== "object" || Array.isArray(value)) {
      if (!types.some(t => t === "string" || t === "number" || t === "boolean" || t === "array")) {
        errors.push(`${path}: expected object`)
      }
      return
    }
    const record = value as Record<string, unknown>
    for (const required of schema.required ?? []) {
      if (!(required in record)) {
        errors.push(`${path}.${required}: required property missing`)
      }
    }
    for (const [key, propertySchema] of Object.entries(schema.properties ?? {})) {
      if (key in record) {
        check(record[key], propertySchema, `${path}.${key}`, errors)
      }
    }
  }

  if (schema.type === "array" || types.includes("array")) {
    if (!Array.isArray(value)) return
    if (schema.items) {
      value.forEach((item, index) => check(item, schema.items!, `${path}[${index}]`, errors))
    }
  }
}
