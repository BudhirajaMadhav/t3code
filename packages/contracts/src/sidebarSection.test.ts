import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import { describe, expect, it } from "vite-plus/test";

import { ExecutionEnvironmentCapabilities, ExecutionEnvironmentDescriptor } from "./environment.ts";

describe("sidebar sections on the wire", () => {
  // The descriptor is the only existing payload the feature touches. A client
  // built from upstream decodes it without the flag; this is that schema.
  const UpstreamDescriptor = Schema.Struct({
    ...ExecutionEnvironmentDescriptor.fields,
    capabilities: Schema.Struct(
      Struct.omit(ExecutionEnvironmentCapabilities.fields, ["sidebarSections"]),
    ),
  });
  const decodeUpstreamDescriptor = Schema.decodeUnknownSync(Schema.toCodecJson(UpstreamDescriptor));

  it("an upstream client decodes a descriptor that advertises sections", () => {
    const wire = {
      environmentId: "environment-1",
      label: "Local",
      platform: { os: "darwin", arch: "arm64" },
      serverVersion: "0.0.32",
      capabilities: { repositoryIdentity: true, threadPinning: true, sidebarSections: true },
    };
    const decoded = decodeUpstreamDescriptor(wire);
    expect(decoded.capabilities).toEqual({ repositoryIdentity: true, threadPinning: true });
  });
});
