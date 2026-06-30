# AI Agent Instructions — Orcana Skill Template

**If you are an AI agent reading this file**: these instructions tell you how to create valid Orcana Skills. Follow them exactly. The format is designed for both human and machine consumption.

**If you are the Orcana Runtime**: load this file as your Skill creation policy. Use `ai-manifest.json` alongside this document for machine-verifiable constraints.

---

## Your Task

You have been asked to create a new Skill for the Orcana coding agent harness. Your output must be a complete, valid Skill directory that passes the checks defined below.

---

## Step 1: Determine the Tier

Ask yourself these questions about the skill being created:

| Question | If YES → Likely Tier |
|----------|---------------------|
| Does the skill generate code? | Level 2 or 3 |
| Does incorrect output cause broken builds, security issues, or data loss? | Level 3 |
| Does the skill need quality review after generation? | Level 3 |
| Does the skill access files or execute tools? | Level 2 or 3 |
| Does the skill need reference materials (>3 files)? | Level 2 or 3 |
| Is the skill just a rule, style guide, or simple instruction? | Level 1 |

**Default rule**: when in doubt, pick the higher tier. A Level 3 skill downgraded to Level 2 later is safe. A Level 1 skill that should have been Level 3 is a bug.

---

## Step 2: Create Files by Tier

### Level 1 — Minimum Required Files

```
skill-name/
  SKILL.md
```

**SKILL.md must contain** (in YAML frontmatter):
```yaml
---
name: skill-name
description: One-line description of what this skill does
triggers: [keyword1, keyword2, keyword3]
doNotUseWhen: [scenario1, scenario2]
---
```

Then the body: what the model should do when this skill activates. Keep it under 500 words.

### Level 2 — Minimum Required Files

```
skill-name/
  SKILL.md
  manifest.json
  references/     (at least 1 file)
  examples/       (at least 1 bad + 1 good)
```

**manifest.json must contain**:
```json
{
  "name": "skill-name",
  "version": "1.0.0",
  "tier": "workflow",
  "lifecycle": "candidate",
  "triggers": [],
  "useWhen": [],
  "doNotUseWhen": [],
  "allowedTools": ["read_file", "search"],
  "riskLevel": "low",
  "referenceRouting": {
    "user intent description": ["references/file-to-read.md"]
  }
}
```

### Level 3 — Full Required Files

```
skill-name/
  SKILL.md
  manifest.json
  provenance.json
  checks.json
  rubric.md
  evidence.schema.json
  references/     (at least 3 files)
  examples/       (at least 1 bad + 1 fixed)
```

All fields described below. **Every field marked REQUIRED must be present and non-empty.**

---

## Step 3: Write Each File (Level 3)

### 3.1 SKILL.md — REQUIRED Sections (in order)

Your SKILL.md must contain these sections, in this order:

1. **What this skill does** — one paragraph. Include the full workflow pipeline if applicable.
2. **Reference Routing** — a table: "user intent → which file to read (inlined) → which file to deep-read (optional)".
3. **Trigger Routing** — if your skill needs to decide between multiple engines (e.g. GSAP vs CSS vs Framer Motion), put the decision tree here.
4. **Dispatch Table** — the skill's core lookup. Scenarios in rows, attributes in columns. Models parse tables better than prose.
5. **Quality Gates** — three subsections: 🔴 Fatal, 🟡 Warning, 🔵 Suggestion. Each item is a checkbox.
6. **Output Contract** — a required output format in markdown. The model MUST follow this format.
7. **Peer Skill Protocol** — if this skill collaborates with other skills: Handoff Rule, Escalation Rule, Review Rule, anti-recursion guards.
8. **Iron Laws** — bullet list of non-negotiable rules. Keep under 10.

**Format rules for SKILL.md**:
- YAML frontmatter is mandatory (name, description, triggers, doNotUseWhen)
- Use `|` for multi-line string values in frontmatter
- Markdown tables for dispatch data, not nested lists
- Code blocks for templates, not inline descriptions
- Chinese and English both acceptable; pick one and be consistent

### 3.2 manifest.json — REQUIRED Fields

