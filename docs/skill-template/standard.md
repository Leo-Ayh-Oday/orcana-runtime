# Orcana Skill Template Standard

**Gold Standard for Harness-grade Skills. Three tiers — match the tier to the skill's risk and complexity.**

> motion-pro-max v2.0.0 is the reference implementation of a **Level 3 Harness-grade Skill**. All future production skills should follow this standard.

---

## Tier Decision Table

| Question | Lite | Workflow | Harness |
|----------|------|----------|---------|
| Does the skill generate code? | No | Sometimes | Yes |
| Does the skill need quality review? | No | Optional | Required |
| Does the skill access files/tools? | No | Readonly | May write |
| Does incorrect output cause damage? | No | UX issues | Broken builds/Security |
| Does the skill need reference materials? | No | ≤ 3 files | > 3 files |
| Does the skill need evidence output? | No | Optional | Required |

---

## Level 1: Lite Skill

For simple rules, response styles, and one-line workflows.

```
my-skill/
  SKILL.md
```

**SKILL.md must contain:**

```yaml
---
name: my-skill
description: One-line description
triggers: [keyword1, keyword2]
doNotUseWhen: [when not to trigger]
---
```

**Examples:** commit message format, reply language setting, naming conventions.

---

## Level 2: Workflow Skill

For fixed workflows with steps and reference materials.

```
my-skill/
  SKILL.md
  manifest.json
  references/
    guide.md
  examples/
    good.md
    bad.md
```

**manifest.json must contain:**

```json
{
  "name": "my-skill",
  "version": "1.0.0",
  "tier": "workflow",
  "lifecycle": "active",
  "triggers": [],
  "useWhen": [],
  "doNotUseWhen": [],
  "allowedTools": ["read_file", "search"],
  "riskLevel": "low",
  "referenceRouting": {
    "intent-a": ["references/guide.md"]
  }
}
```

**SKILL.md must contain:** name, description, when to use, when not to use, workflow steps, reference routing, output format.

**Examples:** PR review, issue triage, README audit, architecture review.

---

## Level 3: Harness-grade Skill

For production code generation, quality-critical workflows, and skills that produce verifiable output.

```
my-skill/
  SKILL.md                 # Human/model-readable main workflow
  manifest.json            # Machine-readable metadata + routing
  provenance.json          # Origin, version, changelog, security
  checks.json              # Machine-executable quality gates
  rubric.md                # Human-readable scoring criteria
  evidence.schema.json     # Mandatory output evidence format
  references/              # Progressive disclosure materials
    routing.md
    recipes.md
    quality-gates.md
  examples/                # Bad → Good → Fixed triples
    scenario.bad.tsx
    scenario.fixed.tsx
  eval/                    # Smoke tests + regression cases
    smoke.md
    regression.md
```

### manifest.json — Standard Fields

```json
{
  "name": "my-skill",
  "version": "1.0.0",
  "description": "One-line",
  "lifecycle": "active",
  "tier": "harness-grade",
  "triggers": ["keyword array"],
  "useWhen": ["specific scenarios to activate"],
  "doNotUseWhen": ["specific scenarios to skip"],
  "allowedTools": ["read_file", "search"],
  "requiredEvidence": ["field1", "field2"],
  "riskLevel": "low | medium | high | critical",
  "referenceRouting": {
    "user intent A": ["refs/a.md"],
    "user intent B": ["refs/b.md"]
  },
  "optionalReferences": {
    "deeper context": ["refs/deep.md"]
  },
  "qualityGates": {
    "fatal": 13,
    "warning": 8,
    "deliveryRule": "Fatal > 0 or Score < 80 = cannot deliver"
  },
  "dependencies": {},
  "peerSkills": {}
}
```

### lifecycle States

| State | Meaning |
|-------|---------|
| `candidate` | New skill, under evaluation. Not auto-triggered. |
| `quarantined` | Security or quality flag. Isolated pending review. |
| `active` | Production-ready. Auto-triggered by keyword match. |
| `deprecated` | Superseded. Shows migration notice on trigger. |

