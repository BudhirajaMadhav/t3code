import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  AuthEnvironmentMaintainScope,
  type EnvironmentId,
  type ResourceTelemetryProcess,
  type ResourceTelemetrySnapshot,
  type ThreadId,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { ChevronRightIcon, MemoryStickIcon } from "lucide-react";
import { useState, useSyncExternalStore } from "react";

import { formatBytes } from "~/lib/formatBytes";
import { useResourceTelemetry } from "~/lib/resourceTelemetryState";
import { cn } from "~/lib/utils";
import { useQuietThreadShell } from "../../state/entities";
import { useEnvironmentScope } from "../../state/session";
import { ProcessSignalActions } from "../settings/ProcessSignalActions";
import {
  canSignalProcess,
  formatProcessName,
  useProcessSignal,
} from "../settings/useProcessSignal";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { groupResourceProcesses, type ResourceGroup } from "./ResourcesPopover.logic";

const MAX_THREAD_GROUPS = 8;
const ROW_GRID = "grid grid-cols-[minmax(0,1fr)_3rem_4.5rem_4.75rem] items-center gap-2 px-3";

const subscribeVisibility = (onChange: () => void) => {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
};

const formatCpu = (percent: number) => `${percent.toFixed(percent >= 10 ? 0 : 1)}%`;

/**
 * Each subscriber makes the sidecar walk the process table, so the chip listens only while the
 * page is visible, for totals every 5 s, and for every sample only while the popover is open.
 */
export function ResourcesChip({ environmentId }: { environmentId: EnvironmentId }) {
  const [open, setOpen] = useState(false);
  const visible = useSyncExternalStore(
    subscribeVisibility,
    () => document.visibilityState === "visible",
  );
  const summary = useResourceTelemetry(visible ? environmentId : null, "summary").data;
  const live = useResourceTelemetry(visible && open ? environmentId : null).data;
  const snapshot = live ?? summary;
  if (snapshot === null || snapshot.processes.length === 0) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            size="compact"
            variant="ghost-muted"
            className="max-sm:hidden"
            aria-label="Resources"
          >
            <MemoryStickIcon />
            <span className="font-mono tabular-nums">
              {formatBytes(snapshot.groups.allT3.currentRssBytes)}
            </span>
          </Button>
        }
      />
      <PopoverPopup align="end" width="lg" padding="none" className="w-[28rem]">
        <ResourcesPanel environmentId={environmentId} snapshot={snapshot} />
      </PopoverPopup>
    </Popover>
  );
}

