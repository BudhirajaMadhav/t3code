# Custom sidebar sections, cache-expiry chip, and per-thread resource popover

Status: design, approved in conversation with the fork's owner on 2026-10-21.
Scope: the owner's fork of T3 Code (`BudhirajaMadhav/t3code`, branch `main`). Not proposed upstream.

Four independent features. Build them as three branches, each its own set of
commits on top of the fork's `main`: **(A) custom sections**, **(B + D) cache-expiry chip and the composer context popover**, **(C) resource
popover**. Each must be shippable on its own.

## Why

The owner moved from Conductor to T3 Code. Conductor grouped work by workspace and showed, at a
glance, what each workspace cost in memory. T3's sidebar is a flat inbox, so related threads (for
example the Heavy Mode feature, which spans an inch-backend thread set and an inch-fe thread set)
are scattered among unrelated ones. The owner also runs long Claude sessions and wants to know
when a session's prompt cache is about to expire, because the next message after expiry re-reads the
whole context at full price.

## Constraints (apply to all three)

- **The official T3 Code mobile app must keep working against this server, unchanged.** The owner
  uses the official Android app and will not get these features there for now. Anything new the
  server stores or streams must be invisible to, or safely ignored by, a client built from upstream.
  Check how the mobile and web clients decode orchestration events and snapshots; if an unknown event
  type or field would make an upstream client fail, do not put the new data there (use a separate
  store / RPC instead). Verify this explicitly (see Verification).
- Keep the changes easy to carry across upstream rebases: prefer new files and narrow edits at
  existing extension points over edits spread through hot files.
- Same-machine data: everything lives in the existing T3 state (`~/.t3`); no new services.
- The org's npm firewall blocks `shell-quote` 1.10.0; the fork's `pnpm-workspace.yaml` already
  overrides it. Do not commit `pnpm-lock.yaml` changes (the owner wants the lockfile left out of the
  fork's `main`).
- Desktop and web only. No mobile app changes in this work.

## A. Custom sidebar sections

### What the owner decided

- Named sections in the sidebar, e.g. "Heavy mode".
- A section can hold threads from **different projects** (an inch-backend thread and an inch-fe thread
  for the same feature sit in one section).
- **Both the user and agents** can create sections, and both can put threads into a section. An agent
  that starts a thread for a feature can place it in that feature's section.
- **Sections follow lineage:** a thread created from a thread that is in a section (a fork, a
  delegated child task, a thread launched by an agent from inside a sectioned thread) lands in the
  same section automatically, at creation time.
- **Not** grouping by worktree or branch.
- Imported threads (from Claude Code / Codex session import) have no lineage; the owner's agent will
  assign them to sections after the build, through the agent tools below.

### Behaviour (decided in conversation, owner confirmed)

- A thread belongs to **at most one** section. Threads without a section stay in today's flat list
  (pinned / active / snoozed / settled) exactly as now.
- Inside a section, threads keep their usual states; settled threads fold away like the main list's
  settled shelf.
- In the sidebar the user can create, rename, and delete a section, and drag threads into and out of
  a section.
- Sections are stored on the server, so the desktop app and the web app show the same sections.

### Agent surface

Expose section operations through the T3 MCP server so agents can use them: list sections, create a
section, rename, delete, put a thread into a section, take it out. Thread-creating tools
(`t3_thread_launch`, `delegate_task`, `t3_thread_fork`, `create_threads`) should accept an optional
section, and when none is given, apply the lineage rule above. Follow the existing toolkit patterns
in `apps/server/src/mcp/toolkits/`.

### Builder's calls (not decided by the owner)

- Where sections sit in the sidebar relative to Pinned and the flat list, ordering of sections, and
  ordering of threads inside a section. Suggested default: sections below Pinned and above the flat
  active list, sections in user-chosen order (drag), threads ordered like the flat list.
- What happens to a section's threads when the section is deleted (suggested: they return to the flat
  list; nothing else changes).
- Whether a pinned thread that is also in a section shows in Pinned, in its section, or both
  (suggested: in its section only, with its pin respected inside the section).
- How the legacy sidebar treats sections (suggested: ignore them; the legacy sidebar is going away
  upstream).
- Storage shape and event/RPC design, within the mobile-compatibility constraint.

## B. Cache-expiry chip

### What the owner decided

- The owner only wants to **know**; T3 must not send anything to keep a cache alive.
- Show it **only on the open thread**, nowhere else (no sidebar indicator, no notifications).

### What already exists

