import { OrchestratorMcpFailure, type RunId, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ThreadWatch from "../../../orchestration-v2/ThreadWatch.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { unavailable } from "../../threadAccess.ts";
import { ThreadWatchToolkit } from "./tools.ts";

const watcher = Effect.gen(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const { thread } = yield* McpInvocationContext.requireThreadScope(scope, "Watching a thread");
  const watches = yield* ThreadWatch.optional;
  if (Option.isNone(watches)) return yield* unavailable();
  return { watcherThreadId: thread.threadId, watches: watches.value };
});

/**
 * Arms the caller's watch on a thread it just started or messaged. It never fails the handoff,
 * which has already happened; `false` means no wake will come.
 */
export const watchAfterHandoff = Effect.fn("mcp.watchAfterHandoff")(function* (input: {
  readonly targetThreadId: ThreadId;
  readonly runId: RunId | null;
  readonly watch: boolean | undefined;
}) {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const watches = yield* ThreadWatch.optional;
  if (input.watch === false || scope.thread === undefined || Option.isNone(watches)) return false;
  return yield* watches.value
    .watch({
      watcherThreadId: scope.thread.threadId,
      targetThreadId: input.targetThreadId,
      ...(input.runId === null ? {} : { runId: input.runId }),
    })
    .pipe(
      Effect.as(true),
      Effect.catchTags({ ThreadWatchError: () => Effect.succeed(false) }),
      Effect.catchDefect((defect) =>
        Effect.logWarning("arming a thread watch failed", { defect }).pipe(Effect.as(false)),
      ),
    );
});

const invalid = (error: ThreadWatch.ThreadWatchError) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });

export const layer = McpToolAccess.toLayer(ThreadWatchToolkit, {
  t3_thread_watch: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { watcherThreadId, watches } = yield* watcher;
      const { runId } = yield* watches
        .watch({ watcherThreadId, targetThreadId: input.threadId })
        .pipe(Effect.mapError(invalid));
      return { threadId: input.threadId, runId };
    }),
  ),
  t3_thread_unwatch: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { watcherThreadId, watches } = yield* watcher;
      const wasWatching = yield* watches.unwatch({
        watcherThreadId,
        targetThreadId: input.threadId,
      });
      return { threadId: input.threadId, wasWatching };
    }),
  ),
});
