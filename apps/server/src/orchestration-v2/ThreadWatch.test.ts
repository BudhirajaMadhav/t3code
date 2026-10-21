import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import {
  resolveT3McpToolDefinition,
  resolveT3McpToolSummaryAction,
} from "@t3tools/shared/t3McpToolPresentation";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../mcp/McpToolAccess.ts";
import * as McpToolAccessTestkit from "../mcp/McpToolAccess.testkit.ts";
import * as OrchestratorMcpService from "../mcp/OrchestratorMcpService.ts";
import * as ThreadMetadataMcpService from "../mcp/ThreadMetadataMcpService.ts";
import * as OrchestratorHandlers from "../mcp/toolkits/orchestrator/handlers.ts";
import { OrchestratorToolkit } from "../mcp/toolkits/orchestrator/tools.ts";
import * as ThreadWatchHandlers from "../mcp/toolkits/threadWatch/handlers.ts";
import { ThreadWatchToolkit } from "../mcp/toolkits/threadWatch/tools.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as ThreadWatch from "./ThreadWatch.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for thread watches"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = ThreadWatch.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      layerDatabase,
      ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
      EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
      ProviderReplayHarness.layerWithRegistry(
        { name: "thread-watch" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { databaseLayer: layerDatabase, runEffectWorker: false },
      ),
    ),
  ),
);

const harness = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const watches = yield* ThreadWatch.ThreadWatch;
  let sequence = 0;
  const next = (prefix: string) => `${prefix}:${++sequence}`;

  const createThread = (id: string, project: string) =>
    orchestrator
      .dispatch({
        type: "thread.create",
        commandId: CommandId.make(next("create")),
        threadId: ThreadId.make(id),
        projectId: ProjectId.make(project),
        title: `Title of ${id}`,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      })
      .pipe(Effect.as(ThreadId.make(id)));

  const send = Effect.fn(function* (threadId: ThreadId) {
    const messageId = MessageId.make(next("message"));
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(next("send")),
      threadId,
      messageId,
      text: "Do the work",
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "user",
      creationSource: "web",
    });
    const { runs } = yield* projections.getThreadRecords(threadId, ["runs"]);
    return runs.find((run) => run.userMessageId === messageId)!;
  });

  /** Writes the event the way the provider runtime would, then lets the reactor see it. */
  const emit = Effect.fn(function* (event: Omit<OrchestrationV2DomainEvent, "id" | "occurredAt">) {
    const full = {
      ...event,
      id: EventId.make(next("event")),
      occurredAt: yield* DateTime.now,
    } as OrchestrationV2DomainEvent;
    yield* eventSink.write({ events: [full] });
    yield* watches.handle(full);
  });

  const reply = Effect.fn(function* (run: OrchestrationV2Run, text: string) {
    const now = yield* DateTime.now;
    yield* emit({
      type: "message.updated",
      threadId: run.threadId,
      runId: run.id,
      payload: {
        id: MessageId.make(next("reply")),
        threadId: run.threadId,
        runId: run.id,
        nodeId: null,
        role: "assistant",
        text,
        attachments: [],
        streaming: false,
        createdAt: now,
        updatedAt: now,
        createdBy: "agent",
        creationSource: "provider",
      },
    } as Omit<OrchestrationV2DomainEvent, "id" | "occurredAt">);
  });

  const end = Effect.fn(function* (run: OrchestrationV2Run, status: OrchestrationV2Run["status"]) {
    const { runs } = yield* projections.getThreadRecords(run.threadId, ["runs"]);
    const current = runs.find((candidate) => candidate.id === run.id)!;
    yield* emit({
      type: "run.updated",
      threadId: run.threadId,
      runId: run.id,
      payload: { ...current, status, completedAt: yield* DateTime.now },
    });
  });

  const ask = Effect.fn(function* (run: OrchestrationV2Run, kind: "user_input" | "command") {
    const id = RuntimeRequestId.make(next("request"));
    yield* emit({
      type: "runtime-request.updated",
      threadId: run.threadId,
      runId: run.id,
      payload: {
        id,
        nodeId: run.rootNodeId ?? NodeId.make(next("node")),
        providerTurnId: null,
        nativeRequestRef: null,
        kind,
        status: "pending",
        responseCapability: { type: "message" },
        createdAt: yield* DateTime.now,
        resolvedAt: null,
      },
    });
    return id;
  });

  const wakes = (threadId: ThreadId) =>
    projections
      .getThreadRecords(threadId, ["messages"])
      .pipe(
        Effect.map(({ messages }) =>
          messages.filter((message) => message.notification?.source.kind === "monitor"),
        ),
      );

  return { orchestrator, projections, watches, createThread, send, reply, end, ask, wakes, next };
});