T3 already knows when a Claude thread's prompt cache has expired: when the user returns to a large
thread after expiry, a **Compact** chip with the thread's token count appears next to the send button
(`docs/user/providers-claude.md`: "The cache lasts about an hour on a Claude subscription and 5
minutes with an API key, Bedrock, or Vertex"). The composer also has a context meter
(`apps/web/src/components/chat/ContextWindowMeter.tsx`), but upstream marks it legacy and it is off by
default (Settings → General → Legacy features), so the countdown must not live inside it or depend on
it. What is missing is the time left **before** expiry. Build on the existing expiry logic and its lifetime rule; do not add a second, competing one.

### Behaviour

- Claude threads only. Codex/OpenAI does not report cache lifetime; show nothing there.
- The cache clock restarts on **every model request** of the thread, including each step inside a
  turn. While a turn runs, the chip is not needed (or shows "warm").
- After the thread goes idle, a small chip in the composer area, next to the model/effort control,
  shows the time left, e.g. "Cache 42m". It turns amber when less than 10 minutes remain.
- After expiry, the existing **Compact** chip takes over; the countdown chip disappears.
- **Cache lifetime:** use the lifetime T3's existing expiry logic uses (subscription vs API key /
  Bedrock / Vertex). If that logic turns out to assume rather than know, check whether the Claude
  Agent SDK's usage reports the 5-minute / 1-hour split (`cache_creation.ephemeral_5m_input_tokens` /
  `ephemeral_1h_input_tokens`) and, if so, prefer it in both places. Do not hard-code 1 hour.
- Delegated child threads have their own caches and their own chips (visible when that child thread
  is open).

### Builder's calls

- Exact wording, colours (use theme tokens), and the threshold (10 minutes suggested).
- Whether the chip ticks every minute or every second near the end.

## C. Per-thread resource popover

### What the owner decided

A popover like Conductor's "Resources" popover, opened from the top bar.

### What already exists

Settings → Diagnostics has resource telemetry: the process tree with CPU, memory, disk I/O, history
charts (5 m to 1 h), and stop/kill actions (`apps/web/src/components/settings/ResourceTelemetryDiagnostics.tsx`,
contracts in `packages/contracts/src/resourceTelemetry.ts`). It groups by process kind (server,
agent root, terminal root, Electron), not by thread, and process records carry no thread identity.

### Behaviour (owner confirmed)

- A chip in the top bar shows the total memory; clicking it opens the popover.
- The popover shows the app total, then **one group per thread** that has live processes, with that
  thread's process tree underneath (the agent CLI, its MCP servers, tools, node, …).
- A terminal process goes under the thread whose worktree it runs in.
- Sorted by memory, largest first; only threads with live processes appear. "Show all" opens the full
  Diagnostics view.
- The existing stop actions are available from the popover.

### The main work

Link each agent (provider) process and each terminal process to its thread on the server, and expose
that link with the telemetry, then build the popover on the existing telemetry stream.

### Builder's calls

- Exact layout, how many groups before "Show all", and what to show for processes that belong to no
  thread (suggested: under "App").

## D. Context and usage popover in the composer

### What the owner decided

A popover like Conductor's context popover, opened from a control in the composer, added as a fourth
feature. The owner turned on T3's legacy context-window indicator for now; this feature replaces it in
a form the fork owns (upstream marked the indicator legacy in #9190 without a stated reason, so it may
be removed).

### Behaviour (from the Conductor popover the owner showed)

- **Context:** used / total (e.g. "300.5k / 1.0M") with a bar.
- **Breakdown** of the context by category, as Claude Code itself reports it: free space, messages,
  autocompact buffer, system tools (deferred), memory files, skills, system prompt, system tools,
  custom agents, each as a percentage.
- **Claude usage:** the 5-hour and 7-day limits as "% left" with bars and reset times, for the account
  the thread runs on. T3 already reads these for Usage → Limits; reuse that data.
- **Account:** provider, plan, login method, email (T3's Limits page already has the account details).
- **Cache:** the countdown from B also appears here.

### Builder's calls and open technical points

- Find how to get the per-category breakdown from the Claude Agent SDK / CLI (Conductor shows it, so
  the data is obtainable; Claude Code's `/context` produces the same categories). If a category is not
  available, leave it out rather than estimate it.
- Codex and other providers: show what they report (context total, limits), no breakdown.
- The control replaces the legacy indicator's slot in the composer when this feature is on; keep the
  legacy toggle working for upstream parity.
- B and D both live in the composer: build them together (one branch) so they share one control and
  one data source.

## E. Back and forward buttons in the top bar

The owner wants Conductor's ← → buttons. T3 already has the behaviour as shortcuts
(`navigation.back`, `mod+[`; `navigation.forward`, `mod+]`; `docs/user/keybindings.md`). Add two
top-bar buttons that trigger those actions, next to C's resource chip, disabled when there is nothing to
go back or forward to, with the shortcut in the tooltip. Built on C's branch, since both live in the
top bar. No new navigation logic.

## Non-goals

- Mobile app support for any of the three (later, if the owner asks, as a custom Android build).
- Notifications, keep-alive pings, or a sidebar cache indicator.
- Grouping by worktree or branch.
- Rebuilding Conductor's fork history for imported threads (they get sections by hand).
- Upstream PRs.

## Anti-goals (would make this a failure even if it works)

- The official mobile app breaks, or shows errors, against this server.
- A section silently loses threads, or threads silently move between sections.
- Lineage places a new thread in the wrong section.
- The cache chip shows a confident but wrong lifetime (e.g. assumes 1 h when the session wrote 5 m).

## Verification

- Focused tests for each feature's logic (section membership and lineage inheritance; cache-lifetime
  derivation from usage; process-to-thread attribution).
- Mobile compatibility: show, with a test or a recorded check against the upstream client's decoding
  code, that a client built from upstream decodes this server's snapshots and event stream with
  sections present.
- Manual check in the built desktop app for each feature, with screenshots (before/after).
