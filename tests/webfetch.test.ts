import { describe, expect, test } from "bun:test"
import { summarizeFetchedContent } from "../src/tools/webfetch"

describe("web_fetch summarization", () => {
  test("condenses wrapped GitHub repository JSON when summarize is requested", () => {
    const body = {
      full_name: "owner/project",
      description: "useful project",
      html_url: "https://github.com/owner/project",
      stargazers_count: 1234,
      language: "TypeScript",
      owner: { avatar_url: "x".repeat(8_000), events_url: "y".repeat(8_000) },
    }
    const fetched = `Title:\n\nMarkdown Content:\n${JSON.stringify(body, null, 2)}`
    const summary = summarizeFetchedContent(fetched, "https://api.github.com/repos/owner/project")

    expect(summary).toContain("owner/project")
    expect(summary).toContain("1234")
    expect(summary.length).toBeLessThan(3_000)
    expect(summary).not.toContain("avatar_url")
  })
})
