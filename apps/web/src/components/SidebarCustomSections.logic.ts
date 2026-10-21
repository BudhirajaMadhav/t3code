import type {
  ContextMenuItem,
  EnvironmentId,
  SidebarSection,
  SidebarSectionId,
  SidebarSectionsState,
  ThreadId,
} from "@t3tools/contracts";

/** A section is unique per environment: `${environmentId}\n${sectionId}`. */
export type CustomSectionKey = string;

export const customSectionKey = (
  environmentId: EnvironmentId,
  sectionId: SidebarSectionId,
): CustomSectionKey => `${environmentId}\n${sectionId}`;

const DROPPABLE_PREFIX = "sidebar-custom-section:";

export const customSectionDroppableId = (key: CustomSectionKey) => `${DROPPABLE_PREFIX}${key}`;

export const customSectionKeyFromDroppableId = (id: string): CustomSectionKey | null =>
  id.startsWith(DROPPABLE_PREFIX) ? id.slice(DROPPABLE_PREFIX.length) : null;

export interface CustomSectionView {
  readonly key: CustomSectionKey;
  readonly environmentId: EnvironmentId;
  readonly section: SidebarSection;
}

export interface SidebarSectionsIndex {
  /** In display order: environments in the given order, then each one's section order. */
  readonly sections: ReadonlyArray<CustomSectionView>;
  readonly sectionByKey: ReadonlyMap<CustomSectionKey, CustomSectionView>;
  /** Scoped thread key (`${environmentId}:${threadId}`) to its section. */
  readonly sectionKeyByThreadKey: ReadonlyMap<string, CustomSectionKey>;
}

export function indexSidebarSections(
  states: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly state: SidebarSectionsState;
  }>,
  threadKey: (environmentId: EnvironmentId, threadId: ThreadId) => string,
): SidebarSectionsIndex {
  const sections: CustomSectionView[] = [];
  const sectionKeyByThreadKey = new Map<string, CustomSectionKey>();
  for (const { environmentId, state } of states) {
    for (const section of state.sections) {
      sections.push({ key: customSectionKey(environmentId, section.id), environmentId, section });
    }
    for (const [threadId, sectionId] of Object.entries(state.threads)) {
      sectionKeyByThreadKey.set(
        threadKey(environmentId, threadId as ThreadId),
        customSectionKey(environmentId, sectionId),
      );
    }
  }
  return {
    sections,
    sectionByKey: new Map(sections.map((view) => [view.key, view])),
    sectionKeyByThreadKey,
  };
}

export interface SidebarThreadLists<T> {
  readonly pinnedThreads: ReadonlyArray<T>;
  readonly activeThreads: ReadonlyArray<T>;
  readonly workingThreads: ReadonlyArray<T>;
  readonly snoozedThreads: ReadonlyArray<T>;
  readonly settledThreads: ReadonlyArray<T>;
}

const LIST_NAMES = [
  "pinnedThreads",
  "activeThreads",
  "workingThreads",
  "snoozedThreads",
  "settledThreads",
] as const;

type ThreadOf<L extends SidebarThreadLists<unknown>> = L["pinnedThreads"][number];

/**
 * Moves sectioned threads out of the flat lists into their section, keeping
 * each list's order. A thread whose section is gone stays in the flat list.
 */
export function splitSidebarListsBySection<L extends SidebarThreadLists<unknown>>(
  lists: L,
  sectionKeyOf: (thread: ThreadOf<L>) => CustomSectionKey | undefined,
  sectionByKey: ReadonlyMap<CustomSectionKey, unknown>,
): {
  readonly flat: L;
  readonly bySection: ReadonlyMap<CustomSectionKey, SidebarThreadLists<ThreadOf<L>>>;
} {
  type Thread = ThreadOf<L>;
  const bySection = new Map<CustomSectionKey, Record<(typeof LIST_NAMES)[number], Thread[]>>();
  const flat: Record<string, unknown> = { ...(lists as object) };
  for (const name of LIST_NAMES) {
    const kept: Thread[] = [];
    for (const thread of lists[name] as ReadonlyArray<Thread>) {
      const key = sectionKeyOf(thread);
      if (key === undefined || !sectionByKey.has(key)) {
        kept.push(thread);
        continue;
      }
      let section = bySection.get(key);
      if (section === undefined) {
        section = {
          pinnedThreads: [],
          activeThreads: [],
          workingThreads: [],
          snoozedThreads: [],
          settledThreads: [],
        };
        bySection.set(key, section);
      }
      section[name].push(thread);
    }
    flat[name] = kept;
  }
  return { flat: flat as L, bySection };
}

export type CustomSectionDrop =
  | { readonly kind: "none" }
  | {
      readonly kind: "assign";
      readonly environmentId: EnvironmentId;
      readonly threadId: ThreadId;
      /** null takes the thread out of its section. */
      readonly sectionId: SidebarSectionId | null;
    };

/**
 * Drops that involve a section. Returns null for a flat thread dropped on the
 * flat list, which the sidebar's own drop planning handles.
 */
export function resolveCustomSectionDrop(input: {
  readonly thread: { readonly environmentId: EnvironmentId; readonly id: ThreadId };
  readonly fromSectionKey: CustomSectionKey | undefined;
  readonly overId: string | null;
  readonly sectionByKey: ReadonlyMap<CustomSectionKey, CustomSectionView>;
}): CustomSectionDrop | null {
  const { thread, fromSectionKey, overId, sectionByKey } = input;
  const targetKey = overId === null ? null : customSectionKeyFromDroppableId(overId);
  const assign = (sectionId: SidebarSectionId | null): CustomSectionDrop => ({
    kind: "assign",
    environmentId: thread.environmentId,
    threadId: thread.id,
    sectionId,
  });
  if (targetKey !== null) {
    const target = sectionByKey.get(targetKey);
    if (
      target === undefined ||
      target.environmentId !== thread.environmentId ||
      targetKey === fromSectionKey
    ) {
      return { kind: "none" };
    }
    return assign(target.section.id);
  }
  if (fromSectionKey === undefined) return null;
  return overId === null ? { kind: "none" } : assign(null);
}

export type SectionMenuId = "section" | `section:${string}`;

/** The thread menu's "Move to section" entry, for threads of one environment. */
export function buildMoveToSectionMenuItem(input: {
  readonly sections: ReadonlyArray<SidebarSection>;
  /** The section every selected thread is in, or null when none or mixed. */
  readonly currentSectionId: SidebarSectionId | null;
  readonly anyInSection: boolean;
}): ContextMenuItem<SectionMenuId> {
  return {
    id: "section",
    label: "Move to section",
    icon: "folder",
    children: [
      ...input.sections.map((section) => ({
        id: `section:${section.id}` as const,
        label: section.title,
        checked: section.id === input.currentSectionId,
      })),
      {
        id: "section:new" as const,
        label: "New section…",
        separatorBefore: input.sections.length > 0,
      },
      ...(input.anyInSection
        ? [{ id: "section:none" as const, label: "Remove from section" }]
        : []),
    ],
  };
}
