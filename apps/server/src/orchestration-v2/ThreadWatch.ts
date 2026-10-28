import {
  CommandId,
  MessageId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Notification,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { reportLabel } from "@t3tools/provider-core/server/notification";
import { subagentResultForRun } from "@t3tools/provider-core/server/subagentProjection";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import type * as ProjectionStore from "./ProjectionStore.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";

/** The wake is a prompt; the agent reads anything longer with t3_thread_read. */
export const LAST_MESSAGE_CHARS = 4_000;

const ENDED: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "completed",
  "failed",
  "interrupted",
  "cancelled",
  "rolled_back",
]);

export class ThreadWatchError extends Schema.TaggedError<ThreadWatchError>()("ThreadWatchError", {
  message: Schema.String,
}) {}

export interface Watch {
  readonly watcherThreadId: ThreadId;
  /** The run this watch fires for; null means the first run after `afterOrdinal`. */
  readonly runId: RunId | null;
  readonly afterOrdinal: number;
  readonly armedAt: number;
}

type Target = ProjectionStore.ProjectionRecords<"runs" | "runtimeRequests">;

export type WatchOutcome =
  | { readonly type: "ended"; readonly run: OrchestrationV2Run }
  | { readonly type: "request"; readonly request: OrchestrationV2RuntimeRequest }
  | { readonly type: "deleted" };

/** An approval or a question; the other request kinds never reach a person. */
const asksSomeone = (request: OrchestrationV2RuntimeRequest) =>
  request.status === "pending" &&
  request.kind !== "dynamic_tool_call" &&
  request.kind !== "auth_refresh";

const byOrdinal = (left: OrchestrationV2Run, right: OrchestrationV2Run) =>
  left.ordinal - right.ordinal;

function watchOutcome(target: Target, watch: Watch): WatchOutcome | undefined {
  if (target.thread.deletedAt !== null) return { type: "deleted" };
  const watched =
    watch.runId === null
      ? target.runs.filter((run) => run.ordinal > watch.afterOrdinal).toSorted(byOrdinal)[0]
      : target.runs.find((run) => run.id === watch.runId);
  if (watched !== undefined && ENDED.has(watched.status)) return { type: "ended", run: watched };
  // A request that was already pending when the watch was armed does not count, so watching a
  // blocked thread again cannot wake the watcher in a loop.
  const request = target.runtimeRequests.find(
    (candidate) =>
      asksSomeone(candidate) && DateTime.toEpochMillis(candidate.createdAt) >= watch.armedAt,
  );
  return request === undefined ? undefined : { type: "request", request };
}

export function threadWatchWake(input: {
  readonly thread: { readonly id: ThreadId; readonly title: string };
  readonly outcome: WatchOutcome;
  readonly pendingRequest: boolean;
  readonly lastMessage: string | null;
}): { readonly text: string; readonly notification: OrchestrationV2Notification } {
  const { thread, outcome } = input;
  const link = `[${thread.title.replace(/[[\]]/g, "")}](t3-thread://v1/${thread.id})`;
  const label = `Thread "${reportLabel(thread.title) ?? thread.id}"`;
  const ended =
    outcome.type !== "ended"
      ? undefined
      : outcome.run.status === "completed" || outcome.run.status === "failed"
        ? outcome.run.status
        : `was ${outcome.run.status.replace("_", " ")}`;
  const lines =
    outcome.type === "ended"
      ? [
          `${link}, a thread you watch, ${ended}.`,
          `Status: ${outcome.run.status}. Pending request: ${input.pendingRequest ? "yes" : "none"}.`,
        ]
      : outcome.type === "request"
        ? [
            `${link}, a thread you watch, is waiting for ${outcome.request.kind === "user_input" ? "an answer to a question" : `an approval (${outcome.request.kind})`}. Read it with t3_pending_request_read using threadId ${thread.id} and requestId ${outcome.request.id}. Answer it with t3_pending_request_respond when the answer follows from the task or the user's instructions; otherwise ask the user.`,
            "Status: waiting. Pending request: yes.",
          ]
        : [`${link}, a thread you watch, was deleted.`];
  if (input.lastMessage !== null) {
    const text = input.lastMessage;
    lines.push(
      "",
      "Last assistant message:",
      text.length <= LAST_MESSAGE_CHARS
        ? text
        : `${text.slice(0, LAST_MESSAGE_CHARS)}\n\n[Cut at ${LAST_MESSAGE_CHARS} of ${text.length} characters. Read the rest with t3_thread_read.]`,
    );
  }
  lines.push(
    "",
    outcome.type === "ended"
      ? "This watch has ended. Sending to the thread with t3_thread_send watches its next run."
      : outcome.type === "request"
        ? "This watch has ended. Call t3_thread_watch to be woken when the thread's run ends."
        : "This watch has ended.",
  );
  return {
    text: lines.join("\n"),
    notification: {
      source: { kind: "monitor" },
      outcome:
        outcome.type === "request"
          ? "updated"
          : outcome.type === "deleted"
            ? "cancelled"
            : outcome.run.status === "completed" || outcome.run.status === "failed"
              ? outcome.run.status
              : "cancelled",
      summary:
        outcome.type === "ended"
          ? `${label} ${ended}`
          : outcome.type === "request"
            ? `${label} needs input`
            : `${label} was deleted`,
    },
  };
}

