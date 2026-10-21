import type {
  EnvironmentId,
  ProviderContextBreakdown,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProvider,
  ThreadId,
  UsageLimitSourceSnapshots,
} from "@t3tools/contracts";
import { limitsNotice } from "@t3tools/shared/usageLimits";
import { Minimize2Icon } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

import { cn } from "~/lib/utils";
import { type ContextWindowSnapshot, formatContextWindowTokens } from "~/lib/contextWindow";
import { useNowSecond } from "~/hooks/useNowSecond";
import { useStableCallback } from "~/hooks/useStableCallback";
import { readContextBreakdown } from "~/state/contextBreakdown";
import { useAtomCommand } from "~/state/use-atom-command";
import { providerClients } from "../settings/providerDriverMeta";
import { RedactedSensitiveText } from "../settings/RedactedSensitiveText";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { LimitWindows } from "../usage/UsageLimits";
import { composerFloatingLayerProps } from "./composerEventScope";
import {
  breakdownRows,
  cacheCountdown,
  formatCacheLifetime,
  threadAccount,
} from "./composerContext.logic";
import { formatContextWindowCompactionMessage } from "./ContextWindowMeter.logic";

/** What ChatView knows about the open thread that the composer does not. */
export interface ComposerContextData {
  readonly environmentId: EnvironmentId;
  /** Null for a local draft, which has no provider session to ask. */
  readonly threadId: ThreadId | null;
  readonly driver: ProviderDriverKind;
  readonly providerInstanceId: ProviderInstanceId | null;
  readonly usageLimitSources: UsageLimitSourceSnapshots;
  /** Null for a provider that reports no prompt cache. */
  readonly promptCache: {
    readonly expiresAtMs: number | null;
    readonly ttlMs: number | undefined;
  } | null;
  readonly isWorking: boolean;
}

const CLAUDE_DRIVER = "claudeAgent";

function formatPercent(value: number): string {
  if (value > 0 && value < 0.1) return "<0.1%";
  return value < 10 ? `${value.toFixed(1).replace(/\.0$/, "")}%` : `${Math.round(value)}%`;
}

// Its own component so the shared second clock re-renders only the label.
function CacheCountdownBadge(props: { readonly expiresAtMs: number; readonly isWorking: boolean }) {
  const nowMs = useNowSecond();
  const countdown = cacheCountdown({ ...props, nowMs });
  if (countdown === null) return null;
  return (
    <span className={cn("tabular-nums", countdown.warning && "text-warning")}>
      Cache {countdown.label}
    </span>
  );
}

function CacheStatus(props: { readonly expiresAtMs: number | null; readonly isWorking: boolean }) {
  const nowMs = useNowSecond();
  if (props.isWorking) return "Warm while the turn runs";
  if (props.expiresAtMs === null) return "Lifetime not reported";
  const countdown = cacheCountdown({ ...props, expiresAtMs: props.expiresAtMs, nowMs });
  return countdown === null ? "Expired" : `${countdown.label} left`;
}

export function ComposerContextControl(props: {
  readonly data: ComposerContextData;
  readonly usage: ContextWindowSnapshot;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly modelDisplayName: string | null;
  readonly onCompact?: (() => void) | undefined;
  readonly compactDisabled: boolean;
  readonly compactDisabledReason: string | null;
}) {
  const { data, usage } = props;
  const expiresAtMs = data.promptCache?.expiresAtMs ?? null;
  const percent = Math.max(0, Math.min(100, usage.usedPercentage ?? 0));

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button variant="ghost-muted" size="compact">
            <ContextRing percent={percent} />
            <span className="sr-only">
              {usage.maxTokens !== null && usage.usedPercentage !== null
                ? `Context window ${formatPercent(usage.usedPercentage)} used`
                : `Context window ${formatContextWindowTokens(usage.usedTokens)} tokens used`}
            </span>
            {expiresAtMs === null ? null : (
              <CacheCountdownBadge expiresAtMs={expiresAtMs} isWorking={data.isWorking} />
            )}
          </Button>
        }
      />
      <PopoverPopup
        {...composerFloatingLayerProps}
        tooltipStyle
        side="top"
        align="end"
        padding="none"
        width="lg"
        className="text-left whitespace-normal"
      >
        <ContextPopoverBody {...props} />
      </PopoverPopup>
    </Popover>
  );
}

function ContextRing({ percent }: { readonly percent: number }) {
  const radius = 9.75;
  const circumference = 2 * Math.PI * radius;
  const color =
    percent > 90
      ? "var(--color-error)"
      : "color-mix(in oklab, var(--color-muted-foreground) 72%, transparent)";
  return (
    <span className="relative flex size-5 shrink-0 items-center justify-center">
      <svg viewBox="0 0 24 24" className="-rotate-90 absolute inset-0 size-full" aria-hidden="true">
        <circle
          cx="12"
          cy="12"
          r={radius}
          fill="none"
          className="stroke-muted-foreground/24"
          strokeWidth="3"
        />
        <circle
          cx="12"
          cy="12"
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - percent / 100)}
        />
      </svg>
    </span>
  );
}

function Section(props: {
  readonly title: string;
  readonly aside?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-3">
        <div className="font-medium text-muted-foreground text-xs">{props.title}</div>
        {props.aside ? (
          <div className="text-secondary-label text-2xs tabular-nums">{props.aside}</div>
        ) : null}
      </div>
      {props.children}
    </div>
  );
}

