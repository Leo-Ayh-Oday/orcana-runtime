/**
 * API Surface Diff — Layer 1 of Ripple Engine 2.0.
 *
 * Replaces the coarse `changedSymbols(): string[]` with structured
 * `ApiChange[]` that classifies every difference between old and new
 * symbol tables into 8 high-yield change kinds.
 *
 * Each ApiChange carries a pre-computed severity so downstream code
 * (previewEdit, tightenRippleDecision, formatRippleBlock) can switch
 * on kind + severity instead of manually re-deriving the same
 * conclusions from raw SymbolInfo fields.
 */

// ── SymbolShape ────────────────────────────────────────────────

/** Lightweight serializable snapshot of a single exported / public symbol.
 *  Narrower than engine.ts's internal SymbolInfo — only the fields
 *  needed for surface comparison. */
export interface SymbolShape {
  name: string
  kind: "function" | "interface" | "type" | "class" | "const"
  exported: boolean
  header: string
  async: boolean
  returnType: string
  /** Field / member names (interface members, class methods/properties). */
  fields: string[]
  /** 1-based line number (display only). */
  line: number
  /** Byte offset of the identifier name in the source file. */
  nameStart: number
  /** Byte offset just past the identifier name. */
  nameEnd: number
  /** Byte offset of the declaration start. */
  declStart: number
  /** Byte offset just past the declaration end. */
  declEnd: number
}

// ── ApiChange ───────────────────────────────────────────────────

export type ApiChangeKind =
  | "export_removed"
  | "export_added"
  | "signature_changed"
  | "async_boundary_changed"
  | "return_type_changed"
  | "interface_field_removed"
  | "interface_field_added"
  | "kind_changed"

export interface ApiChange {
  kind: ApiChangeKind
  symbol: string
  oldShape?: SymbolShape
  newShape?: SymbolShape
  /** Pre-computed severity based on kind + exported status. */
  severity: "info" | "warn" | "block"
  /** Human-readable one-line description of what changed. */
  detail: string
}

// ── Severity computation ────────────────────────────────────────

function computeSeverity(kind: ApiChangeKind, oldExported: boolean, newExported: boolean): ApiChange["severity"] {
  const exported = oldExported || newExported
  switch (kind) {
    case "export_removed":
    case "async_boundary_changed":
    case "interface_field_removed":
      return "block"
    case "signature_changed":
    case "kind_changed":
      return exported ? "block" : "warn"
    case "return_type_changed":
      return exported ? "warn" : "info"
    case "export_added":
    case "interface_field_added":
      return "info"
  }
}

// ── Shape extraction ────────────────────────────────────────────

/**
 * Convert engine.ts's internal SymbolInfo map into SymbolShape[].
 * Callers pass `extractSymbols()` result through this before diffing.
 */
export function toSymbolShapes(symbols: Map<string, {
  name: string
  kind: "function" | "interface" | "type" | "class" | "const"
  exported: boolean
  header: string
  async: boolean
  returnType: string
  fields: Set<string>
  line: number
  nameStart: number
  nameEnd: number
  declStart: number
  declEnd: number
}>): Map<string, SymbolShape> {
  const out = new Map<string, SymbolShape>()
  for (const [key, sym] of symbols) {
    out.set(key, {
      name: sym.name,
      kind: sym.kind,
      exported: sym.exported,
      header: sym.header,
      async: sym.async,
      returnType: sym.returnType,
      fields: [...sym.fields],
      line: sym.line,
      nameStart: sym.nameStart,
      nameEnd: sym.nameEnd,
      declStart: sym.declStart,
      declEnd: sym.declEnd,
    })
  }
  return out
}

// ── Diff engine ─────────────────────────────────────────────────

/**
 * Compare two symbol tables and return structured changes.
 *
 * Detection order matters — the first matching kind wins:
 *   1. export_removed      — old exported, no new
 *   2. export_added        — new exported, no old
 *   3. kind_changed        — function→const, interface→type, etc.
 *   4. async_boundary_changed — sync↔async transition
 *   5. signature_changed   — header text differs
 *   6. return_type_changed — only return type differs (header same)
 *   7. interface_field_removed / added
 *
 * A single symbol can produce multiple ApiChange entries
 * (e.g. a function that became async AND changed return type).
 */
