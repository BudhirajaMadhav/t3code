import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EventId,
  type OrchestrationV2DomainEvent,
  ProjectId,
  ProviderInstanceId,
  type SidebarSectionId,
  ThreadId,
} from "@t3tools/contracts";
import type * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as SidebarSectionLineage from "./SidebarSectionLineage.ts";
import * as SidebarSections from "./SidebarSections.ts";

type Services =
  | Crypto.Crypto
  | SidebarSections.SidebarSections
  | SidebarSectionLineage.SidebarSectionLineage
  | ServerConfig.ServerConfig
  | FileSystem.FileSystem
  | Path.Path
  | Scope.Scope;

const layerIn = (baseDir: string) =>
  SidebarSectionLineage.layer.pipe(
    Layer.provideMerge(SidebarSections.layer),
    Layer.provide(Layer.mock(Orchestrator.OrchestratorV2)({ streamDomainEvents: Stream.empty })),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
  );

/** Runs `body` against a fresh state directory; `seed` is the file found at startup. */
const withSections = <A, E>(body: Effect.Effect<A, E, Services>, seed?: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-sidebar-sections-" });
    if (seed !== undefined) {
      const config = yield* ServerConfig.ServerConfig.pipe(
        Effect.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
      );
      yield* fs.makeDirectory(config.stateDir, { recursive: true });
      yield* fs.writeFileString(path.join(config.stateDir, "sidebar-sections.json"), seed);
    }
    return yield* body.pipe(Effect.provide(layerIn(baseDir)));
  }).pipe(Effect.scoped);

/** A second service over the same directory, as after a server restart. */
const reloaded = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const baseDir = config.baseDir;
  return yield* Effect.gen(function* () {
    return yield* (yield* SidebarSections.SidebarSections).state;
  }).pipe(Effect.provide(layerIn(baseDir)));
});

const sections = SidebarSections.SidebarSections;
const thread = (id: string) => ThreadId.make(id);
const create = (title: string, threadIds: ReadonlyArray<string> = []) =>
  Effect.gen(function* () {
    const { sectionId } = yield* (yield* sections).update({
      type: "create",
      title,
      threadIds: threadIds.map(thread),
    });
    return sectionId!;
  });
const assign = (threadIds: ReadonlyArray<string>, sectionId: SidebarSectionId | null) =>
  Effect.gen(function* () {
    yield* (yield* sections).update({
      type: "assign",
      threadIds: threadIds.map(thread),
      sectionId,
    });
  });
const state = Effect.flatMap(sections, (service) => service.state).pipe(
  // Plain keys, so expectations can be written as object literals.
  Effect.map((current) => ({
    ...current,
    threads: current.threads as Readonly<Record<string, SidebarSectionId>>,
  })),
);

