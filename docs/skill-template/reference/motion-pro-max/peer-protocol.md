# Peer Skill Protocol — How the 3-Skill Chain Works

motion-pro-max is not a standalone skill. It's the middle link in a 3-skill chain.

---

## The Three Skills

```
ui-ux-pro-max-plus     motion-pro-max         motion-review
(design authority)     (motion authority)     (independent verifier)
       │                      │                      │
       ▼                      ▼                      ▼
  Outputs Design        Reads Handoff,         Scores 0-100,
  Handoff Packet        generates code         blocks on Fatal>0
```

---

## The Handoff Packet — Interface Contract

Instead of motion-pro-max reading ui-ux-pro-max-plus's full SKILL.md (which could trigger recursive activation), the design skill outputs a compact JSON packet:

```json
{
  "designStyle": "Clean Tech",
  "brandTone": "calm, premium, technical",
  "colorSystem": {
    "primary": "oklch(0.45 0.22 265)",
    "surface": "oklch(1 0 0)",
    "textPrimary": "oklch(0.15 0 0)"
  },
  "typography": {
    "heading": "--text-hero (2.5-4rem, 700-800)",
    "body": "--text-md (1rem, 400)"
  },
  "componentRules": {
    "card": "3-level hierarchy",
    "button": "5 states",
    "shadow": "--shadow-md / --shadow-lg / --shadow-xl"
  },
  "motionHints": {
    "allowedIntensity": "medium",
    "avoid": ["bouncy modal", "neon glow", "transition: all"]
  }
}
```

This is the **minimum viable interface** — 6 fields that carry all the design information motion-pro-max needs. It's 1/20th the size of the full ui-ux SKILL.md.

---

## Handoff Rule (motion-pro-max side)

```
WHEN motion-pro-max activates:
  IF Design Handoff Packet exists:
    → Read only: designStyle, colorSystem, typography, componentRules, motionHints
    → Map designStyle to motion language via style→motion table
    → Map motionHints.allowedIntensity to spring choice
    → Map motionHints.avoid to quality gate pre-checks
    → Proceed to scene dispatch
  ELSE:
    → Request compact handoff from user
    → Do NOT auto-activate ui-ux-pro-max-plus
    → Do NOT load ui-ux SKILL.md or references
```

## Escalation Rule (ui-ux side)

```
WHEN ui-ux-pro-max-plus completes:
  IF user also requested motion:
    → Output Design Handoff Packet in completion
    → Main loop routes to motion-pro-max with handoff
    → Do NOT recursively call motion-pro-max from within ui-ux
  ELSE:
    → Deliver UI design as standalone output
```

## Review Rule (motion-review side)

```
WHEN motion-pro-max outputs animation code:
  → motion-review activates
  → Scores against 5 dimensions (0-100)
  → Checks 13 Fatal rules
  → IF Fatal > 0: auto-fix, re-score (max 3 rounds)
  → IF Score < 80: block delivery, return gap report
  → IF Score >= 80: pass, attach review report to evidence
```

---

## Anti-Recursion Guards

Three explicit guards prevent infinite loops:

### Guard 1: Handoff, not Invocation
motion-pro-max reads a JSON packet, not another skill's full SKILL.md. There is no code path where motion-pro-max "calls" ui-ux-pro-max-plus.

### Guard 2: No Auto-Activation on Missing Handoff
If no Design Handoff Packet exists, motion-pro-max asks the user. It does not attempt to produce one itself by activating ui-ux.

### Guard 3: Main Loop Routing
The main agent loop routes between skills. Skills don't route to each other. The pipeline is:
```
Main Loop decides → activates ui-ux → collects output → activates motion-pro-max → collects output → activates motion-review
```
Skills are stateless functions. They don't know about each other's activation state.

---

## What This Enables

1. **Independent testing**: each skill can be tested in isolation with a mock handoff packet.
2. **Skill substitution**: a different design skill could produce the same handoff format, and motion-pro-max would work unchanged.
3. **Parallel development**: the three skills can be improved independently as long as the handoff contract holds.
4. **Safe evolution**: Recursive Evolution OS can replace one link in the chain without breaking the others.
