import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import { ThreadId } from "./baseSchemas.ts";
import { ResourceTelemetryProcess } from "./resourceTelemetry.ts";

const { threadId: _threadId, ...upstreamFields } = ResourceTelemetryProcess.fields;
const decodeUpstream = Schema.decodeUnknownSync(Schema.Struct(upstreamFields));
const encodeProcess = Schema.encodeSync(ResourceTelemetryProcess);

describe("ResourceTelemetryProcess", () => {
  it("still decodes for clients built before processes carried a thread", () => {
    const seenAt = DateTime.makeUnsafe(1_700_000_000_000);
    const wire = encodeProcess({
      identity: { pid: 42, startTimeMs: 1 },
      ppid: 1,
      childPids: [],
      depth: 1,
      name: "claude",
      command: "claude --output-format stream-json",
      status: "Running",
      category: "server-child",
      cpuPercent: 1,
      cpuTimeMs: 10,
      residentBytes: 1_024,
      peakResidentBytes: 2_048,
      virtualBytes: 4_096,
      ioReadBytes: 0,
      ioWriteBytes: 0,
      ioReadBytesPerSecond: 0,
      ioWriteBytesPerSecond: 0,
      ioSemantics: "storage",
      runTimeMs: 1_000,
      firstSeenAt: seenAt,
      lastSeenAt: seenAt,
      threadId: ThreadId.make("thread-1"),
    });

    expect(wire).toHaveProperty("threadId", "thread-1");
    expect(decodeUpstream(wire)).not.toHaveProperty("threadId");
  });
});
