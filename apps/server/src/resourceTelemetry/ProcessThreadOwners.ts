import type { ResourceTelemetryProcess, ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

// Spawn sites register right after the fork returns. A larger gap means the PID was reused.
const SPAWN_MATCH_TOLERANCE_MS = 5_000;

export interface ProcessOwner {
  readonly threadId: ThreadId;
  readonly spawnedAtMs: number;
}

export interface ProcessThreadOwnersShape {
  readonly register: (pid: number, threadId: ThreadId) => void;
  readonly unregister: (pid: number) => void;
  readonly current: () => ReadonlyMap<number, ProcessOwner>;
}

const EMPTY_OWNERS: ReadonlyMap<number, ProcessOwner> = new Map();

/**
 * Which thread launched each agent and terminal process. Sync, because the Claude SDK spawns
 * through a plain callback. A reference with a no-op default, like `AgentScope`, so adapter and
 * terminal layers need no new requirement; `server.ts` provides the live map.
 */
export const ProcessThreadOwners = Context.Reference<ProcessThreadOwnersShape>(
  "t3/resourceTelemetry/ProcessThreadOwners",
  {
    defaultValue: () => ({
      register: () => {},
      unregister: () => {},
      current: () => EMPTY_OWNERS,
    }),
  },
);

export const layer = Layer.effect(
  ProcessThreadOwners,
  Effect.gen(function* () {
    const clock = yield* Clock.Clock;
    const owners = new Map<number, ProcessOwner>();
    return {
      register: (pid, threadId) => {
        owners.set(pid, { threadId, spawnedAtMs: clock.currentTimeMillisUnsafe() });
      },
      unregister: (pid) => {
        owners.delete(pid);
      },
      current: () => owners,
    } satisfies ProcessThreadOwnersShape;
  }),
);

/** Registers a spawned child for its thread and forgets it when the child exits. */
export function trackChildProcess(
  owners: ProcessThreadOwnersShape,
  threadId: ThreadId,
  child: { readonly pid?: number | undefined; once(event: "exit", listener: () => void): unknown },
): void {
  const pid = child.pid;
  if (pid === undefined) return;
  owners.register(pid, threadId);
  child.once("exit", () => owners.unregister(pid));
}

/** Each process belongs to its nearest registered ancestor, itself included. */
export function attributeProcessThreads(
  processes: ReadonlyArray<ResourceTelemetryProcess>,
  owners: ReadonlyMap<number, ProcessOwner>,
): ReadonlyArray<ResourceTelemetryProcess> {
  if (owners.size === 0) return processes;
  const byPid = new Map(processes.map((process) => [process.identity.pid, process]));
  const resolved = new Map<number, ThreadId | null>();
  const ownerOf = (pid: number, visiting: Set<number>): ThreadId | null => {
    const cached = resolved.get(pid);
    if (cached !== undefined) return cached;
    const process = byPid.get(pid);
    if (process === undefined || visiting.has(pid)) return null;
    visiting.add(pid);
    const owner = owners.get(pid);
    const threadId =
      owner !== undefined &&
      Math.abs(process.identity.startTimeMs - owner.spawnedAtMs) <= SPAWN_MATCH_TOLERANCE_MS
        ? owner.threadId
        : ownerOf(process.ppid, visiting);
    resolved.set(pid, threadId);
    return threadId;
  };
  return processes.map((process) => {
    const threadId = ownerOf(process.identity.pid, new Set());
    return threadId === null ? process : { ...process, threadId };
  });
}
