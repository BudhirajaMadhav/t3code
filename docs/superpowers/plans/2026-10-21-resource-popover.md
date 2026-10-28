# Plan: per-thread resource popover (feature C)

Spec: `docs/superpowers/specs/2026-10-21-custom-sections-cache-resources-design.md`, part C.
Branch: `custom/resource-popover`.

## What exists

- The native sidecar samples the server's process tree only while something subscribes to
  `subscribeResourceTelemetry`; the server merges it with Electron metrics into
  `ResourceTelemetrySnapshot` (every process has `pid`, `startTimeMs`, `ppid`, `depth`, CPU, RSS).
- Nothing records which thread owns a process. The `provider-root` / `terminal-root` categories
  exist in the contract but the server never assigns them.
- Every provider and terminal launch already passes through `AgentScope.wrap({ threadId })` just
  before it spawns, but `wrap` returns a command, not a PID. The PID is known only at each spawn site.

## Attribution (server)

1. New `apps/server/src/resourceTelemetry/ProcessThreadOwners.ts`: a `Context.Reference` (no-op
   default, like `AgentScope`) holding `pid -> { threadId, spawnedAtMs }`, plus a pure
   `attributeProcessThreads(processes, owners)`. The live layer is provided next to
   `AgentScopeLive.layer` in `server.ts`, so adapters, the terminal manager and telemetry share one
   map, and no layer signature or testkit changes.
2. Spawn sites register the PID and unregister on exit:
   - Claude: wrap the default `spawnClaudeProcessGroup` (has the `ChildProcess` and `input.threadId`).
   - Codex: after `spawner.spawn` in `layerAppServerClientFactory`; unregister in the session scope.
   - Terminal: after the PTY spawns (`session.threadId`); unregister on PTY exit. Terminals are
     already per thread and start in that thread's worktree, which is the spec's rule.
3. A process belongs to the nearest registered ancestor (itself included), so the agent CLI, its MCP
   servers, tools and node children all land under the thread. A registration matches only when the
   process start time is within 5 s of the spawn time, so a reused PID never inherits a stale owner.
4. `ResourceTelemetry` applies the attribution to every snapshot it builds. The contract gets one
   field: `ResourceTelemetryProcess.threadId: optionalKey(ThreadId)`.

Per provider:

| Provider                                            | Decision                                                                                                                             |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Claude, Codex                                       | Attributed (one CLI / app-server per thread session; subagents share it).                                                            |
| Terminals                                           | Attributed. Terminals opened outside a real thread show as "Unknown thread".                                                         |
| OpenCode                                            | Not attributed: one shared server serves every thread. Shows under App.                                                              |
| ACP (Cursor, Grok, Antigravity, registry), Pi, Muse | Not in this change: the PID sits inside package runtimes that need the reference threaded through hot adapter code. Shows under App. |
| Windows Claude                                      | Not attributed: the SDK spawns the CLI itself there.                                                                                 |

## Mobile compatibility

The official mobile app never subscribes to resource telemetry (it only maps the method name for
background leases). Upstream web/desktop clients decode with Effect Schema, whose default
`onExcessProperty: "ignore"` drops the unknown `threadId` key. A contracts test decodes a fork
snapshot with the upstream process shape to keep this true. No new RPC, event or stored data.

## Client (web/desktop)

- `ResourcesChip` at the right end of `ChatHeader`: memory icon + total RSS of all T3 processes.
  Hidden without the diagnostics-read scope or before the first sample.
- The chip reuses the existing telemetry stream. It subscribes only while the page is visible,
  because a live subscriber makes the sidecar walk the process table (1 s, 5 s on battery, 15 s
  when constrained). This is the same cost the Diagnostics page has while open.
- Popover: header with total memory and CPU; then an "App" group (unattributed processes: server,
  Electron, monitor, helpers; collapsed by default); then one group per thread with live processes,
  largest memory first, expanded, with the process tree indented under it. Up to 8 thread groups;
  more are counted in the footer. Footer "Show all" links to Settings → Diagnostics.
- Stop actions: the existing INT/KILL buttons on signalable rows. The Diagnostics signal handler
  moves into a shared `useProcessSignal` hook used by both views.
- Grouping and sorting live in a pure `ResourcesPopover.logic.ts`.

## Tests

- Server: `attributeProcessThreads` (descendants inherit, nearest owner wins, start-time guard,
  unowned processes untouched).
- Web: grouping and sorting (App group, memory order, tie-break, tree order within a group).
- Contracts: upstream process shape decodes a snapshot that carries `threadId`.

## Not in scope

Mobile UI, category changes in Diagnostics, history attribution, per-thread history.
