import { OrchestratorMcpFailure, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as SidebarSections from "../../../sidebarSections/SidebarSections.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller, unavailable } from "../../threadAccess.ts";
import { sectionFailure } from "./placement.ts";
import { SectionToolkit } from "./tools.ts";

/** Resolves omitted ids to the caller and refuses ids that name no thread. */
const existingThreads = Effect.fn("mcp.sectionThreads")(function* (
  threadIds: ReadonlyArray<ThreadId> | undefined,
) {
  const { threads, caller } = yield* readCaller();
  if (threadIds === undefined) {
    if (caller === undefined) {
      return yield* new OrchestratorMcpFailure({
        code: "target_required",
        message: "Pass threadIds: this MCP client is not running inside a T3 thread.",
      });
    }
    return [caller.id];
  }
  for (const threadId of threadIds) {
    const shell = yield* threads.getThreadShell(threadId).pipe(Effect.mapError(unavailable));
    if (shell === null || shell.deletedAt !== null) {
      return yield* new OrchestratorMcpFailure({
        code: "thread_not_found",
        message: `Thread ${threadId} was not found.`,
      });
    }
  }
  return threadIds;
});

const update = (input: Parameters<SidebarSections.SidebarSections["Service"]["update"]>[0]) =>
  SidebarSections.SidebarSections.pipe(
    Effect.flatMap((sections) => sections.update(input)),
    Effect.mapError(sectionFailure),
  );

export const layer = McpToolAccess.toLayer(SectionToolkit, {
  t3_section_list: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      yield* readCaller();
      const { sections, threads } = yield* (yield* SidebarSections.SidebarSections).state;
      const members = Object.entries(threads);
      return {
        sections: sections.map((section) => ({
          sectionId: section.id,
          title: section.title,
          threadIds: members.flatMap(([threadId, sectionId]) =>
            sectionId === section.id ? [threadId as ThreadId] : [],
          ),
        })),
      };
    }),
  ),
  t3_section_create: McpToolAccess.writesThreads(
    (input) => input.threadIds ?? [],
    (input) =>
      Effect.gen(function* () {
        const threadIds =
          input.threadIds === undefined ? [] : yield* existingThreads(input.threadIds);
        const { sectionId } = yield* update({ type: "create", title: input.title, threadIds });
        return { sectionId: sectionId! };
      }),
  ),
  t3_section_rename: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      yield* readCaller();
      yield* update({ type: "rename", sectionId: input.sectionId, title: input.title });
      return {};
    }),
  ),
  t3_section_delete: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      yield* readCaller();
      yield* update({ type: "delete", sectionId: input.sectionId });
      return {};
    }),
  ),
  t3_section_assign: McpToolAccess.writesThreads(
    (input) => input.threadIds ?? [undefined],
    (input) =>
      Effect.gen(function* () {
        const threadIds = yield* existingThreads(input.threadIds);
        yield* update({ type: "assign", threadIds, sectionId: input.sectionId });
        return {};
      }),
  ),
});