export class ThreadWatch extends Context.Service<
  ThreadWatch,
  {
    /** Arms or re-arms the watcher's watch on the target. */
    readonly watch: (input: {
      readonly watcherThreadId: ThreadId;
      readonly targetThreadId: ThreadId;
      /** The run to watch, such as the one a send created; else the current or next run. */
      readonly runId?: RunId;
    }) => Effect.Effect<{ readonly runId: RunId | null }, ThreadWatchError>;
    readonly unwatch: (input: {
      readonly watcherThreadId: ThreadId;
      readonly targetThreadId: ThreadId;
    }) => Effect.Effect<boolean>;
    readonly check: (targetThreadId: ThreadId) => Effect.Effect<void>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/orchestration-v2/ThreadWatch") {}

/**
 * MCP handlers read the service through this instead of declaring it as a tool dependency, which
 * keeps upstream's toolkit test wiring untouched in this fork. The server always provides it.
 */
export const optional = Effect.serviceOption(ThreadWatch);

interface WatchRow {
  readonly watcherThreadId: string;
  readonly runId: string | null;
  readonly afterOrdinal: number;
  readonly armedAt: number;
}

const logFailure =
  (message: string, fields: Record<string, unknown>) =>
  <E>(cause: Cause.Cause<E>): Effect.Effect<void> =>
    Cause.hasInterruptsOnly(cause)
      ? Effect.interrupt
      : Effect.logWarning(message, { ...fields, cause });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStoreV2;

  // Not a numbered migration: a fork's migration number collides with upstream's next one, and
  // the migrator then skips upstream's.
  yield* Effect.all([
    sql`CREATE TABLE IF NOT EXISTS thread_watches (
      watcher_thread_id TEXT NOT NULL,
      target_thread_id TEXT NOT NULL,
      run_id TEXT,
      after_ordinal INTEGER NOT NULL,
      armed_at INTEGER NOT NULL,
      PRIMARY KEY (watcher_thread_id, target_thread_id)
    )`,
    sql`CREATE INDEX IF NOT EXISTS idx_thread_watches_target ON thread_watches(target_thread_id)`,
  ]).pipe(Effect.catchCause(logFailure("creating the thread watch table failed", {})));

  const lastAssistantText = Effect.fn("ThreadWatch.lastAssistantText")(function* (
    threadId: ThreadId,
    run: OrchestrationV2Run,
  ) {
    const records = yield* projections.getThreadRecords(threadId, ["messages", "turnItems"], {
      messageRoles: ["assistant"],
      messageRunIds: [run.id],
      turnItemRunId: run.id,
      turnItemTypes: ["assistant_message", "error"],
    });
    const result = subagentResultForRun(records, run);
    return result.messageId === null && result.turnItemId === null ? null : result.text;
  });

  const deliver = Effect.fn("ThreadWatch.deliver")(function* (
    target: Target,
    watch: Watch,
    outcome: WatchOutcome,
  ) {
    const watcher = yield* projections.getThreadShell(watch.watcherThreadId);
    // Archiving or deleting the watcher puts its work away; a wake would bring it back.
    if (watcher === null || watcher.archivedAt !== null) return;
    const run =
      outcome.type === "ended"
        ? outcome.run
        : target.runs
            .filter((candidate) => candidate.startedAt !== null)
            .toSorted(byOrdinal)
            .at(-1);
    const wake = threadWatchWake({
      thread: target.thread,
      outcome,
      pendingRequest: target.runtimeRequests.some(asksSomeone),
      lastMessage: run === undefined ? null : yield* lastAssistantText(target.thread.id, run),
    });
    // The same key for the same news makes a repeated delivery replay its command receipt.
    const key = `${watch.watcherThreadId}:${target.thread.id}:${
      outcome.type === "ended"
        ? outcome.run.id
        : outcome.type === "request"
          ? outcome.request.id
          : "deleted"
    }`;
    yield* engine.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`server:thread-watch:${key}`),
      threadId: watch.watcherThreadId,
      messageId: MessageId.make(`message:thread-watch:${key}`),
      text: wake.text,
      notification: wake.notification,
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "agent",
      creationSource: "server",
    });
  });

  const check: ThreadWatch["Service"]["check"] = Effect.fn("ThreadWatch.check")(
    function* (targetThreadId) {
      const rows = yield* sql<WatchRow>`
        SELECT
          watcher_thread_id AS "watcherThreadId",
          run_id AS "runId",
          after_ordinal AS "afterOrdinal",
          armed_at AS "armedAt"
        FROM thread_watches
        WHERE target_thread_id = ${targetThreadId}
      `;
      if (rows.length === 0) return;
      const target = yield* projections.getThreadRecords(targetThreadId, [
        "runs",
        "runtimeRequests",
      ]);
      for (const row of rows) {
        const watch: Watch = {
          watcherThreadId: ThreadId.make(row.watcherThreadId),
          runId: row.runId === null ? null : RunId.make(row.runId),
          afterOrdinal: row.afterOrdinal,
          armedAt: row.armedAt,
        };
        const outcome = watchOutcome(target, watch);
        if (outcome === undefined) continue;
        yield* deliver(target, watch, outcome).pipe(
          Effect.catchCause(
            logFailure("thread watch wake failed", {
              watcherThreadId: watch.watcherThreadId,
              targetThreadId,
            }),
          ),
        );
        // One-shot. A re-arm since this read has a new armed_at and stays.
        yield* sql`
          DELETE FROM thread_watches
          WHERE watcher_thread_id = ${row.watcherThreadId}
            AND target_thread_id = ${targetThreadId}
            AND armed_at = ${row.armedAt}
        `;
      }
    },
    (effect, targetThreadId) =>
      effect.pipe(Effect.catchCause(logFailure("thread watch check failed", { targetThreadId }))),
  );

  const watch: ThreadWatch["Service"]["watch"] = Effect.fn("ThreadWatch.watch")(function* (input) {
    if (input.watcherThreadId === input.targetThreadId) {
      return yield* new ThreadWatchError({ message: "A thread cannot watch itself." });
    }
    const watcher = yield* projections.getThreadShell(input.watcherThreadId).pipe(Effect.orDie);
    if (watcher === null) {
      return yield* new ThreadWatchError({ message: "The watching thread was not found." });
    }
    // As with pull request watches: a subagent's result already reaches the thread that
    // delegated to it, and a wake would start work nobody asked it for.
    if (watcher.lineage.relationshipToParent === "subagent") {
      return yield* new ThreadWatchError({
        message:
          "A subagent cannot watch threads; the thread that delegated to it gets its result.",
      });
    }
    const target = yield* projections.getThreadShell(input.targetThreadId).pipe(Effect.orDie);
    if (target === null) {
      return yield* new ThreadWatchError({
        message: `Thread ${input.targetThreadId} was not found.`,
      });
    }
    const { runs } = yield* projections
      .getThreadRecords(input.targetThreadId, ["runs"])
      .pipe(Effect.orDie);
    const pinned =
      runs.find((run) => run.id === input.runId) ??
      runs.filter((run) => !ENDED.has(run.status)).toSorted(byOrdinal)[0];
    const afterOrdinal = Math.max(0, ...runs.map((run) => run.ordinal));
    const armedAt = yield* Clock.currentTimeMillis;
    yield* sql`
      INSERT INTO thread_watches (watcher_thread_id, target_thread_id, run_id, after_ordinal, armed_at)
      VALUES (${input.watcherThreadId}, ${input.targetThreadId}, ${pinned?.id ?? null}, ${afterOrdinal}, ${armedAt})
      ON CONFLICT (watcher_thread_id, target_thread_id) DO UPDATE SET
        run_id = excluded.run_id,
        after_ordinal = excluded.after_ordinal,
        armed_at = excluded.armed_at
    `.pipe(Effect.orDie);
    // The run may have ended before the watch was stored.
    yield* check(input.targetThreadId);
    return { runId: pinned?.id ?? null };
  });

  const unwatch: ThreadWatch["Service"]["unwatch"] = Effect.fn("ThreadWatch.unwatch")(
    function* (input) {
      const removed = yield* sql`
        DELETE FROM thread_watches
        WHERE watcher_thread_id = ${input.watcherThreadId}
          AND target_thread_id = ${input.targetThreadId}
        RETURNING watcher_thread_id
      `.pipe(Effect.orDie);
      return removed.length > 0;
    },
  );

  // Untraced: it sees every domain event, and almost all return at once.
  const handle: ThreadWatch["Service"]["handle"] = Effect.fnUntraced(function* (event) {
    if (
      (event.type === "run.updated" && ENDED.has(event.payload.status)) ||
      (event.type === "runtime-request.updated" && asksSomeone(event.payload)) ||
      event.type === "thread.deleted"
    ) {
      yield* check(event.threadId);
    }
  });

  const start: ThreadWatch["Service"]["start"] = Effect.fn("ThreadWatch.start")(function* () {
    yield* forkParked(
      Stream.runForEach(engine.streamDomainEvents, handle).pipe(
        Effect.catchCause(logFailure("thread watch event stream failed", {})),
      ),
    );
    // The live stream does not replay what happened while the server was down.
    yield* forkParked(
      sql<{
        readonly id: string;
      }>`SELECT DISTINCT target_thread_id AS "id" FROM thread_watches`.pipe(
        Effect.flatMap((rows) =>
          Effect.forEach(rows, (row) => check(ThreadId.make(row.id)), { discard: true }),
        ),
        Effect.catchCause(logFailure("thread watch catch-up failed", {})),
      ),
    );
  });

  return { watch, unwatch, check, handle, start } satisfies ThreadWatch["Service"];
});

export const layer = Layer.effect(ThreadWatch, make);
