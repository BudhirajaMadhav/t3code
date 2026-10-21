import {
  SidebarSection,
  SidebarSectionId,
  SidebarSectionNotFoundError,
  SidebarSectionPersistenceError,
  type SidebarSectionsState,
  type SidebarSectionsUpdateInput,
  type SidebarSectionsUpdateResult,
  ThreadId,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ServerConfig from "../config.ts";

// A JSON file, not a SQL migration: the migrator skips every id at or below the
// highest recorded one, so a fork-only migration id would make the database
// skip the upstream migration that later takes the same id.
const StoredSidebarSections = Schema.Struct({
  version: Schema.Literal(1),
  sections: Schema.Array(SidebarSection),
  // null records an explicit "no section", so a late lineage write cannot put
  // a thread back into a section someone took it out of.
  threads: Schema.Record(ThreadId, Schema.NullOr(SidebarSectionId)),
});
type StoredSidebarSections = typeof StoredSidebarSections.Type;

const EMPTY: StoredSidebarSections = { version: 1, sections: [], threads: {} };
const decodeStored = Schema.decodeUnknownEffect(Schema.fromJsonString(StoredSidebarSections));

const toState = (stored: StoredSidebarSections): SidebarSectionsState => {
  const known = new Set(stored.sections.map((section) => section.id));
  const threads: Record<ThreadId, SidebarSectionId> = {};
  for (const [threadId, sectionId] of Object.entries(stored.threads)) {
    if (sectionId !== null && known.has(sectionId)) threads[threadId as ThreadId] = sectionId;
  }
  return { sections: stored.sections, threads };
};

export class SidebarSections extends Context.Service<
  SidebarSections,
  {
    readonly state: Effect.Effect<SidebarSectionsState>;
    /** The current state, then the whole state again after every change. */
    readonly changes: Stream.Stream<SidebarSectionsState>;
    readonly update: (
      input: SidebarSectionsUpdateInput,
    ) => Effect.Effect<
      SidebarSectionsUpdateResult,
      SidebarSectionNotFoundError | SidebarSectionPersistenceError
    >;
    /**
     * Puts `threadId` in the section `fromThreadId` is in, unless something
     * already decided `threadId`'s section.
     */
    readonly inherit: (input: {
      readonly threadId: ThreadId;
      readonly fromThreadId: ThreadId;
    }) => Effect.Effect<void, SidebarSectionPersistenceError>;
    readonly forget: (threadId: ThreadId) => Effect.Effect<void, SidebarSectionPersistenceError>;
  }
>()("t3/sidebarSections/SidebarSections") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const config = yield* ServerConfig.ServerConfig;
  const filePath = path.join(config.stateDir, "sidebar-sections.json");

  const loaded = yield* fs.readFileString(filePath).pipe(
    Effect.flatMap(decodeStored),
    Effect.catch((error) =>
      error._tag === "PlatformError" && error.reason._tag === "NotFound"
        ? Effect.succeed(EMPTY)
        : // Keep an unreadable file for recovery; the next write would replace it.
          DateTime.now.pipe(
            Effect.flatMap((now) =>
              fs.rename(filePath, `${filePath}.corrupt-${DateTime.toEpochMillis(now)}`),
            ),
            Effect.ignore,
            Effect.andThen(
              Effect.logError("sidebar sections file could not be read; starting empty", {
                cause: error,
              }),
            ),
            Effect.as(EMPTY),
          ),
    ),
  );
  const ref = yield* SubscriptionRef.make(loaded);
  const writes = yield* Semaphore.make(1);

  const save = (next: StoredSidebarSections) =>
    writeFileStringAtomically({
      filePath,
      contents: `${JSON.stringify(next, null, 2)}\n`,
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.mapError((cause) => new SidebarSectionPersistenceError({ cause })),
      Effect.andThen(SubscriptionRef.set(ref, next)),
    );

  /** Serializes read-modify-write; `undefined` from `change` means nothing to save. */
  const modify = <A, E>(
    change: (
      current: StoredSidebarSections,
    ) => Effect.Effect<readonly [A, StoredSidebarSections | undefined], E>,
  ) =>
    writes.withPermits(1)(
      Effect.gen(function* () {
        const [result, next] = yield* change(yield* SubscriptionRef.get(ref));
        if (next !== undefined) yield* save(next);
        return result;
      }),
    );

  const requireSection = (stored: StoredSidebarSections, sectionId: SidebarSectionId) =>
    stored.sections.some((section) => section.id === sectionId)
      ? Effect.void
      : Effect.fail(new SidebarSectionNotFoundError({ sectionId }));

  const withThreads = (
    stored: StoredSidebarSections,
    threadIds: ReadonlyArray<ThreadId>,
    sectionId: SidebarSectionId | null,
  ): StoredSidebarSections => {
    const threads = { ...stored.threads };
    for (const threadId of threadIds) threads[threadId] = sectionId;
    return { ...stored, threads };
  };

  const update: SidebarSections["Service"]["update"] = Effect.fn("SidebarSections.update")(
    function* (input) {
      if (input.type === "create") {
        const id = SidebarSectionId.make(
          `section-${yield* crypto.randomUUIDv4().pipe(Effect.orDie)}`,
        );
        const createdAt = DateTime.formatIso(yield* DateTime.now);
        return yield* modify((stored) =>
          Effect.succeed([
            { sectionId: id },
            withThreads(
              { ...stored, sections: [...stored.sections, { id, title: input.title, createdAt }] },
              input.threadIds ?? [],
              id,
            ),
          ] as const),
        );
      }
      return yield* modify((stored) =>
        Effect.gen(function* () {
          const unchanged = { sectionId: null };
          switch (input.type) {
            case "rename": {
              yield* requireSection(stored, input.sectionId);
              const sections = stored.sections.map((section) =>
                section.id === input.sectionId ? { ...section, title: input.title } : section,
              );
              return [unchanged, { ...stored, sections }] as const;
            }
            case "delete": {
              yield* requireSection(stored, input.sectionId);
              const members = Object.entries(stored.threads).flatMap(([threadId, sectionId]) =>
                sectionId === input.sectionId ? [threadId as ThreadId] : [],
              );
              const next = withThreads(stored, members, null);
              return [
                unchanged,
                {
                  ...next,
                  sections: stored.sections.filter((section) => section.id !== input.sectionId),
                },
              ] as const;
            }
            case "move": {
              yield* requireSection(stored, input.sectionId);
              if (input.beforeSectionId !== null) {
                yield* requireSection(stored, input.beforeSectionId);
              }
              if (input.beforeSectionId === input.sectionId) return [unchanged, undefined] as const;
              const moved = stored.sections.find((section) => section.id === input.sectionId)!;
              const rest = stored.sections.filter((section) => section.id !== input.sectionId);
              const index =
                input.beforeSectionId === null
                  ? rest.length
                  : rest.findIndex((section) => section.id === input.beforeSectionId);
              return [
                unchanged,
                { ...stored, sections: [...rest.slice(0, index), moved, ...rest.slice(index)] },
              ] as const;
            }
            case "assign": {
              if (input.sectionId !== null) yield* requireSection(stored, input.sectionId);
              return [unchanged, withThreads(stored, input.threadIds, input.sectionId)] as const;
            }
          }
        }),
      );
    },
  );

  const inherit: SidebarSections["Service"]["inherit"] = Effect.fn("SidebarSections.inherit")(
    function* ({ threadId, fromThreadId }) {
      yield* modify((stored) => {
        const sectionId = stored.threads[fromThreadId];
        const decided = Object.hasOwn(stored.threads, threadId);
        return Effect.succeed([
          undefined,
          decided || sectionId == null || !stored.sections.some((s) => s.id === sectionId)
            ? undefined
            : withThreads(stored, [threadId], sectionId),
        ] as const);
      });
    },
  );

  const forget: SidebarSections["Service"]["forget"] = Effect.fn("SidebarSections.forget")(
    function* (threadId) {
      yield* modify((stored) => {
        if (!Object.hasOwn(stored.threads, threadId)) {
          return Effect.succeed([undefined, undefined] as const);
        }
        const { [threadId]: _removed, ...threads } = stored.threads;
        return Effect.succeed([undefined, { ...stored, threads }] as const);
      });
    },
  );

  return SidebarSections.of({
    state: SubscriptionRef.get(ref).pipe(Effect.map(toState)),
    changes: SubscriptionRef.changes(ref).pipe(Stream.map(toState)),
    update,
    inherit,
    forget,
  });
});

export const layer = Layer.effect(SidebarSections, make);
