import type { SDKControlGetContextUsageResponse } from "@anthropic-ai/claude-agent-sdk";
import type { ProviderContextBreakdown } from "@t3tools/contracts";

const KNOWN_KINDS: ReadonlySet<string> = new Set(["used", "free", "buffer", "deferred"]);
type Category = ProviderContextBreakdown["categories"][number];

/**
 * Claude Code's `/context` rows as reported, largest first. Rows of a kind this
 * build does not know are left out rather than guessed, but still count toward
 * the window, so the shown percentages stay relative to the whole window.
 */
export function claudeContextBreakdown(
  usage: SDKControlGetContextUsageResponse,
  checkedAt: string,
): ProviderContextBreakdown {
  const windowTokens = usage.categories
    .filter((category) => category.kind !== "deferred")
    .reduce((sum, category) => sum + Math.max(0, category.tokens), 0);
  return {
    model: usage.model,
    totalTokens: Math.max(0, Math.round(usage.totalTokens)),
    maxTokens: Math.round(windowTokens > 0 ? windowTokens : Math.max(0, usage.maxTokens)),
    categories: usage.categories
      .filter(
        (category) =>
          category.tokens > 0 && category.name.trim() !== "" && KNOWN_KINDS.has(category.kind),
      )
      .map((category): Category => ({
        name: category.name.trim(),
        tokens: Math.round(category.tokens),
        kind: category.kind,
      }))
      .toSorted((left, right) => right.tokens - left.tokens),
    checkedAt,
  };
}