const providerInstanceId = ProviderInstanceId.make("codex");
const created = (
  id: string,
  lineage: {
    readonly parentThreadId: string;
    readonly relationshipToParent: "fork" | "subagent";
  } | null,
  creationSource: "web" | "mcp" | "provider" = "web",
): OrchestrationV2DomainEvent => {
  const at = DateTime.makeUnsafe(Date.UTC(2026, 9, 21));
  return {
    id: EventId.make(`created:${id}`),
    type: "thread.created",
    threadId: thread(id),
    providerInstanceId,
    occurredAt: at,
    payload: {
      createdBy: "user",
      creationSource,
      id: thread(id),
      projectId: ProjectId.make("project"),
      title: id,
      providerInstanceId,
      modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: {
        parentThreadId: lineage === null ? null : thread(lineage.parentThreadId),
        relationshipToParent: lineage?.relationshipToParent ?? null,
        rootThreadId: thread(lineage?.parentThreadId ?? id),
      },
      forkedFrom: null,
      createdAt: at,
      updatedAt: at,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
  } as OrchestrationV2DomainEvent;
};
const handle = (event: OrchestrationV2DomainEvent) =>
  Effect.flatMap(SidebarSectionLineage.SidebarSectionLineage, (lineage) => lineage.handle(event));

it.layer(NodeServices.layer)("sidebar sections", (it) => {
  it.effect("creates sections in order and survives a restart", () =>
    withSections(
      Effect.gen(function* () {
        const heavy = yield* create("Heavy mode", ["backend", "frontend"]);
        const docs = yield* create("Docs");
        const current = yield* state;
        assert.deepEqual(
          current.sections.map((section) => section.title),
          ["Heavy mode", "Docs"],
        );
        assert.deepEqual(current.threads, { backend: heavy, frontend: heavy });
        assert.deepEqual(yield* reloaded, current);
        assert.notEqual(heavy, docs);
      }),
    ),
  );

  it.effect("moves a thread between sections and out of them", () =>
    withSections(
      Effect.gen(function* () {
        const first = yield* create("First", ["a"]);
        const second = yield* create("Second");
        yield* assign(["a"], second);
        assert.deepEqual((yield* state).threads, { a: second });
        yield* assign(["a"], null);
        assert.deepEqual((yield* state).threads, {});
        yield* assign(["a"], first);
        assert.deepEqual((yield* state).threads, { a: first });
      }),
    ),
  );

  it.effect("deleting a section returns its threads to the flat list only", () =>
    withSections(
      Effect.gen(function* () {
        const gone = yield* create("Gone", ["a", "b"]);
        const kept = yield* create("Kept", ["c"]);
        yield* (yield* sections).update({ type: "delete", sectionId: gone });
        const current = yield* state;
        assert.deepEqual(
          current.sections.map((section) => section.id),
          [kept],
        );
        assert.deepEqual(current.threads, { c: kept });
      }),
    ),
  );

  it.effect("renames and reorders", () =>
    withSections(
      Effect.gen(function* () {
        const a = yield* create("A");
        const b = yield* create("B");
        const c = yield* create("C");
        const service = yield* sections;
        yield* service.update({ type: "rename", sectionId: b, title: "Bee" });
        yield* service.update({ type: "move", sectionId: c, beforeSectionId: a });
        yield* service.update({ type: "move", sectionId: a, beforeSectionId: null });
        assert.deepEqual(
          (yield* state).sections.map((section) => section.title),
          ["C", "Bee", "A"],
        );
      }),
    ),
  );

  it.effect("rejects an unknown section without changing anything", () =>
    withSections(
      Effect.gen(function* () {
        const real = yield* create("Real", ["a"]);
        const missing = "section-missing" as SidebarSectionId;
        const service = yield* sections;
        const error = yield* service
          .update({ type: "assign", threadIds: [thread("a")], sectionId: missing })
          .pipe(Effect.flip);
        assert.equal(error._tag, "SidebarSectionNotFoundError");
        assert.deepEqual((yield* state).threads, { a: real });
      }),
    ),
  );

  it.effect("streams the current state, then each change", () =>
    withSections(
      Effect.gen(function* () {
        const service = yield* sections;
        const first = yield* service.changes.pipe(Stream.runHead);
        assert.deepEqual(Option.getOrNull(first), { sections: [], threads: {} });
        const id = yield* create("Live", ["a"]);
        const next = yield* service.changes.pipe(Stream.runHead);
        assert.deepEqual({ ...Option.getOrNull(next)?.threads }, { a: id } as object);
      }),
    ),
  );

  it.effect("keeps an unreadable file aside instead of overwriting it", () =>
    withSections(
      Effect.gen(function* () {
        yield* create("Fresh");
        const fs = yield* FileSystem.FileSystem;
        const config = yield* ServerConfig.ServerConfig;
        const kept = (yield* fs.readDirectory(config.stateDir)).filter((name) =>
          name.startsWith("sidebar-sections.json.corrupt-"),
        );
        assert.equal(kept.length, 1);
        const path = yield* Path.Path;
        assert.equal(yield* fs.readFileString(path.join(config.stateDir, kept[0]!)), "{not json");
      }),
      "{not json",
    ),
  );

  it.effect("a fork and a delegated child land in the parent's section", () =>
    withSections(
      Effect.gen(function* () {
        const id = yield* create("Heavy mode", ["parent"]);
        yield* handle(created("fork", { parentThreadId: "parent", relationshipToParent: "fork" }));
        yield* handle(
          created("child", { parentThreadId: "parent", relationshipToParent: "subagent" }, "mcp"),
        );
        assert.deepEqual((yield* state).threads, { parent: id, fork: id, child: id });
      }),
    ),
  );

  it.effect("lineage never overrides an explicit choice", () =>
    withSections(
      Effect.gen(function* () {
        const parentSection = yield* create("Parent", ["parent"]);
        const other = yield* create("Other");
        // Explicit choices recorded before the created event is handled.
        yield* assign(["explicit"], other);
        yield* assign(["removed"], null);
        yield* handle(
          created("explicit", { parentThreadId: "parent", relationshipToParent: "fork" }),
        );
        yield* handle(
          created("removed", { parentThreadId: "parent", relationshipToParent: "fork" }),
        );
        assert.deepEqual((yield* state).threads, { parent: parentSection, explicit: other });
      }),
    ),
  );

  it.effect("ignores threads without a sectioned parent and native subagents", () =>
    withSections(
      Effect.gen(function* () {
        yield* create("Parent", ["parent"]);
        yield* handle(created("top-level", null));
        yield* handle(
          created("orphan", { parentThreadId: "unsectioned", relationshipToParent: "fork" }),
        );
        yield* handle(
          created(
            "native",
            { parentThreadId: "parent", relationshipToParent: "subagent" },
            "provider",
          ),
        );
        assert.deepEqual(Object.keys((yield* state).threads), ["parent"]);
      }),
    ),
  );

  it.effect("a deleted thread leaves its section", () =>
    withSections(
      Effect.gen(function* () {
        yield* create("Section", ["a", "b"]);
        yield* handle({
          ...created("a", null),
          type: "thread.deleted",
        } as OrchestrationV2DomainEvent);
        assert.deepEqual(Object.keys((yield* state).threads), ["b"]);
      }),
    ),
  );
});
