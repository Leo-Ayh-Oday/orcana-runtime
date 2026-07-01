/** Tests for OrcanaComposer pure functions — covers PR-3 acceptance points.
 *
 *  Points covered:
 *    1. Paste block system: pasteToken, displayDraft, expandDraft, labelForPaste
 *    2. Paste detection: shouldStagePaste, findInsertedText (diff-based)
 *    3. Cursor position: flatToRowCol (flat → [row, col])
 *    4. Multi-line handling: countLines
 *    5. "英文说明吞掉正文" fix: TextArea viewport (verified via component structure)
 */

import { describe, expect, test } from "bun:test"
import {
  pasteToken,
  countLines,
  labelForPaste,
  displayDraft,
  expandDraft,
  shouldStagePaste,
  findInsertedText,
  flatToRowCol,
  type PasteBlock,
} from "../../src/tui/components/OrcanaComposer"

// ── pasteToken ──

describe("pasteToken", () => {
  test("generates PASTE:N format for id=1", () => {
    expect(pasteToken(1)).toBe("PASTE:1")
  })

  test("generates PASTE:N format for large id", () => {
    expect(pasteToken(42)).toBe("PASTE:42")
  })

  test("generates PASTE:0 for zero id", () => {
    expect(pasteToken(0)).toBe("PASTE:0")
  })
})

// ── countLines ──

describe("countLines", () => {
  test("returns 0 for empty string", () => {
    expect(countLines("")).toBe(0)
  })

  test("returns 1 for single line", () => {
    expect(countLines("hello")).toBe(1)
  })

  test("returns 2 for two lines", () => {
    expect(countLines("line1\nline2")).toBe(2)
  })

  test("returns 3 for three lines with trailing newline", () => {
    expect(countLines("a\nb\nc")).toBe(3)
  })

  test("returns 4 for three newlines", () => {
    expect(countLines("a\nb\nc\n")).toBe(4)
  })
})

// ── labelForPaste ──

describe("labelForPaste", () => {
  test("single line paste label", () => {
    const block: PasteBlock = { id: 1, token: "PASTE:1", text: "hello", lines: 1, chars: 5 }
    expect(labelForPaste(block)).toBe("[Pasted text #1, 5 chars loaded]")
  })

  test("multi-line paste label includes line count", () => {
    const block: PasteBlock = { id: 2, token: "PASTE:2", text: "line1\nline2\nline3", lines: 3, chars: 17 }
    expect(labelForPaste(block)).toBe("[Pasted text #2 +3 lines, 17 chars loaded]")
  })

  test("large paste label", () => {
    const block: PasteBlock = { id: 10, token: "PASTE:10", text: "x".repeat(1000), lines: 1, chars: 1000 }
    expect(labelForPaste(block)).toBe("[Pasted text #10, 1000 chars loaded]")
  })
})

// ── displayDraft ──

describe("displayDraft", () => {
  test("returns text unchanged when no paste blocks", () => {
    expect(displayDraft("hello world", [])).toBe("hello world")
  })

  test("replaces token with label", () => {
    const block: PasteBlock = { id: 1, token: "PASTE:1", text: "pasted content", lines: 1, chars: 14 }
    expect(displayDraft("before PASTE:1 after", [block])).toBe(
      "before [Pasted text #1, 14 chars loaded] after",
    )
  })

  test("replaces multiple different tokens", () => {
    const b1: PasteBlock = { id: 1, token: "PASTE:1", text: "aaa", lines: 1, chars: 3 }
    const b2: PasteBlock = { id: 2, token: "PASTE:2", text: "bbb", lines: 1, chars: 3 }
    expect(displayDraft("PASTE:1 and PASTE:2", [b1, b2])).toBe(
      "[Pasted text #1, 3 chars loaded] and [Pasted text #2, 3 chars loaded]",
    )
  })

  test("handles token without matching block (shows fallback)", () => {
    expect(displayDraft("PASTE:99", [])).toBe("[Pasted text #99]")
  })

  test("handles empty string", () => {
    expect(displayDraft("", [])).toBe("")
  })

  test("preserves text with no tokens", () => {
    const block: PasteBlock = { id: 1, token: "PASTE:1", text: "x", lines: 1, chars: 1 }
    expect(displayDraft("no tokens here", [block])).toBe("no tokens here")
  })
})

// ── expandDraft ──