export function diffApiSurface(
  oldShapes: Map<string, SymbolShape>,
  newShapes: Map<string, SymbolShape>,
): ApiChange[] {
  const changes: ApiChange[] = []
  const allNames = new Set([...oldShapes.keys(), ...newShapes.keys()])

  for (const name of allNames) {
    const oldSym = oldShapes.get(name)
    const newSym = newShapes.get(name)

    // ── 1. Removed ──
    if (oldSym && !newSym) {
      if (oldSym.exported) {
        changes.push({
          kind: "export_removed",
          symbol: name,
          oldShape: oldSym,
          severity: computeSeverity("export_removed", oldSym.exported, false),
          detail: `Exported ${oldSym.kind} '${name}' was removed.`,
        })
      }
      continue
    }

    // ── 2. Added ──
    if (!oldSym && newSym) {
      if (newSym.exported) {
        changes.push({
          kind: "export_added",
          symbol: name,
          newShape: newSym,
          severity: computeSeverity("export_added", false, newSym.exported),
          detail: `Exported ${newSym.kind} '${name}' was added.`,
        })
      }
      continue
    }

    if (!oldSym || !newSym) continue

    // ── 3. Kind changed ──
    if (oldSym.kind !== newSym.kind) {
      changes.push({
        kind: "kind_changed",
        symbol: name,
        oldShape: oldSym,
        newShape: newSym,
        severity: computeSeverity("kind_changed", oldSym.exported, newSym.exported),
        detail: `'${name}' changed from ${oldSym.kind} to ${newSym.kind}.`,
      })
      // Still check other changes below — kind change doesn't absorb everything
    }

    // ── 4. Async boundary changed ──
    if (oldSym.async !== newSym.async) {
      changes.push({
        kind: "async_boundary_changed",
        symbol: name,
        oldShape: oldSym,
        newShape: newSym,
        severity: computeSeverity("async_boundary_changed", oldSym.exported, newSym.exported),
        detail: oldSym.async
          ? `'${name}' changed from async to sync.`
          : `'${name}' changed from sync to async.`,
      })
    }

    // ── 5. Signature changed (header text differs) ──
    // ── 6. Return type changed (may co-occur with signature change) ──
    const headerChanged = oldSym.header !== newSym.header
    const returnTypeChanged = oldSym.returnType !== newSym.returnType

    if (headerChanged) {
      changes.push({
        kind: "signature_changed",
        symbol: name,
        oldShape: oldSym,
        newShape: newSym,
        severity: computeSeverity("signature_changed", oldSym.exported, newSym.exported),
        detail: `'${name}' signature changed.`,
      })
    }

    if (returnTypeChanged) {
      changes.push({
        kind: "return_type_changed",
        symbol: name,
        oldShape: oldSym,
        newShape: newSym,
        severity: computeSeverity("return_type_changed", oldSym.exported, newSym.exported),
        detail: `'${name}' return type changed from '${oldSym.returnType || "void"}' to '${newSym.returnType || "void"}'.`,
      })
    }

    // ── 7 & 8. Interface / class field changes ──
    if (oldSym.kind === "interface" || oldSym.kind === "class") {
      const oldFields = new Set(oldSym.fields)
      const newFields = new Set(newSym.fields)
      for (const field of oldFields) {
        if (!newFields.has(field)) {
          changes.push({
            kind: "interface_field_removed",
            symbol: `${name}.${field}`,
            oldShape: oldSym,
            newShape: newSym,
            severity: computeSeverity("interface_field_removed", oldSym.exported, newSym.exported),
            detail: `Field '${field}' removed from ${oldSym.kind} '${name}'.`,
          })
        }
      }
      for (const field of newFields) {
        if (!oldFields.has(field)) {
          changes.push({
            kind: "interface_field_added",
            symbol: `${name}.${field}`,
            oldShape: oldSym,
            newShape: newSym,
            severity: computeSeverity("interface_field_added", oldSym.exported, newSym.exported),
            detail: `Field '${field}' added to ${newSym.kind} '${name}'.`,
          })
        }
      }
    }
  }

  return changes
}

// ── Utility ─────────────────────────────────────────────────────

/** Extract just the symbol names from a list of ApiChanges. */
export function changedSymbolNames(changes: ApiChange[]): string[] {
  return [...new Set(changes.map(c => c.symbol.split(".")[0] ?? c.symbol))]
}

/** True if any change has the given severity or higher. */
export function hasSeverity(changes: ApiChange[], severity: ApiChange["severity"]): boolean {
  if (severity === "block") return changes.some(c => c.severity === "block")
  if (severity === "warn") return changes.some(c => c.severity === "block" || c.severity === "warn")
  return changes.length > 0
}