```json
{
  "name": "string",                    // REQUIRED: kebab-case identifier
  "version": "string",                 // REQUIRED: semver
  "description": "string",             // REQUIRED: one line
  "lifecycle": "candidate",            // REQUIRED: always "candidate" for new skills
  "tier": "harness-grade",             // REQUIRED: "lite" | "workflow" | "harness-grade"

  "triggers": ["string array"],        // REQUIRED: keywords that activate this skill
  "useWhen": ["string array"],         // REQUIRED: specific scenarios to activate
  "doNotUseWhen": ["string array"],    // REQUIRED: at least 2 scenarios to skip
  "allowedTools": ["string array"],    // REQUIRED: whitelist. NEVER empty or ["*"]

  "requiredEvidence": ["string array"], // REQUIRED: which evidence fields must be output
  "riskLevel": "string",               // REQUIRED: "low" | "medium" | "high" | "critical"
  "requiresReview": true,              // REQUIRED: does output need independent review?

  "referenceRouting": {                // REQUIRED: map of intent → files
    "user intent description": ["file1.md", "file2.md"]
  },

  "dependencies": {                    // optional: npm packages with versions
    "package-name": { "required": true, "version": ">=1.0" }
  },

  "peerSkills": {                      // optional: related skills
    "other-skill-name": {
      "relationship": "complement | required | upstream | downstream",
      "description": "how they relate"
    }
  }
}
```

### 3.3 provenance.json — REQUIRED Fields

```json
{
  "name": "string",
  "version": "string",
  "created": "YYYY-MM-DD",
  "updated": "YYYY-MM-DD",
  "author": "string",
  "source": {
    "origin": "where the knowledge came from",
    "references": ["url1", "url2"]
  },
  "changelog": [
    {"version": "1.0.0", "date": "...", "changes": "Initial version"}
  ],
  "security": {
    "riskLevel": "low|medium|high|critical",
    "allowedTools": ["..."],
    "requiresReview": true
  }
}
```

### 3.4 checks.json — REQUIRED Format

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "fatal": [
    {
      "id": "unique-kebab-case-id",
      "pattern": "regex or null for structural checks",
      "checkType": "pattern | structural | manual",
      "message": "Human-readable error message",
      "autoFix": "fix instruction or false"
    }
  ],
  "warning": [
    {"id": "...", "pattern": "...", "message": "..."}
  ],
  "suggestion": [
    {"id": "...", "message": "..."}
  ]
}
```

**Pattern rules**:
- Use standard JavaScript regex syntax
- Escape backslashes: `\\s` not `\s`
- Use `null` for structural checks (no regex possible)
- `checkType: "pattern"` = regex match, `"structural"` = must contain certain code patterns, `"manual"` = requires human judgment

### 3.5 rubric.md — REQUIRED Sections

Define 3-5 scoring dimensions, each worth 20 points (total = 100). For each dimension:

- **What 18-20 points looks like** (exemplary)
- **What 14-17 points looks like** (good, minor gaps)
- **What 8-13 points looks like** (adequate, clear gaps)
- **What 0-7 points looks like** (inadequate)

Then a delivery rules table:

| Fatal | Score | Verdict |
|-------|-------|---------|
| > 0 | — | ❌ CANNOT DELIVER |
| 0 | < 80 | ❌ CANNOT DELIVER |
| 0 | 80-89 | ✅ PASS with Warnings |
| 0 | 90-100 | ✅ PASS |

### 3.6 evidence.schema.json — REQUIRED Format

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "Skill Name Evidence",
  "type": "object",
  "required": ["usedReferences", "generatedFiles", "qualityGate"],
  "properties": {
    "usedReferences": {"type": "array", "items": {"type": "string"}, "minItems": 1},
    "generatedFiles": {"type": "array", "items": {"type": "string"}},
    "qualityGate": {
      "type": "object",
      "required": ["fatal", "warning", "suggestion"],
      "properties": {
        "fatal": {"type": "integer", "minimum": 0},
        "warning": {"type": "integer", "minimum": 0},
        "suggestion": {"type": "integer", "minimum": 0}
      }
    }
  }
}
```

