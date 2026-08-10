# OpenWolf Protocol

OpenWolf is Orcana's compact context router. It records verified repository
boundaries and durable decisions; detailed design remains under `docs/`.

## Session Order

1. Read the repository `AGENTS.md` supplied by the active workspace.
2. Read `.wolf/anatomy.md` before repository exploration.
3. Read `.wolf/cerebrum.md` before changing code.
4. Load only task-relevant documents from `docs/`.
5. Treat current code, tests, Git state, and runtime evidence as more current
   than historical notes.

## File Roles

- `anatomy.md`: authoritative checkout, branch, and path map.
- `cerebrum.md`: durable constraints, decisions, and do-not-repeat lessons.
- `gate-telemetry.json`: generated gate observations; evidence, not authority.

## Evidence Priority

Current owner request -> current Git/runtime evidence -> accepted contracts and
ADRs -> OpenWolf durable decisions -> historical plans and reports.

Report conflicts explicitly. A passing mock, skipped conditional, or process
self-report is not evidence that a real Linux isolation boundary executed.

## Update Policy

OpenWolf writes require explicit owner approval. Keep entries factual and
compact. Never store credentials, tokens, raw private conversations, or
unverified production claims.
