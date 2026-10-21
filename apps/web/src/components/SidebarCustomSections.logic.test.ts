import { EnvironmentId, SidebarSectionId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  customSectionDroppableId,
  customSectionKey,
  indexSidebarSections,
  resolveCustomSectionDrop,
  splitSidebarListsBySection,
} from "./SidebarCustomSections.logic";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const heavy = SidebarSectionId.make("section-heavy");
const docs = SidebarSectionId.make("section-docs");
const threadKey = (environmentId: string, threadId: string) => `${environmentId}:${threadId}`;
const section = (id: SidebarSectionId, title: string) => ({ id, title, createdAt: "" });

const index = indexSidebarSections(
  [
    {
      environmentId: local,
      state: {
        sections: [section(heavy, "Heavy mode"), section(docs, "Docs")],
        threads: { [ThreadId.make("backend")]: heavy, [ThreadId.make("frontend")]: heavy },
      },
    },
    { environmentId: remote, state: { sections: [section(heavy, "Remote heavy")], threads: {} } },
  ],
  threadKey,
);

describe("custom sidebar sections", () => {
  it("keeps sections per environment, in order", () => {
    expect(index.sections.map((view) => view.section.title)).toEqual([
      "Heavy mode",
      "Docs",
      "Remote heavy",
    ]);
    // The same section id in another environment is a different section.
    expect(index.sectionKeyByThreadKey.get("local:backend")).toBe(customSectionKey(local, heavy));
    expect(index.sectionKeyByThreadKey.has("remote:backend")).toBe(false);
  });

  it("moves sectioned threads out of the flat lists without reordering either", () => {
    type Row = { readonly key: string };
    const row = (key: string): Row => ({ key });
    const { flat, bySection } = splitSidebarListsBySection(
      {
        pinnedThreads: [row("local:pinned"), row("local:frontend")],
        activeThreads: [row("local:a"), row("local:backend"), row("local:b")],
        workingThreads: [],
        snoozedThreads: [],
        settledThreads: [row("local:orphan")],
        snoozeNow: "kept",
      },
      (thread) => index.sectionKeyByThreadKey.get(thread.key),
      index.sectionByKey,
    );
    expect(flat.pinnedThreads.map((thread) => thread.key)).toEqual(["local:pinned"]);
    expect(flat.activeThreads.map((thread) => thread.key)).toEqual(["local:a", "local:b"]);
    expect(flat.snoozeNow).toBe("kept");
    const lists = bySection.get(customSectionKey(local, heavy));
    // A pinned thread shows in its section only, still pinned there.
    expect(lists?.pinnedThreads.map((thread) => thread.key)).toEqual(["local:frontend"]);
    expect(lists?.activeThreads.map((thread) => thread.key)).toEqual(["local:backend"]);
  });

  it("leaves a thread whose section is gone in the flat list", () => {
    const { flat, bySection } = splitSidebarListsBySection(
      {
        pinnedThreads: [],
        activeThreads: ["local:stale"],
        workingThreads: [],
        snoozedThreads: [],
        settledThreads: [],
      },
      () => customSectionKey(local, SidebarSectionId.make("section-deleted")),
      index.sectionByKey,
    );
    expect(flat.activeThreads).toEqual(["local:stale"]);
    expect(bySection.size).toBe(0);
  });

  describe("drops", () => {
    const backend = { environmentId: local, id: ThreadId.make("backend") };
    const flatThread = { environmentId: local, id: ThreadId.make("flat") };
    const drop = (
      thread: typeof backend,
      fromSection: SidebarSectionId | undefined,
      overId: string | null,
    ) =>
      resolveCustomSectionDrop({
        thread,
        fromSectionKey:
          fromSection === undefined ? undefined : customSectionKey(local, fromSection),
        overId,
        sectionByKey: index.sectionByKey,
      });

    it("puts a flat thread into the section it is dropped on", () => {
      expect(
        drop(flatThread, undefined, customSectionDroppableId(customSectionKey(local, docs))),
      ).toEqual({ kind: "assign", environmentId: local, threadId: flatThread.id, sectionId: docs });
    });

    it("leaves flat-to-flat drops to the flat list", () => {
      expect(drop(flatThread, undefined, "local:other")).toBeNull();
    });

    it("moves between sections and out of them", () => {
      expect(
        drop(backend, heavy, customSectionDroppableId(customSectionKey(local, docs))),
      ).toMatchObject({ kind: "assign", sectionId: docs });
      expect(drop(backend, heavy, "local:some-flat-row")).toMatchObject({
        kind: "assign",
        sectionId: null,
      });
      expect(drop(backend, heavy, null)).toEqual({ kind: "none" });
      expect(
        drop(backend, heavy, customSectionDroppableId(customSectionKey(local, heavy))),
      ).toEqual({ kind: "none" });
    });

    it("never moves a thread into another environment's section", () => {
      expect(
        drop(flatThread, undefined, customSectionDroppableId(customSectionKey(remote, heavy))),
      ).toEqual({ kind: "none" });
    });
  });
});
