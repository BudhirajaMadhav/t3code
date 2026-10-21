import type {
  ProviderContextBreakdown,
  ProviderInstanceId,
  ServerProvider,
  UsageLimitSourceSnapshots,
} from "@t3tools/contracts";
import { collectProviderUsageLimits } from "@t3tools/shared/usageLimits";

const MINUTE = 60_000;
const CACHE_WARNING_MS = 10 * MINUTE;

/** Time left on an idle thread's prompt cache, or null while a turn runs, after expiry, or when the lifetime is unknown. */
export function cacheCountdown(input: {
  readonly expiresAtMs: number | null;
  readonly nowMs: number;
  readonly isWorking: boolean;
}): { readonly label: string; readonly warning: boolean } | null {
  if (input.isWorking || input.expiresAtMs === null) return null;
  const remaining = input.expiresAtMs - input.nowMs;
  if (remaining <= 0) return null;
  const minutes = Math.floor(remaining / MINUTE);
  return {
    label: minutes < 1 ? "<1m" : `${minutes}m`,
    warning: remaining < CACHE_WARNING_MS,
  };
}

export function formatCacheLifetime(ttlMs: number): string {
  return ttlMs >= 60 * MINUTE && ttlMs % (60 * MINUTE) === 0
    ? `${ttlMs / (60 * MINUTE)}h`
    : `${Math.round(ttlMs / MINUTE)}m`;
}

export function breakdownRows(breakdown: ProviderContextBreakdown) {
  return breakdown.categories.map((category) => ({
    ...category,
    percent: breakdown.maxTokens > 0 ? (category.tokens / breakdown.maxTokens) * 100 : 0,
  }));
}

// Auth types that name how the provider signs in rather than a plan.
const LOGIN_METHODS: Record<string, string> = {
  apiKey: "API key",
  bedrock: "Amazon Bedrock",
  customEndpoint: "Custom endpoint",
};

function accountDetails(provider: ServerProvider, driverLabel: string) {
  const { auth } = provider;
  const loginMethod = auth.type === undefined ? undefined : LOGIN_METHODS[auth.type];
  const signedIn = auth.status === "authenticated";
  return {
    provider: provider.displayName?.trim() || driverLabel,
    plan: loginMethod === undefined ? auth.label : undefined,
    loginMethod: loginMethod ?? (signedIn ? `${driverLabel} account` : undefined),
    email: auth.email,
  };
}

/**
 * The account the thread runs on and its limits, as Usage → Limits reports
 * them. Limits merges instances that share a login, so a sibling instance's
 * row stands in when it won the merge.
 */
export function threadAccount(input: {
  readonly providerInstanceId: ProviderInstanceId | null;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly sources: UsageLimitSourceSnapshots;
  readonly driverLabel: string;
  readonly now: number;
}) {
  const provider = input.providers.find(
    (candidate) => candidate.instanceId === input.providerInstanceId,
  );
  if (provider === undefined) return null;
  const native = (
    collectProviderUsageLimits(provider.instanceId, input.providers, input.sources, input.now)
      ?.accounts ?? []
  ).filter((account) => account.instanceId !== undefined);
  const email = provider.auth.email?.trim().toLowerCase();
  const limits =
    native.find((account) => account.instanceId === provider.instanceId) ??
    (email === undefined
      ? undefined
      : native.find((account) => account.email?.trim().toLowerCase() === email));
  return {
    details: accountDetails(provider, input.driverLabel),
    limits: limits === undefined ? null : { driver: limits.driver, limits: limits.limits },
  };
}
