import { describe, expect, test } from "bun:test"
import stringWidth from "string-width"
import { formatDisplayText, wrapTerminalLine } from "../src/tui/format"

describe("TUI display formatting", () => {
  test("normalizes markdown tables into aligned terminal rows", () => {
    const lines = formatDisplayText([
      "| 引擎 | 语言 | 适合 |",
      "| Godot | GDScript / C# | 独立游戏、开源免费 |",
      "| Unity | C# | 中大型项目 |",
    ].join("\n"), 100)

    expect(lines[0]).toContain("| 引擎")
    expect(lines[1]).toMatch(/^\| -+/)
    expect(lines[2]).toContain("Godot")
    expect(lines[3]).toContain("Unity")
    expect(new Set(lines.map(line => stringWidth(line))).size).toBeLessThanOrEqual(2)
  })

  test("wraps wide CJK text by terminal width instead of utf16 length", () => {
    const lines = wrapTerminalLine("可以做游戏，取决于你要什么类型", 12)

    expect(lines.length).toBeGreaterThan(1)
    expect(lines.every(line => line.length <= 12)).toBe(true)
  })

  test("wraps long markdown table cells without discarding their tail", () => {
    const lines = formatDisplayText([
      "| 能力 | 说明 |",
      "| 搜索 | 这段很长的说明必须完整保留直到最后四个字 |",
    ].join("\n"), 32)

    expect(lines.join("").replace(/[|\s]/g, "")).toContain("最后四个字")
  })
})