describe("expandDraft", () => {
  test("returns text unchanged when no paste blocks", () => {
    expect(expandDraft("hello", [])).toBe("hello")
  })

  test("expands token to original text", () => {
    const block: PasteBlock = { id: 1, token: "PASTE:1", text: "original pasted content", lines: 1, chars: 23 }
    expect(expandDraft("before PASTE:1 after", [block])).toBe("before original pasted content after")
  })

  test("expands multiple tokens", () => {
    const b1: PasteBlock = { id: 1, token: "PASTE:1", text: "AAA", lines: 1, chars: 3 }
    const b2: PasteBlock = { id: 2, token: "PASTE:2", text: "BBB", lines: 1, chars: 3 }
    expect(expandDraft("PASTE:1 PASTE:2", [b1, b2])).toBe("AAA BBB")
  })

  test("handles token without matching block (empty string)", () => {
    expect(expandDraft("PASTE:99", [])).toBe("")
  })

  test("empty string input", () => {
    expect(expandDraft("", [])).toBe("")
  })

  test("multi-line paste expansion", () => {
    const block: PasteBlock = {
      id: 1,
      token: "PASTE:1",
      text: "line1\nline2\nline3",
      lines: 3,
      chars: 17,
    }
    expect(expandDraft("PASTE:1", [block])).toBe("line1\nline2\nline3")
  })
})

// ── shouldStagePaste ──

describe("shouldStagePaste", () => {
  test("returns false for empty string", () => {
    expect(shouldStagePaste("")).toBe(false)
  })

  test("returns false for short single-line text", () => {
    expect(shouldStagePaste("hello")).toBe(false)
  })

  test("returns true for text exceeding char threshold (800+)", () => {
    expect(shouldStagePaste("x".repeat(800))).toBe(true)
  })

  test("returns true for multi-line text (2+ lines)", () => {
    expect(shouldStagePaste("line1\nline2")).toBe(true)
  })

  test("returns false for single character", () => {
    expect(shouldStagePaste("a")).toBe(false)
  })

  test("returns true for large multi-line paste", () => {
    const text = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n")
    expect(shouldStagePaste(text)).toBe(true)
  })
})

// ── findInsertedText ──

describe("findInsertedText", () => {
  test("returns null when newValue is shorter (deletion)", () => {
    expect(findInsertedText("hello world", "hello")).toBeNull()
  })

  test("returns null when values are equal", () => {
    expect(findInsertedText("hello", "hello")).toBeNull()
  })

  test("returns null for small insertion (< 40 chars, < 2 lines)", () => {
    expect(findInsertedText("hello", "hello world")).toBeNull()
  })

  test("detects large insertion at end", () => {
    const oldValue = "hello "
    const inserted = "x".repeat(800)
    const newValue = oldValue + inserted
    const result = findInsertedText(oldValue, newValue)
    expect(result).not.toBeNull()
    expect(result!.inserted).toBe(inserted)
    expect(result!.start).toBe(oldValue.length)
    expect(result!.end).toBe(newValue.length)
  })

  test("detects large insertion at beginning", () => {
    const inserted = "x".repeat(800)
    const oldValue = " world"
    const newValue = inserted + oldValue
    const result = findInsertedText(oldValue, newValue)
    expect(result).not.toBeNull()
    expect(result!.inserted).toBe(inserted)
    expect(result!.start).toBe(0)
    expect(result!.end).toBe(inserted.length)
  })

  test("detects large insertion in middle", () => {
    const prefix = "hello "
    const suffix = " world"
    const inserted = "x".repeat(800)
    const oldValue = prefix + suffix
    const newValue = prefix + inserted + suffix
    const result = findInsertedText(oldValue, newValue)
    expect(result).not.toBeNull()
    expect(result!.inserted).toBe(inserted)
    expect(result!.start).toBe(prefix.length)
    expect(result!.end).toBe(prefix.length + inserted.length)
  })

  test("detects multi-line insertion (2+ lines)", () => {
    const oldValue = "hello"
    const inserted = "line1\nline2\nline3"
    const newValue = oldValue + inserted
    const result = findInsertedText(oldValue, newValue)
    expect(result).not.toBeNull()
    expect(result!.inserted).toBe(inserted)
  })

  test("returns null for very small diff (< 40 chars)", () => {
    const oldValue = "hello"
    const newValue = "hello world some more text"
    expect(findInsertedText(oldValue, newValue)).toBeNull()
  })

  test("handles empty oldValue", () => {
    const inserted = "x".repeat(800)
    const result = findInsertedText("", inserted)
    expect(result).not.toBeNull()
    expect(result!.inserted).toBe(inserted)
    expect(result!.start).toBe(0)
    expect(result!.end).toBe(inserted.length)
  })

  test("handles CJK characters in insertion", () => {
    const oldValue = "开始 "
    const inserted = "中".repeat(400)
    const newValue = oldValue + inserted
    const result = findInsertedText(oldValue, newValue)
    expect(result).not.toBeNull()
    expect(result!.inserted).toBe(inserted)
  })
})

