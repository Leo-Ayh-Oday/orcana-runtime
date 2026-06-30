# Design Rationale — Why the Skill Template Works This Way

Each design decision in this standard has a specific reason. This document records them so future maintainers (human or AI) understand the trade-offs.

---

## 1. Why Three Tiers (Not One or Five)?

**One tier would force unnecessary complexity on simple skills.** A "commit message format" skill doesn't need `checks.json`, `evidence.schema.json`, and a peer review pipeline. That overhead discourages creating useful small skills.

**Five tiers would over-fit.** The jump from "has references" to "has quality gates" to "has evidence + peer protocol" is a natural progression. More granularity would create analysis paralysis — "should this be Level 3 or Level 4?"

The three tiers map to real risk profiles:

| Tier | Risk Profile | Cost of Failure | Engineering Investment |
|------|-------------|----------------|----------------------|
| Lite | Near-zero | Wrong tone, minor confusion | Write a paragraph |
| Workflow | Low | Wrong process steps, wasted time | Write a document + examples |
| Harness | Medium-High | Broken code, security issues, data loss | Full QA infrastructure |

**Decision**: Three tiers. If a skill's risk doesn't clearly fit one, default to the higher tier.

---

## 2. Why `doNotUseWhen` Is Mandatory (Even for Lite)

Academic research on agent skills (arXiv:2602.08004, arXiv:2601.10338) found two recurring problems:

- **Intent redundancy**: Multiple skills with overlapping triggers, causing unpredictable activation.
- **Over-triggering**: Skills activating on tangentially related prompts, polluting context.

A skill author knows best when their skill should NOT fire. Making this explicit prevents downstream debugging of "why did this skill activate for my database migration question?"

**Rule**: `doNotUseWhen` must contain at least one concrete scenario where the skill should stay silent.

---

## 3. Why `allowedTools` Is a Whitelist (Not "read everything by default")

A skill that generates GSAP code has no reason to access `write_file` or `shell`. If the skill prompt gets compromised (prompt injection, supply chain attack), a whitelist limits the damage.

Research (arXiv:2602.20156) showed that skill file attacks can induce data exfiltration and destructive operations, with success rates up to 80% on some models. Whitelisting tools is a defense-in-depth measure — the skill can't do what it was never allowed to do.

**Rule**: `allowedTools` must be explicit. `["read_file", "search"]` is correct. Omitting it means "no restrictions" — which is wrong.

---

## 4. Why `manifest.json` Is Separate from `SKILL.md`

`SKILL.md` is for humans and models to read — natural language, context-heavy, threaded with explanations.

`manifest.json` is for machines to parse — structured, deterministic, no ambiguity.

Separating them means:
- **Harness routing**: The runtime reads `manifest.json` to decide whether to activate a skill, without loading the full `SKILL.md` into context.
- **Skill registry**: A registry of 50+ skills can be queried by machine without parsing 50 markdown files.
- **Tool allowlisting**: Before loading `SKILL.md` content, the harness checks `manifest.allowedTools` and enforces restrictions.

**Rule**: `manifest.json` is the machine contract. `SKILL.md` is the human/machine narrative. Both are required for Level 2+.

---

## 5. Why `evidence.schema.json` (Not "let the model self-report")

Models are known to claim verification they didn't perform. "I ran the tests and they all pass" when no test was executed is a well-documented failure mode.

`evidence.schema.json` defines required fields that the harness can validate:
- Was `qualityGate.fatal` actually 0?
- Did `accessibility.reducedMotion` get set?
- Were `generatedFiles` listed?

The model must fill in these fields, which forces explicit accounting. The `EvidenceLedger` can then cross-check: "Model claims typecheck passed, but `evidence.qualityGate` shows fatal=2."

**Rule**: Every Level 3 skill must output structured evidence. The harness verifies, not the model.

---

## 6. Why `provenance.json` (Supply Chain)

As skills get shared between users and projects, knowing where a skill came from becomes critical.

`provenance.json` records:
- Who created it
- What sources the knowledge came from (URLs, documents, design systems)
- Version history with dated changelog entries
- Security posture (riskLevel, allowedTools, requiresReview)

This enables:
- **Audit**: if a skill produces bad output, trace back to which version introduced the problem.
- **Deprecation**: if a source document is updated, find all skills that reference it.
- **Quarantine**: if a security vulnerability is found, immediately identify and isolate affected skills.

---

## 7. Why Peer Skill Protocol (Not "just link to the other skill")

Two skills that need each other can easily create infinite recursion:

```
ui-ux activates → sees "motion needed" → activates motion-pro-max
  → motion-pro-max sees "design spec needed" → activates ui-ux
    → ui-ux sees "motion needed" → ...
```

The Peer Skill Protocol prevents this with three explicit rules:

1. **Handoff Rule**: downstream skill only reads the upstream's *Handoff Packet* (structured JSON), never the full `SKILL.md`.
2. **Escalation Rule**: if no handoff exists, request one from the user — don't auto-activate the upstream skill.
3. **No recursion**: a skill must not activate a skill that could activate it back.

The Handoff Packet is the minimum viable interface — ~6 fields of structured design data — not a full knowledge dump.

---

## 8. Why Lifecycle States (Not just "active/inactive")

Skills have a lifecycle:

```
candidate → quarantine → active → deprecated
```

- **candidate**: New skill, under review. Manual trigger only. No auto-activation.
- **quarantined**: Flagged for security or quality issues. Isolated. Only fires when explicitly invoked for testing.
- **active**: Production-ready. Auto-triggered by keyword match.
- **deprecated**: Superseded. Shows migration notice on trigger instead of executing.

This prevents "oops, the new skill broke everything" by requiring a gate before auto-activation. It also prevents stale skills from silently continuing to fire.

---

## 9. Why the Reference Implementation Matters

A specification without a working example is ambiguous. `motion-pro-max/` v2.0.0 serves as:

- **Compliance proof**: the standard isn't theoretical — one skill already implements all of it.
- **Copy-paste template**: a new Level 3 skill author can copy the directory structure and fill in new content.
- **Machine training data**: AI agents can read the reference to learn the expected structure before generating a new skill.

**Rule**: every tier in the standard should have at least one reference implementation in the repo.

---

## 10. Anti-Patterns We Explicitly Avoid

| Anti-Pattern | Why It's Bad | How We Prevent It |
|-------------|-------------|------------------|
| "Just put everything in SKILL.md" | Overwhelms context, no progressive disclosure | Reference routing table, mandatory |
| "It's a safe skill, no need for `doNotUseWhen`" | Skill fires on irrelevant prompts, pollutes context | Mandatory for all tiers |
| "The model can check its own work" | Self-review bias, false completion claims | `checks.json` + `evidence.schema.json` + `motion-review` |
| "Skills don't need versioning" | Can't roll back, can't audit, can't trace | `provenance.json` with changelog |
| "Just let the skills call each other" | Recursive activation, context explosion | Peer Skill Protocol with Handoff Packets |
| "One mega-skill is better than multiple small ones" | Coupling, context bloat, harder to review independently | Three-tier system, peer skills |
