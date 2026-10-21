import { assert, describe, it } from "@effect/vitest";
import { ThreadId, type ResourceTelemetryProcess } from "@t3tools/contracts";

import { attributeProcessThreads, type ProcessOwner } from "./ProcessThreadOwners.ts";

const SPAWNED_AT = 1_700_000_000_000;
const threadA = ThreadId.make("thread-a");
const threadB = ThreadId.make("thread-b");

const process = (pid: number, ppid: number, startTimeMs = SPAWNED_AT) =>
  ({ identity: { pid, startTimeMs }, ppid }) as ResourceTelemetryProcess;

const owners = (...entries: ReadonlyArray<readonly [number, ThreadId, number?]>) =>
  new Map<number, ProcessOwner>(
    entries.map(([pid, threadId, spawnedAtMs = SPAWNED_AT]) => [pid, { threadId, spawnedAtMs }]),
  );

const threadIds = (processes: ReadonlyArray<ResourceTelemetryProcess>) =>
  processes.map((entry) => [entry.identity.pid, entry.threadId ?? null]);

describe("attributeProcessThreads", () => {
  it("gives an agent's whole subtree to its thread and leaves the rest unowned", () => {
    const attributed = attributeProcessThreads(
      [
        process(10, 1),
        process(20, 10),
        process(21, 20),
        process(22, 21),
        process(30, 10),
        process(40, 10),
      ],
      owners([20, threadA], [30, threadB]),
    );

    assert.deepStrictEqual(threadIds(attributed), [
      [10, null],
      [20, threadA],
      [21, threadA],
      [22, threadA],
      [30, threadB],
      [40, null],
    ]);
  });

  it("uses the nearest registered ancestor", () => {
    const attributed = attributeProcessThreads(
      [process(20, 10), process(21, 20), process(22, 21)],
      owners([20, threadA], [21, threadB]),
    );

    assert.deepStrictEqual(threadIds(attributed), [
      [20, threadA],
      [21, threadB],
      [22, threadB],
    ]);
  });

  it("ignores a registration whose PID now belongs to a later process", () => {
    const attributed = attributeProcessThreads(
      [process(20, 10, SPAWNED_AT + 60_000), process(21, 20, SPAWNED_AT + 60_000)],
      owners([20, threadA]),
    );

    assert.deepStrictEqual(threadIds(attributed), [
      [20, null],
      [21, null],
    ]);
  });

  it("stops on a parent cycle", () => {
    const attributed = attributeProcessThreads(
      [process(20, 21), process(21, 20)],
      owners([99, threadA]),
    );

    assert.deepStrictEqual(threadIds(attributed), [
      [20, null],
      [21, null],
    ]);
  });
});