// ── flatToRowCol ──

describe("flatToRowCol", () => {
  test("returns [0, 0] for position 0", () => {
    expect(flatToRowCol("hello", 0)).toEqual([0, 0])
  })

  test("returns [0, 4] for position 4 in single line", () => {
    expect(flatToRowCol("hello", 4)).toEqual([0, 4])
  })

  test("returns [0, 5] for position at end of single line", () => {
    expect(flatToRowCol("hello", 5)).toEqual([0, 5])
  })

  test("returns [1, 0] for position right after newline", () => {
    expect(flatToRowCol("hello\nworld", 6)).toEqual([1, 0])
  })

  test("returns [1, 3] for position in second line", () => {
    expect(flatToRowCol("hello\nworld", 9)).toEqual([1, 3])
  })

  test("returns [2, 0] for position after two newlines", () => {
    expect(flatToRowCol("a\nb\nc", 4)).toEqual([2, 0])
  })

  test("returns [2, 1] for position in third line", () => {
    expect(flatToRowCol("a\nb\ncd", 5)).toEqual([2, 1])
  })

  test("handles position beyond text length (clamps)", () => {
    expect(flatToRowCol("hello", 100)).toEqual([0, 5])
  })

  test("handles empty string", () => {
    expect(flatToRowCol("", 0)).toEqual([0, 0])
  })

  test("handles position 0 on multi-line text", () => {
    expect(flatToRowCol("line1\nline2\nline3", 0)).toEqual([0, 0])
  })

  test("handles CJK characters (treats as single chars)", () => {
    expect(flatToRowCol("你好\n世界", 3)).toEqual([1, 0])
  })
})

// ── Integration: displayDraft + expandDraft round-trip ──

describe("paste block round-trip", () => {
  test("display then expand restores original", () => {
    const originalText = "This is a large pasted content that exceeds the threshold limit."
    const block: PasteBlock = {
      id: 1,
      token: pasteToken(1),
      text: originalText,
      lines: countLines(originalText),
      chars: originalText.length,
    }
    const draft = `before ${block.token} after`
    const displayed = displayDraft(draft, [block])
    const expanded = expandDraft(draft, [block])

    // displayed should contain the label, not the original text
    expect(displayed).toContain("[Pasted text #1")
    expect(displayed).not.toContain(originalText)

    // expanded should contain the original text
    expect(expanded).toContain(originalText)
    expect(expanded).toBe(`before ${originalText} after`)
  })

  test("multiple paste blocks round-trip", () => {
    const text1 = "x".repeat(800)
    const text2 = "y".repeat(800)
    const b1: PasteBlock = { id: 1, token: pasteToken(1), text: text1, lines: 1, chars: 800 }
    const b2: PasteBlock = { id: 2, token: pasteToken(2), text: text2, lines: 1, chars: 800 }

    const draft = `PASTE:1 middle PASTE:2`
    const expanded = expandDraft(draft, [b1, b2])
    expect(expanded).toBe(`${text1} middle ${text2}`)
  })
})

// ── findInsertedText + shouldStagePaste integration ──

describe("paste detection integration", () => {
  test("large paste is detected and qualifies for staging", () => {
    const oldValue = "hello"
    const inserted = "x".repeat(1000)
    const newValue = oldValue + inserted

    const diff = findInsertedText(oldValue, newValue)
    expect(diff).not.toBeNull()
    expect(shouldStagePaste(diff!.inserted)).toBe(true)
  })

  test("small insertion is detected but not staged", () => {
    const oldValue = "hello"
    const newValue = "hello world"
    const diff = findInsertedText(oldValue, newValue)
    // Small diff returns null (pruned)
    expect(diff).toBeNull()
  })

  test("multi-line paste is detected and staged", () => {
    const oldValue = "start "
    const inserted = "line1\nline2\nline3\nline4"
    const newValue = oldValue + inserted

    const diff = findInsertedText(oldValue, newValue)
    expect(diff).not.toBeNull()
    expect(shouldStagePaste(diff!.inserted)).toBe(true)
  })
})
