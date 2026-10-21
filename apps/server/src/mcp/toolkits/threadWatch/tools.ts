import { OrchestratorMcpFailure, RunId, ThreadId } from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as Schema from "effect/Schema";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
];

const ThreadWatchTool = Tool.make("t3_thread_watch", {
  description:
    "Needs an agent running inside a T3 thread. Have T3 Code wake THIS thread once when another thread's run ends (completed, failed, interrupted, or cancelled) or when that thread asks for an approval or an answer. The wake message carries the thread's link, status, pending request, and last assistant message. Use it instead of polling with t3_thread_wait or t3_thread_read or running a watcher, then end your turn. Works for any thread in this environment, in any project. It watches the thread's current run, or its next run when the thread is idle. A watch fires once; call again, or send to the thread with t3_thread_send, to watch again. t3_thread_launch and t3_thread_send already watch the thread they start or message. A subagent cannot watch.",
  parameters: Schema.Struct({ threadId: ThreadId }),
  success: Schema.Struct({
    threadId: ThreadId,
    runId: Schema.NullOr(RunId).annotate({
      description: "The run being watched. Null means the thread's next run.",
    }),
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Watch a T3 thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const ThreadUnwatchTool = Tool.make("t3_thread_unwatch", {
  description:
    "Stop watching a thread, so its run ending no longer wakes this thread. Unwatching a thread that is not watched succeeds with wasWatching=false.",
  parameters: Schema.Struct({ threadId: ThreadId }),
  success: Schema.Struct({ threadId: ThreadId, wasWatching: Schema.Boolean }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Stop watching a T3 thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ThreadWatchToolkit = Toolkit.make(ThreadWatchTool, ThreadUnwatchTool);
