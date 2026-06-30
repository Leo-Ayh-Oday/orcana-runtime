# Orcana Gold Standard Skill Template

**The authoritative specification for creating production-grade Agent Skills.**

This document is intended for three audiences:
- **Humans** — designers and maintainers creating new Skills
- **AI agents** — models reading this to understand how to produce valid Skills
- **Orcana Runtime** — the harness that loads, routes, and audits Skills

---

## Quick Navigation

| You are... | Start here |
|------------|-----------|
| New to Orcana Skills, want to understand the concept | [Design Rationale](#design-rationale) |
| Creating your first Skill | [Standard.md — Tier Decision Table](standard.md) |
| Building a production-grade Skill | [Standard.md — Level 3 Checklist](standard.md) |
| Looking at the reference implementation | [Reference: motion-pro-max](reference/motion-pro-max/) |
| An AI agent reading this repo | [for-ai/ai-readme.md](for-ai/ai-readme.md) |
| Orcana Runtime loading this | [for-ai/ai-manifest.json](for-ai/ai-manifest.json) |
| Self-evolution system designing Skills | [for-ai/ai-readme.md §Self-Evolution](for-ai/ai-readme.md) |

---

## What This Is

A **three-tier system** for designing Agent Skills. Not all Skills need the full treatment — the tier system matches complexity to overhead.

```
Level 1 (Lite)         Level 2 (Workflow)        Level 3 (Harness-grade)
    │                       │                         │
SKILL.md only         + manifest + refs         + checks + rubric
                                              + evidence schema
                                              + provenance + examples
                                              + peer skill protocol
```

**Reference implementation**: `motion-pro-max/` v2.0.0 — a complete Level 3 Skill.

---

## Directory Structure

```
docs/skill-template/
├── README.md                   ← You are here
├── standard.md                 ← Full 3-tier specification
├── design-rationale.md         ← WHY: design decisions, trade-offs, anti-patterns
├── checklist.md                ← Human-readable checklist for creating a new Skill
│
├── reference/
│   └── motion-pro-max/         ← Complete Level 3 reference walkthrough
│       ├── README.md
│       ├── structure.md        ← Why each file exists, what it contributes
│       └── peer-protocol.md    ← How the 3-skill collaboration works
│
└── for-ai/
    ├── ai-readme.md            ← Instructions for AI agents (both human and Orcana)
    └── ai-manifest.json        ← Machine-readable skill template spec
```

---

## Three Tiers at a Glance

### Level 1 — Lite Skill

One file. For simple rules and response styles.

```
my-skill/
  SKILL.md    ← name + description + triggers + doNotUseWhen + content
```

**When to use**: commit message format, reply language, naming conventions, one-line workflows.

### Level 2 — Workflow Skill

For fixed processes with references.

```
my-skill/
  SKILL.md
  manifest.json       ← machine-readable metadata
  references/         ← 1-3 reference files
  examples/           ← bad/good examples
```

**When to use**: PR review, issue triage, README audit, architecture review.

### Level 3 — Harness-grade Skill

For production code generation and quality-critical workflows.

```
my-skill/
  SKILL.md                 ← Main workflow (router + body)
  manifest.json            ← Machine routing + useWhen/doNotUseWhen
  provenance.json          ← Origin trace, changelog, security
  checks.json              ← Machine-executable quality gates
  rubric.md                ← Scoring criteria
  evidence.schema.json     ← Required output evidence format
  references/              ← Progressive disclosure materials
  examples/                ← Bad → Good → Fixed triples
```

**When to use**: code generation, security audit, design systems, any skill where incorrect output causes real damage.

---

## The Four Hard Rules

Every Skill, regardless of tier, must satisfy these:

1. **Routeable** — `manifest.json` tells the harness when to trigger, when NOT to trigger, and what references to load for each user intent.
2. **Reviewable** — output has a fixed schema so the harness can check correctness.
3. **Bounded** — `doNotUseWhen` prevents over-triggering; `allowedTools` limits tool access; `riskLevel` declares blast radius.
4. **Traceable** — `provenance.json` records origin, version history, and security posture.

---

## Design Rationale

Three principles drove this design:

### 1. Progressive Disclosure (not "pour everything into context")

Claude Agent Skills documentation emphasizes filesystem-based skills with on-demand loading. A Skill's `SKILL.md` should be a **router**, not a knowledge dump. References load only when the user's intent matches.

This is why Level 3 Skills have a `referenceRouting` table — the harness knows which file to load without dumping all of them.

### 2. Machine-Auditable Quality (not "trust the model")

AI-generated output needs independent verification. `checks.json` provides regex patterns and structural checks that can run without an LLM. `evidence.schema.json` defines required output fields so `EvidenceLedger` can record what was actually delivered — not what the model *said* it delivered.

### 3. Safety by Default (not "hope the prompt is enough")

`doNotUseWhen` prevents over-triggering. `allowedTools` is a whitelist — no tool access unless explicitly granted. `riskLevel` determines review requirements. `provenance.json` enables supply chain auditing.

Skills with `riskLevel: "high"` or `"critical"` require peer review and quarantine before activation.

---

## Self-Evolution Note

Orcana's Recursive Evolution OS can use this template to **design new Skills autonomously**. The process:

```
Evolution OS identifies a capability gap
  ↓
Reads docs/skill-template/for-ai/ai-readme.md
  ↓
Determines tier based on risk assessment
  ↓
Generates SKILL.md + manifest.json + checks.json etc.
  ↓
Submits to Skill Registry as candidate
  ↓
Passes through quarantine → peer review → active
```

See [for-ai/ai-readme.md §Self-Evolution](for-ai/ai-readme.md) for the full autonomous Skill creation protocol.
