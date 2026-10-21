import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * The provider's own breakdown of its context window, as Claude Code's
 * `/context` reports it. `deferred` rows sit outside the window; the other
 * kinds add up to `maxTokens`.
 */
export const ProviderContextBreakdown = Schema.Struct({
  model: Schema.String,
  totalTokens: NonNegativeInt,
  maxTokens: NonNegativeInt,
  categories: Schema.Array(
    Schema.Struct({
      name: TrimmedNonEmptyString,
      tokens: NonNegativeInt,
      kind: Schema.Literals(["used", "free", "buffer", "deferred"]),
    }),
  ),
  checkedAt: IsoDateTime,
});
export type ProviderContextBreakdown = typeof ProviderContextBreakdown.Type;

export const ProviderReadContextBreakdownInput = Schema.Struct({
  threadId: ThreadId,
});
export type ProviderReadContextBreakdownInput = typeof ProviderReadContextBreakdownInput.Type;

/** Null when the thread has no live session that can report a breakdown. */
export const ProviderReadContextBreakdownResult = Schema.NullOr(ProviderContextBreakdown);
export type ProviderReadContextBreakdownResult = typeof ProviderReadContextBreakdownResult.Type;

export class ProviderReadContextBreakdownError extends Schema.TaggedError<ProviderReadContextBreakdownError>()(
  "ProviderReadContextBreakdownError",
  {
    threadId: ThreadId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to read the context breakdown for thread ${this.threadId}.`;
  }
}
