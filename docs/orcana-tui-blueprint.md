# Orcana TUI Blueprint

Orcana's TUI should not copy another agent's chat surface. It should be a
runtime console for a constraint-first coding agent: every visible surface
should explain what the runtime is doing, what is blocked, what evidence exists,
and which write can be trusted.

## What To Steal From Mature Ink TUIs

The useful lesson is not the branding or the splash screen. The durable pattern
is the boundary map:

```text
renderer shell
  -> app store
  -> event adapter
  -> layout slots
  -> scrollback viewport
  -> composer
  -> command/keybinding registry
  -> modal/focus owner
```

For Orcana, the equivalent runtime shape is:

```text
agentLoop stream
  -> StreamEventAdapter
  -> TuiStore / reduceTuiEvent
  -> AppShell
  -> HeaderBar / StatusBar / Scrollback / RightRail / PlanPanel / OrcanaComposer
```

This is already partly implemented under `src/tui/`. The next work is to make
the boundaries stricter so the UI can grow without turning `main.tsx` back into
the product.

## Orcana-Native Product Model

The TUI should make Orcana's unique runtime concepts first-class:

- **Sonar**: current mode, model, context pressure, cache behavior, and queue.
- **Ripple**: API-surface obligations and cascade risk, not just tool logs.
- **Gates**: policy/semantic/hook blocks shown as an explainable decision trail.
- **Evidence**: typecheck/test/build/manual proof as completion currency.
- **Patch Flow**: proposed, verified, committed, rolled back transactions.
- **Rewind**: visible recovery points and restore scope before risky work.
- **Mode Contract**: planner/coder/review/repair/report as explicit UI state.

The UI should feel like an operations console for a coding runtime, not a themed
terminal chat.

## Architecture Rules

1. **Keep `src/tui/main.tsx` as orchestration only.**
   Agent startup, stream wiring, lifecycle cleanup, and high-level hooks belong
   there. Command implementations, keybindings, modal state, and formatting
   should live in dedicated modules.

2. **Command metadata and command execution must share one registry.**
   `src/tui/commands/registry.ts` is already the metadata source. The next step
   is a dispatcher module that maps `/status`, `/gates`, `/models`, `/clear`,
   and future `/rewind` actions to handlers. `main.tsx` should call
   `dispatchTuiCommand(context, input)` rather than keep a long if-chain.

3. **Keybindings need contexts.**
   Global, composer, scrollback, clarification, palette, confirm, and rewind
   should be separate contexts. A handled key should not leak into lower-priority
   behavior. This is the terminal equivalent of focus ownership.

4. **Use selector subscriptions where churn becomes visible.**
   `TuiStore` is a good external store. For higher-frequency streams, add
   `useTuiSelector(store, selector, equality?)` so HeaderBar, RightRail, and
   Scrollback do not all rerender for every unrelated event.

5. **Treat the composer as a product surface.**
   `OrcanaComposer` should remain responsible for paste staging, command
   palette behavior, history, queue semantics, and future voice/FIM insertion.
   App-level commands should not be encoded inside the text-editing hook.

6. **Scrollback must be viewport-first.**
   The current line slicing is the right direction. For long runs, move toward a
   measured line cache plus capped render range so thousands of messages do not
   create thousands of Ink/Yoga nodes.

7. **Modal ownership must be explicit.**
   Confirmation, clarification, rewind, model picker, and command palette should
   be modal states with their own keybinding context and footer hints. They
   should not be ad hoc branches inside the global `useInput` handler.

8. **Theme should stay semantic.**
   Components should prefer `theme.*` concepts over raw palette colors. Add
   semantic slots for `eventActivity`, `modePlanner`, `modeCoder`,
   `rippleBlocked`, `evidencePassed`, and `patchCommitted` as the UI expands.

## Target Layout

```text
+--------------------------------------------------------------------+
| Orcana  model/provider  mode  ctx/cache  queue  health             |
+--------------------------------------------------------------------+
| Status rail: round, gates, evidence, active tools, patch state      |
+------------------------------------------+-------------------------+
| Scrollback / transcript viewport         | Runtime rail            |
| - user prompts                           | - mode contract         |
| - assistant stream                       | - ripple obligations    |
| - activity events                        | - gate summary          |
| - tool summaries                         | - evidence ledger       |
|                                          | - patch transactions    |
+------------------------------------------+-------------------------+
| Active panel: plan / clarification / confirm / rewind / palette     |
+--------------------------------------------------------------------+
| OrcanaComposer: multiline input, paste blocks, command palette      |
| Footer hints: context-aware keybindings                             |
+--------------------------------------------------------------------+
```

Compact terminals should hide the right rail and promote the most important
runtime counters into the StatusBar.

## Implementation Slices

1. **Stabilize current TUI.**
   Keep typecheck green. Treat stdin filtering, mouse mode cleanup, and event
   kind exhaustiveness as runtime safety, not polish.

2. **Extract command dispatcher.**
   Move the slash-command if-chain out of `main.tsx`, keep the registry as the
   source of truth, and add unit tests for safe-concurrent behavior plus handler
   output.

3. **Introduce keybinding contexts.**
   Start with scrollback and clarification. Then add command palette and confirm
   modal contexts.

4. **Add selector hook.**
   Keep `TuiStore`, but let components subscribe to precise view data when event
   volume grows.

5. **Virtualize long transcripts.**
   Preserve line-level scroll behavior, but cap mounted rows and cache formatted
   lines by message id, width, status, and pending tick.

6. **Promote Orcana runtime modals.**
   Implement high-risk confirm, rewind list/confirm/progress, model picker, and
   mode/effort picker as modal states instead of plain text commands.

## Definition Of Done

A finished Orcana TUI makes these questions answerable at a glance:

- What is the agent doing right now?
- Which mode contract is active?
- What blocked or warned, and from which layer?
- What evidence exists before the agent claims done?
- What patch transaction changed files, and can it be rolled back?
- Is the user typing a new request, selecting a command, confirming risk, or
  navigating history?

That is the distinctive Orcana surface: a coding-agent control room, not just a
chat transcript with a better logo.