### SKILL.md — Standard Sections

Every Level 3 SKILL.md must include these sections:

1. **What this skill does** — one paragraph
2. **When to use** — specific scenarios
3. **When not to use** — hard exclusions
4. **Reference Routing** — table: user intent → which file to read
5. **Workflow** — step-by-step process
6. **Quality Gates** — Fatal / Warning / Suggestion checklist
7. **Output Contract** — mandatory output format with Evidence block
8. **Failure Modes** — known edge cases and how to handle

### checks.json — Standard Format

```json
{
  "fatal": [
    {
      "id": "unique-check-id",
      "pattern": "regex or null",
      "checkType": "pattern | structural | manual",
      "message": "Human-readable error",
      "autoFix": "fix instruction or false"
    }
  ],
  "warning": [],
  "suggestion": []
}
```

### evidence.schema.json — Minimum Required Fields

Every harness-grade skill output must include:

```json
{
  "usedReferences": ["array of consulted files"],
  "generatedFiles": ["array of created/modified files"],
  "qualityGate": { "fatal": 0, "warning": 0, "suggestion": 0 },
  "accessibility": { "reducedMotion": true, "focusVisible": true },
  "performance": { "transformOpacityOnly": true },
  "verdict": "PASS | FAIL"
}
```

### provenance.json — Standard Fields

```json
{
  "name": "skill-name",
  "version": "1.0.0",
  "created": "YYYY-MM-DD",
  "updated": "YYYY-MM-DD",
  "author": "author identifier",
  "source": { "origin": "where knowledge came from", "references": ["urls"] },
  "changelog": [{ "version": "1.0.0", "date": "...", "changes": "..." }],
  "security": { "riskLevel": "low|medium|high", "allowedTools": [], "requiresReview": false }
}
```

---

## Security Requirements

Every skill tier has baseline security:

| Requirement | Lite | Workflow | Harness |
|-------------|------|----------|---------|
| `doNotUseWhen` | ✅ | ✅ | ✅ |
| `allowedTools` whitelist | — | ✅ | ✅ |
| `riskLevel` declared | — | ✅ | ✅ |
| `provenance.json` (source trace) | — | — | ✅ |
| `checks.json` (machine-auditable) | — | — | ✅ |
| Peer review required before active | — | — | ✅ |
| Quarantine support | — | — | ✅ |

---

## Promotion Pipeline

```
candidate ──► manual review ──► quarantine ──► fix ──► re-review
                 │                                      │
                 ▼                                      ▼
              active ◄──────────────────────────────────┘
                 │
                 ▼
            deprecated ──► migration notice (auto-injected on trigger)
```

---

## Reference Implementation

`motion-pro-max/` v2.0.0 is the complete Level 3 reference:

```
~/.claude/skills/motion-pro-max/
  SKILL.md                 (17.9KB — router + dispatch + fatal rules + output contract)
  manifest.json            (machine routing + useWhen/doNotUseWhen/peerSkills)
  provenance.json          (origin trace + changelog + security declaration)
  checks.json              (13 Fatal / 8 Warning / 7 Suggestion — machine-executable)
  rubric.md                (5-dimension scoring 0-100, delivery rules)
  evidence.schema.json     (JSON Schema — required fields for EvidenceLedger)
  references/              (7 files — scene-recipes, motion-system, principles, etc.)
  examples/                (hero-nextjs.bad.tsx → hero-nextjs.fixed.tsx)
```

---

## Quick Start: Create a New Harness-grade Skill

```bash
cp -r docs/skill-templates/harness-grade/ ~/.claude/skills/my-new-skill/
# Edit SKILL.md — fill in all 8 standard sections
# Edit manifest.json — fill triggers, useWhen, doNotUseWhen, allowedTools
# Edit provenance.json — set created date, author, source
# Edit checks.json — add domain-specific quality gates
# Edit rubric.md — define scoring dimensions
# Edit evidence.schema.json — add domain-specific evidence fields
# Add examples/bad + examples/fixed
# Add references/ as needed
# Submit for peer review → quarantine → active
```
