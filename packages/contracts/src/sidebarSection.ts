import * as Schema from "effect/Schema";

import { IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

// Sections stay out of the orchestration log and the shell stream: clients
// built from upstream decode those with closed unions, so they reach a client
// only through the sidebarSections RPCs, which such a client never calls.

export const SidebarSectionId = TrimmedNonEmptyString.pipe(Schema.brand("SidebarSectionId"));
export type SidebarSectionId = typeof SidebarSectionId.Type;

export const SidebarSectionTitle = TrimmedNonEmptyString.check(Schema.isMaxLength(80));

export const SidebarSection = Schema.Struct({
  id: SidebarSectionId,
  title: SidebarSectionTitle,
  createdAt: IsoDateTime,
});
export type SidebarSection = typeof SidebarSection.Type;

export const SidebarSectionsState = Schema.Struct({
  /** In display order. */
  sections: Schema.Array(SidebarSection),
  /** Only threads that are in a section. */
  threads: Schema.Record(ThreadId, SidebarSectionId),
});
export type SidebarSectionsState = typeof SidebarSectionsState.Type;

const SidebarSectionThreadIds = Schema.Array(ThreadId).check(Schema.isMaxLength(500));

export const SidebarSectionsUpdateInput = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("create"),
    title: SidebarSectionTitle,
    threadIds: Schema.optional(SidebarSectionThreadIds),
  }),
  Schema.Struct({
    type: Schema.Literal("rename"),
    sectionId: SidebarSectionId,
    title: SidebarSectionTitle,
  }),
  Schema.Struct({ type: Schema.Literal("delete"), sectionId: SidebarSectionId }),
  Schema.Struct({
    type: Schema.Literal("move"),
    sectionId: SidebarSectionId,
    /** null moves the section to the end. */
    beforeSectionId: Schema.NullOr(SidebarSectionId),
  }),
  Schema.Struct({
    type: Schema.Literal("assign"),
    threadIds: SidebarSectionThreadIds,
    /** null takes the threads out of their sections. */
    sectionId: Schema.NullOr(SidebarSectionId),
  }),
]);
export type SidebarSectionsUpdateInput = typeof SidebarSectionsUpdateInput.Type;

export const SidebarSectionsUpdateResult = Schema.Struct({
  /** The created section; null for every other update. */
  sectionId: Schema.NullOr(SidebarSectionId),
});
export type SidebarSectionsUpdateResult = typeof SidebarSectionsUpdateResult.Type;

export class SidebarSectionNotFoundError extends Schema.TaggedError<SidebarSectionNotFoundError>()(
  "SidebarSectionNotFoundError",
  { sectionId: SidebarSectionId },
) {
  override get message(): string {
    return `Sidebar section ${this.sectionId} does not exist.`;
  }
}

export class SidebarSectionPersistenceError extends Schema.TaggedError<SidebarSectionPersistenceError>()(
  "SidebarSectionPersistenceError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not save the sidebar sections.";
  }
}
