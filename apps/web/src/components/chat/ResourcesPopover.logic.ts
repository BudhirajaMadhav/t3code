import type { ResourceTelemetryProcess, ThreadId } from "@t3tools/contracts";

export interface ResourceGroup {
  /** `null` is the app itself: server, desktop shell, monitor, and helpers no thread owns. */
  readonly threadId: ThreadId | null;
  /** In the snapshot's tree order, so parents come before their children. */
  readonly processes: ReadonlyArray<ResourceTelemetryProcess>;
  readonly baseDepth: number;
  readonly residentBytes: number;
  readonly cpuPercent: number;
}

function toGroup(
  threadId: ThreadId | null,
  processes: ReadonlyArray<ResourceTelemetryProcess>,
): ResourceGroup {
  return {
    threadId,
    processes,
    baseDepth: processes.length === 0 ? 0 : Math.min(...processes.map((entry) => entry.depth)),
    residentBytes: processes.reduce((total, entry) => total + entry.residentBytes, 0),
    cpuPercent: processes.reduce((total, entry) => total + entry.cpuPercent, 0),
  };
}

/** The app group, then one group per thread with live processes, largest memory first. */
export function groupResourceProcesses(processes: ReadonlyArray<ResourceTelemetryProcess>): {
  readonly app: ResourceGroup;
  readonly threads: ReadonlyArray<ResourceGroup>;
} {
  const appProcesses: ResourceTelemetryProcess[] = [];
  const byThread = new Map<ThreadId, ResourceTelemetryProcess[]>();
  for (const entry of processes) {
    if (entry.threadId === undefined) {
      appProcesses.push(entry);
      continue;
    }
    const list = byThread.get(entry.threadId) ?? [];
    list.push(entry);
    byThread.set(entry.threadId, list);
  }
  return {
    app: toGroup(null, appProcesses),
    threads: [...byThread]
      .map(([threadId, list]) => toGroup(threadId, list))
      .toSorted(
        (left, right) =>
          right.residentBytes - left.residentBytes ||
          (left.threadId ?? "").localeCompare(right.threadId ?? ""),
      ),
  };
}
