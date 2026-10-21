import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  breakdownRows,
  cacheCountdown,
  formatCacheLifetime,
  threadAccount,
} from "./composerContext.logic";

const MINUTE = 60_000;

describe("cacheCountdown", () => {
  const expiresAtMs = Date.parse("2026-10-21T12:00:00.000Z");
  const at = (msLeft: number) =>
    cacheCountdown({ expiresAtMs, nowMs: expiresAtMs - msLeft, isWorking: false });

  it("shows whole minutes left, rounded down", () => {
    expect(at(42 * MINUTE + 30_000)).toEqual({ label: "42m", warning: false });
    expect(at(60 * MINUTE)).toEqual({ label: "60m", warning: false });
  });

  it("turns amber below ten minutes and shows <1m in the last minute", () => {
    expect(at(10 * MINUTE)).toMatchObject({ label: "10m", warning: false });
    expect(at(10 * MINUTE - 1)).toMatchObject({ label: "9m", warning: true });
    expect(at(59_999)).toEqual({ label: "<1m", warning: true });
  });

  it("hides after expiry, while a turn runs, and when the lifetime is unknown", () => {
    expect(at(0)).toBeNull();
    expect(at(-1)).toBeNull();
    expect(
      cacheCountdown({ expiresAtMs, nowMs: expiresAtMs - MINUTE, isWorking: true }),
    ).toBeNull();
    expect(cacheCountdown({ expiresAtMs: null, nowMs: 0, isWorking: false })).toBeNull();
  });
});

describe("formatCacheLifetime", () => {
  it("names the two lifetimes Claude writes", () => {
    expect(formatCacheLifetime(60 * MINUTE)).toBe("1h");
    expect(formatCacheLifetime(5 * MINUTE)).toBe("5m");
  });
});

describe("breakdownRows", () => {
  it("measures each row against the window, deferred rows included", () => {
    const rows = breakdownRows({
      model: "claude-opus-4-7",
      totalTokens: 300_000,
      maxTokens: 1_000_000,
      categories: [
        { name: "Free space", tokens: 650_000, kind: "free" },
        { name: "Messages", tokens: 250_000, kind: "used" },
        { name: "System tools (deferred)", tokens: 32_000, kind: "deferred" },
      ],
      checkedAt: "2026-10-21T00:00:00.000Z",
    });
    expect(rows.map(({ name, percent }) => [name, percent])).toEqual([
      ["Free space", 65],
      ["Messages", 25],
      ["System tools (deferred)", 3.2],
    ]);
  });
});

function window(id: string, usedPercent: number): ServerProviderUsageWindow {
  return {
    id,
    kind: id === "five_hour" ? "session" : "weekly",
    label: id === "five_hour" ? "5-hour" : "7-day",
    usedPercent,
    resetsAt: "2026-10-21T15:00:00.000Z",
  };
}

function claude(input: {
  instanceId: string;
  email: string;
  auth?: Partial<ServerProvider["auth"]>;
  usedPercent?: number;
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: ProviderDriverKind.make("claudeAgent"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: {
      status: "authenticated",
      type: "max",
      label: "Claude Max",
      email: input.email,
      ...input.auth,
    },
    checkedAt: "2026-10-21T12:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...(input.usedPercent === undefined
      ? {}
      : {
          usageLimits: {
            checkedAt: "2026-10-21T12:00:00.000Z",
            windows: [window("five_hour", input.usedPercent), window("seven_day", 10)],
          },
        }),
  };
}

describe("threadAccount", () => {
  const now = Date.parse("2026-10-21T12:00:00.000Z");
  const read = (instanceId: string, providers: ServerProvider[]) =>
    threadAccount({
      providerInstanceId: ProviderInstanceId.make(instanceId),
      providers,
      sources: [],
      driverLabel: "Claude",
      now,
    });

  it("reads Limits for the thread's account only", () => {
    const providers = [
      claude({ instanceId: "claude_work", email: "work@example.com", usedPercent: 80 }),
      claude({ instanceId: "claude_home", email: "home@example.com", usedPercent: 20 }),
    ];

    const account = read("claude_home", providers);

    expect(account?.details).toEqual({
      provider: "Claude",
      plan: "Claude Max",
      loginMethod: "Claude account",
      email: "home@example.com",
    });
    expect(account?.limits?.limits.windows.map((entry) => [entry.id, entry.usedPercent])).toEqual([
      ["five_hour", 20],
      ["seven_day", 10],
    ]);
  });

  it("uses the sibling instance that Limits kept for the same login", () => {
    const providers = [
      claude({ instanceId: "claude_a", email: "me@example.com", usedPercent: 40 }),
      claude({ instanceId: "claude_b", email: "Me@Example.com" }),
    ];

    expect(read("claude_b", providers)?.limits?.limits.windows[0]?.usedPercent).toBe(40);
  });

  it("names an API key login as the login method, not a plan", () => {
    const account = read("claude_key", [
      claude({
        instanceId: "claude_key",
        email: "key@example.com",
        auth: { type: "apiKey", label: "Claude API Key" },
      }),
    ]);

    expect(account?.details).toMatchObject({ plan: undefined, loginMethod: "API key" });
    expect(account?.limits).toBeNull();
  });
});
