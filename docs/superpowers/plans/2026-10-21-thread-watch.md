# Thread watch: wake a thread when another thread's run ends

Status: plan, 2026-10-21. Branch `custom/thread-watch`. Fork-only.

## Goal

Thread X watches thread Y. When the watched run of Y ends (completed, failed, interrupted,
cancelled) or Y raises a new approval or question, T3 wakes X once with Y's title and link,
the status, the pending request (if any), and Y's last assistant message (cut at 4,000
characters, with a note).

## What exists

- PR-watch wakes and delegated-task question wakes are a server-created `message.dispatch`
  with a `notification` and `dispatchMode: queue_after_active` (`PullRequestWatchReactor`,
  `DelegatedTaskQuestionReactor`). The orchestrator only accepts notifications in this shape.
  It queues the wake behind an active run, or starts it when the thread is idle, and an
  automatic wake keeps a snoozed thread snoozed.
- Delegated completions add a cohort-based steer that is specific to `delegate_task`. Thread
  watch does not touch it.
- `DelegatedTaskQuestionReactor` follows `engine.streamDomainEvents` (live tail only) and
  catches up from projections.
- `subagentResultForRun` picks a run's last assistant message (or its failure message).

## Design

- **Delivery.** Reuse the notification path above with `source: { kind: "monitor" }`, the
  kind PR-watch uses. No contract change, so an upstream client decodes the wake as it
  decodes a PR-watch wake. Command and message IDs derive from watcher, target and the run
  (or the request), so the orchestrator's command receipt makes a repeated delivery a no-op.
- **Storage.** A small `thread_watches` SQLite table (watcher, target, `after_ordinal`,
  `armed_at`; key watcher+target), created with `CREATE TABLE IF NOT EXISTS` when the service
  starts. Not a numbered migration: a fork migration number would collide with upstream's next
  one and the migrator would then skip upstream's. Not in the event stream: new events or
  projection fields are what upstream clients could fail on. Durable, so a watch survives a
  server restart.
- **Which run.** A watch fires for the first run with `ordinal > after_ordinal` that reaches a
  terminal state. `t3_thread_send` pins the run it created or joined. `t3_thread_watch` pins
  Y's current run, or the next one when Y is idle. `t3_thread_launch` pins the first run.
- **Pending requests.** A pending approval or question (not `dynamic_tool_call`, not
  `auth_refresh`) created after the watch was armed fires it. Requests that were already
  pending at arm time do not, so re-watching a blocked thread cannot loop.
- **One-shot.** Firing deletes the row (only if it was not re-armed meanwhile). A later send or
  watch re-arms it (upsert). Many watchers per target are fine.
- **Reactor.** Follow domain events: terminal `run.updated`, pending `runtime-request.updated`,
  and `thread.deleted` trigger a check of the watches on that thread. A check also runs at
  arm time (races) and once at startup (events missed while the server was down).
- **Lifecycle.** Y deleted: wake X with status "deleted", then end. X archived or deleted at
  fire time: drop the watch silently. Y archived: the watch stays; a run end still fires it.
  A thread cannot watch itself. A subagent cannot watch (its parent owns the follow-up, as with
  PR watch).
- **Auto-arm.** `t3_thread_launch` and `t3_thread_send` arm a watch for the calling thread
  unless `watch: false`, the caller is not a thread, the caller is a subagent, the target is
  the caller, or the send returned a delegated `taskId` (its completion already reaches the
  parent). Results report `watching`.
- **Explicit tools.** `t3_thread_watch` / `t3_thread_unwatch` (threadId), any project, in a new
  `threadWatch` toolkit.
- **Not changed.** `delegate_task`, the orchestrator, and the contracts package.

## Steps

1. `orchestration-v2/ThreadWatch.ts`: service (watch, unwatch, check, handle, start) with the
   table and the wake text. Wire `start` in `server.ts`.
2. `mcp/toolkits/threadWatch/`: the two tools; register in `McpHttpServer`, tool presentation,
   and the toolkit test list.
3. `watch` opt-out and `watching` result on launch and send; tool descriptions; one sentence in
   the orchestration instructions so agents end their turn instead of polling.
4. Tests (`ThreadWatch.test.ts`): arming; one-shot firing on each terminal status and on a
   pending request; re-arm on send; cross-project; deleted target; delegated sends do not arm.
5. Docs: `docs/orchestration-v2/orchestrator-mcp-server.md` tool surface.
6. Run the new and touched tests, server and shared typecheck, scoped lint.
