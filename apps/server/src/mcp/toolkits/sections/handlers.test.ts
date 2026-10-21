import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type SidebarSectionId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type { Toolkit } from "effect/ai";

import * as ServerConfig from "../../../config.ts";
import * as ThreadLaunch from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as SidebarSections from "../../../sidebarSections/SidebarSections.ts";
import * as SidebarSectionsTestkit from "../../../sidebarSections/SidebarSections.testkit.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as ProjectHandlers from "../project/handlers.ts";
import { ProjectToolkit } from "../project/tools.ts";
import * as SectionHandlers from "./handlers.ts";
import { SectionToolkit } from "./tools.ts";

const callerId = ThreadId.make("caller");
const projectId = ProjectId.make("project");
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId: providerInstanceId, model: "gpt-5" };
const shell = (id: ThreadId) =>
  ({
    id,
    projectId,
    providerInstanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    activeRunId: "active-run",
    archivedAt: null,
    deletedAt: null,
  }) as OrchestrationV2ThreadShell;
const known = new Set(["caller", "other"]);

const layerDependencies = (launched: Array<ThreadId>) =>
  Layer.mergeAll(
    SidebarSectionsTestkit.layer,
    ServerSettings.layerTest(),
    NodeCrypto.layer,
    Layer.succeed(McpInvocationContext.McpInvocationContext, {
      environmentId: EnvironmentId.make("environment"),
      requestNamespace: "session",
      thread: { threadId: callerId, providerSessionId: "session", providerInstanceId },
      client: undefined,
      issuedAt: 0,
      capabilities: new Set(["orchestration" as const]),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (id) => Effect.succeed(known.has(id) ? shell(id) : null),
    }),
    Layer.mock(ThreadLaunch.ThreadLaunchService)({
      launch: (input) => {
        launched.push(input.threadId!);
        return Effect.succeed({
          threadId: input.threadId,
          projection: { thread: { id: input.threadId, projectId, modelSelection }, runs: [] },
          resumed: false,
        } as unknown as ThreadLaunch.ThreadLaunchResult);
      },
    }),
    Layer.mock(Project.ProjectService)({}),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/projects" }),
    Layer.mock(GitVcsDriver.GitVcsDriver)({}),
    NodeServices.layer,
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-section-tools-" }).pipe(
      Layer.provide(NodeServices.layer),
    ),
  );

const call = <Tools extends Record<string, never>>(
  toolkit: Toolkit.WithHandler<Tools>,
  name: string,
  params: unknown,
) =>
  (toolkit.handle as (name: string, params: unknown) => Effect.Effect<Stream.Stream<unknown>>)(
    name,
    params,
  ).pipe(
    Stream.unwrap,
    Stream.runCollect,
    Effect.map((items) => items.at(-1) as { readonly isFailure: boolean; readonly result: never }),
  );

/** Runs `body` with both toolkits sharing one section store. */
const withTools = <A, E, R>(
  body: (tools: {
    readonly section: (name: string, params: unknown) => ReturnType<typeof call>;
    readonly project: (name: string, params: unknown) => ReturnType<typeof call>;
    readonly launched: ReadonlyArray<ThreadId>;
  }) => Effect.Effect<A, E, R>,
) => {
  const launched: Array<ThreadId> = [];
  return Effect.gen(function* () {
    const sectionTools = yield* SectionToolkit.pipe(
      Effect.provide(McpToolAccess.HandlersLayer.layer(SectionHandlers.layer)),
    );
    const projectTools = yield* ProjectToolkit.pipe(
      Effect.provide(McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer)),
    );
    return yield* body({
      section: (name, params) => call(sectionTools as never, name, params),
      project: (name, params) => call(projectTools as never, name, params),
      launched,
    });
  }).pipe(Effect.provide(layerDependencies(launched)));
};

const membership = Effect.gen(function* () {
  const { threads } = yield* (yield* SidebarSections.SidebarSections).state;
  return { ...threads } as Readonly<Record<string, SidebarSectionId>>;
});

it.effect("agents create, list, fill, rename and delete sections", () =>
  withTools(({ section }) =>
    Effect.gen(function* () {
      const created = yield* section("t3_section_create", { title: "Heavy mode" });
      const { sectionId } = created.result as { sectionId: SidebarSectionId };
      // Omitted threadIds means the calling thread.
      yield* section("t3_section_assign", { sectionId });
      yield* section("t3_section_assign", { threadIds: ["other"], sectionId });
      yield* section("t3_section_rename", { sectionId, title: "Heavy" });
      const listed = yield* section("t3_section_list", {});
      expect(listed.result).toEqual({
        sections: [{ sectionId, title: "Heavy", threadIds: ["caller", "other"] }],
      });

      const unknownThread = yield* section("t3_section_assign", {
        threadIds: ["missing"],
        sectionId,
      });
      expect(unknownThread.isFailure).toBe(true);

      yield* section("t3_section_assign", { threadIds: ["other"], sectionId: null });
      expect(yield* membership).toEqual({ caller: sectionId });
      yield* section("t3_section_delete", { sectionId });
      expect(yield* membership).toEqual({});
    }),
  ),
);

it.effect("a thread launched from a sectioned thread joins its section", () =>
  withTools(({ section, project, launched }) =>
    Effect.gen(function* () {
      const created = yield* section("t3_section_create", {
        title: "Heavy mode",
        threadIds: ["caller"],
      });
      const { sectionId } = created.result as { sectionId: SidebarSectionId };
      yield* project("t3_thread_launch", { title: "Frontend half" });
      expect(launched).toHaveLength(1);
      expect((yield* membership)[launched[0]!]).toBe(sectionId);
    }),
  ),
);

it.effect("an explicit sectionId wins over the caller's section", () =>
  withTools(({ section, project, launched }) =>
    Effect.gen(function* () {
      yield* section("t3_section_create", { title: "Caller's", threadIds: ["caller"] });
      const other = yield* section("t3_section_create", { title: "Other" });
      const { sectionId } = other.result as { sectionId: SidebarSectionId };
      yield* project("t3_thread_launch", { title: "Elsewhere", sectionId });
      expect((yield* membership)[launched[0]!]).toBe(sectionId);
    }),
  ),
);

it.effect("an unknown sectionId is refused before any thread is created", () =>
  withTools(({ project, launched }) =>
    Effect.gen(function* () {
      const result = yield* project("t3_thread_launch", {
        title: "Nowhere",
        sectionId: "section-missing",
      });
      expect(result.isFailure).toBe(true);
      expect(launched).toHaveLength(0);
    }),
  ),
);
