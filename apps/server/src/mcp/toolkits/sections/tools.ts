import {
  OrchestratorMcpFailure,
  SidebarSectionId,
  SidebarSectionTitle,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as SidebarSections from "../../../sidebarSections/SidebarSections.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

/** The `sectionId` argument of the thread-creating tools. */
export const NewThreadSectionInput = Schema.optional(
  SidebarSectionId.annotate({
    description:
      "Sidebar section for the new thread (t3_section_list). Omit to use the section of the thread it is created from.",
  }),
);

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    SidebarSections.SidebarSections,
  ],
};
const Section = Schema.Struct({
  sectionId: SidebarSectionId,
  title: Schema.String,
  threadIds: Schema.Array(ThreadId),
});
const Done = Schema.Struct({});

const SectionListTool = Tool.make("t3_section_list", {
  ...shared,
  description:
    "List the user's sidebar sections in display order with the threads in each. A section groups related threads, across projects, in the T3 sidebar. A thread is in at most one section; threads in none are omitted.",
  parameters: Tool.EmptyParams,
  success: Schema.Struct({ sections: Schema.Array(Section) }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const SectionCreateTool = Tool.make("t3_section_create", {
  ...shared,
  description:
    "Create a sidebar section at the end of the list, optionally moving threads into it. Threads you later create from a thread in a section join that section automatically.",
  parameters: Schema.Struct({
    title: SidebarSectionTitle,
    threadIds: Schema.optional(Schema.Array(ThreadId).check(Schema.isMaxLength(500))),
  }),
  success: Schema.Struct({ sectionId: SidebarSectionId }),
}).annotate(Tool.Destructive, false);

const SectionRenameTool = Tool.make("t3_section_rename", {
  ...shared,
  description: "Rename a sidebar section.",
  parameters: Schema.Struct({ sectionId: SidebarSectionId, title: SidebarSectionTitle }),
  success: Done,
}).annotate(Tool.Destructive, false);

const SectionDeleteTool = Tool.make("t3_section_delete", {
  ...shared,
  description:
    "Delete a sidebar section. Its threads return to the main list unchanged; no thread is deleted.",
  parameters: Schema.Struct({ sectionId: SidebarSectionId }),
  success: Done,
}).annotate(Tool.Destructive, true);

const SectionAssignTool = Tool.make("t3_section_assign", {
  ...shared,
  description:
    "Put threads into a sidebar section, moving them out of any other section, or take them out with sectionId=null. Omit threadIds for this thread.",
  parameters: Schema.Struct({
    threadIds: Schema.optional(
      Schema.Array(ThreadId).check(Schema.isMinLength(1), Schema.isMaxLength(500)),
    ),
    sectionId: Schema.NullOr(SidebarSectionId),
  }),
  success: Done,
}).annotate(Tool.Destructive, false);

export const SectionToolkit = Toolkit.make(
  SectionListTool,
  SectionCreateTool,
  SectionRenameTool,
  SectionDeleteTool,
  SectionAssignTool,
);
