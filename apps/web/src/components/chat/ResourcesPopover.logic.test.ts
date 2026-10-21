import { ThreadId, type ResourceTelemetryProcess } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { groupResourceProcesses } from "./ResourcesPopover.logic";

const threadA = ThreadId.make("thread-a");
const threadB = ThreadId.make("thread-b");
const threadC = ThreadId.make("thread-c");

const process = (
  pid: number,
  depth: number,
  residentBytes: number,
  threadId?: ThreadId,
): ResourceTelemetryProcess =>
  ({
    identity: { pid, startTimeMs: 1 },
    depth,
    residentBytes,
    cpuPercent: pid / 10,
    ...(threadId === undefined ? {} : { threadId }),
  }) as ResourceTelemetryProcess;

const pids = (processes: ReadonlyArray<ResourceTelemetryProcess>) =>
  processes.map((entry) => entry.identity.pid);

describe("groupResourceProcesses", () => {
  it("keeps unowned processes in the app group and orders threads by memory", () => {
    const { app, threads } = groupResourceProcesses([
      process(1, 0, 300),
      process(10, 1, 100, threadA),
      process(11, 2, 50, threadA),
      process(20, 1, 400, threadB),
      process(30, 1, 10),
      process(40, 1, 150, threadC),
    ]);

    expect(pids(app.processes)).toEqual([1, 30]);
    expect(app.residentBytes).toBe(310);
    expect(threads.map((group) => [group.threadId, group.residentBytes])).toEqual([
      [threadB, 400],
      [threadA, 150],
      [threadC, 150],
    ]);
  });

  it("keeps tree order inside a thread and indents from its shallowest process", () => {
    const { threads } = groupResourceProcesses([
      process(10, 1, 1, threadA),
      process(11, 2, 1, threadA),
      process(12, 3, 1, threadA),
      process(13, 2, 1, threadA),
    ]);

    expect(pids(threads[0]?.processes ?? [])).toEqual([10, 11, 12, 13]);
    expect(threads[0]?.baseDepth).toBe(1);
    expect(threads[0]?.cpuPercent).toBeCloseTo(4.6);
  });
});