it.effect.each(["completed", "failed", "interrupted", "cancelled"] as const)(
  "wakes a watcher in another project once when the run ends %s",
  (status) =>
    Effect.gen(function* () {
      const h = yield* harness;
      const watcher = yield* h.createThread("thread:watcher", "project:a");
      const target = yield* h.createThread("thread:target", "project:b");
      const run = yield* h.send(target);

      assert.deepEqual(
        yield* h.watches.watch({ watcherThreadId: watcher, targetThreadId: target }),
        {
          runId: run.id,
        },
      );
      yield* h.reply(run, "All tests pass.");
      yield* h.end(run, status);
      yield* h.end(run, status);
      yield* h.watches.check(target);

      const wakes = yield* h.wakes(watcher);
      assert.equal(wakes.length, 1);
      assert.include(wakes[0]!.text, "[Title of thread:target](t3-thread://v1/thread:target)");
      assert.include(wakes[0]!.text, `Status: ${status}. Pending request: none.`);
      assert.include(wakes[0]!.text, "Last assistant message:\nAll tests pass.");
      assert.deepEqual(wakes[0]!.notification, {
        source: { kind: "monitor" },
        outcome: status === "completed" || status === "failed" ? status : "cancelled",
        summary: `Thread "Title of thread:target" ${
          status === "completed" || status === "failed" ? status : `was ${status}`
        }`,
      });
      assert.isFalse(
        yield* h.watches.unwatch({ watcherThreadId: watcher, targetThreadId: target }),
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect("wakes once on a new pending request, never on one pending before the watch", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    const watcher = yield* h.createThread("thread:watcher", "project:a");
    const target = yield* h.createThread("thread:target", "project:a");
    const run = yield* h.send(target);
    yield* h.ask(run, "user_input");
    yield* TestClock.adjust("1 second");

    yield* h.watches.watch({ watcherThreadId: watcher, targetThreadId: target });
    assert.lengthOf(yield* h.wakes(watcher), 0);

    yield* TestClock.adjust("1 second");
    const requestId = yield* h.ask(run, "command");
    yield* h.end(run, "completed");

    const wakes = yield* h.wakes(watcher);
    assert.equal(wakes.length, 1);
    assert.include(wakes[0]!.text, "is waiting for an approval (command)");
    assert.include(wakes[0]!.text, `threadId thread:target and requestId ${requestId}`);
    assert.include(wakes[0]!.text, "Status: waiting. Pending request: yes.");
    assert.equal(wakes[0]!.notification?.outcome, "updated");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("watches the next run of an idle thread, and a re-arm watches the sent run", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    const watcher = yield* h.createThread("thread:watcher", "project:a");
    const target = yield* h.createThread("thread:target", "project:b");
    const first = yield* h.send(target);
    yield* h.end(first, "completed");

    assert.deepEqual(yield* h.watches.watch({ watcherThreadId: watcher, targetThreadId: target }), {
      runId: null,
    });
    yield* h.watches.check(target);
    assert.lengthOf(yield* h.wakes(watcher), 0);

    const second = yield* h.send(target);
    const queued = yield* h.send(target);
    yield* h.end(second, "completed");
    assert.lengthOf(yield* h.wakes(watcher), 1);

    // What t3_thread_send does: pin the run its message created, here queued behind nothing.
    const sent = yield* h.watches.watch({
      watcherThreadId: watcher,
      targetThreadId: target,
      runId: queued.id,
    });
    assert.deepEqual(sent, { runId: queued.id });
    yield* h.end(queued, "failed");
    const wakes = yield* h.wakes(watcher);
    assert.equal(wakes.length, 2);
    assert.include(wakes[1]!.text, "Status: failed.");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a watch pinned to a queued run ignores the run ahead of it", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    const watcher = yield* h.createThread("thread:watcher", "project:a");
    const target = yield* h.createThread("thread:target", "project:a");
    const active = yield* h.send(target);
    const queued = yield* h.send(target);
    yield* h.watches.watch({ watcherThreadId: watcher, targetThreadId: target, runId: queued.id });

    yield* h.end(active, "completed");
    assert.lengthOf(yield* h.wakes(watcher), 0);
    yield* h.end(queued, "completed");
    assert.lengthOf(yield* h.wakes(watcher), 1);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("several threads watch one thread; deleting it wakes each, an archived one drops", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    const first = yield* h.createThread("thread:first", "project:a");
    const second = yield* h.createThread("thread:second", "project:b");
    const archived = yield* h.createThread("thread:archived", "project:a");
    const target = yield* h.createThread("thread:target", "project:c");
    yield* h.send(target);
    for (const watcherThreadId of [first, second, archived]) {
      yield* h.watches.watch({ watcherThreadId, targetThreadId: target });
    }
    yield* h.orchestrator.dispatch({
      type: "thread.archive",
      commandId: CommandId.make("archive-watcher"),
      threadId: archived,
    });
    yield* h.orchestrator.dispatch({
      type: "thread.delete",
      commandId: CommandId.make("delete-target"),
      threadId: target,
    });
    yield* h.watches.check(target);

    for (const watcher of [first, second]) {
      const wakes = yield* h.wakes(watcher);
      assert.equal(wakes.length, 1);
      assert.include(wakes[0]!.text, "a thread you watch, was deleted.");
    }
    assert.lengthOf(yield* h.wakes(archived), 0);
    assert.isFalse(yield* h.watches.unwatch({ watcherThreadId: archived, targetThreadId: target }));
  }).pipe(Effect.provide(layerTest)),
);

it.effect("refuses a self-watch and a subagent watcher; unwatch ends a watch", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    const parent = yield* h.createThread("thread:parent", "project:a");
    const target = yield* h.createThread("thread:target", "project:a");
    const parentRun = yield* h.send(parent);
    yield* h.orchestrator.dispatch({
      type: "delegated_task.request",
      commandId: CommandId.make("delegate"),
      parentThreadId: parent,
      parentRunId: parentRun.id,
      parentNodeId: parentRun.rootNodeId!,
      task: "Research",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      createdBy: "agent",
      creationSource: "mcp",
    });
    const { subagents } = yield* h.projections.getThreadRecords(parent, ["subagents"]);
    const child = subagents[0]!.childThreadId!;

    const self = yield* Effect.flip(
      h.watches.watch({ watcherThreadId: target, targetThreadId: target }),
    );
    assert.equal(self.message, "A thread cannot watch itself.");
    const subagent = yield* Effect.flip(
      h.watches.watch({ watcherThreadId: child, targetThreadId: target }),
    );
    assert.include(subagent.message, "A subagent cannot watch threads");

    yield* h.watches.watch({ watcherThreadId: parent, targetThreadId: target });
    assert.isTrue(yield* h.watches.unwatch({ watcherThreadId: parent, targetThreadId: target }));
    yield* h.end(yield* h.send(target), "completed");
    assert.lengthOf(yield* h.wakes(parent), 0);
  }).pipe(Effect.provide(layerTest)),
);

it("cuts a long last message and names the cut", () => {
  const wake = ThreadWatch.threadWatchWake({
    thread: { id: ThreadId.make("thread:long"), title: "Long [one]" },
    outcome: { type: "deleted" },
    pendingRequest: false,
    lastMessage: "x".repeat(ThreadWatch.LAST_MESSAGE_CHARS + 10),
  });
  assert.include(wake.text, "[Long one](t3-thread://v1/thread:long)");
  assert.include(
    wake.text,
    `${"x".repeat(ThreadWatch.LAST_MESSAGE_CHARS)}\n\n[Cut at 4000 of 4010 characters.`,
  );
  assert.notInclude(wake.text, "x".repeat(ThreadWatch.LAST_MESSAGE_CHARS + 1));
});

it("presents the watch tools", () => {
  for (const tool of Object.values(ThreadWatchToolkit.tools)) {
    assert.isNotNull(resolveT3McpToolDefinition(tool.name), tool.name);
    assert.isNotNull(resolveT3McpToolSummaryAction(tool.name), tool.name);
  }
});

const callerThreadId = ThreadId.make("thread:caller");
const layerCaller = Layer.mergeAll(
  Layer.succeed(McpInvocationContext.McpInvocationContext, {
    environmentId: EnvironmentId.make("environment"),
    requestNamespace: "session",
    thread: {
      threadId: callerThreadId,
      providerSessionId: "session",
      providerInstanceId: instanceId,
    },
    client: undefined,
    issuedAt: 0,
    capabilities: new Set(["orchestration" as const]),
  }),
  McpToolAccessTestkit.liveThreadsLayer,
  Layer.mock(ThreadMetadataMcpService.ThreadMetadataMcpService)({}),
);

it.effect(
  "t3_thread_send watches the run it reached unless it is a delegated task or opted out",
  () =>
    Effect.gen(function* () {
      const armed: Array<{ readonly targetThreadId: ThreadId; readonly runId?: RunId }> = [];
      let taskId: NodeId | undefined;
      const layerDependencies = Layer.mergeAll(
        layerCaller,
        Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({
          sendToThread: (_scope, input) =>
            Effect.succeed({
              threadId: input.threadId,
              messageId: MessageId.make("message:sent"),
              runId: RunId.make("run:sent"),
              ...(taskId === undefined ? {} : { taskId }),
              status: "running" as const,
              delivery: "started" as const,
            }),
        }),
        Layer.mock(ThreadWatch.ThreadWatch)({
          watch: (input) => {
            armed.push({ targetThreadId: input.targetThreadId, runId: input.runId! });
            return Effect.succeed({ runId: input.runId ?? null });
          },
        }),
      );
      const toolkit = yield* OrchestratorToolkit.pipe(
        Effect.provide(
          McpToolAccess.HandlersLayer.layer(OrchestratorHandlers.layer).pipe(
            Layer.provide(layerDependencies),
          ),
        ),
      );
      const send = (input: { readonly watch?: boolean }) =>
        toolkit
          .handle("t3_thread_send", {
            threadId: ThreadId.make("thread:other"),
            message: "Go",
            ...input,
          })
          .pipe(
            Stream.unwrap,
            Stream.runCollect,
            Effect.map((parts) => parts.at(-1)?.result as { readonly watching: boolean }),
            Effect.provide(layerDependencies),
          );

      assert.isTrue((yield* send({})).watching);
      assert.deepEqual(armed, [
        { targetThreadId: ThreadId.make("thread:other"), runId: RunId.make("run:sent") },
      ]);
      assert.isFalse((yield* send({ watch: false })).watching);
      taskId = NodeId.make("task:child");
      assert.isFalse((yield* send({})).watching);
      assert.lengthOf(armed, 1);
    }),
);

it.effect("t3_thread_watch needs the server's watch service", () =>
  Effect.gen(function* () {
    const toolkit = yield* ThreadWatchToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ThreadWatchHandlers.layer).pipe(
          Layer.provide(layerCaller),
        ),
      ),
    );
    const result = yield* toolkit
      .handle("t3_thread_watch", { threadId: ThreadId.make("thread:other") })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(layerCaller));
    assert.deepInclude(result.at(-1)?.result, { code: "orchestration_error" });
  }),
);
