# Plan: custom sidebar sections (feature A)

Design: `docs/superpowers/specs/2026-10-21-custom-sections-cache-resources-design.md`, part A.

## Storage and wire (mobile-safe by construction)

- Sections never enter the orchestration event log, the thread shell, the shell stream, or the
  server-config stream. An upstream client decodes those with closed unions (a new shell stream
  `kind` or config event kills its subscription), so the data lives in a separate store.
- Store: `<stateDir>/sidebar-sections.json`, written atomically behind a semaphore. Not a SQL
  migration: the migrator skips every id at or below the highest recorded one, so a fork migration
  id would collide with a future upstream migration and silently skip it.
- Shape: ordered `sections` (`id`, `title`, `createdAt`) and `threads`, a map from thread id to a
  section id or `null`. `null` records "explicitly in no section" so a late lineage write cannot
  put a thread back. A file that does not decode is moved aside (`.corrupt-<time>`), never
  overwritten.
- RPC: two new methods, `sidebarSections.subscribe` (stream of the whole state, re-sent on each
  change) and `sidebarSections.update` (one payload union: create, rename, delete, move, assign).
  Old clients never call them. A new optional capability `sidebarSections` on the environment
  descriptor gates the UI; decoders ignore unknown keys there.

## Lineage

- Rule: a thread created from a sectioned thread lands in that section at creation. An explicit
  assignment (user, agent, or the `sectionId` tool argument) always wins; inheritance only writes
  when the thread has no recorded decision, so the order of the two writes does not matter.
- Fork (web, mobile, MCP) and `delegate_task` children: a reactor on live `thread.created` events
  reads `lineage.parentThreadId`. Provider-native subagent threads are skipped: they have no
  sidebar row and would grow the file without limit.
- `t3_thread_launch` and `create_threads` record no parent on the thread, so their MCP handlers
  apply the caller's section. The fork and `delegate_task` handlers also apply it, so the tool
  result already reflects the section.
- Not covered (no lineage recorded today): "Implement plan in new thread", scheduled-task runs,
  imports, plain new threads.
- A thread deletion removes its entry.

## Agent surface

- New toolkit `t3_section_list`, `t3_section_create`, `t3_section_rename`, `t3_section_delete`,
  `t3_section_assign` (`sectionId: null` takes threads out).
- `t3_thread_launch`, `delegate_task`, `t3_thread_fork`, `create_threads` accept an optional
  `sectionId`, checked before the thread is created.

## Sidebar (web and desktop)

- Sections sit above Pinned. The sortable drag projection assumes its rows are contiguous; a block
  between Pinned and Active would need that projection rewritten.
- Each section is collapsible (per-client). Inside: pinned threads first (pin order, pin icon),
  then active and working in the flat list's order, then folded Snoozed and Settled.
- A sectioned thread shows only in its section. Deleting a section returns its threads to the flat
  list unchanged.
- Section order: creation order; Move up / Move down in the section menu. No drag reordering of
  sections.
- Drag a row onto a section to add it; drag a sectioned row onto the main list to take it out, or
  onto another section to move it. Dragging out of the sidebar still attaches the thread as
  context.
- Thread menu and multi-select menu: "Move to section" (sections, New section..., Remove from
  section). Section header menu: Rename..., Move up, Move down, Delete.
- Sections are per environment. A thread joins only its own environment's sections; a section of
  a non-primary environment shows the environment label.
- Empty sections show unless a project filter is active. Search results stay flat. The legacy
  sidebar ignores sections. No mobile changes. No command-palette entry.

## Verification

- Server: store tests (create, rename, move, delete returns threads, assign, inherit-after-explicit,
  corrupt file kept), reactor tests (fork and delegated child inherit, native subagent skipped,
  deletion prunes), MCP tests (section tools, launch inherits the caller's section, explicit
  `sectionId` wins).
- Mobile compatibility: a test decodes the environment descriptor that carries the new capability
  with the upstream capability schema, and a check that the branch changes no streamed
  orchestration or config schema.
- Web: logic tests for splitting the partition by section and for drop planning.
