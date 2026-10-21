import {
  isProviderNativeSubagentThread,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { forkParked } from "../serverActivation.ts";
import * as SidebarSections from "./SidebarSections.ts";

/**
 * Forks and delegate_task children record their parent in `lineage`, so they
 * land in the parent's section here. `t3_thread_launch` and `create_threads`
 * record no parent; their MCP handlers apply the caller's section instead.
 */
export class SidebarSectionLineage extends Context.Service<
  SidebarSectionLineage,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  }
>()("t3/sidebarSections/SidebarSectionLineage") {}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const sections = yield* SidebarSections.SidebarSections;

  // Runs for every domain event, so no span per call.
  const handle = Effect.fnUntraced(
    function* (event: OrchestrationV2DomainEvent) {
      if (event.type === "thread.deleted") {
        yield* sections.forget(event.threadId);
        return;
      }
      if (event.type !== "thread.created") return;
      const thread = event.payload;
      const parentThreadId = thread.lineage.parentThreadId;
      // Provider-native subagents have no sidebar row and can number in the
      // hundreds per workflow; recording them would only grow the file.
      if (parentThreadId === null || isProviderNativeSubagentThread(thread)) return;
      yield* sections.inherit({ threadId: thread.id, fromThreadId: parentThreadId });
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("applying sidebar section lineage failed", {
            threadId: event.threadId,
            cause,
          }),
        ),
      ),
  );

  const start: SidebarSectionLineage["Service"]["start"] = () =>
    forkParked(
      Stream.runForEach(engine.streamDomainEvents, handle).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("sidebar section lineage event stream failed", { cause }),
        ),
      ),
    );

  return SidebarSectionLineage.of({ start, handle });
});

export const layer = Layer.effect(SidebarSectionLineage, make);