function Row(props: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 text-2xs leading-4">
      <span className="text-secondary-label">{props.label}</span>
      <span className="min-w-0 truncate font-medium tabular-nums text-secondary-label">
        {props.children}
      </span>
    </div>
  );
}

function ContextPopoverBody(props: {
  readonly data: ComposerContextData;
  readonly usage: ContextWindowSnapshot;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly modelDisplayName: string | null;
  readonly onCompact?: (() => void) | undefined;
  readonly compactDisabled: boolean;
  readonly compactDisabledReason: string | null;
}) {
  const { data, usage } = props;
  // The popup mounts on open, so this is the moment the popover was opened.
  const [openedAt] = useState(Date.now);
  const driverLabel = providerClients.get(data.driver)?.label ?? String(data.driver);
  const account = threadAccount({
    providerInstanceId: data.providerInstanceId,
    providers: props.providers,
    sources: data.usageLimitSources,
    driverLabel,
    now: openedAt,
  });
  const limitsNoticeText = account?.limits ? limitsNotice(account.limits.limits) : null;
  const percent = Math.max(0, Math.min(100, usage.usedPercentage ?? 0));

  return (
    <div className="flex flex-col gap-3 p-(--floating-content-inset)">
      <Section
        title="Context"
        aside={
          usage.maxTokens !== null
            ? `${formatContextWindowTokens(usage.usedTokens)} / ${formatContextWindowTokens(usage.maxTokens ?? null)}`
            : formatContextWindowTokens(usage.usedTokens)
        }
      >
        {usage.maxTokens !== null ? (
          <div
            className="h-1.5 w-full overflow-hidden rounded-full bg-muted/60"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(percent)}
            aria-label="Context window usage"
          >
            <div
              className="h-full rounded-full bg-muted-foreground/72"
              style={{ width: `${percent}%` }}
            />
          </div>
        ) : null}
        {usage.compactsAutomatically ? (
          <div className="text-pretty text-secondary-label text-2xs">
            {formatContextWindowCompactionMessage(
              props.modelDisplayName,
              usage.autoCompactThreshold,
            )}
          </div>
        ) : null}
      </Section>

      {data.driver === CLAUDE_DRIVER && data.threadId !== null ? (
        <BreakdownSection environmentId={data.environmentId} threadId={data.threadId} />
      ) : null}

      {data.promptCache ? (
        <Section title="Cache">
          <Row label="Prompt cache">
            <CacheStatus expiresAtMs={data.promptCache.expiresAtMs} isWorking={data.isWorking} />
          </Row>
          {data.promptCache.ttlMs !== undefined ? (
            <Row label="Lifetime">{formatCacheLifetime(data.promptCache.ttlMs)}</Row>
          ) : null}
        </Section>
      ) : null}

      {account?.limits ? (
        <Section title={`${driverLabel} usage`}>
          {limitsNoticeText ? (
            <div className="text-secondary-label text-2xs">{limitsNoticeText}</div>
          ) : (
            <LimitWindows
              compact
              driver={account.limits.driver}
              windows={account.limits.limits.windows}
              now={openedAt}
            />
          )}
        </Section>
      ) : null}

      {account ? (
        <Section title="Account">
          <Row label="Provider">{account.details.provider}</Row>
          {account.details.plan ? <Row label="Plan">{account.details.plan}</Row> : null}
          {account.details.loginMethod ? (
            <Row label="Login method">{account.details.loginMethod}</Row>
          ) : null}
          {account.details.email ? (
            <Row label="Email">
              <RedactedSensitiveText
                value={account.details.email}
                ariaLabel="Toggle account email visibility"
                revealTooltip="Click to reveal email"
                hideTooltip="Click to hide email"
              />
            </Row>
          ) : null}
        </Section>
      ) : null}

      {props.onCompact ? (
        <div className="flex flex-col gap-1">
          <Button
            size="xs"
            variant="outline"
            disabled={props.compactDisabled}
            onClick={props.onCompact}
          >
            <Minimize2Icon aria-hidden="true" />
            Compact context
          </Button>
          {props.compactDisabled && props.compactDisabledReason ? (
            <div className="text-pretty text-secondary-label text-2xs">
              {props.compactDisabledReason}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

type BreakdownState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly breakdown: ProviderContextBreakdown | null }
  | { readonly status: "failed" };

function BreakdownSection(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const read = useStableCallback(useAtomCommand(readContextBreakdown, { reportFailure: false }));
  const [state, setState] = useState<BreakdownState>({ status: "loading" });
  const { environmentId, threadId } = props;
  // Asked once per opening: the popup unmounts when it closes.
  useEffect(() => {
    let current = true;
    void read({ environmentId, input: { threadId } }).then((result) => {
      if (!current) return;
      setState(
        result._tag === "Success"
          ? { status: "ready", breakdown: result.value }
          : { status: "failed" },
      );
    });
    return () => {
      current = false;
    };
  }, [read, environmentId, threadId]);

  return (
    <Section title="Breakdown">
      {state.status === "loading" ? (
        <div className="text-secondary-label text-2xs">Reading Claude's context…</div>
      ) : state.status === "failed" ? (
        <div className="text-secondary-label text-2xs">Claude did not report its context.</div>
      ) : state.breakdown === null ? (
        <div className="text-pretty text-secondary-label text-2xs">
          Claude reports this while its session runs. It returns with your next message.
        </div>
      ) : (
        breakdownRows(state.breakdown).map((row) => (
          <Row key={row.name} label={row.name}>
            {formatPercent(row.percent)}
          </Row>
        ))
      )}
    </Section>
  );
}
