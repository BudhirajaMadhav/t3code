import type { SDKControlGetContextUsageResponse } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "@effect/vitest";

import { claudeContextBreakdown } from "./claudeContextBreakdown.ts";

type Row = SDKControlGetContextUsageResponse["categories"][number];

// Rows as Claude Code 2.1.305 answered `get_context_usage` with `detail: "summary"`.
const response = (categories: ReadonlyArray<Omit<Row, "color">>) =>
  ({
    categories: categories.map((category) => ({ ...category, color: "inactive" })),
    totalTokens: 23_969,
    maxTokens: 200_000,
    rawMaxTokens: 200_000,
    percentage: 12,
    gridRows: [],
    model: "claude-sonnet-4-6",
    memoryFiles: [],
    mcpTools: [],
    agents: [],
  }) as unknown as SDKControlGetContextUsageResponse;

describe("claudeContextBreakdown", () => {
  it("keeps Claude Code's rows, largest first, measured against the window", () => {
    const breakdown = claudeContextBreakdown(
      response([
        { name: "System prompt", tokens: 106, kind: "used" },
        { name: "System tools", tokens: 22_285, kind: "used" },
        { name: "System tools (deferred)", tokens: 32_280, kind: "deferred", isDeferred: true },
        { name: "Messages", tokens: 0, kind: "used" },
        { name: "Skills", tokens: 1_578, kind: "used" },
        { name: "Autocompact buffer", tokens: 33_000, kind: "buffer" },
        { name: "Free space", tokens: 143_031, kind: "free" },
      ]),
      "2026-10-21T00:00:00.000Z",
    );

    expect(breakdown).toEqual({
      model: "claude-sonnet-4-6",
      totalTokens: 23_969,
      maxTokens: 200_000,
      categories: [
        { name: "Free space", tokens: 143_031, kind: "free" },
        { name: "Autocompact buffer", tokens: 33_000, kind: "buffer" },
        { name: "System tools (deferred)", tokens: 32_280, kind: "deferred" },
        { name: "System tools", tokens: 22_285, kind: "used" },
        { name: "Skills", tokens: 1_578, kind: "used" },
        { name: "System prompt", tokens: 106, kind: "used" },
      ],
      checkedAt: "2026-10-21T00:00:00.000Z",
    });
  });

  it("leaves out a row of an unknown kind without shrinking the window", () => {
    const breakdown = claudeContextBreakdown(
      response([
        { name: "Messages", tokens: 60_000, kind: "used" },
        { name: "Hologram", tokens: 40_000, kind: "projected" as Row["kind"] },
        { name: "Free space", tokens: 100_000, kind: "free" },
      ]),
      "2026-10-21T00:00:00.000Z",
    );

    expect(breakdown.maxTokens).toBe(200_000);
    expect(breakdown.categories.map((category) => category.name)).toEqual([
      "Free space",
      "Messages",
    ]);
  });
});
