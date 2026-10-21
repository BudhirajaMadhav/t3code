# Plan: cache-expiry chip (B) and composer context popover (D)

Spec: `docs/superpowers/specs/2026-10-21-custom-sections-cache-resources-design.md`, parts B and D.
Branch: `custom/composer-context`.

## What exists

- **Cache lifetime is already known, not assumed.** The Claude adapter reads the SDK's
  `cache_creation.ephemeral_1h_input_tokens` / `ephemeral_5m_input_tokens` on every root model
  request and stamps the provider turn's token usage with `promptCacheTtlMs` and
  `promptCacheExpiresAt` (request start + lifetime). Server idle compaction uses
  `promptCacheExpiresAt`. Recorded Claude transcripts on a subscription write 1h only.
- **The web Compact chip uses a weaker rule:** `updatedAt + promptCacheTtlMs`, else a 70-minute
  guess. It ignores `promptCacheExpiresAt`.
- **Usage → Limits** data reaches the composer already: `collectProviderUsageLimits` builds the
  report the `/usage-limits` banner renders with `LimitWindows`. Account details come from the
  provider snapshot's `auth` (`label` = plan or login kind, `email`, `type`).
- **Breakdown:** the SDK's `Query.getContextUsage({ detail: "summary" })` answers with the same
  categories as `/context` (name, tokens, kind `used | free | buffer | deferred`). A probe against
  the installed CLI showed that the non-deferred rows sum to `maxTokens`. `summary` makes no
  token-count API calls. It needs the live query; T3 unloads an idle session after 30 minutes.

## Decisions (builder's calls)

1. **One expiry rule.** A web helper derives the expiry: `promptCacheExpiresAt`, else
   `updatedAt + promptCacheTtlMs`, else unknown. The Compact chip uses it and keeps its 70-minute
   guess only for unknown. The countdown shows nothing when the expiry is unknown, so it never
   shows a guessed lifetime.
2. **One control.** A new composer control replaces the legacy meter's slot: the context ring plus
   "Cache 42m" while the countdown applies. Click opens the popover. This puts the countdown
   beside the send button, where the Compact chip appears after expiry, rather than beside the
   model picker. The spec asks for one shared control, and that is the slot D names.
3. **Countdown rules:** Claude selection only; hidden while a turn runs; whole minutes rounded down,
   "<1m" in the last minute; amber below 10 minutes (warning theme token); hidden at expiry. The
   label is its own small component on the app's shared one-second clock, so the composer does not
   re-render.
4. **Setting:** new client setting "Context popover" (Settings → General, on by default). On: the
   new control takes the slot. Off: the legacy toggle works exactly as upstream.
5. **Breakdown transport:** a new request/response RPC `provider.readContextBreakdown`
   (`{ threadId }` → breakdown or `null`), read scope. It asks the live Claude session through an
   optional adapter method. `null` means no live session (idle-unloaded, other provider, or a
   native subagent thread); the popover then says the breakdown returns with the next message.
   The popover fetches on each open. No persistence and no events.
6. **Breakdown mapping:** rows with tokens > 0, labelled with Claude Code's own names, sorted by
   tokens, percentage = tokens / `maxTokens`. Deferred rows stay, marked as outside the window.
   Unknown kinds are dropped, not estimated.
7. **Popover sections:** Context (used / total, bar), Breakdown (Claude only), Cache (Claude only:
   time left and lifetime, or Expired / Warm), usage limits for the thread's provider instance
   (`collectProviderUsageLimits` + `LimitWindows`), Account (provider, plan, login method, email
   redacted like Limits), and the existing Compact context action.

## Mobile compatibility

No change to orchestration events, snapshots, or server config. The only wire addition is a new
RPC tag that an upstream client never sends. The new setting is client-local (web storage and the
desktop settings file); the server and mobile app never read client settings.

## Steps

1. Web: shared expiry helper and countdown derivation in `ContextWindowMeter.logic.ts`; switch the
   Compact chip to it. Tests.
2. Contracts: breakdown schema, RPC, WS method; server authorization and instrumentation entries.
3. Server: optional `readContextBreakdown` on the adapter session runtime; Claude implementation
   through `getContextUsage`; pure mapping in its own file with tests; `ws.ts` handler.
4. Web: setting; `ComposerContextControl` + popover; wire from ChatView through ChatComposer.
   Limits/account derivation in a logic file with tests.
5. Focused tests, typecheck of contracts/server/web, scoped lint, screenshots if a dev server can
   run against seeded data.