function ResourcesPanel({
  environmentId,
  snapshot,
}: {
  environmentId: EnvironmentId;
  snapshot: ResourceTelemetrySnapshot;
}) {
  const { app, threads } = groupResourceProcesses(snapshot.processes);
  const shownThreads = threads.slice(0, MAX_THREAD_GROUPS);
  const hiddenThreadCount = threads.length - shownThreads.length;
  const total = snapshot.groups.allT3;
  // Group keys whose expansion differs from the default: the app starts folded, threads open.
  const [toggled, setToggled] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (key: string) =>
    setToggled((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const canMaintainEnvironment = useEnvironmentScope(environmentId, AuthEnvironmentMaintainScope);
  const { signalingKeys, signalProcess } = useProcessSignal(environmentId);
  const groupProps = {
    environmentId,
    canMaintainEnvironment,
    signalingKeys,
    onSignal: signalProcess,
  };

  return (
    <div className="flex flex-col text-xs">
      <div className={cn(ROW_GRID, "pt-3 pb-2 font-medium")}>
        <span className="text-muted-foreground">Resources</span>
        <span className="text-right font-mono tabular-nums">
          {formatCpu(total.currentCpuPercent)}
        </span>
        <span className="text-right font-mono tabular-nums">
          {formatBytes(total.currentRssBytes)}
        </span>
        <span />
      </div>
      <div className="max-h-[min(70vh,32rem)] overflow-y-auto border-t border-border/60 py-1">
        <ResourceGroupSection
          group={app}
          expanded={toggled.has("app")}
          onToggle={() => toggle("app")}
          {...groupProps}
        />
        {shownThreads.map((group) => {
          const key = group.threadId ?? "app";
          return (
            <ResourceGroupSection
              key={key}
              group={group}
              expanded={!toggled.has(key)}
              onToggle={() => toggle(key)}
              {...groupProps}
            />
          );
        })}
        {threads.length === 0 ? (
          <p className="px-3 py-2 text-muted-foreground">No thread has running processes.</p>
        ) : null}
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-border/60 px-3 py-2">
        <span className="text-muted-foreground">
          {hiddenThreadCount > 0
            ? `${hiddenThreadCount} more ${hiddenThreadCount === 1 ? "thread" : "threads"}`
            : null}
        </span>
        <Button
          size="micro"
          variant="link"
          render={<Link to="/settings/diagnostics" search={{ machine: environmentId }} />}
        >
          Show all
        </Button>
      </div>
    </div>
  );
}

function ResourceGroupSection({
  group,
  expanded,
  onToggle,
  environmentId,
  canMaintainEnvironment,
  signalingKeys,
  onSignal,
}: {
  group: ResourceGroup;
  expanded: boolean;
  onToggle: () => void;
  environmentId: EnvironmentId;
  canMaintainEnvironment: boolean;
  signalingKeys: ReadonlySet<string>;
  onSignal: ReturnType<typeof useProcessSignal>["signalProcess"];
}) {
  return (
    <div>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className={cn(
          ROW_GRID,
          "w-full cursor-pointer py-1.5 text-left font-medium hover:bg-accent/50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        )}
      >
        <span className="flex min-w-0 items-center gap-1">
          <ChevronRightIcon
            aria-hidden
            className={cn("size-3.5 shrink-0 text-muted-foreground", expanded && "rotate-90")}
          />
          <span className="truncate">
            {group.threadId === null ? (
              "App"
            ) : (
              <ThreadTitle environmentId={environmentId} threadId={group.threadId} />
            )}
          </span>
        </span>
        <span className="text-right font-mono tabular-nums text-muted-foreground">
          {formatCpu(group.cpuPercent)}
        </span>
        <span className="text-right font-mono tabular-nums">
          {formatBytes(group.residentBytes)}
        </span>
        <span />
      </button>
      {expanded
        ? group.processes.map((process) => (
            <ProcessRow
              key={`${process.identity.pid}:${process.identity.startTimeMs}`}
              process={process}
              indent={process.depth - group.baseDepth}
              disabled={
                !canMaintainEnvironment ||
                signalingKeys.has(`${process.identity.pid}:${process.identity.startTimeMs}`)
              }
              onSignal={onSignal}
            />
          ))
        : null}
    </div>
  );
}

function ThreadTitle({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const shell = useQuietThreadShell(scopeThreadRef(environmentId, threadId));
  return shell?.title ?? "Unknown thread";
}

function ProcessRow({
  process,
  indent,
  disabled,
  onSignal,
}: {
  process: ResourceTelemetryProcess;
  indent: number;
  disabled: boolean;
  onSignal: ReturnType<typeof useProcessSignal>["signalProcess"];
}) {
  return (
    <div className={cn(ROW_GRID, "group/process py-1 hover:bg-accent/30")}>
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              className="truncate text-muted-foreground"
              style={{ paddingLeft: `${1.25 + Math.min(indent, 6) * 0.75}rem` }}
            />
          }
        >
          {formatProcessName(process)}
        </TooltipTrigger>
        <TooltipPopup side="left" variant="code">
          {process.command || process.name}
        </TooltipPopup>
      </Tooltip>
      <span className="text-right font-mono tabular-nums text-muted-foreground">
        {formatCpu(process.cpuPercent)}
      </span>
      <span className="text-right font-mono tabular-nums text-muted-foreground">
        {formatBytes(process.residentBytes)}
      </span>
      <span className="opacity-0 group-hover/process:opacity-100 focus-within:opacity-100">
        {canSignalProcess(process) ? (
          <ProcessSignalActions
            disabled={disabled}
            onSignal={(signal) => void onSignal(process, signal)}
          />
        ) : null}
      </span>
    </div>
  );
}