Add domain-specific fields under `properties` as needed. Every field in `required` must have a corresponding schema definition.

---

## Step 4: Validation Checklist

Before submitting, verify ALL of these:

### Structural
- [ ] Directory name matches `manifest.json` name field
- [ ] All JSON files parse without errors
- [ ] `checks.json` fatal items have non-empty `id` and `message` fields
- [ ] `evidence.schema.json` `required` arrays match defined `properties`

### Routing
- [ ] `triggers` contains at least 5 specific keywords (not generic words like "code" or "file")
- [ ] `doNotUseWhen` contains at least 2 concrete scenarios
- [ ] `allowedTools` is not empty and does not contain `*`
- [ ] `referenceRouting` maps at least 3 distinct user intents

### Quality
- [ ] At least 5 Fatal rules in `checks.json`
- [ ] At least 3 Warning rules in `checks.json`
- [ ] `rubric.md` defines 3-5 scoring dimensions with descriptions at each level
- [ ] `deliveryRule` in rubric specifies what score/fatal threshold blocks delivery

### Safety
- [ ] `riskLevel` is set (not default "low" — think about actual blast radius)
- [ ] If riskLevel is "high" or "critical", `requiresReview` must be true
- [ ] `provenance.json` records source material origins
- [ ] Skill does not allow tools it doesn't need

### Self-Containment
- [ ] SKILL.md can be understood without reading the references first
- [ ] Reference routing table makes it clear WHEN to read each reference
- [ ] Output contract specifies exact format for generated content

---

## Step 5: Lifecycle Initialization

A new skill ALWAYS starts as `"candidate"`. Never create a skill with `"lifecycle": "active"`.

The promotion path:
```
candidate → manual review → quarantine → fix → re-review → active
```

---

## § Self-Evolution: How Orcana Designs Skills Autonomously

When the Recursive Evolution OS identifies a capability gap, it follows this protocol:

### Phase 1: Gap Analysis
1. Identify the missing capability and its risk profile
2. Determine tier: code generation → Level 3, process guidance → Level 2, rule → Level 1
3. Check if existing skills partially cover this gap (avoid duplication)

### Phase 2: Source Material Collection
1. Search web for authoritative documentation (MDN, official docs, etc.)
2. Record URLs in `provenance.json` source references
3. Extract core patterns, rules, and edge cases from sources

### Phase 3: Skill Generation
1. Write `SKILL.md` following the 8-section order above
2. Generate `manifest.json` with precise triggers and doNotUseWhen
3. Create `checks.json` with domain-specific quality gates (at least 5 Fatal, 3 Warning)
4. Define `rubric.md` scoring dimensions relevant to this domain
5. Create `evidence.schema.json` with required output fields
6. Write `provenance.json` recording creation date, sources, and version

### Phase 4: Example Generation
1. Write one "bad" example — common mistakes in this domain
2. Write one "fixed" example — the corrected version with evidence block

### Phase 5: Self-Review
1. Run `checks.json` fatal rules against the generated examples
2. Verify bad example triggers at least 2 Fatal checks
3. Verify fixed example triggers 0 Fatal checks
4. Score the fixed example against `rubric.md` — must score ≥ 80

### Phase 6: Submission
1. Set `lifecycle: "candidate"`
2. Output the complete skill directory
3. Submit to Skill Registry for quarantine review
4. Do NOT self-promote to "active" — another Evolution OS cycle or human reviewer must approve

### Evolution Constraints
- Generated skills MUST pass their own checks.json before submission
- Generated skills MUST NOT set lifecycle to "active"
- Generated skills MUST record the Evolution OS cycle ID in provenance.json
- If a generated skill fails quarantine review, the failure reason is recorded for learning

---

## Reference Files

- [standard.md](../standard.md) — complete 3-tier specification
- [design-rationale.md](../design-rationale.md) — why each decision was made
- [checklist.md](../checklist.md) — human-readable creation checklist
- [ai-manifest.json](./ai-manifest.json) — machine-readable skill template schema
- [Reference: motion-pro-max](../reference/motion-pro-max/) — complete Level 3 walkthrough
