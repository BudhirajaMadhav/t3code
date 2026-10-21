import {
  OrchestratorMcpFailure,
  type SidebarSectionId,
  type SidebarSectionNotFoundError,
  type SidebarSectionPersistenceError,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as SidebarSections from "../../../sidebarSections/SidebarSections.ts";
import { unavailable } from "../../threadAccess.ts";

export const sectionFailure = (
  error: SidebarSectionNotFoundError | SidebarSectionPersistenceError,
) =>
  error._tag === "SidebarSectionNotFoundError"
    ? new OrchestratorMcpFailure({
        code: "invalid_request",
        message: "The sidebar section was not found. t3_section_list shows sections.",
      })
    : unavailable();

/** Refuses an unknown section before a tool creates a thread for it. */
export const checkSection = Effect.fn("mcp.checkSection")(function* (
  sectionId: SidebarSectionId | undefined,
) {
  if (sectionId === undefined) return;
  const { sections } = yield* (yield* SidebarSections.SidebarSections).state;
  if (!sections.some((section) => section.id === sectionId)) {
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message:
        "The sidebar section was not found. No thread was created. t3_section_list shows sections.",
    });
  }
});

/**
 * Puts a thread a tool just created in the requested section, or else in the
 * section of the thread it came from. The thread already exists, so a failure
 * here is logged rather than failing a call the agent might then retry.
 */
export const placeNewThreads = Effect.fn("mcp.placeNewThreads")(function* (input: {
  readonly threadIds: ReadonlyArray<ThreadId>;
  readonly sectionId: SidebarSectionId | undefined;
  readonly parentThreadId: ThreadId | undefined;
}) {
  const sections = yield* SidebarSections.SidebarSections;
  const { threadIds, sectionId, parentThreadId } = input;
  if (threadIds.length === 0) return;
  const placed: Effect.Effect<
    unknown,
    SidebarSectionNotFoundError | SidebarSectionPersistenceError
  > =
    sectionId !== undefined
      ? sections.update({ type: "assign", threadIds, sectionId })
      : parentThreadId === undefined
        ? Effect.void
        : Effect.forEach(threadIds, (threadId) =>
            sections.inherit({ threadId, fromThreadId: parentThreadId }),
          );
  yield* placed.pipe(
    Effect.asVoid,
    Effect.catch((cause) =>
      Effect.logWarning("placing a new thread in a sidebar section failed", { threadIds, cause }),
    ),
  );
});
